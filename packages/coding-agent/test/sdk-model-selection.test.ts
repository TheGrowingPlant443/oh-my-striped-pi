import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { getBundledModel, getBundledModels } from "@oh-my-striped-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-striped-pi/pi-catalog/provider-models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-striped-pi/pi-catalog/provider-models/descriptors";
import { parseArgs } from "@oh-my-striped-pi/pi-coding-agent/cli/args";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { getModelMatchPreferences, resolveModelScope } from "@oh-my-striped-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import {
	buildSessionOptions as buildCliSessionOptions,
	rebuildScopedModels,
	resolveScopedModels,
} from "@oh-my-striped-pi/pi-coding-agent/main";
import { createAgentSession, type ExtensionFactory } from "@oh-my-striped-pi/pi-coding-agent/sdk";
import * as discoveryModule from "@oh-my-striped-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-striped-pi/pi-coding-agent/task/executor";
import { getBundledAgent } from "@oh-my-striped-pi/pi-coding-agent/task/agents";
import { AgentStorage } from "@oh-my-striped-pi/pi-coding-agent/session/agent-storage";
import type { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import {
	getRetryFallbackRole,
	installRetryFallbackRole,
	type RetryFallbackRole,
} from "@oh-my-striped-pi/pi-coding-agent/session/retry-fallback-chains";
import { getRestorableSessionModels } from "@oh-my-striped-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-striped-pi/pi-coding-agent/session/session-entries";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-striped-pi/pi-coding-agent/session/turn-recovery";
import type { AgentDefinition } from "@oh-my-striped-pi/pi-coding-agent/task/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-striped-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgRetryFallbackChains } from "@oh-my-striped-pi/pi-coding-agent/session/settings";

describe("createAgentSession deferred model pattern resolution", () => {
	let tempDir: string;
	let fixtureDir: string;
	let fixtureAuthStorage: AuthStorage;
	let fixtureModelRegistry: ModelRegistry;
	const authStoragesToClose: AuthStorage[] = [];

	beforeAll(() => {
		fixtureDir = path.join(os.tmpdir(), `pi-sdk-model-selection-fixture-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		fixtureAuthStorage = createInMemoryAuthStorage();
		fixtureModelRegistry = new ModelRegistry(fixtureAuthStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-model-selection-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		// Sessions without explicit settings run `Settings.init({ agentDir: tempDir })`, which
		// opens `<tempDir>/agent.db` process-wide; release it so Windows can delete tempDir.
		resetSettingsForTest();
		AgentStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		fixtureAuthStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("local", {
			baseUrl: "local://inference",
			apiKey: "RUNTIME_KEY",
			api: "local-inference",
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "runtime-fallback-model",
					name: "Runtime Fallback Model",
					reasoning: true,
					thinking: {
						mode: "effort",
						efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
						defaultLevel: Effort.High,
					},
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	const dynamicOnlyProviderConfig: ProviderConfigInput = {
		baseUrl: "local://inference",
		apiKey: "RUNTIME_KEY",
		api: "local-inference",
		fetchDynamicModels: async () => [
			{
				id: "cached-runtime-model",
				name: "Cached Runtime Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	};

	const dynamicOnlyProviderExtension: ExtensionFactory = pi => {
		pi.registerProvider("local", dynamicOnlyProviderConfig);
	};

	function buildSessionOptions(modelPattern: string | string[]) {
		// Reuse one empty registry across these model-only cases. Opening a fresh
		// AuthStorage runs the full SQLite schema setup, while every session here
		// registers and removes the same inline provider on its own lifecycle.
		const authStorage = fixtureAuthStorage;
		const modelRegistry = fixtureModelRegistry;
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern,
		};
	}

	test("resolves explicit modelPattern after extension providers register", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(buildSessionOptions("local/runtime-model"));

		try {
			expect(session.model).toBeDefined();
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("lets a child task spawn a model agent inherited from its parent", async () => {
		const bundledTask = getBundledAgent("task");
		if (!bundledTask) throw new Error("Expected bundled task agent");
		const modelAgent: AgentDefinition = {
			...bundledTask,
			name: "m1",
			model: ["local/runtime-model"],
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [bundledTask], projectAgentsDir: null });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			};
		});
		const { session } = await createAgentSession({
			...buildSessionOptions("local/runtime-model"),
			settings: Settings.isolated({ "async.enabled": false }),
			toolNames: ["task"],
			inheritedSessionAgents: [modelAgent],
		});

		try {
			const taskTool = session.getToolByName("task");
			if (!taskTool) throw new Error("Expected child task tool");
			await taskTool.execute("nested-model-agent-call", {
				agent: "m1",
				task: "Inspect the target with the tagged model.",
			});

			expect(dispatched[0]?.modelOverride).toEqual(["local/runtime-model"]);
		} finally {
			await session.dispose();
		}
	});

	async function startPrewalkSession(
		prewalkInto: string | undefined,
		{
			model = "local/runtime-model",
			defaultRole,
			smolRole,
			extension = providerExtension,
			authenticatedProvider,
			hasUI = false,
			onPrewalkWarning,
		}: {
			model?: string;
			defaultRole?: string;
			smolRole?: string;
			extension?: ExtensionFactory;
			authenticatedProvider?: string;
			hasUI?: boolean;
			onPrewalkWarning?: (warning: string) => void;
		} = {},
	) {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		if (authenticatedProvider) authStorage.keys.setRuntime(authenticatedProvider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated();
		if (defaultRole) settings.setModelRole("default", defaultRole);
		if (smolRole) settings.setModelRole("smol", smolRole);
		const cliOptions = await buildCliSessionOptions(
			parseArgs(["--model", model, ...(prewalkInto ? ["--prewalk-into", prewalkInto] : ["--prewalk"])]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);
		const { session } = await createAgentSession({
			...cliOptions,
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			hasUI,
			onPrewalkWarning,
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});
		return session;
	}

	test("resolves prewalk target registered by an extension", async () => {
		const session = await startPrewalkSession("local/runtime-fallback-model:low");
		try {
			expect(session.model?.id).toBe("runtime-model");
			expect(session.getPrewalkState()?.target.id).toBe("runtime-fallback-model");
			expect(session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});

	test("resolves the default smol prewalk role from an extension", async () => {
		const session = await startPrewalkSession(undefined, {
			smolRole: "local/runtime-fallback-model:low",
		});
		try {
			expect(session.getPrewalkState()?.target.id).toBe("runtime-fallback-model");
			expect(session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});

	test("prefers an earlier extension role target to a later bundled fallback", async () => {
		const fallback = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!fallback) throw new Error("expected claude-sonnet-4.5 to be bundled");
		const session = await startPrewalkSession("@default", {
			defaultRole: `local/runtime-fallback-model:low,${fallback.provider}/${fallback.id}`,
			authenticatedProvider: fallback.provider,
		});
		try {
			expect(session.getPrewalkState()?.target.provider).toBe("local");
			expect(session.getPrewalkState()?.target.id).toBe("runtime-fallback-model");
			expect(session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});

	test("keeps a bundled fallback when the earlier extension target is absent", async () => {
		const startup = getBundledModel("github-copilot", "claude-opus-4.5");
		const fallback = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!startup || !fallback) throw new Error("expected bundled models");
		const session = await startPrewalkSession("@default", {
			model: `${startup.provider}/${startup.id}`,
			defaultRole: `local/missing,${fallback.provider}/${fallback.id}`,
			authenticatedProvider: fallback.provider,
			extension: () => {},
		});
		try {
			expect(session.model?.id).toBe(startup.id);
			expect(session.getPrewalkState()?.target.id).toBe(fallback.id);
		} finally {
			await session.dispose();
		}
	});

	test("fetches a mixed-case cold extension provider without probing unrelated providers", async () => {
		const unrelatedFetch = vi.fn(async () => []);
		const extension: ExtensionFactory = pi => {
			pi.registerProvider("local", dynamicOnlyProviderConfig);
			pi.registerProvider("github-copilot", {
				baseUrl: "https://api.githubcopilot.com",
				api: "openai-completions",
				fetchDynamicModels: unrelatedFetch,
			});
		};
		const session = await startPrewalkSession("LOCAL/cached-runtime-model", {
			model: "github-copilot/claude-sonnet-4.5",
			authenticatedProvider: "github-copilot",
			extension,
			hasUI: true,
		});
		try {
			expect(session.getPrewalkState()?.target.id).toBe("cached-runtime-model");
			expect(unrelatedFetch).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("warns and continues when an extension prewalk target never registers", async () => {
		const writes = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const warnings: string[] = [];
		const session = await startPrewalkSession("local/missing-model", {
			onPrewalkWarning: warning => warnings.push(warning),
		});
		try {
			expect(session.getPrewalkState()).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("local/missing-model");
			expect(writes).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});

	test("resolves explicit dynamic-only modelPattern from fresh runtime cache", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, "models.yml");
		const primerRegistry = new ModelRegistry(authStorage, modelsPath);
		primerRegistry.registerProvider("local", dynamicOnlyProviderConfig, "ext://runtime");
		await primerRegistry.refreshRuntimeProviders("online");
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [dynamicOnlyProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "local/cached-runtime-model",
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("cached-runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("defers online runtime discovery until the UI starts it after first paint", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("github-copilot", "github-copilot-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const model = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!model) throw new Error("missing bundled startup model");
		let fetches = 0;
		const extension: ExtensionFactory = pi => {
			pi.registerProvider("local", {
				baseUrl: "local://inference",
				apiKey: "RUNTIME_KEY",
				api: "local-inference",
				fetchDynamicModels: async () => {
					fetches += 1;
					return [
						{
							id: "deferred-runtime-model",
							name: "Deferred Runtime Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			model,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			hasUI: true,
		});

		try {
			expect(fetches).toBe(0);
			expect(result.startBackgroundModelDiscovery).toBeDefined();
			await result.startBackgroundModelDiscovery?.();
			expect(fetches).toBe(1);
			expect(modelRegistry.find("local", "deferred-runtime-model")).toBeDefined();
		} finally {
			await result.session.dispose();
		}
	});

	test("preserves an explicit model when a reused registry already finished discovery", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("github-copilot", "github-copilot-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		modelRegistry.refreshInBackground("offline");
		await modelRegistry.awaitInitialBackgroundRefresh();

		const catalogModel = modelRegistry.find("github-copilot", "claude-sonnet-4.5");
		if (!catalogModel) throw new Error("missing bundled registry model");
		const explicitModel = buildModel({
			id: catalogModel.id,
			name: "Explicit Claude endpoint",
			api: catalogModel.api,
			provider: catalogModel.provider,
			baseUrl: "https://explicit-sdk-endpoint.example/v1",
			reasoning: catalogModel.reasoning,
			input: [...catalogModel.input],
			cost: catalogModel.cost,
			contextWindow: 321_000,
			maxTokens: 12_345,
		});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			model: explicitModel,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			// Flush a reconciler armed against the already-settled refresh; an
			// incorrect explicit-model opt-in would replace the model here.
			await Promise.resolve();
			expect(session.model?.baseUrl).toBe("https://explicit-sdk-endpoint.example/v1");
			expect(session.model?.contextWindow).toBe(321_000);
			expect(session.model?.maxTokens).toBe(12_345);
		} finally {
			await session.dispose();
		}
	});

	test("hydrates credential-scoped model caches before fallback validation", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const providers = [
			{ id: "github-copilot", apiKey: "copilot-test-key", baseUrl: "https://api.githubcopilot.com" },
		];
		const modelsPath = path.join(tempDir, "models.yml");
		const fallbackSelectors: string[] = [];
		for (const provider of providers) {
			authStorage.keys.setRuntime(provider.id, provider.apiKey);
			const cachedModel = buildModel({
				id: "discovered-only-model",
				name: "Discovered Only Model",
				api: "openai-responses",
				provider: provider.id,
				baseUrl: provider.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_384,
			});
			writeModelCache(
				resolveModelCacheProviderId(provider.id, { apiKey: provider.apiKey }),
				Date.now(),
				[cachedModel],
				true,
				"",
				path.join(tempDir, "models.db"),
			);
			fallbackSelectors.push(`${provider.id}/${cachedModel.id}`);
		}
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const settings = Settings.isolated({
			"retry.fallbackChains": { default: fallbackSelectors },
		});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "github-copilot/gpt-4o",
		});

		try {
			expect(session.configWarnings.filter(warning => warning.includes("discovered-only-model"))).toEqual([]);
		} finally {
			await session.dispose();
		}
	});

	test("rehydrates credential-scoped caches after credentials change", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const provider = "github-copilot";
		const baseUrl = "https://api.githubcopilot.com";
		const cacheDbPath = path.join(tempDir, "models.db");
		const firstModel = buildModel({
			id: "first-credential-model",
			name: "First Credential Model",
			api: "openai-responses",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		authStorage.keys.setRuntime(provider, "first-key");
		writeModelCache(
			resolveModelCacheProviderId(provider, { apiKey: "first-key" }),
			Date.now(),
			[firstModel],
			true,
			"",
			cacheDbPath,
		);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		await modelRegistry.hydrateCredentialScopedModelCaches();
		expect(modelRegistry.find(provider, firstModel.id)).toBeDefined();

		const secondModel = buildModel({
			...firstModel,
			id: "second-credential-model",
			name: "Second Credential Model",
		});
		authStorage.keys.setRuntime(provider, "second-key");
		writeModelCache(
			resolveModelCacheProviderId(provider, { apiKey: "second-key" }),
			Date.now(),
			[secondModel],
			true,
			"",
			cacheDbPath,
		);

		await modelRegistry.hydrateCredentialScopedModelCaches();
		expect(modelRegistry.find(provider, secondModel.id)).toBeDefined();
	});

	test("does not silently fallback when explicit modelPattern is unresolved", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(buildSessionOptions("local/missing-model"));

		try {
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toBe('Model "local/missing-model" not found');
		} finally {
			await session.dispose();
		}
	});

	test("names the provider's near ids when a deferred provider-qualified pattern stays unresolved", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(buildSessionOptions("local/runtime-modl"));

		try {
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toContain('Model "local/runtime-modl" not found');
			expect(modelFallbackMessage).toContain("Did you mean local/runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("does not resolve a disabled provider through deferred subagent model selection", async () => {
		const settings = Settings.isolated({ disabledProviders: ["local"] });
		const { session, modelFallbackMessage } = await createAgentSession({
			...buildSessionOptions("local/runtime-model"),
			settings,
			modelPatternAuthFallback: "local/runtime-fallback-model",
		});

		try {
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toBe('Model "local/runtime-model" not found');
		} finally {
			await session.dispose();
		}
	});

	test("advances past a disabled first selector to an enabled discovery-backed model", async () => {
		// A disabled provider's model already sits in the static catalog, so
		// resolveCliModel resolves the first selector against the full registry. If
		// that match short-circuited the deferred discovery refresh, the enabled
		// second selector (only reachable after a models.yml discovery fetch) would
		// never be discovered and dispatch would report it as not found.
		const disabledModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!disabledModel) {
			throw new Error("Expected bundled github-copilot model");
		}
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "disabled-first-models.yml"));
		const fetchModels = vi.fn(dynamicOnlyProviderConfig.fetchDynamicModels!);
		modelRegistry.registerProvider("local", { ...dynamicOnlyProviderConfig, fetchDynamicModels: fetchModels });

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ disabledProviders: [disabledModel.provider] }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: [`${disabledModel.provider}/${disabledModel.id}`, "local/cached-runtime-model"],
		});

		try {
			expect(fetchModels).toHaveBeenCalled();
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("cached-runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("uses auth fallback when deferred subagent modelPattern resolves without working credentials", async () => {
		const parentModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!parentModel) {
			throw new Error("Expected bundled github-copilot parent model");
		}
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime(parentModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "fallback-models.yml"));
		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async requested => {
			if (requested.provider === "local") return undefined;
			if (requested.provider === parentModel.provider) return "test-key";
			return undefined;
		});
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "local/runtime-model",
			modelPatternAuthFallback: `${parentModel.provider}/${parentModel.id}`,
		});

		try {
			expect(session.model?.provider).toBe(parentModel.provider);
			expect(session.model?.id).toBe(parentModel.id);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
			getApiKeySpy.mockRestore();
		}
	});

	test("resolves deferred role-alias modelPattern after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", "local/runtime-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...buildSessionOptions("@smol"),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resolves deferred bare configured role names after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "local/runtime-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...buildSessionOptions("task"),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resolves deferred suffixed bare configured roles after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "local/runtime-fallback-model");
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "cli-models.yml"));
		const parsed = parseArgs(["--model", "task:high"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.modelPattern).toBe("task:high");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("local");
				expect(session.model?.id).toBe("runtime-fallback-model");
				expect(session.thinkingLevel).toBe(Effort.High);
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("defers bare role chains when an earlier candidate may be registered by extensions", async () => {
		const fallbackModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!fallbackModel) {
			throw new Error("Expected bundled github-copilot fallback model");
		}
		const settings = Settings.isolated();
		settings.setModelRole("task", `local/runtime-model,${fallbackModel.provider}/${fallbackModel.id}`);
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "role-chain-models.yml"));
		const parsed = parseArgs(["--model", "task"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("local");
				expect(session.model?.id).toBe("runtime-model");
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("resolves an authenticated bundled candidate after a missing deferred role target", async () => {
		const settings = Settings.isolated({
			modelProviderOrder: ["local", "github-copilot"],
		});
		settings.setModelRole("task", "local/missing-model,gpt-4o");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("github-copilot", "test-key");
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "ambiguous-role-models.yml"));
		const parsed = parseArgs(["--model", "task"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");

			const { session } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("github-copilot");
				expect(session.model?.id).toBe("gpt-4o");
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("uses a configured suffixed role fallback when its primary model is unavailable", async () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				slow: ["local/missing-fallback", "local/runtime-fallback-model"],
			},
		});
		settings.setModelRole("slow", "local/missing-model");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("local", "test-key");
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "missing-role-models.yml"));
		const parsed = parseArgs(["--model", "slow:low"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.modelPattern).toBe("slow:low");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("local");
				expect(session.model?.id).toBe("runtime-fallback-model");
				// `low` differs from the fallback model's default (`high`), so this
				// proves the suffix is inherited rather than the model default applied.
				expect(session.thinkingLevel).toBe(Effort.Low);
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("uses the configured default fallback before an arbitrary authenticated model", async () => {
		const settings = Settings.isolated({
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: ["local/runtime-fallback-model"],
			},
		});
		settings.setModelRole("default", "local/missing-model:low");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("local", "test-key");
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "default-fallback-models.yml"));

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-fallback-model");
			expect(session.thinkingLevel).toBe(Effort.Low);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("preserves deferred bare role fallback chains", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "local/runtime-model,local/runtime-fallback-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...buildSessionOptions("task"),
			modelPatternFallbackRole: "subagent:deferred",
			settings,
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("local/runtime-model");
			expect(cfgRetryFallbackChains.get(session.settings)["subagent:deferred"]).toEqual([
				"local/runtime-fallback-model",
			]);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test.each([
		["depleted", "runtime-model"],
		["reserve", "runtime-m"],
	] as const)("resolves the source selector when skipping a %s startup model", async (state, pattern) => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", `${pattern},local/runtime-fallback-model`);
		const options = buildSessionOptions("task");
		vi.spyOn(options.authStorage.health, "model").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? { state, accounts: [{ credentialId: 1, credentialType: "oauth", state }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session, modelFallbackMessage } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware",
			settings,
			hasUI: false,
		});
		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-fallback-model");
			expect(modelFallbackMessage).toContain("local/runtime-model -> local/runtime-fallback-model");
			expect(modelFallbackMessage).toMatch(/preflight/i);
			expect(modelFallbackMessage).toMatch(/no request.*source model/i);
		} finally {
			await session.dispose();
		}
	});

	test("rejects a depleted terminal fallback after startup skips the primary", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "local/runtime-model,local/runtime-fallback-model");
		const options = buildSessionOptions("task");
		const usageHealth = vi.spyOn(options.authStorage.health, "model").mockResolvedValue({
			state: "depleted",
			accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }],
		});

		const { session, modelFallbackMessage } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware-terminal",
			settings,
			hasUI: false,
		});
		try {
			expect(usageHealth).toHaveBeenCalledTimes(2);
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toContain("not found");
		} finally {
			await session.dispose();
		}
	});

	test("defers ACP reserve fallback until prompt-time capabilities are configured", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "local/runtime-model,local/runtime-fallback-model");
		const options = buildSessionOptions("task");
		vi.spyOn(options.authStorage.health, "model").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware-acp",
			settings,
			hasUI: false,
			deferUsageReserveConfirmation: true,
		});
		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("enforces fail-closed reserve policy without requiring a fallback candidate", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		const options = buildSessionOptions("local/runtime-model");
		vi.spyOn(options.authStorage.health, "model").mockResolvedValue({
			state: "reserve",
			accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
		});

		await expect(
			createAgentSession({
				...options,
				settings,
				hasUI: false,
			}),
		).rejects.toThrow("reserve policy is fail-closed");
	});

	test("installs fallback chain for remaining deferred subagent modelPattern candidates", async () => {
		const { session } = await createAgentSession({
			...buildSessionOptions(["local/runtime-model", "local/runtime-fallback-model"]),
			modelPatternFallbackRole: "subagent:deferred",
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("local/runtime-model");
			expect(cfgRetryFallbackChains.get(session.settings)["subagent:deferred"]).toEqual([
				"local/runtime-fallback-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("installs an inherited fallback chain for a deferred singleton modelPattern", async () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["local/runtime-fallback-model"],
			},
		});
		settings.setModelRole("default", "local/runtime-fallback-model");
		const { session } = await createAgentSession({
			...buildSessionOptions("local/runtime-model"),
			settings,
			modelPatternFallbackRole: "subagent:deferred-default",
			modelPatternDefaultFallbackChain: ["local/runtime-fallback-model"],
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred-default")).toBe("local/runtime-model");
			expect(cfgRetryFallbackChains.get(session.settings)["subagent:deferred-default"]).toEqual([
				"local/runtime-fallback-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("keeps an explicitly empty inherited chain empty for a deferred singleton sharing the default model", async () => {
		const primary = "local/runtime-model";
		const fallback = "local/runtime-fallback-model";
		const role = "subagent:deferred-empty";
		const ownerSettings = () => {
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [fallback] } });
			settings.setModelRole("default", primary);
			return settings;
		};
		// Live chain lookup on the primary: the persisted role must win over `default`, which shares the model.
		const chainFor = (session: AgentSession) => {
			const recovery = new TurnRecovery({
				model: () => session.model,
				thinkingLevel: () => undefined,
				sessionManager: session.sessionManager,
				settings: session.settings,
				modelRegistry: session.modelRegistry,
				configWarnings: [],
			} as unknown as TurnRecoveryHost);
			const keys = recovery.retryFallbackChainKeys(primary);
			const candidates = keys.flatMap(key =>
				recovery.findRetryFallbackCandidates(key, primary).map(candidate => candidate.raw),
			);
			return { keys, candidates };
		};
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const { session } = await createAgentSession({
			...buildSessionOptions(primary),
			settings: ownerSettings(),
			sessionManager,
			modelPatternFallbackRole: role,
			modelPatternDefaultFallbackChain: [],
		});

		let retryFallback: RetryFallbackRole | undefined;
		try {
			expect(chainFor(session)).toEqual({ keys: [role], candidates: [] });

			// A runtime fallback answers; resume must still restore the primary as the default.
			session.sessionManager.appendModelChange(fallback, EPHEMERAL_MODEL_CHANGE_ROLE, true);
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "local-inference",
				provider: "local",
				model: "runtime-fallback-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const context = session.sessionManager.buildSessionContext();
			expect(getRestorableSessionModels(context.models, session.sessionManager.getLastModelChangeRole())).toEqual([
				primary,
			]);

			// Switching back to the primary is temporary too; the role's empty chain must still own it.
			session.sessionManager.appendModelChange(primary, EPHEMERAL_MODEL_CHANGE_ROLE);
			expect(chainFor(session)).toEqual({ keys: [role], candidates: [] });
			retryFallback = getRetryFallbackRole(session.settings, role);
		} finally {
			await session.dispose();
		}
		if (!retryFallback) throw new Error("Expected the deferred role's retry fallback");

		// Cold revival reopens the transcript and reinstalls the persisted role before resuming.
		const reviveSettings = ownerSettings();
		installRetryFallbackRole(reviveSettings, role, retryFallback);
		const { session: revived } = await createAgentSession({
			...buildSessionOptions(primary),
			settings: reviveSettings,
			sessionManager: await SessionManager.open(sessionFile, undefined, undefined, { throwIfMissing: true }),
		});
		try {
			expect(`${revived.model?.provider}/${revived.model?.id}`).toBe(primary);
			expect(chainFor(revived)).toEqual({ keys: [role], candidates: [] });
		} finally {
			await revived.dispose();
		}
	});

	test("splits deferred comma-delimited modelPattern and installs fallback chain", async () => {
		const { session } = await createAgentSession({
			...buildSessionOptions("local/runtime-model,local/runtime-fallback-model"),
			modelPatternFallbackRole: "subagent:deferred",
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("local/runtime-model");
			expect(cfgRetryFallbackChains.get(session.settings)["subagent:deferred"]).toEqual([
				"local/runtime-fallback-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("does not apply default role thinking override when modelPattern is explicit", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Low });
		settings.setModelRole("smol", "github-copilot/gpt-5.4");
		settings.setModelRole("default", "@smol:high");

		const { session } = await createAgentSession({
			...buildResumeOptions(),
			sessionManager: SessionManager.inMemory(),
			modelPattern: "github-copilot/gpt-5.4",
			settings,
		});

		try {
			expect(session.model?.provider).toBe("github-copilot");
			expect(session.model?.id).toBe("gpt-5.4");
			expect(session.thinkingLevel).toBe(Effort.Low);
		} finally {
			await session.dispose();
		}
	});

	test("clamps a max default thinking level to the model's ladder ceiling", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "max" });

		const { session } = await createAgentSession({
			...buildResumeOptions(),
			sessionManager: SessionManager.inMemory(),
			modelPattern: "github-copilot/gpt-5.4",
			settings,
		});

		try {
			expect(session.model?.provider).toBe("github-copilot");
			expect(session.model?.id).toBe("gpt-5.4");
			// Copilot's GPT-5.4 KDL ladder ends at xhigh.
			expect(session.thinkingLevel).toBe(Effort.XHigh);
		} finally {
			await session.dispose();
		}
	});

	test.each(["pending", "failed"])(
		"selects the settings default model without waiting for %s usage prefetch or validating auth",
		async prefetchState => {
			const defaultModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
			if (!defaultModel) {
				throw new Error("Expected bundled github-copilot default model");
			}

			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime(defaultModel.provider, "test-key");
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const settings = Settings.isolated();
			settings.setModelRole("default", `${defaultModel.provider}/${defaultModel.id}`);

			const getApiKeySpy = vi
				.spyOn(modelRegistry, "getApiKey")
				.mockRejectedValue(new Error("settings default model should not validate auth during startup"));
			const pendingPrefetch = Promise.withResolvers<void>();
			const prefetchSpy = vi
				.spyOn(authStorage.keys, "prefetchUsage")
				.mockImplementation(() =>
					prefetchState === "pending"
						? pendingPrefetch.promise
						: Promise.reject(new Error("Usage prefetch unavailable")),
				);

			try {
				const { session } = await createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					authStorage,
					modelRegistry,
					settings,
					sessionManager: SessionManager.inMemory(),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					rules: [],
					preloadedCustomToolPaths: [],
					toolNames: ["read"],
				});

				try {
					expect(session.model?.provider).toBe(defaultModel.provider);
					expect(session.model?.id).toBe(defaultModel.id);
					expect(getApiKeySpy).not.toHaveBeenCalled();
					expect(prefetchSpy).toHaveBeenCalledWith(defaultModel.provider, session.sessionId, {
						baseUrl: defaultModel.baseUrl,
						modelId: defaultModel.id,
						accountIds: undefined,
					});
				} finally {
					await session.dispose();
				}
			} finally {
				pendingPrefetch.resolve();
				prefetchSpy.mockRestore();
				getApiKeySpy.mockRestore();
				authStorage.close();
			}
		},
	);

	test.each([
		// Not in the catalog at all.
		["github-copilot/claude-sonnet-9-9", "not found"],
		// Bundled, but deliberately outside the enabled scope.
		["github-copilot/gpt-4o", "is unavailable (no credentials, or not in enabledModels)"],
	] as const)(
		"names a configured default %s that does not resolve instead of switching silently",
		async (configured, reason) => {
			const authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("github-copilot", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const settings = Settings.isolated({ enabledModels: ["github-copilot/claude-sonnet-4.5"] });
			settings.setModelRole("default", configured);

			try {
				const { session, modelFallbackMessage } = await createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					authStorage,
					modelRegistry,
					settings,
					sessionManager: SessionManager.inMemory(),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					rules: [],
					preloadedCustomToolPaths: [],
					toolNames: ["read"],
				});

				try {
					expect(session.model).toBeDefined();
					expect(modelFallbackMessage).toContain(`Default model ${configured} ${reason}`);
					expect(modelFallbackMessage).toContain(`${session.model?.provider}/${session.model?.id}`);
				} finally {
					await session.dispose();
				}
			} finally {
				authStorage.close();
			}
		},
	);

	test("restores the saved session model without resolving auth over the network", async () => {
		// Regression: `restoreSessionModel` probed each saved-model candidate with
		// the async `getApiKey`, which refreshes OAuth tokens and hits the auth
		// broker. When the broker was unreachable that blocked resume for the full
		// ~10s refresh timeout — the "Still starting … restoreSessionModel" hang.
		// Selection now uses the synchronous, side-effect-free `hasConfiguredAuth`
		// probe; the real key is resolved lazily per request via the resolver.
		const savedModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!savedModel) {
			throw new Error("Expected bundled github-copilot default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime(savedModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-saved-model.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-saved", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${savedModel.provider}/${savedModel.id}`,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "resume-saved-sessions"));

		// A rejecting getApiKey stands in for the unreachable broker / hanging
		// OAuth refresh: if startup awaits it to pick the restore model, it surfaces.
		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("startup model restore must not resolve auth over the network"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				sessionManager,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe(savedModel.provider);
				expect(session.model?.id).toBe(savedModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
		}
	});

	function buildResumeOptions() {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("github-copilot", "test-key");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("local/missing-model");
		return {
			...buildSessionOptions(""),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			sessionManager,
			settings: Settings.isolated({ modelRoles: { default: "github-copilot/claude-sonnet-4.5" } }),
			extensions: [],
		};
	}

	test("rejects a headless resume instead of substituting the settings default", async () => {
		await expect(createAgentSession(buildResumeOptions())).rejects.toThrow(
			"Could not restore model local/missing-model",
		);
	});

	test("rejects a headless resume instead of selecting the first available model", async () => {
		await expect(createAgentSession({ ...buildResumeOptions(), settings: Settings.isolated() })).rejects.toThrow(
			"Could not restore model local/missing-model",
		);
	});

	test("rejects an interactive resume when retry model fallback is disabled", async () => {
		await expect(
			createAgentSession({
				...buildResumeOptions(),
				hasUI: true,
				settings: Settings.isolated({
					modelRoles: { default: "github-copilot/claude-sonnet-4.5" },
					retry: { modelFallback: false },
				}),
			}),
		).rejects.toThrow("Could not restore model local/missing-model");
	});

	test("rejects a resume when tool UI is available but startup fallback warnings are not", async () => {
		await expect(
			createAgentSession({ ...buildResumeOptions(), hasUI: true, allowSessionModelFallback: false }),
		).rejects.toThrow("Could not restore model local/missing-model");
	});

	test("keeps the fallback warning and settings default for interactive resume", async () => {
		const { session, modelFallbackMessage } = await createAgentSession({ ...buildResumeOptions(), hasUI: true });
		try {
			expect(session.model?.provider).toBe("github-copilot");
			expect(session.model?.id).toBe("claude-sonnet-4.5");
			expect(modelFallbackMessage).toContain("Could not restore model local/missing-model");
		} finally {
			await session.dispose();
		}
	});

	test("keeps the restore failure when the settings default is also stale on interactive resume", async () => {
		const { session, modelFallbackMessage } = await createAgentSession({
			...buildResumeOptions(),
			hasUI: true,
			settings: Settings.isolated({ modelRoles: { default: "github-copilot/claude-sonnet-9-9" } }),
		});
		try {
			expect(session.model).toBeDefined();
			expect(modelFallbackMessage).toContain("Could not restore model local/missing-model");
			expect(modelFallbackMessage).toContain("Default model github-copilot/claude-sonnet-9-9 not found");
		} finally {
			await session.dispose();
		}
	});

	test.each(["model", "modelPattern"] as const)(
		"honors an explicit %s instead of a saved removed-provider model",
		async selection => {
			const options = buildResumeOptions();
			options.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
			const model = options.modelRegistry.find("github-copilot", "claude-sonnet-4.5");
			if (!model) throw new Error("Expected bundled github-copilot default model");
			const { session, modelFallbackMessage } = await createAgentSession({
				...options,
				...(selection === "model" ? { model } : { modelPattern: "github-copilot/claude-sonnet-4.5" }),
			});
			try {
				expect(session.model?.provider).toBe("github-copilot");
				expect(session.model?.id).toBe("claude-sonnet-4.5");
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		},
	);

	test("restores an extension-discovered session model before rejecting headless resume", async () => {
		const options = buildResumeOptions();
		options.sessionManager.appendModelChange("local/cached-runtime-model");
		const discoveryStarted = Promise.withResolvers<void>();
		const finishDiscovery = Promise.withResolvers<void>();
		const extension: ExtensionFactory = pi => {
			pi.registerProvider("local", {
				...dynamicOnlyProviderConfig,
				fetchDynamicModels: async context => {
					discoveryStarted.resolve();
					await finishDiscovery.promise;
					return dynamicOnlyProviderConfig.fetchDynamicModels!(context);
				},
			});
		};
		const startup = createAgentSession({ ...options, extensions: [extension] });
		await discoveryStarted.promise;
		finishDiscovery.resolve();
		const { session, modelFallbackMessage } = await startup;
		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("cached-runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	/** A fresh persisted session on the settings default, ready to switch at runtime. */
	function buildSwitchOptions() {
		return {
			...buildResumeOptions(),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "sessions")),
		};
	}

	/** A session file whose only saved model is `model`, holding one user turn. */
	async function writeSavedModelSession(model: string): Promise<string> {
		const sessionFile = path.join(tempDir, `saved-${Snowflake.next()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: `saved-${Snowflake.next()}`, timestamp, cwd: tempDir },
				{ type: "model_change", id: "model", parentId: null, timestamp, model, role: "default" },
				{
					type: "message",
					id: "user",
					parentId: "model",
					timestamp,
					message: { role: "user", content: "Remember ZEBRA-42.", timestamp: Date.parse(timestamp) },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	test.each([
		["headless", {}],
		["tool-UI-only", { hasUI: true, allowSessionModelFallback: false }],
		[
			"retry-fallback-disabled UI",
			{
				hasUI: true,
				settings: Settings.isolated({
					modelRoles: { default: "github-copilot/claude-sonnet-4.5" },
					retry: { modelFallback: false },
				}),
			},
		],
	] as const)("keeps a %s session when switching to one whose saved model is unavailable", async (_host, host) => {
		const { session } = await createAgentSession({ ...buildSwitchOptions(), ...host });
		try {
			const previousFile = session.sessionFile;
			const target = await writeSavedModelSession("local/missing-model");
			await expect(session.switchSession(target)).rejects.toThrow("Could not restore model local/missing-model");
			expect(session.sessionFile).toBe(previousFile);
			expect(session.messages).toEqual([]);
			expect(session.model?.id).toBe("claude-sonnet-4.5");
		} finally {
			await session.dispose();
		}
	});

	test("switches a UI session to an unavailable saved model with a restore warning", async () => {
		const { session } = await createAgentSession({ ...buildSwitchOptions(), hasUI: true });
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(`${event.level}: ${event.message}`);
		});
		try {
			const target = await writeSavedModelSession("local/missing-model");
			await expect(session.switchSession(target)).resolves.toBe(true);
			expect(session.sessionFile).toBe(target);
			expect(session.model?.id).toBe("claude-sonnet-4.5");
			const warning = "Could not restore model local/missing-model. Using github-copilot/claude-sonnet-4.5";
			expect(notices).toEqual([`warning: ${warning}`]);

			// A host that re-renders after switching takes the warning itself.
			const reported: string[] = [];
			const next = await writeSavedModelSession("local/missing-model");
			await session.switchSession(next, { onModelFallback: message => reported.push(message) });
			expect(reported).toEqual([warning]);
			expect(notices).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	});

	test("restores an extension-discovered model when switching before discovery ran", async () => {
		// UI startup defers runtime discovery until after the first paint, so
		// `/resume` can run before the provider's models exist in the registry.
		const { session } = await createAgentSession({
			...buildSwitchOptions(),
			hasUI: true,
			extensions: [dynamicOnlyProviderExtension],
		});
		try {
			const target = await writeSavedModelSession("local/cached-runtime-model");
			await expect(session.switchSession(target)).resolves.toBe(true);
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("cached-runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test.each(["anthropic/claude-sonnet-4-5", "custom-provider/claude-sonnet-4-5", "github-copilot/claude-sonnet-4.5"])(
		"binds an explicit switch model over saved %s and restores it on the next switch",
		async savedSelector => {
			const { session } = await createAgentSession(buildSwitchOptions());
			try {
				const settingsDefault = session.modelRegistry.find("github-copilot", "claude-sonnet-4.5");
				const explicit = session.modelRegistry.find("github-copilot", "claude-sonnet-4.6");
				if (!settingsDefault || !explicit) throw new Error("Expected bundled github-copilot Sonnet models");
				const target = await writeSavedModelSession(savedSelector);
				await expect(session.switchSession(target, { model: explicit })).resolves.toBe(true);
				expect(session.model?.id).toBe("claude-sonnet-4.6");

				// The target recorded the explicit model, so a later switch restores it.
				await session.newSession();
				await session.setModel(settingsDefault);
				await expect(session.switchSession(target)).resolves.toBe(true);
				expect(session.model?.id).toBe("claude-sonnet-4.6");
			} finally {
				await session.dispose();
			}
		},
	);

	test("does not record a redundant explicit switch model over the same saved thinking-suffixed model", async () => {
		const { session } = await createAgentSession(buildSwitchOptions());
		try {
			const explicit = session.modelRegistry.find("github-copilot", "claude-sonnet-4.6");
			if (!explicit) throw new Error("Expected bundled Copilot Sonnet model");
			const target = await writeSavedModelSession("github-copilot/claude-sonnet-4.6:high");
			await expect(session.switchSession(target, { model: explicit })).resolves.toBe(true);
			expect(session.model).toEqual(explicit);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	});

	test("restores a discovery-backed session model instead of falling back to the default role", async () => {
		// Saved model discovery must complete before resume can choose a default role.
		const defaultModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!defaultModel) {
			throw new Error("Expected bundled github-copilot default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// A resolvable default role gives the buggy path a concrete model to wrongly
		// fall back to (mirrors a real config with Claude as the default role).
		authStorage.keys.setRuntime(defaultModel.provider, "test-key");

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const fetchModels = vi.fn(dynamicOnlyProviderConfig.fetchDynamicModels!);
		modelRegistry.registerProvider("local", { ...dynamicOnlyProviderConfig, fetchDynamicModels: fetchModels });

		const targetSessionFile = path.join(tempDir, "resume-discovery-model.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-discovery", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "dynamic-model-change",
					parentId: null,
					timestamp,
					model: "local/cached-runtime-model",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(
			targetSessionFile,
			path.join(tempDir, "resume-discovery-sessions"),
		);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated({ modelRoles: { default: `${defaultModel.provider}/${defaultModel.id}` } }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(fetchModels).toHaveBeenCalled();
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("cached-runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("prefers the provider default over catalog order in the startup fallback", async () => {
		// No configured role: startup must prefer the provider default over catalog order.
		const providerDefault = getBundledModel("github-copilot", DEFAULT_MODEL_PER_PROVIDER["github-copilot"]);
		const catalogFirst = getBundledModels("github-copilot")[0];
		if (!providerDefault || !catalogFirst) {
			throw new Error("Expected bundled github-copilot models for fallback regression");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("github-copilot", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		// No `default` model role configured: forces the step-4 startup fallback.
		const settings = Settings.isolated({ enabledModels: ["github-copilot/*"] });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("github-copilot");
			expect(session.model?.id).toBe(providerDefault.id);
			expect(session.model?.id).not.toBe(catalogFirst.id);
		} finally {
			await session.dispose();
		}
	});

	test("resolves the default thinking level against the startup fallback model", async () => {
		const fallbackModel = getBundledModel("github-copilot", "gpt-4o");
		if (!fallbackModel || fallbackModel.reasoning) {
			throw new Error("Expected bundled non-reasoning Copilot model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("github-copilot", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ enabledModels: ["github-copilot/gpt-4o"], defaultThinkingLevel: Effort.High }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("github-copilot");
			expect(session.model?.id).toBe("gpt-4o");
			expect(session.thinkingLevel).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("loads model overrides from the supplied agent directory", async () => {
		await Bun.write(
			path.join(tempDir, "models.yml"),
			[
				"providers:",
				"  github-copilot:",
				"    modelOverrides:",
				"      gpt-4o:",
				"        contextWindow: 123456",
			].join("\n"),
		);
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("github-copilot", "copilot-test-key");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "github-copilot/gpt-4o",
		});

		try {
			expect(session.model?.provider).toBe("github-copilot");
			expect(session.model?.id).toBe("gpt-4o");
			expect(session.model?.contextWindow).toBe(123_456);
		} finally {
			await session.dispose();
		}
	});

	test("restores role model max selector from extension provider after startup resume", async () => {
		const defaultModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!defaultModel) {
			throw new Error("Expected bundled github-copilot default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-extension.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${defaultModel.provider}/${defaultModel.id}`,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "local/runtime-fallback-model:max",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-fallback-model");
			expect(session.thinkingLevel).toBe(Effort.XHigh);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("restores extension role model when saved default cannot be restored before extensions load", async () => {
		const settingsDefaultModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!settingsDefaultModel) {
			throw new Error("Expected bundled github-copilot default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(settingsDefaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Saved default points at a provider that has no usable credentials. The
		// last active role (`smol`) is supplied by the inline extension and is
		// only resolvable once provider registrations are processed.
		const targetSessionFile = path.join(tempDir, "resume-extension-default-missing.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext-no-default", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "github-copilot/not-available",
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "local/runtime-model",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions-no-default"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${settingsDefaultModel.provider}/${settingsDefaultModel.id}`);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("local");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("resolves the default role to an extension model in enabledModels instead of silently substituting an in-scope provider (issue #6694)", async () => {
		const configuredModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!configuredModel) {
			throw new Error("Expected bundled github-copilot configured model");
		}
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// The extension provider carries an inline apiKey; the "normally
		// configured" provider needs credentials so it lands in the startup scope.
		authStorage.keys.setRuntime(configuredModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "scope-6694-models.yml"));

		const enabledModels = ["local/runtime-model", `${configuredModel.provider}/${configuredModel.id}`];
		const settings = Settings.isolated({ enabledModels });
		settings.setModelRole("default", "local/runtime-model");

		// main.ts resolves the model scope BEFORE extensions register providers,
		// so the extension-registered model is dropped and only the configured
		// provider survives into the startup scope.
		const scopedModels = await resolveModelScope(
			enabledModels,
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.map(scoped => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${configuredModel.provider}/${configuredModel.id}`,
		]);

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parseArgs([]),
				scopedModels,
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);

			const { session } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				// The configured default role names the extension model, which is
				// itself listed in enabledModels. Once extensions register their
				// providers it must win — not be silently replaced by the other
				// in-scope provider's model.
				expect(session.model?.provider).toBe("local");
				expect(session.model?.id).toBe("runtime-model");
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("adds extension models named by enabledModels to the session scope without waiting for background discovery (issue #6694)", async () => {
		const configuredModel = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!configuredModel) {
			throw new Error("Expected bundled github-copilot configured model");
		}
		const configuredSelector = `${configuredModel.provider}/${configuredModel.id}`;
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime(configuredModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "scope-extension-models.yml"));
		const settings = Settings.isolated({ enabledModels: ["local/runtime-*", configuredSelector] });
		const parsed = parseArgs([]);
		const scopeIds = (scope: ReadonlyArray<{ model: { provider: string; id: string } }> | undefined) =>
			scope?.map(scoped => `${scoped.model.provider}/${scoped.model.id}`);

		// main.ts snapshots the scope before extensions register their providers.
		const scopedModels = await resolveScopedModels(parsed, modelRegistry, settings);
		expect(scopeIds(scopedModels)).toEqual([configuredSelector]);

		const cliOptions = await buildCliSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);
		const { session } = await createAgentSession({
			...cliOptions,
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			// The provider is registered now, but the scoped /models list and the
			// Ctrl+P cycle still hold the startup snapshot.
			expect(scopeIds(session.scopedModels)).toEqual([configuredSelector]);

			// A slow catalog refresh is still in flight; the extension models must
			// not wait for it.
			vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockReturnValue(Promise.withResolvers<void>().promise);
			const rebuilt = await rebuildScopedModels(session, parsed, modelRegistry, settings);

			const expected = ["local/runtime-model", "local/runtime-fallback-model", configuredSelector];
			expect(scopeIds(session.scopedModels)).toEqual(expected);
			// main.ts announces the startup scope from the returned list.
			expect(scopeIds(rebuilt)).toEqual(expected);
		} finally {
			await session.dispose();
		}
	});

	test("pins the first CLI --models scoped model even when the saved default role is out of scope", async () => {
		const scopedTarget = getBundledModel("github-copilot", "gpt-4o");
		const savedDefault = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!scopedTarget || !savedDefault) {
			throw new Error("Expected bundled openai and github-copilot models");
		}
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime(scopedTarget.provider, "test-key");
		authStorage.keys.setRuntime(savedDefault.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "cli-scope-models.yml"));
		const settings = Settings.isolated({});
		settings.setModelRole("default", `${savedDefault.provider}/${savedDefault.id}`);

		const parsed = parseArgs(["--models", `${scopedTarget.provider}/${scopedTarget.id}`]);
		const scopedModels = await resolveModelScope(
			parsed.models ?? [],
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.map(scoped => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${scopedTarget.provider}/${scopedTarget.id}`,
		]);

		const cliOptions = await buildCliSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);
		// The issue #6694 deferral must NOT apply to an explicit CLI scope:
		// createAgentSession re-resolves the default role against
		// `settings.enabledModels` only and never sees `--models`, so leaving
		// `options.model` unset would let the saved out-of-scope default
		// silently escape the scope the user just asked for.
		expect(cliOptions.model?.provider).toBe(scopedTarget.provider);
		expect(cliOptions.model?.id).toBe(scopedTarget.id);
	});
});
