import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as catalogPolicy from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Request {
	stage: string;
	provider: string;
	sessionId: string | undefined;
	key: unknown;
	system: unknown;
	tools: unknown;
	input: unknown;
}

beforeEach(() => {
	const resolve = catalogPolicy.resolveCatalogPolicy;
	vi.spyOn(catalogPolicy, "resolveCatalogPolicy").mockImplementation(model => ({
		...resolve(model),
		sharedPromptCache: model.provider === "github-copilot" && model.id === "gpt-5.4",
	}));
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it.each([
	["automatic eligible key", false, false],
	["model switched to an ineligible model", true, false],
	["explicit eligible key", false, true],
	["explicit ineligible key", true, true],
] as const)(
	"keeps primary, ephemeral, and handoff routing consistent for %s",
	async (_name, switchToIneligible, explicit) => {
		using dir = TempDir.createSync("@omp-task-side-cache-");
		const auth = await AuthStorage.create(dir.join("auth.db"));
		auth.keys.setRuntime("github-copilot", "test-key");
		const mock = createMockModel({ handler: { content: [{ type: "text", text: "## Goal\nContinue the review." }] } });
		const requests: Request[] = [];
		let stage = "seed";
		const realFactory = settingsStream.createSettingsAwareStreamFn;
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation(settings =>
			realFactory(settings, async (model, context, options) => {
				const cacheOptions = {
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					providerSessionState: options?.providerSessionState,
				};
				const body = buildParams(model as Model<"openai-responses">, context, cacheOptions, undefined).params;
				requests.push({
					stage,
					provider: model.provider,
					sessionId: options?.sessionId,
					key: body.prompt_cache_key,
					system: context.systemPrompt,
					tools: body.tools,
					input: body.input,
				});
				return mock.stream(model, context, options);
			}),
		);
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			model: getBundledModel("github-copilot", "gpt-5.4"),
			providerSessionId: "child-provider-session",
			providerPromptCacheKey: explicit ? "configured-cache" : undefined,
			taskPromptCacheKey: "parent:task",
			sessionManager: SessionManager.inMemory(dir.path()),
			settings: Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
				"compaction.enabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			systemPrompt: ["Review the supplied code."],
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			await session.prompt("Review the cache-key change.");
			expect(requests[0]?.key).toBe(explicit ? "configured-cache" : "parent:task");
			if (switchToIneligible) session.agent.setModel(getBundledModel("github-copilot", "gpt-5.5"));
			if (explicit) session.agent.promptCacheKey = "live-explicit-cache";
			stage = "primary";
			await session.prompt("Check the next part.");
			stage = "ephemeral";
			await session.runEphemeralTurn({ promptText: "Summarize the current result." });
			stage = "handoff";
			await session.handoff();
			const current = requests.slice(1);
			expect(current.map(r => r.stage)).toEqual(["primary", "ephemeral", "handoff"]);
			expect(current.map(r => r.provider)).toEqual(Array(3).fill("github-copilot"));
			const expected = explicit
				? "live-explicit-cache"
				: switchToIneligible
					? "child-provider-session"
					: "parent:task";
			expect(current.map(r => r.key)).toEqual(Array(3).fill(expected));
			const primary = current[0];
			for (const side of current.slice(1)) {
				expect(side.system).toEqual(primary.system);
				expect(side.tools).toEqual(primary.tools);
				if (!Array.isArray(side.input) || !Array.isArray(primary.input)) {
					throw new Error("Expected Responses input arrays");
				}
				expect(side.input.slice(0, primary.input.length)).toEqual(primary.input);
				expect(side.sessionId).not.toBe(primary.sessionId);
			}
			expect(current[1]?.sessionId).not.toBe(current[2]?.sessionId);
		} finally {
			await session.dispose();
			auth.close();
		}
	},
);
