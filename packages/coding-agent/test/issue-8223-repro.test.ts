import { expect, test } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-striped-pi/pi-agent-core";
import { type FetchImpl, streamSimple } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-striped-pi/pi-utils";
import { toProviderModelConfig } from "./helpers/model-fixtures";

test("keeps company advisor context and accepts a silent review", async () => {
	const temp = TempDir.createSync("@issue-8223-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	const model = buildModel({
		id: "claude-company-reviewer",
		name: "Company Reviewer",
		provider: "company",
		api: "anthropic-messages",
		baseUrl: "https://models.company.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	});
	const registry = new ModelRegistry(auth);
	registry.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "company-test-key",
		models: [toProviderModelConfig(model)],
	});
	const bodies: unknown[] = [];
	const fetchMock: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		const events = [
			{
				type: "message_start",
				message: {
					id: "review",
					role: "assistant",
					model: model.id,
					content: [],
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Analyzing only" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "company-signature" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		];
		return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const advisorStreamFn: StreamFn = (requestModel, context, options) =>
		streamSimple(requestModel, context, { ...options, fetch: fetchMock });
	const agent = new Agent({ initialState: { model, systemPrompt: ["Primary"], tools: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(temp.path(), temp.path()),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		advisorTools: [],
		advisorStreamFn,
	});
	try {
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("advisor did not start");
		await advisor.prompt("### Session update [in progress — more steps follow]\nImplement an order book.");
		expect(advisor.state.error).toBeUndefined();
		expect(bodies).toHaveLength(1);
		expect(advisor.state.model?.contextWindow).toBe(model.contextWindow);
		expect(bodies[0]).toMatchObject({
			system: expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })]),
			tools: expect.arrayContaining([expect.objectContaining({ name: "advise" })]),
		});
	} finally {
		await session.dispose();
		auth.close();
		await temp.remove();
	}
});
