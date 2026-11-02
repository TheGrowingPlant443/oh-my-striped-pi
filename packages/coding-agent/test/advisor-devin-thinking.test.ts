import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-striped-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { toProviderModelConfig } from "./helpers/model-fixtures";

// Regression for https://github.com/can1357/oh-my-pi/issues/4579.
//
// When the advisor role resolves to a reasoning model without a controllable
// effort surface (`reasoning: true`, `thinking: undefined` — a self-hosted
// endpoint that routes reasoning by model id, not a wire param), the advisor
// descriptor MUST NOT hand the Agent a concrete `Effort.Medium` default. That
// would trip `requireSupportedEffort` inside `stream.ts` on the first prompt
// and disable the advisor session-wide with an empty
// `Supported efforts:` warning list.
//
// This mirrors the `auto`-path fix already covered by
// `auto-thinking-classifier.test.ts:145` for `clampAutoThinkingEffort`, at the
// advisor descriptor boundary.
describe("AgentSession advisor descriptor thinking level", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let anthropicModel: Model;
	let noEffortModel: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
		anthropicModel = buildModel({
			provider: "company-anthropic-advisor",
			id: "claude-sonnet-4-5",
			name: "Company Anthropic advisor",
			api: "anthropic-messages",
			baseUrl: "https://advisor.company.invalid",
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			input: ["text"],
			supportsTools: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		modelRegistry.registerProvider(anthropicModel.provider, {
			api: anthropicModel.api,
			apiKey: "test-key",
			baseUrl: anthropicModel.baseUrl,
			models: [toProviderModelConfig(anthropicModel)],
		});

		// Register a self-hosted provider with a reasoning model that has NO
		// `thinking` metadata (`trustExplicitThinkingOnly` stops the catalog from
		// inferring a ladder): `reasoning: true` with no controllable effort surface.
		modelRegistry.registerProvider("no-effort-advisor-test", {
			api: "openai-completions",
			apiKey: "test-key",
			baseUrl: "http://127.0.0.1:11434/v1",
			models: [
				{
					id: "no-thinking",
					name: "Test No-Thinking",
					api: "openai-completions",
					reasoning: true,
					compat: { trustExplicitThinkingOnly: true },
					input: ["text"],
					supportsTools: true,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 64_000,
				},
			],
		});
		const noEffort = modelRegistry.find("no-effort-advisor-test", "no-thinking");
		if (!noEffort) throw new Error("Expected synthetic no-effort-advisor-test/no-thinking to register");
		noEffortModel = noEffort;
	});

	afterAll(() => {
		authStorage.close();
	});

	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(() => {
		sessionManager = SessionManager.inMemory("/tmp/advisor-devin-thinking");
		const agent = new Agent({
			initialState: {
				model: anthropicModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
	});

	it("advisor on a reasoning model without an effort surface boots without an unsupported-effort throw", () => {
		// Confirm the catalog shape that triggered the bug: `reasoning: true` with
		// no controllable `thinking.efforts`. The synthetic model in `beforeAll`
		// guarantees this shape regardless of upstream catalog drift.
		expect(noEffortModel.reasoning).toBe(true);
		expect(noEffortModel.thinking).toBeUndefined();

		session.settings.setModelRole("advisor", `${noEffortModel.provider}/${noEffortModel.id}`);

		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.isAdvisorActive()).toBe(true);

		// Before the fix, the descriptor hardcoded `ThinkingLevel.Medium` which
		// flowed to `Agent#state.thinkingLevel` and then tripped
		// `requireSupportedEffort` inside the provider's option mapping on the
		// first stream. The clamp now forwards no explicit effort
		// (mirroring `clampAutoThinkingEffort`), so the Agent stores `undefined`
		// and the provider's default routing applies.
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.model.provider).toBe(noEffortModel.provider);
		expect(advisor.state.model.id).toBe(noEffortModel.id);
		expect(advisor.state.thinkingLevel).toBeUndefined();
		// `Off` is reserved for the explicit "disable reasoning" selector; the
		// no-effort path forwards no effort while keeping reasoning enabled.
		expect(advisor.state.disableReasoning).toBe(false);
	});

	it("Anthropic advisor with no configured thinking suffix still gets the medium default", () => {
		// Guard against over-clamping: models that support `medium` MUST keep
		// receiving it so the historical advisor thinking budget is preserved.
		session.settings.setModelRole("advisor", `${anthropicModel.provider}/${anthropicModel.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.model.provider).toBe(anthropicModel.provider);
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("advisor without an effort surface and an explicit :off suffix disables reasoning without clamping to inherit", () => {
		// `off` is an explicit user opt-out and MUST reach the Agent as
		// `disableReasoning: true` regardless of the model's effort surface. The
		// clamp helper preserves `off`; verifying that here so a future change
		// to the descriptor doesn't route `off` through the no-controllable-effort
		// fallback and silently re-enable reasoning.
		session.settings.setModelRole("advisor", `${noEffortModel.provider}/${noEffortModel.id}:off`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBeUndefined();
		expect(advisor.state.disableReasoning).toBe(true);
	});
});
