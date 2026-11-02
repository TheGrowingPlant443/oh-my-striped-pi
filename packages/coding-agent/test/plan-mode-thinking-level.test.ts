/**
 * Tests for plan mode thinking level propagation.
 *
 * Bug: When entering plan mode, the thinking level configured on the plan role
 * (e.g., "github-copilot/gpt-5.6-sol:xhigh") is discarded. resolveRoleModel()
 * calls resolveModelRoleValue() but only returns .model, dropping the thinking level.
 * #applyPlanModeModel() therefore has no thinking level to apply.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-striped-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";

import { cfgModelRoles } from "@oh-my-striped-pi/pi-coding-agent/config/model-settings";
import { getTestModel } from "./helpers/model-fixtures";

describe("plan mode thinking level", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let sessionSettings: Settings;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("github-copilot", "test-key");
		modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		sessionSettings = Settings.isolated();
		const model = getTestModel("github-copilot", candidate => candidate.id === "gpt-5.6-sol");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	});

	afterAll(async () => {
		await session.dispose();
		authStorage.close();
	});

	function configureRoles(modelRoles: Record<string, string>): AgentSession {
		cfgModelRoles.override(sessionSettings, modelRoles);
		return session;
	}

	describe("resolveRoleModelWithThinking", () => {
		it("returns thinking level when plan role includes a thinking suffix", () => {
			configureRoles({ plan: "github-copilot/gpt-5.6-sol:xhigh" });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeDefined();
			expect(result.model!.provider).toBe("github-copilot");
			expect(result.model!.id).toBe("gpt-5.6-sol");
			expect(result.thinkingLevel).toBe(ThinkingLevel.XHigh);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("returns no explicit thinking level when plan role has no thinking suffix", () => {
			configureRoles({ plan: "github-copilot/gpt-5.6-sol" });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeDefined();
			expect(result.model!.id).toBe("gpt-5.6-sol");
			expect(result.explicitThinkingLevel).toBe(false);
		});

		it("returns no model when no plan role is configured", () => {
			configureRoles({});

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeUndefined();
		});

		it("works with the default role", () => {
			configureRoles({ default: "github-copilot/gpt-5.6-sol:medium" });

			const result = session.resolveRoleModelWithThinking("default");
			expect(result.model!.id).toBe("gpt-5.6-sol");
			expect(result.thinkingLevel).toBe(ThinkingLevel.Medium);
			expect(result.explicitThinkingLevel).toBe(true);
		});
	});
});
