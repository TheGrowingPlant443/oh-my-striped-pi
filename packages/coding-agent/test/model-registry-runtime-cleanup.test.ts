import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "@oh-my-striped-pi/pi-ai";
import { getOAuthProvider, unregisterOAuthProviders } from "@oh-my-striped-pi/pi-ai/oauth";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId } from "@oh-my-striped-pi/pi-catalog/provider-models";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-striped-pi/pi-utils";

describe("ModelRegistry runtime source cleanup", () => {
	let authStorage: AuthStorage;

	const sourceId = "ext://runtime-cleanup";
	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "runtime-model",
		name: "Runtime Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearCustomApis();
		unregisterOAuthProviders(sourceId);
		authStorage.close();
	});

	test("clearSourceRegistrations removes runtime overlays and fallback auth for that source", () => {
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("github-copilot", config, sourceId);
		registry.registerProvider("local", { api: "local-inference", streamSimple }, sourceId);

		expect(registry.find("github-copilot", "runtime-model")).toBeDefined();
		expect(registry.authStorage.keys.source("github-copilot") !== undefined).toBe(true);
		expect(getCustomApi("local-inference")?.streamSimple).toBe(streamSimple);

		registry.clearSourceRegistrations(sourceId);

		expect(registry.find("github-copilot", "runtime-model")).toBeUndefined();
		expect(registry.authStorage.keys.source("github-copilot") !== undefined).toBe(false);
		expect(getCustomApi("local-inference")).toBeUndefined();
	});

	test("clearing several sources removes only their overlays and rebuilds the catalog once", () => {
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		registry.registerProvider(
			"github-copilot",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [baseModel],
			},
			sourceId,
		);
		registry.registerProvider(
			"local",
			{
				api: "local-inference",
				models: [{ ...baseModel, id: "kept-model", kind: "tiny" }],
			},
			"ext://kept",
		);
		const clearConfig = vi.spyOn(registry.authStorage.keys, "clearConfig");

		registry.clearSourceRegistrations([sourceId, "ext://empty"]);

		expect(clearConfig).toHaveBeenCalledTimes(1);
		expect(registry.find("github-copilot", "runtime-model")).toBeUndefined();
		expect(registry.find("local", "kept-model")).toBeDefined();
	});

	test("extension rebinding preserves unrelated credential-scoped cached models", async () => {
		using tempDir = TempDir.createSync("@omsp-model-registry-rebind-");
		const provider = "github-copilot";
		const apiKey = "copilot-test-key";
		const cachedModel = buildModel({
			id: "cached-credential-model",
			name: "Cached Credential Model",
			api: "openai-responses",
			provider,
			baseUrl: "https://api.githubcopilot.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		authStorage.keys.setRuntime(provider, apiKey);
		writeModelCache(
			resolveModelCacheProviderId(provider, { apiKey }),
			Date.now(),
			[cachedModel],
			true,
			"",
			tempDir.join("models.db"),
		);
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		await registry.hydrateCredentialScopedModelCaches();
		expect(registry.getAvailable().some(model => model.provider === provider && model.id === cachedModel.id)).toBe(
			true,
		);

		for (let cycle = 0; cycle < 2; cycle += 1) {
			registry.registerProvider(
				"local",
				{
					api: "local-inference",
					models: [{ ...baseModel, kind: "tiny" }],
				},
				sourceId,
			);
			registry.clearSourceRegistrations(sourceId);

			expect(registry.getAvailable().some(model => model.provider === provider && model.id === cachedModel.id)).toBe(
				true,
			);
		}
	});

	test("unloading an override-only extension keeps a built-in provider's hydrated discoveries", async () => {
		using tempDir = TempDir.createSync("@omsp-model-registry-override-only-");
		const provider = "github-copilot";
		const apiKey = "copilot-test-key";
		const cachedModel = buildModel({
			id: "cached-credential-model",
			name: "Cached Credential Model",
			api: "openai-responses",
			provider,
			baseUrl: "https://api.githubcopilot.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		authStorage.keys.setRuntime(provider, apiKey);
		writeModelCache(
			resolveModelCacheProviderId(provider, { apiKey }),
			Date.now(),
			[cachedModel],
			true,
			"",
			tempDir.join("models.db"),
		);
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		await registry.hydrateCredentialScopedModelCaches();
		expect(registry.getAvailable().some(model => model.provider === provider && model.id === cachedModel.id)).toBe(
			true,
		);

		// An extension registers only a transport override for the built-in
		// provider — no models, no fetchDynamicModels manager.
		registry.registerProvider(provider, { baseUrl: "https://gateway.example.com/v1" }, sourceId);
		registry.clearSourceRegistrations(sourceId);

		expect(registry.getAvailable().some(model => model.provider === provider && model.id === cachedModel.id)).toBe(
			true,
		);
	});

	test("extension rebinding discards discoveries removed from the model config", async () => {
		using tempDir = TempDir.createSync("@omsp-model-registry-config-rebind-");
		const modelsPath = tempDir.join("models.json");
		const provider = "github-copilot";
		const baseUrl = "http://127.0.0.1:11435";
		const discoveredModel = { id: "removed-config-model", context_length: 128_000 };
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl,
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () => Response.json({ data: [discoveredModel] }),
		});
		await registry.refreshProvider(provider, "online");
		expect(registry.find(provider, discoveredModel.id)).toBeDefined();
		registry.registerProvider(
			"local",
			{
				api: "local-inference",
				models: [{ ...baseModel, kind: "tiny" }],
			},
			sourceId,
		);

		await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
		registry.clearSourceRegistrations(sourceId);

		expect(registry.find(provider, discoveredModel.id)).toBeUndefined();
	});

	test("extension rebinding discards discoveries whose model overrides changed", async () => {
		using tempDir = TempDir.createSync("@omsp-model-registry-override-rebind-");
		const modelsPath = tempDir.join("models.json");
		const provider = "github-copilot";
		const baseUrl = "http://127.0.0.1:11436";
		const modelId = "override-config-model";
		const discoveredModel = { id: modelId, context_length: 128_000 };
		const writeConfig = (modelOverrides: Record<string, unknown> | undefined) =>
			Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						[provider]: {
							baseUrl,
							api: "openai-completions",
							auth: "none",
							discovery: { type: "openai-models-list" },
							...(modelOverrides ? { modelOverrides } : {}),
						},
					},
				}),
			);
		await writeConfig({ [modelId]: { headers: { "X-Override": "stale" } } });
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () => Response.json({ data: [discoveredModel] }),
		});
		await registry.refreshProvider(provider, "online");
		const configured = registry.find(provider, modelId);
		expect(configured && (await registry.resolveModelHeaders(configured))?.["X-Override"]).toBe("stale");
		registry.registerProvider(
			"local",
			{
				api: "local-inference",
				models: [{ ...baseModel, kind: "tiny" }],
			},
			sourceId,
		);

		// Remove the per-model override, keeping the discovery config identical.
		await writeConfig(undefined);
		registry.clearSourceRegistrations(sourceId);

		const restored = registry.find(provider, modelId);
		expect(restored && (await registry.resolveModelHeaders(restored))?.["X-Override"]).toBeUndefined();
	});

	test("unregisterProvider removes only the named provider and its login entry", () => {
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		registry.registerProvider(
			"company-runtime",
			{
				baseUrl: "https://runtime.company.example/v1",
				apiKey: "RUNTIME_KEY",
				api: "company-cleanup-api",
				streamSimple,
				models: [baseModel],
				oauth: { name: "Company runtime", login: async () => "runtime-token" },
			},
			sourceId,
		);
		registry.registerProvider(
			"company-peer",
			{
				baseUrl: "https://peer.company.example/v1",
				apiKey: "PEER_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: "peer-model" }],
			},
			sourceId,
		);

		expect(getOAuthProvider("company-runtime")).toBeDefined();
		registry.unregisterProvider("company-runtime");

		expect(registry.find("company-runtime", "runtime-model")).toBeUndefined();
		expect(registry.authStorage.keys.source("company-runtime")).toBeUndefined();
		expect(getOAuthProvider("company-runtime")).toBeUndefined();
		expect(registry.find("company-peer", "peer-model")).toBeDefined();
	});
});
