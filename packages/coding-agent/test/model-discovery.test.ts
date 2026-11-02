import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl, Model } from "@oh-my-striped-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-striped-pi/pi-ai/providers/openai-completions";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { Effort } from "@oh-my-striped-pi/pi-catalog/effort";
import { writeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-striped-pi/pi-catalog/provider-models";
import type { ModelSpec, OpenAICompat } from "@oh-my-striped-pi/pi-catalog/types";
import {
	discoverModelsByProviderType,
	discoverOpenAIModelsList,
	discoverProxyModels,
	type DiscoveryProviderConfig,
} from "@oh-my-striped-pi/pi-coding-agent/config/model-discovery";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { ProviderDiscoverySchema } from "@oh-my-striped-pi/pi-coding-agent/config/models-config-schema";
import { resetSettingsForTest } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-striped-pi/pi-utils";

const provider = "company";
const baseUrl = "https://inference.company.example/v1";

describe("ModelRegistry runtime discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-test-model-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function writeConfig(url = baseUrl) {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: url,
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
	}

	async function discover(
		data: Record<string, unknown>[],
		discovery: DiscoveryProviderConfig["discovery"] = { type: "openai-models-list" },
	) {
		const config: DiscoveryProviderConfig = { provider, api: "openai-completions", baseUrl, discovery };
		const ctx = {
			fetch: (async input => {
				expect(String(input)).toBe(`${baseUrl}/models`);
				return Response.json({ data });
			}) satisfies FetchImpl,
			getBearerApiKeyResolver: async () => undefined,
		};
		return discovery.type === "proxy" ? discoverProxyModels(config, ctx) : discoverOpenAIModelsList(config, ctx);
	}

	for (const strategy of ["online", "online-if-uncached", "offline"] as const) {
		test(`${strategy} discovery only refreshes expired Copilot OAuth when online`, async () => {
			const provider = "github-copilot";
			authStorage.close();
			let refreshCalls = 0;
			authStorage = await AuthStorage.create(":memory:", {
				refreshOAuthCredential: async (_provider, _credentialId, credential) => {
					refreshCalls++;
					return { ...credential, access: "fresh-copilot-token", expires: Date.now() + 3_600_000 };
				},
			});
			await authStorage.credentials.set(provider, {
				type: "oauth",
				access: "expired-copilot-token",
				refresh: "copilot-refresh",
				expires: Date.now() - 60_000,
			});
			fs.writeFileSync(
				modelsJsonPath,
				JSON.stringify({
					providers: {
						[provider]: { baseUrl, api: "openai-completions", discovery: { type: "openai-models-list" } },
					},
				}),
			);
			let fetchCalls = 0;
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: async input => {
					expect(String(input)).toBe(`${baseUrl}/models`);
					fetchCalls++;
					return Response.json({ data: [{ id: "oauth-discovered-model" }] });
				},
			});
			await registry.refreshProvider(provider, strategy);
			expect(refreshCalls).toBe(strategy === "offline" ? 0 : 1);
			expect(fetchCalls).toBe(strategy === "offline" ? 0 : 1);
			expect(registry.find(provider, "oauth-discovered-model") !== undefined).toBe(strategy !== "offline");
		});
	}

	test("scoped discovery coalesces with an in-flight background refresh", async () => {
		writeConfig();
		const response = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		let calls = 0;
		const fetchMock: FetchImpl = async input => {
			if (String(input) !== `${baseUrl}/models`) return new Response("", { status: 404 });
			calls++;
			started.resolve();
			return response.promise;
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		registry.refreshInBackground();
		await started.promise;
		const scoped = registry.refreshDiscoverableProviders([provider], "online-if-uncached");
		expect(calls).toBe(1);
		response.resolve(Response.json({ data: [{ id: "dynamic-model", context_length: 65_536 }] }));
		await Promise.all([scoped, registry.awaitBackgroundRefresh()]);
		expect(calls).toBe(1);
		expect(registry.find(provider, "dynamic-model")?.contextWindow).toBe(65_536);
	});

	test("does not apply in-flight discovery after provider configuration changes", async () => {
		writeConfig();
		const response = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		let newCalls = 0;
		const fetchMock: FetchImpl = async input => {
			if (String(input) === `${baseUrl}/models`) {
				started.resolve();
				return response.promise;
			}
			if (String(input) === "https://new-inference.company.example/v1/models") {
				newCalls++;
				return Response.json({ data: [{ id: "new-model" }] });
			}
			return new Response("", { status: 404 });
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		registry.refreshInBackground();
		await started.promise;
		const previousMtime = fs.statSync(modelsJsonPath).mtimeMs;
		writeConfig("https://new-inference.company.example/v1");
		const changedTime = new Date(previousMtime + 1_000);
		fs.utimesSync(modelsJsonPath, changedTime, changedTime);
		const refreshed = registry.refresh("online-if-uncached");
		response.resolve(Response.json({ data: [{ id: "old-model" }] }));
		await Promise.all([refreshed, registry.awaitBackgroundRefresh()]);
		expect(newCalls).toBe(1);
		expect(registry.find(provider, "new-model")).toBeDefined();
		expect(registry.find(provider, "old-model")).toBeUndefined();
	});

	test("refreshIfStale rebuilds only after models config changes on disk", async () => {
		const writeModels = (ids: string[]) =>
			fs.writeFileSync(
				modelsJsonPath,
				JSON.stringify({
					providers: {
						[provider]: {
							baseUrl,
							api: "openai-completions",
							auth: "none",
							models: ids.map(id => ({ id, reasoning: false, input: ["text"] })),
						},
					},
				}),
			);
		writeModels(["first-model"]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(await registry.refreshIfStale()).toBe(false);
		const previousMtime = fs.statSync(modelsJsonPath).mtimeMs;
		writeModels(["first-model", "added-model"]);
		const changedTime = new Date(previousMtime + 1_000);
		fs.utimesSync(modelsJsonPath, changedTime, changedTime);
		expect(registry.find(provider, "added-model")).toBeUndefined();
		expect(await registry.refreshIfStale()).toBe(true);
		expect(registry.find(provider, "added-model")).toBeDefined();
		expect(await registry.refreshIfStale()).toBe(false);
	});

	test("discovers explicitly configured company providers without borrowing Copilot identity", async () => {
		for (const provider of ["ollama", "llama.cpp", "lm-studio", "litellm", "company"]) {
			for (const probe of [discoverModelsByProviderType, discoverOpenAIModelsList, discoverProxyModels]) {
				const models = await probe(
					{ provider, api: "openai-completions", baseUrl, discovery: { type: "openai-models-list" } },
					{
						fetch: async () => Response.json({ data: [{ id: "private-model" }] }),
						getBearerApiKeyResolver: async () => undefined,
					},
				);
				expect(models.map(model => model.provider)).toEqual([provider]);
			}
		}
	});

	test("rejects non-HTTP and mismatched discovery APIs before resolving credentials or fetching", async () => {
		for (const config of [
			{ provider: "local", api: "local-inference" },
			{ provider: "local", api: "openai-completions" },
			{ provider: "github-copilot", api: "local-inference" },
		]) {
			let authCalls = 0;
			let fetchCalls = 0;
			for (const probe of [discoverModelsByProviderType, discoverOpenAIModelsList, discoverProxyModels]) {
				await expect(
					Promise.resolve().then(() =>
						probe(
							{ ...config, baseUrl, discovery: { type: "openai-models-list" } },
							{
								fetch: async () => {
									fetchCalls++;
									return Response.json({ data: [] });
								},
								getBearerApiKeyResolver: async () => {
									authCalls++;
									return undefined;
								},
							},
						),
					),
				).rejects.toThrow(/Unsupported API|does not support HTTP discovery/);
			}
			expect(authCalls).toBe(0);
			expect(fetchCalls).toBe(0);
		}
	});

	test("requires an explicit discovery URL before resolving auth or fetching", async () => {
		for (const discovery of [
			{ type: "openai-models-list" as const },
			{ type: "openai-models-list" as const, injectV1: false },
			{ type: "proxy" as const },
		]) {
			let authCalls = 0;
			let fetchCalls = 0;
			await expect(
				discoverModelsByProviderType(
					{ provider, api: "openai-completions", discovery },
					{
						fetch: async () => {
							fetchCalls++;
							return Response.json({ data: [] });
						},
						getBearerApiKeyResolver: async () => {
							authCalls++;
							return undefined;
						},
					},
				),
			).rejects.toThrow(/requires a baseUrl/);
			expect(authCalls).toBe(0);
			expect(fetchCalls).toBe(0);
		}
	});

	test("rejects local HTTP discovery and Copilot discovery without a URL before installing credentials", () => {
		for (const [id, config, error] of [
			["local", { baseUrl, discovery: { type: "openai-models-list" } }, /does not support HTTP discovery/],
			["github-copilot", { discovery: { type: "openai-models-list" } }, /baseUrl.*required/],
		] as const) {
			fs.writeFileSync(
				modelsJsonPath,
				JSON.stringify({
					providers: {
						[id]: { ...config, apiKey: "must-not-install", api: "openai-completions" },
					},
				}),
			);
			const source = authStorage.keys.source(id);
			let fetchCalls = 0;
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: async () => {
					fetchCalls++;
					return Response.json({ data: [] });
				},
			});
			expect(String(registry.getError())).toMatch(error);
			expect(authStorage.keys.source(id)).toEqual(source);
			expect(fetchCalls).toBe(0);
		}
	});

	test("discovers explicitly configured self-hosted environment endpoints", async () => {
		const aliases = ["OLLAMA_BASE_URL", "LM_STUDIO_BASE_URL", "LLAMA_CPP_BASE_URL", "LITELLM_BASE_URL"];
		const saved = new Map(aliases.map(name => [name, process.env[name]]));
		const requested: string[] = [];
		try {
			for (const name of aliases) process.env[name] = "https://inference.company.example";
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: async input => {
					requested.push(String(input));
					return new Response("", { status: 404 });
				},
			});
			await registry.refresh();
			expect(requested.some(url => url.startsWith("https://inference.company.example"))).toBe(true);
			expect(registry.getDiscoverableProviders()).toEqual(
				expect.arrayContaining(["ollama", "llama.cpp", "lm-studio"]),
			);
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	test("accepts self-hosted discovery modes and validates their options", () => {
		for (const type of ["openai-models-list", "proxy"]) {
			expect(ProviderDiscoverySchema.allows({ type, timeoutMs: 30_000, advertisedReasoning: false })).toBe(true);
			for (const timeoutMs of [-500, 0, "30000"])
				expect(ProviderDiscoverySchema.allows({ type, timeoutMs })).toBe(false);
		}
		for (const type of ["ollama", "llama.cpp", "lm-studio", "apple-foundation-models", "litellm"])
			expect(ProviderDiscoverySchema.allows({ type })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "openai-models-list", injectV1: false })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "proxy", injectV1: false })).toBe(false);
	});

	test("honors advertised context and independent output limit precedence", async () => {
		const models = await discover([
			{ id: "context", context_length: 100_000, limits: { max_input_tokens: 922_000, max_output_tokens: 128_000 } },
			{ id: "nested", limits: { max_input_tokens: 922_000, max_output_tokens: 128_000 } },
			{ id: "top-provider", top_provider: { context_length: 1_048_576, max_completion_tokens: 32_768 } },
			{ id: "nested-wins", max_tokens: 65_536, limits: { max_output_tokens: 16_000 } },
			{ id: "flat-cap", context_length: 8_192, max_tokens: 65_536 },
			{ id: "flat-output", max_output_tokens: 384_000, context_length: 1_000_000 },
			{ id: "flat-completion", max_completion_tokens: 8_192 },
			{ id: "independent-output", limits: { max_input_tokens: "invalid", max_output_tokens: 64_000 } },
			{ id: "overflow", limits: { max_input_tokens: Number.MAX_SAFE_INTEGER, max_output_tokens: 32_768 } },
			{ id: "no-limits" },
		]);
		const byId = new Map(models.map(model => [model.id, model]));
		expect(byId.get("context")).toMatchObject({ contextWindow: 100_000, maxTokens: 100_000 });
		expect(byId.get("nested")).toMatchObject({ contextWindow: 1_050_000, maxTokens: 128_000 });
		expect(byId.get("top-provider")).toMatchObject({ contextWindow: 1_048_576, maxTokens: 32_768 });
		expect(byId.get("nested-wins")?.maxTokens).toBe(16_000);
		expect(byId.get("flat-cap")?.maxTokens).toBe(8_192);
		expect(byId.get("flat-output")?.maxTokens).toBe(384_000);
		expect(byId.get("flat-completion")?.maxTokens).toBe(8_192);
		expect(byId.get("independent-output")).toMatchObject({ contextWindow: 128_000, maxTokens: 64_000 });
		for (const id of ["overflow", "no-limits"])
			expect(byId.get(id)).toMatchObject({ contextWindow: 128_000, maxTokens: 32_768 });
	});

	test("unusable nested output limits do not suppress usable flat limits", async () => {
		for (const invalid of [1.5, 1e30, 0, -1, "invalid", null, [65_536]]) {
			const [model] = await discover([
				{ id: "invalid-nested", max_tokens: 65_536, limits: { max_output_tokens: invalid } },
			]);
			expect(model?.maxTokens).toBe(65_536);
		}
	});

	test("usable nested limits outrank invalid and valid flat limits", async () => {
		for (const flat of ["invalid", 1.5, 0, undefined, 65_536]) {
			const [model] = await discover([
				{ id: "nested-output", max_tokens: flat, limits: { max_output_tokens: 32_768 } },
			]);
			expect(model?.maxTokens).toBe(32_768);
		}
	});

	test("enriches thin rows from the retained bundled catalog without borrowing prices", async () => {
		const reference = getBundledModel("github-copilot", "gpt-5.6-sol");
		if (!reference) throw new Error("Expected bundled Copilot reference");
		const models = await discover([{ id: reference.id }, { id: "unknown-model" }]);
		expect(models[0]).toMatchObject({
			name: reference.name,
			contextWindow: reference.contextWindow,
			maxTokens: reference.maxTokens,
			reasoning: reference.reasoning,
			input: reference.input,
		});
		expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(models[1]).toMatchObject({ contextWindow: 128_000, reasoning: false });
	});

	for (const type of ["openai-models-list", "proxy"] as const) {
		test(`${type} reads input modalities and routes supported non-chat outputs`, async () => {
			const models = await discover(
				[
					{ id: "direct", input: ["text", "image"] },
					{ id: "architecture", architecture: { input_modalities: ["text", "image"] } },
					{ id: "modalities", input_modalities: ["text", "image"] },
					{ id: "text", input: ["text"] },
					{ id: "default" },
					{ id: "embedder", output_modalities: ["embeddings"], context_length: 8192 },
					{ id: "image-generator", output: ["image"] },
					{ id: "audio-generator", output_modalities: ["audio"] },
					{ id: "video-generator", architecture: { output_modalities: ["video"] } },
					{ id: "multimodal-chat", architecture: { output_modalities: ["text", "image"] } },
				],
				{ type },
			);
			const byId = new Map(models.map(model => [model.id, model]));
			for (const id of ["direct", "architecture", "modalities"])
				expect(byId.get(id)?.input).toEqual(["text", "image"]);
			for (const id of ["text", "default"]) expect(byId.get(id)?.input).toEqual(["text"]);
			if (type === "openai-models-list") {
				expect(byId.get("embedder")?.api).toBe("openai-embeddings");
				expect(byId.get("image-generator")?.api).toBe("openai-images");
			} else {
				expect(byId.has("embedder")).toBe(false);
				expect(byId.has("image-generator")).toBe(false);
			}
			for (const id of ["audio-generator", "video-generator"]) expect(byId.has(id)).toBe(false);
			expect(byId.get("multimodal-chat")?.api).toBe("openai-completions");
		});
	}

	test("injectV1 false keeps versioned roots and removes query strings from runtime URLs", async () => {
		const models = await discoverOpenAIModelsList(
			{
				provider,
				api: "openai-completions",
				baseUrl: "https://inference.company.example/v3/compat?token=secret#fragment",
				discovery: { type: "openai-models-list", injectV1: false },
			},
			{
				fetch: async input => {
					expect(String(input)).toBe("https://inference.company.example/v3/compat/models");
					return Response.json({ data: [{ id: "versioned-model" }] });
				},
				getBearerApiKeyResolver: async () => undefined,
			},
		);
		expect(models[0]?.baseUrl).toBe("https://inference.company.example/v3/compat");
	});

	for (const type of ["openai-models-list", "proxy"] as const) {
		test(`${type} honors advertised reasoning with explicit wire compat`, async () => {
			const [model] = await discover(
				[
					{
						id: "acme-think",
						metadata: {
							display_name: "Acme Think",
							context_window: 272_000,
							input_modalities: ["text", "image"],
							supported_reasoning_levels: [
								{ effort: "none" },
								{ effort: "low" },
								{ effort: "high" },
								{ effort: "max" },
								{ effort: "ultra" },
							],
							default_reasoning_level: "high",
						},
					},
				],
				{ type },
			);
			expect(model).toMatchObject({
				name: "Acme Think",
				contextWindow: 272_000,
				input: ["text", "image"],
				reasoning: true,
			});
			expect(model?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model?.thinking?.defaultLevel).toBe(Effort.High);
			expect((model?.compat as OpenAICompat | undefined)?.supportsReasoningEffort).toBe(true);
			if (!model || model.api !== "openai-completions") throw new Error("Expected discovered completions model");
			const wireModel = buildModel({
				...model,
				compat: { ...model.compatConfig, supportsReasoningParams: true },
			});
			let payload: Record<string, unknown> | undefined;
			const fetchMock: FetchImpl = async (_input, init) => {
				payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
				return new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"index":0,"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			const context = { messages: [{ role: "user" as const, content: "OK", timestamp: Date.now() }] };
			await streamOpenAICompletions(wireModel as Model<"openai-completions">, context, {
				apiKey: "TEST_KEY",
				fetch: fetchMock,
				reasoning: "max",
			}).result();
			expect(payload?.reasoning_effort).toBe("max");
			await streamOpenAICompletions(wireModel as Model<"openai-completions">, context, {
				apiKey: "TEST_KEY",
				fetch: fetchMock,
				disableReasoning: true,
			}).result();
			expect(payload?.reasoning_effort).toBe("none");
		});

		test(`${type} honors reasoning denial and advertisedReasoning opt-out`, async () => {
			const [denied] = await discover(
				[{ id: "gpt-5.6-sol", metadata: { reasoning: false, supported_reasoning_levels: ["low"] } }],
				{ type },
			);
			expect(denied?.reasoning).toBe(false);
			expect(denied?.thinking).toBeUndefined();
			const [ignored] = await discover([{ id: "unknown-thinker", supported_reasoning_levels: ["low", "high"] }], {
				type,
				advertisedReasoning: false,
			});
			expect(ignored?.reasoning).toBe(false);
			expect(ignored?.thinking).toBeUndefined();
		});
	}

	test("proxy discovery uses advertised names, context and endpoint routing", async () => {
		const models = await discover(
			[
				{
					id: "anthropic-model",
					name: "Advertised Name",
					supported_endpoint_types: ["anthropic"],
					context_length: 200_000,
				},
				{ id: "openai-model", supported_endpoint_types: ["openai"], context_length: 65_536 },
				{ id: "zero-context", context_length: 0 },
			],
			{ type: "proxy" },
		);
		expect(models[0]).toMatchObject({ name: "Advertised Name", api: "anthropic-messages", contextWindow: 200_000 });
		expect(models[1]).toMatchObject({ api: "openai-completions", contextWindow: 65_536 });
		expect(models[2]?.contextWindow).toBe(128_000);
	});

	test("startup restores a legacy stale-marked Copilot variant via requestModelId", async () => {
		const provider = "github-copilot";
		const bundledBase = getBundledModel(provider, "gpt-5.6-sol");
		if (!bundledBase?.headers) throw new Error("Expected bundled Copilot transport headers");
		const cachedVariant = buildModel({
			...(bundledBase as ModelSpec<"openai-responses">),
			id: "gpt-5.6-sol-1m",
			requestModelId: bundledBase.id,
			contextWindow: 1_050_000,
		});
		authStorage.keys.setRuntime(provider, "ghp_test_token");
		const cacheProviderId = resolveModelCacheProviderId(provider, { apiKey: "ghp_test_token" });
		writeModelCache(cacheProviderId, Date.now(), [cachedVariant], true, "", cacheDbPath);
		const db = new Database(cacheDbPath);
		db.run("UPDATE model_cache SET header_restore_version = 0 WHERE provider_id = ?", [cacheProviderId]);
		db.close();
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.hydrateCredentialScopedModelCaches();
		expect(registry.find(provider, cachedVariant.id)?.headers).toEqual(bundledBase.headers);
	});

	test("repeated cache hydration preserves the catalog with two Copilot accounts", async () => {
		const provider = "github-copilot";
		const bundledBase = getBundledModel(provider, "gpt-5.6-sol");
		if (!bundledBase?.headers) throw new Error("Expected bundled Copilot transport headers");
		const cachedVariant = buildModel({
			...(bundledBase as ModelSpec<"openai-responses">),
			id: "gpt-5.6-sol-1m",
			requestModelId: bundledBase.id,
			contextWindow: 1_050_000,
		});
		const expires = Date.now() + 3_600_000;
		await authStorage.credentials.set(provider, [
			{ type: "oauth", access: "gho_account_a", refresh: "refresh-a", expires },
			{ type: "oauth", access: "gho_account_b", refresh: "refresh-b", expires },
		]);
		const cacheProviderId = resolveModelCacheProviderId(provider, {
			apiKey: JSON.stringify({ token: "gho_account_a" }),
		});
		writeModelCache(cacheProviderId, Date.now(), [cachedVariant], true, "", cacheDbPath, [bundledBase]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.hydrateCredentialScopedModelCaches();
		await registry.hydrateCredentialScopedModelCaches();
		expect(registry.find(provider, cachedVariant.id)?.headers).toEqual(bundledBase.headers);
	});

	test("startup drops a Copilot alias whose headers differ from its bundled base", () => {
		const provider = "github-copilot";
		const bundledBase = getBundledModel(provider, "gpt-5.6-sol");
		if (!bundledBase?.headers) throw new Error("Expected bundled Copilot transport headers");
		const alias = buildModel({
			...(bundledBase as ModelSpec<"openai-responses">),
			id: "gpt-5.6-sol-custom",
			requestModelId: bundledBase.id,
			headers: { "X-Tenant-Route": "tenant-a" },
		});
		writeModelCache(resolveModelCacheProviderId(provider), Date.now(), [alias], true, "", cacheDbPath, [bundledBase]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(registry.find(provider, alias.id)).toBeUndefined();
		expect(registry.find(provider, bundledBase.id)?.headers).toEqual(bundledBase.headers);
	});
});
