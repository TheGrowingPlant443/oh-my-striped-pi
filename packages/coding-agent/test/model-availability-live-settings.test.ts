import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

function bundled(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

describe("disabledProviders takes effect live", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-model-availability-live-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("github-copilot", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	const startSession = (settings: Settings, modelRegistry: ModelRegistry, scopedModels: Model<Api>[]) => {
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: scopedModels[0],
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			scopedModels: scopedModels.map(model => ({ model })),
		});
		return session;
	};

	it("drops a provider disabled mid-session from the model list and the Ctrl+P cycle", async () => {
		const sonnet = bundled("github-copilot", "claude-sonnet-4.5");
		const opus = bundled("github-copilot", "claude-opus-4.5");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const live = startSession(settings, modelRegistry, [sonnet, opus]);
		expect(live.getAvailableModels().some(model => model.provider === "github-copilot")).toBe(true);

		cfgDisabledProviders.set(settings, ["github-copilot"]);

		expect(live.scopedModels).toEqual([]);
		expect(live.getAvailableModels().some(model => model.provider === "github-copilot")).toBe(false);
		expect(await live.cycleModel()).toBeUndefined();
	});

	it("restores the retained provider when re-enabled mid-session", async () => {
		const sonnet = bundled("github-copilot", "claude-sonnet-4.5");
		const settings = Settings.isolated();
		cfgDisabledProviders.set(settings, ["github-copilot"]);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		startSession(settings, modelRegistry, [sonnet]);
		expect(modelRegistry.getAvailable()).toEqual([]);
		const reapply = vi.spyOn(modelRegistry, "reapplyModelPolicies");
		const discoverableProviders = modelRegistry.getDiscoverableProviders();

		cfgDisabledProviders.set(settings, []);
		await Promise.resolve();
		await reapply.mock.results[0]?.value;

		expect(modelRegistry.getAvailable().some(model => model.provider === "github-copilot")).toBe(true);
		expect(modelRegistry.getDiscoverableProviders()).toEqual(discoverableProviders);
	});
});
