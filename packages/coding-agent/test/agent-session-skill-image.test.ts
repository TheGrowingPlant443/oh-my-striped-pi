import { afterEach, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-striped-pi/pi-agent-core";
import { Effort } from "@oh-my-striped-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-striped-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-striped-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { convertToLlm, type CustomMessage } from "@oh-my-striped-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-striped-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { ONE_PIXEL_PNG as PNG, VISION_DESCRIPTION_SSE } from "./helpers/skill-image-vision";
import { toProviderModelConfig } from "./helpers/model-fixtures";

const textSpec: ModelSpec<"openai-completions"> = {
	id: "company-text",
	name: "Company text",
	provider: "company-skill",
	api: "openai-completions",
	baseUrl: "https://skill.company.invalid/v1",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};
const visionSpec: ModelSpec<"openai-completions"> = {
	...textSpec,
	id: "company-vision",
	name: "Company vision",
	input: ["text", "image"],
};

const skill: Pick<CustomMessage, "customType" | "content" | "display" | "attribution" | "details"> = {
	customType: "skill-prompt",
	content: [
		{ type: "text", text: "Expanded skill. What is in the image?" },
		{ type: "image", data: PNG, mimeType: "image/png" },
	],
	display: true,
	attribution: "user",
	details: { name: "review", args: "describe" },
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose();
});

function setup(options: { responses?: MockResponseSource; beforeVisionReply?: () => Promise<void> } = {}) {
	const tempDir = TempDir.createSync("@skill-image-");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(textSpec.provider, "test-key");
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	registry.registerProvider(textSpec.provider, {
		api: textSpec.api,
		baseUrl: textSpec.baseUrl,
		apiKey: "test-key",
		models: [toProviderModelConfig(textSpec), toProviderModelConfig(visionSpec)],
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		modelRoles: {
			vision: `${visionSpec.provider}/${visionSpec.id}:high`,
			default: `${textSpec.provider}/${textSpec.id}:high`,
		},
	});
	const mock = createMockModel({ responses: options.responses, handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: buildModel(textSpec),
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: registry,
		toolRegistry: new Map(),
	});
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request) => {
				// Gate the vision transport before replying so preprocessing races stay observable.
				const url = input instanceof Request ? input.url : String(input);
				if (url.endsWith("/chat/completions")) await options.beforeVisionReply?.();
				return new Response(VISION_DESCRIPTION_SSE, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
			{ preconnect: fetch.preconnect },
		),
	);
	cleanup.push(async () => {
		fetchSpy.mockRestore();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	const visionCalls = () =>
		fetchSpy.mock.calls.filter(([input]) =>
			(input instanceof Request ? input.url : String(input)).endsWith("/chat/completions"),
		).length;
	return { session, mock, visionCalls };
}

function expectDescriptionBeforeSkill(messages: { role: string; content: unknown }[]) {
	const description = messages.findIndex(
		message => message.role === "developer" && JSON.stringify(message.content).includes("A red square."),
	);
	const prompt = messages.findIndex(
		message => message.role === "user" && JSON.stringify(message.content).includes("Expanded skill."),
	);
	expect(description).toBeGreaterThanOrEqual(0);
	expect(prompt).toBeGreaterThan(description);
}

it("describes a pasted image in an idle user-invoked skill before the main model call", async () => {
	const { session, mock, visionCalls } = setup();
	await session.promptCustomMessage(skill);
	expect(visionCalls()).toBe(1);
	expectDescriptionBeforeSkill(mock.calls[0]?.context.messages ?? []);
});

it("describes a queued user-invoked skill image before delivery", async () => {
	const { session, mock, visionCalls } = setup();
	await session.promptCustomMessage(skill, { streamingBehavior: "followUp", queueOnly: true });
	await session.prompt("kickoff");
	await session.waitForIdle();
	expect(visionCalls()).toBe(1);
	const skillRequest = mock.calls.find(call =>
		call.context.messages.some(message => JSON.stringify(message.content).includes("Expanded skill.")),
	);
	expectDescriptionBeforeSkill(skillRequest?.context.messages ?? []);
});

it("queues an image-bearing skill when another turn starts during vision preprocessing", async () => {
	const visionStarted = Promise.withResolvers<void>();
	const releaseVision = Promise.withResolvers<void>();
	const otherStarted = Promise.withResolvers<void>();
	const releaseOther = Promise.withResolvers<void>();
	const { session, mock, visionCalls } = setup({
		beforeVisionReply: async () => {
			visionStarted.resolve();
			await releaseVision.promise;
		},
		responses: [
			async () => {
				otherStarted.resolve();
				await releaseOther.promise;
				return { content: ["other done"] };
			},
		],
	});
	const skillDispatch = session.promptCustomMessage(skill, { streamingBehavior: "followUp" });
	await visionStarted.promise;
	const otherTurn = session.prompt("other turn");
	await otherStarted.promise;
	releaseVision.resolve();
	// Queued into the running turn, the skill settles while that turn is still blocked;
	// dispatching it as its own turn would wait for the other turn and never settle here.
	await skillDispatch;
	expect(session.agent.state.isStreaming).toBe(true);
	releaseOther.resolve();
	await otherTurn;
	await session.waitForIdle();
	expect(visionCalls()).toBe(1);
	const skillRequest = mock.calls.find(call =>
		call.context.messages.some(message => JSON.stringify(message.content).includes("Expanded skill.")),
	);
	expect(JSON.stringify(skillRequest?.context.messages)).toContain("other turn");
	expectDescriptionBeforeSkill(skillRequest?.context.messages ?? []);
});

it("drops an image-bearing skill when aborted during vision preprocessing", async () => {
	const visionStarted = Promise.withResolvers<void>();
	const releaseVision = Promise.withResolvers<void>();
	const { session, mock, visionCalls } = setup({
		beforeVisionReply: async () => {
			visionStarted.resolve();
			await releaseVision.promise;
		},
	});
	const skillDispatch = session.promptCustomMessage(skill);
	await visionStarted.promise;
	await session.abort();
	releaseVision.resolve();
	await skillDispatch;
	await session.waitForIdle();
	expect(visionCalls()).toBe(1);
	expect(mock.calls.length).toBe(0);
	expect(session.messages.length).toBe(0);
});
