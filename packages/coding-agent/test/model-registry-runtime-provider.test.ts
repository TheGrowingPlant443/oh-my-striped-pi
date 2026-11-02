import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	clearCustomApis,
	Effort,
	type FetchImpl,
	getCustomApi,
	type Model,
} from "@oh-my-striped-pi/pi-ai";
import { getOAuthProviders, unregisterOAuthProviders } from "@oh-my-striped-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-striped-pi/pi-utils";

describe("ModelRegistry runtime provider registration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let fetchRequests: string[];

	const sourceIds = ["ext://oauth"];

	// Stub transport: reject every request so refresh("online") drives the full
	// online discovery path with deterministic, instant failures instead of real
	// network. Provider fetches (dynamic + stencil.so) are caught and swallowed,
	// leaving the registry with its bundled catalog plus runtime overlays.
	const offlineFetch: FetchImpl = input => {
		fetchRequests.push(String(input));
		return Promise.reject(new Error("network disabled in model-registry runtime test"));
	};

	beforeEach(async () => {
		fetchRequests = [];
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
	});

	afterEach(() => {
		vi.useRealTimers();
		clearCustomApis();
		for (const sourceId of sourceIds) unregisterOAuthProviders(sourceId);
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

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

	function getProviderModels(registry: ModelRegistry, providerName: string) {
		return registry.getAll().filter(model => model.provider === providerName);
	}

	async function expectProviderHeader(
		registry: ModelRegistry,
		providerName: string,
		headerName: string,
		expectedValue: string | undefined,
	): Promise<void> {
		for (const model of getProviderModels(registry, providerName)) {
			expect((await registry.resolveModelHeaders(model))?.[headerName]).toBe(expectedValue);
		}
	}

	async function expectProviderHeaderAcrossRefresh(
		registry: ModelRegistry,
		providerName: string,
		headerName: string,
		expectedValue: string | undefined,
	): Promise<void> {
		await expectProviderHeader(registry, providerName, headerName, expectedValue);
		await registry.refresh("offline");
		await expectProviderHeader(registry, providerName, headerName, expectedValue);
		await registry.refreshProvider(providerName, "offline");
		await expectProviderHeader(registry, providerName, headerName, expectedValue);
	}

	async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
		for (let i = 0; i < 1000; i++) {
			if (predicate()) return;
			await Promise.resolve();
		}
		throw new Error(errorMessage);
	}

	async function expectModelTransportAcrossRefresh(
		registry: ModelRegistry,
		providerName: string,
		modelId: string,
		baseUrl: string,
		headerName: string,
		headerValue: string | undefined,
	): Promise<void> {
		const model = registry.find(providerName, modelId);
		expect(model?.baseUrl).toBe(baseUrl);
		expect(model && (await registry.resolveModelHeaders(model))?.[headerName]).toBe(headerValue);
		await registry.refresh("offline");
		const refreshed = registry.find(providerName, modelId);
		expect(refreshed?.baseUrl).toBe(baseUrl);
		expect(refreshed && (await registry.resolveModelHeaders(refreshed))?.[headerName]).toBe(headerValue);
		await registry.refreshProvider(providerName, "offline");
		const providerRefreshed = registry.find(providerName, modelId);
		expect(providerRefreshed?.baseUrl).toBe(baseUrl);
		expect(providerRefreshed && (await registry.resolveModelHeaders(providerRefreshed))?.[headerName]).toBe(
			headerValue,
		);
	}

	test("registers company APIs, OAuth and discovery with source-owned cleanup", async () => {
		const login = vi.fn(async () => "company-key");
		const dynamic = vi.fn(async () => [{ ...baseModel, id: "discovered-company-model" }]);
		registry.registerProvider(
			"company-provider",
			{
				api: "company-api",
				baseUrl: "https://inference.company.example/v1",
				streamSimple,
				oauth: { name: "Company", login },
				fetchDynamicModels: dynamic,
				models: [baseModel],
			},
			"ext://company",
		);
		expect(getCustomApi("company-api")).toBeDefined();
		expect(getOAuthProviders().some(provider => provider.id === "company-provider")).toBe(true);
		expect(login).not.toHaveBeenCalled();
		await registry.refreshRuntimeProviders("online");
		expect(dynamic).toHaveBeenCalled();
		expect(registry.find("company-provider", "discovered-company-model")?.provider).toBe("company-provider");
		registry.clearSourceRegistrations("ext://company");
		expect(getCustomApi("company-api")).toBeUndefined();
		expect(getOAuthProviders().some(provider => provider.id === "company-provider")).toBe(false);
		expect(registry.find("company-provider", "discovered-company-model")).toBeUndefined();
	});

	test("keyless company registration survives reload without a dummy credential", async () => {
		registry.registerProvider(
			"keyless-company",
			{
				api: "openai-completions",
				auth: "none",
				baseUrl: "https://inference.company.example/v1",
				models: [baseModel],
			},
			"ext://keyless",
		);
		for (const refresh of [false, true]) {
			if (refresh) await registry.refresh("offline");
			const model = registry.find("keyless-company", baseModel.id);
			expect(model).toBeDefined();
			expect(registry.hasConfiguredAuth(model!)).toBe(true);
			expect(await registry.getApiKey(model!)).toBe("N/A");
			expect(authStorage.credentials.has("keyless-company")).toBe(false);
		}
		registry.clearSourceRegistrations("ext://keyless");
		expect(registry.find("keyless-company", baseModel.id)).toBeUndefined();
	});

	test("headers-only re-registration keeps a keyless provider keyless", async () => {
		const config = {
			api: "openai-completions" as const,
			auth: "none" as const,
			baseUrl: "https://inference.company.example/v1",
			models: [baseModel],
		};
		registry.registerProvider("keyless-headers", config, "ext://keyless-headers");
		registry.registerProvider("keyless-headers", { headers: { "X-Test": "1" } }, "ext://keyless-headers");
		const model = registry.find("keyless-headers", baseModel.id);
		expect(model).toBeDefined();
		expect(registry.hasConfiguredAuth(model!)).toBe(true);
		registry.clearSourceRegistrations("ext://keyless-headers");
	});

	test("registerProvider applies headers-only overrides to existing provider models across refresh", async () => {
		const providerName = "github-copilot";
		const runtimeHeader = "X-Runtime-Provider-Header";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(providerName, { headers: { [runtimeHeader]: "runtime-header" } }, "ext://runtime");
		await expectProviderHeaderAcrossRefresh(registry, providerName, runtimeHeader, "runtime-header");

		registry.clearSourceRegistrations("ext://runtime");
		await expectProviderHeader(registry, providerName, runtimeHeader, undefined);
	});

	test("registerProvider keeps runtime header objects live for request-time reads", async () => {
		const providerHeaders: Record<string, string> = { "X-Request-ID": "request-1" };
		const modelHeaders: Record<string, string> = { "X-Message-ID": "message-1" };

		registry.registerProvider(
			"github-copilot",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				headers: providerHeaders,
				models: [{ ...baseModel, headers: modelHeaders }],
			},
			"ext://runtime",
		);

		providerHeaders["X-Request-ID"] = "request-2";
		providerHeaders["X-Turn-ID"] = "turn-2";
		modelHeaders["X-Message-ID"] = "message-2";
		modelHeaders["X-Model-Turn-ID"] = "model-turn-2";

		const model = registry.find("github-copilot", "runtime-model");
		if (!model) throw new Error("Expected runtime model");
		expect(await registry.resolveModelHeaders(model)).toEqual({
			"X-Request-ID": "request-2",
			"X-Turn-ID": "turn-2",
			"X-Message-ID": "message-2",
			"X-Model-Turn-ID": "model-turn-2",
		});
	});

	test("registerProvider applies authHeader overrides to existing provider models across refresh", async () => {
		const providerName = "github-copilot";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(providerName, { apiKey: "RUNTIME_AUTH_KEY", authHeader: true }, "ext://runtime");
		await expectProviderHeaderAcrossRefresh(registry, providerName, "Authorization", "Bearer RUNTIME_AUTH_KEY");

		registry.clearSourceRegistrations("ext://runtime");
		await expectProviderHeader(registry, providerName, "Authorization", undefined);
	});

	test("registerProvider applies remoteCompaction-only overrides to existing provider models across refresh", async () => {
		const providerName = "github-copilot";
		const overrideEndpoint = "https://runtime.example.com/v1/compact";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(
			providerName,
			{ remoteCompaction: { enabled: false, endpoint: overrideEndpoint } },
			"ext://runtime",
		);

		const expectCompaction = () => {
			for (const model of getProviderModels(registry, providerName)) {
				expect(model.remoteCompaction?.enabled).toBe(false);
				expect(model.remoteCompaction?.endpoint).toBe(overrideEndpoint);
			}
		};
		expectCompaction();
		await registry.refresh("offline");
		expectCompaction();
		await registry.refreshProvider(providerName, "offline");
		expectCompaction();

		registry.clearSourceRegistrations("ext://runtime");
		for (const model of getProviderModels(registry, providerName)) {
			expect(model.remoteCompaction?.endpoint).not.toBe(overrideEndpoint);
		}
	});

	test("refreshRuntimeProviders preserves model-level remoteCompaction over provider defaults", async () => {
		const providerName = "github-copilot";
		const providerEndpoint = "https://runtime.example.com/v1/responses/provider-compact";
		const modelEndpoint = "https://runtime.example.com/v1/responses/model-compact";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-responses",
				remoteCompaction: {
					enabled: true,
					api: "openai-responses",
					endpoint: providerEndpoint,
					model: "provider-compact",
				},
				fetchDynamicModels: async () => [
					{
						...baseModel,
						id: "dynamic-compact-model",
						remoteCompaction: {
							endpoint: modelEndpoint,
							model: "model-compact",
						},
					},
				],
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");
		const model = registry.find(providerName, "dynamic-compact-model");
		expect(model?.remoteCompaction).toEqual({
			enabled: true,
			api: "openai-responses",
			endpoint: modelEndpoint,
			model: "model-compact",
		});
	});
	test("combines static fallback models with dynamic provider discovery", async () => {
		const providerName = "github-copilot";
		let dynamicFetches = 0;
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: "fallback-model" }],
				fetchDynamicModels: async () => {
					dynamicFetches++;
					return [{ ...baseModel, id: "dynamic-model" }];
				},
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");

		expect(dynamicFetches).toBe(1);
		expect(registry.find(providerName, "dynamic-model")).toBeDefined();
		expect(registry.find(providerName, "fallback-model")).toBeDefined();
	});

	test("configured discovery suppresses extension fetchDynamicModels for the same provider", async () => {
		const providerName = "github-copilot";
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						baseUrl: "http://127.0.0.1:4893",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const configuredFetch: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4893/v1/models") {
				return Response.json({
					data: [{ id: "shared-runtime-model", context_length: 32_768 }],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: configuredFetch });
		let runtimeFetchCalls = 0;
		configuredRegistry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					runtimeFetchCalls++;
					return [{ ...baseModel, id: "shared-runtime-model", contextWindow: 999_999 }];
				},
			},
			"ext://runtime",
		);

		await configuredRegistry.refreshProvider(providerName, "online");

		expect(runtimeFetchCalls).toBe(0);
		expect(configuredRegistry.find(providerName, "shared-runtime-model")?.contextWindow).toBe(32_768);
	});

	test("runtime provider manager supersedes the built-in shared catalog manager", async () => {
		let catalogFetches = 0;
		const catalogFetch: FetchImpl = async input => {
			catalogFetches++;
			throw new Error(`Unexpected built-in catalog fetch: ${String(input)}`);
		};
		const overrideRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: catalogFetch });
		let runtimeFetches = 0;
		overrideRegistry.registerProvider(
			"github-copilot",
			{
				baseUrl: "https://runtime.example.com/v1",
				api: "anthropic-messages",
				fetchDynamicModels: async () => {
					runtimeFetches++;
					return [{ ...baseModel, id: "runtime-anthropic-model" }];
				},
			},
			"ext://runtime",
		);

		await overrideRegistry.refreshProvider("github-copilot", "online");

		expect(runtimeFetches).toBe(1);
		expect(catalogFetches).toBe(0);
		expect(getProviderModels(overrideRegistry, "github-copilot").map(model => model.id)).toEqual([
			"runtime-anthropic-model",
		]);
	});

	test("refreshRuntimeProviders times out extension fetchDynamicModels that never resolves", async () => {
		vi.useFakeTimers();
		const hangingFetch = Promise.withResolvers<readonly NonNullable<ProviderConfigInput["models"]>[number][]>();
		registry.registerProvider(
			"github-copilot",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: () => hangingFetch.promise,
			},
			"ext://runtime",
		);

		const baselineTimers = vi.getTimerCount();
		let outcome: "resolved" | "rejected" | undefined;
		const refresh = registry.refreshRuntimeProviders("online").then(
			() => {
				outcome = "resolved";
			},
			error => {
				outcome = "rejected";
				throw error;
			},
		);

		await drainMicrotasksUntil(
			() => vi.getTimerCount() > baselineTimers,
			"dynamic fetch timeout timer was not armed",
		);
		expect(outcome).toBeUndefined();
		vi.advanceTimersByTime(14_999);
		await Promise.resolve();
		expect(outcome).toBeUndefined();
		vi.advanceTimersByTime(1);
		await refresh;
		expect(outcome).toBe("resolved");
		expect(registry.find("github-copilot", "any-model")).toBeUndefined();
	});

	test("registerProvider preserves explicit thinking and backfills wire facts", () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "anthropic-messages",
			models: [
				{
					...baseModel,
					id: "runtime-thinking-model",
					reasoning: true,
					thinking: {
						mode: "anthropic-adaptive",
						efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
					},
				},
			],
		};

		registry.registerProvider("github-copilot", config, "ext://runtime");
		const model = registry.find("github-copilot", "runtime-thinking-model");

		expect(model?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			// Adaptive ladders are wire-exact (no backfilled effortMap); only
			// requiresEffort is backfilled from identity.
			requiresEffort: true,
		});
	});

	test("extension-registered models survive refresh('offline') cycle", async () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("github-copilot", config, "ext://runtime");
		expect(registry.find("github-copilot", "runtime-model")).toBeDefined();

		await registry.refresh("offline");

		const model = registry.find("github-copilot", "runtime-model");
		expect(model?.baseUrl).toBe("https://runtime.example.com/v1");
		expect(model?.api).toBe("openai-completions");
	});

	test("extension-registered models survive refresh('online') cycle", async () => {
		// The shared registry uses a stub fetch that rejects every request, so
		// refresh("online") exercises the full online discovery path without real
		// network: each provider's fetch fails fast and is swallowed. The contract
		// under test is overlay survival across the online cycle, not discovery.
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "online-survivor" }],
		};

		registry.registerProvider("github-copilot", config, "ext://runtime");
		expect(registry.find("github-copilot", "online-survivor")).toBeDefined();

		await registry.refresh("online");

		const model = registry.find("github-copilot", "online-survivor");
		expect(model?.api).toBe("openai-completions");
	});

	test("headers-only runtime override preserves existing baseUrl across refresh", async () => {
		const modelId = "runtime-headers-only-baseurl-survivor";
		const overrideBaseUrl = "https://runtime-baseurl.example.com/v1";
		const runtimeHeader = "X-Runtime-Headers-Only";

		registry.registerProvider(
			"github-copilot",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);
		registry.registerProvider("github-copilot", { baseUrl: overrideBaseUrl }, "ext://runtime");
		registry.registerProvider("github-copilot", { headers: { [runtimeHeader]: "runtime-header" } }, "ext://runtime");

		await expectModelTransportAcrossRefresh(
			registry,
			"github-copilot",
			modelId,
			overrideBaseUrl,
			runtimeHeader,
			"runtime-header",
		);
		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("github-copilot", modelId)).toBeUndefined();
	});

	test("runtime headers override modelOverrides headers across refresh cycles", async () => {
		const targetModel = registry.getAll().find(model => model.provider === "github-copilot");
		if (!targetModel) throw new Error("Expected bundled anthropic model");

		const modelId = targetModel.id;
		const sharedHeader = "X-Shared-Provider-Model-Header";
		const configHeaderValue = "config-header";
		const runtimeHeaderValue = "runtime-header";

		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"github-copilot": { modelOverrides: { [modelId]: { headers: { [sharedHeader]: configHeaderValue } } } },
				},
			}),
		);

		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
		const configuredModel = configuredRegistry.find("github-copilot", modelId);
		expect(configuredModel && (await configuredRegistry.resolveModelHeaders(configuredModel))?.[sharedHeader]).toBe(
			configHeaderValue,
		);

		configuredRegistry.registerProvider(
			"github-copilot",
			{ headers: { [sharedHeader]: runtimeHeaderValue } },
			"ext://runtime",
		);
		await expectProviderHeaderAcrossRefresh(configuredRegistry, "github-copilot", sharedHeader, runtimeHeaderValue);

		configuredRegistry.clearSourceRegistrations("ext://runtime");
		const restoredModel = configuredRegistry.find("github-copilot", modelId);
		expect(restoredModel && (await configuredRegistry.resolveModelHeaders(restoredModel))?.[sharedHeader]).toBe(
			configHeaderValue,
		);
	});

	test("extension-registered API keys survive refresh cycle for auth resolution", async () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "test-runtime-key",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("github-copilot", config, "ext://runtime");
		expect(registry.authStorage.keys.source("github-copilot")?.kind).toBe("config");

		await registry.refresh("offline");

		expect(await registry.getApiKeyForProvider("github-copilot")).toBe("test-runtime-key");
	});

	test("extension-registered local inference handler survives model refresh", async () => {
		registry.registerProvider("local", { api: "local-inference", streamSimple }, "ext://runtime");
		expect(getCustomApi("local-inference")?.streamSimple).toBe(streamSimple);

		await registry.refresh("offline");

		expect(getCustomApi("local-inference")?.streamSimple).toBe(streamSimple);
	});

	test("re-registering a provider replaces overlays and keeps transport overrides stable", async () => {
		const runtimeHeader = "X-ReRegister-Provider-Header";
		const overrideBaseUrl = "https://runtime-override.example.com/v1";
		const config1: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v1", name: "Model V1" }],
		};
		const config2: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v2",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v2", name: "Model V2" }],
		};

		registry.registerProvider("github-copilot", config1, "ext://runtime");
		registry.registerProvider(
			"github-copilot",
			{ baseUrl: overrideBaseUrl, headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);
		registry.registerProvider("github-copilot", config2, "ext://runtime");

		expect(registry.find("github-copilot", "model-v1")).toBeUndefined();
		await expectModelTransportAcrossRefresh(
			registry,
			"github-copilot",
			"model-v2",
			overrideBaseUrl,
			runtimeHeader,
			"runtime-header",
		);
	});

	test("provider source handoff does not retain previous source transport overrides", async () => {
		const providerName = "github-copilot";
		const leakedHeader = "X-Old-Source-Header";
		const sourceBBaseUrl = "https://source-b.example.com/v1";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://source-a.example.com/v1",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{ baseUrl: "https://override-a.example.com/v1", headers: { [leakedHeader]: "from-source-a" } },
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{
				baseUrl: sourceBBaseUrl,
				apiKey: "KEY_B",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-b" }],
			},
			"ext://b",
		);

		expect(registry.find(providerName, "model-a")).toBeUndefined();
		await expectModelTransportAcrossRefresh(
			registry,
			providerName,
			"model-b",
			sourceBBaseUrl,
			leakedHeader,
			undefined,
		);
	});

	test("transport-only source handoff clears previous source headers immediately", async () => {
		const providerName = "github-copilot";
		const sourceAHeader = "X-Source-A-Header";
		const sourceBHeader = "X-Source-B-Header";

		registry.registerProvider(providerName, { headers: { [sourceAHeader]: "from-source-a" } }, "ext://a");
		await expectProviderHeader(registry, providerName, sourceAHeader, "from-source-a");

		registry.registerProvider(providerName, { headers: { [sourceBHeader]: "from-source-b" } }, "ext://b");
		await expectProviderHeaderAcrossRefresh(registry, providerName, sourceAHeader, undefined);
		await expectProviderHeader(registry, providerName, sourceBHeader, "from-source-b");
	});

	test("multiple extension providers survive refresh independently", async () => {
		registry.registerProvider(
			"github-copilot",
			{
				baseUrl: "https://a.example.com",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			"local",
			{
				api: "local-inference",
				models: [{ ...baseModel, id: "model-b", kind: "tiny" }],
			},
			"ext://b",
		);

		expect(registry.find("github-copilot", "model-a")).toBeDefined();
		expect(registry.find("local", "model-b")).toBeDefined();

		await registry.refresh("offline");

		expect(registry.find("github-copilot", "model-a")).toBeDefined();
		expect(registry.find("local", "model-b")).toBeDefined();
	});

	test("oauth.modifyModels projection survives refresh and refreshProvider", async () => {
		await authStorage.credentials.set("projecting-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Mirrors a credential-aware provider: the registered `models` array is a
		// pre-discovery bootstrap, and modifyModels swaps in the catalog the
		// account actually has.
		const providerHeaders = { "X-Parent": "parent", "X-Mode": "base" };
		const config: ProviderConfigInput = {
			api: "custom-projection-api",
			baseUrl: "https://example.invalid/",
			streamSimple,
			headers: providerHeaders,
			models: [baseModel],
			oauth: {
				name: "Projecting OAuth",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
				modifyModels: models => [
					...models.filter(model => model.provider !== "projecting-provider"),
					{
						...(models.find(model => model.provider === "projecting-provider") as Model<Api>),
						id: "projected-model",
						name: "Projected Model",
						headers: { "X-Mode": "projected" },
					},
				],
			},
		};

		registry.registerProvider("projecting-provider", config, "ext://oauth");

		const projectedIds = () => getProviderModels(registry, "projecting-provider").map(model => model.id);
		expect(projectedIds()).toEqual(["projected-model"]);
		await expectProviderHeader(registry, "projecting-provider", "X-Parent", "parent");
		await expectProviderHeader(registry, "projecting-provider", "X-Mode", "projected");
		providerHeaders["X-Parent"] = "rotated";

		// The model selector reloads the registry offline every time it opens; the
		// projection must not fall back to the bootstrap `models` array.
		await registry.refresh("offline");
		expect(projectedIds()).toEqual(["projected-model"]);
		await expectProviderHeader(registry, "projecting-provider", "X-Parent", "rotated");
		await expectProviderHeader(registry, "projecting-provider", "X-Mode", "projected");

		await registry.refreshProvider("projecting-provider", "offline");
		expect(projectedIds()).toEqual(["projected-model"]);
		await expectProviderHeader(registry, "projecting-provider", "X-Parent", "rotated");
		await expectProviderHeader(registry, "projecting-provider", "X-Mode", "projected");

		registry.clearSourceRegistrations("ext://oauth");
		expect(getProviderModels(registry, "projecting-provider")).toEqual([]);
	});

	test("oauth.modifyModels output is materialized through buildModel", async () => {
		await authStorage.credentials.set("materializing-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Extensions author specs, so a hook that builds its own catalog (rather
		// than deriving it from the models it was handed) returns records with no
		// resolved surface at all. The registry must still hand out built models:
		// consumers read `identity` unconditionally.
		const config: ProviderConfigInput = {
			api: "custom-materialize-api",
			baseUrl: "https://example.invalid/",
			streamSimple,
			models: [baseModel],
			oauth: {
				name: "Materializing OAuth",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
				modifyModels: models => [
					...models.filter(model => model.provider !== "materializing-provider"),
					{
						...baseModel,
						id: "claude-sonnet-4-5",
						name: "Synthesized Model",
						provider: "materializing-provider",
						api: "custom-materialize-api",
						baseUrl: "https://example.invalid/",
					} as unknown as Model<Api>,
				],
			},
		};

		registry.registerProvider("materializing-provider", config, "ext://oauth");

		const [projected, ...rest] = getProviderModels(registry, "materializing-provider");
		expect(rest).toEqual([]);
		expect(projected?.id).toBe("claude-sonnet-4-5");
		expect(projected?.identity).toEqual({ class: "anthropic", family: "sonnet", revision: "4.5.0" });
		expect(projected?.tokenizer).toBe("claude-v3");
	});

	test("a spec-shaped projected model keeps its sparse compat override", async () => {
		await authStorage.credentials.set("compat-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// On a spec the sparse override lives in `compat`, not `compatConfig`, so
		// the row cannot be projected back to spec stage before it is built —
		// that reads the absent `compatConfig` and drops the override, and the
		// request handler stops sending the cache header the extension asked for.
		const config: ProviderConfigInput = {
			api: "openai-completions",
			baseUrl: "https://example.invalid/",
			models: [baseModel],
			oauth: {
				name: "Compat OAuth",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
				modifyModels: models => [
					...models.filter(model => model.provider !== "compat-provider"),
					{
						...baseModel,
						id: "synthesized-model",
						provider: "compat-provider",
						api: "openai-completions",
						baseUrl: "https://example.invalid/",
						compat: { promptCacheSessionHeader: "x-grok-conv-id" },
					} as unknown as Model<Api>,
				],
			},
		};

		registry.registerProvider("compat-provider", config, "ext://oauth");

		const [projected] = getProviderModels(registry, "compat-provider") as Model<"openai-completions">[];
		expect(projected?.id).toBe("synthesized-model");
		expect(projected?.compat?.promptCacheSessionHeader).toBe("x-grok-conv-id");
		expect(projected?.compatConfig).toEqual({ promptCacheSessionHeader: "x-grok-conv-id" });
	});

	test("a throwing modifyModels logs once per distinct failure", async () => {
		await authStorage.credentials.set("noisy-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		try {
			registry.registerProvider(
				"noisy-provider",
				{
					api: "custom-noisy-api",
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: "Noisy OAuth",
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: () => {
							throw new Error("boom");
						},
					},
				},
				"ext://oauth",
			);

			const modifierWarnings = () =>
				warn.mock.calls.filter(([message]) => String(message).includes("extension model projection failed"));
			expect(modifierWarnings()).toHaveLength(1);
			expect(modifierWarnings()[0]?.[1]).toMatchObject({ provider: "noisy-provider", error: "boom" });

			// Same failure on every later recomposition must not spam the log.
			await registry.refresh("offline");
			expect(modifierWarnings()).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("a non-idempotent modifyModels does not compound across refreshes", async () => {
		await authStorage.credentials.set("appending-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Deliberately append-only: the hook never strips its own prior output, so
		// feeding it an already-projected list would duplicate on every rebuild.
		let projectionCount = 0;
		registry.registerProvider(
			"appending-provider",
			{
				api: "custom-appending-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Appending OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						projectionCount += 1;
						const seed = models.find(model => model.provider === "appending-provider") as Model<Api>;
						return [...models, { ...seed, id: `extra-${projectionCount}` }];
					},
				},
			},
			"ext://oauth",
		);

		const ids = () => getProviderModels(registry, "appending-provider").map(model => model.id);
		expect(ids()).toEqual(["runtime-model", "extra-1"]);

		await registry.refresh("offline");
		expect(ids()).toHaveLength(2);

		await registry.refresh("online");
		expect(ids()).toHaveLength(2);
	});

	test("a non-idempotent modifyModels does not compound when another provider registers", async () => {
		// The SDK and CLI loaders drain pending registrations one at a time, so an
		// earlier provider's projection is still in #models when the next arrives.
		const registerAppending = async (providerName: string, apiId: string) => {
			await authStorage.credentials.set(providerName, {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			});
			let projectionCount = 0;
			registry.registerProvider(
				providerName,
				{
					api: apiId,
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: `${providerName} OAuth`,
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: models => {
							projectionCount += 1;
							const seed = models.find(model => model.provider === providerName) as Model<Api>;
							return [...models, { ...seed, id: `extra-${projectionCount}` }];
						},
					},
				},
				"ext://oauth",
			);
		};

		await registerAppending("appending-first", "custom-appending-first-api");
		expect(getProviderModels(registry, "appending-first").map(model => model.id)).toEqual([
			"runtime-model",
			"extra-1",
		]);

		await registerAppending("appending-second", "custom-appending-second-api");
		// Catalog changes rerun whole-catalog hooks, but each run must start from
		// the unprojected snapshot rather than accumulating prior output.
		expect(getProviderModels(registry, "appending-first")).toHaveLength(2);
		expect(getProviderModels(registry, "appending-second").map(model => model.id)).toEqual([
			"runtime-model",
			"extra-1",
		]);

		await registry.refresh("offline");
		expect(getProviderModels(registry, "appending-first")).toHaveLength(2);
		expect(getProviderModels(registry, "appending-second")).toHaveLength(2);
	});

	test("provider-scoped lookups preserve whole-catalog modifyModels projections", async () => {
		const hiddenModel = registry.getAll().find(model => model.provider === "github-copilot");
		await authStorage.credentials.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.filter(model => model.provider !== hiddenModel?.provider || model.id !== hiddenModel.id),
				},
			},
			"ext://oauth",
		);

		expect(registry.find(hiddenModel!.provider, hiddenModel!.id)).toBeUndefined();
		const refreshPromise = registry.refresh("offline");
		// While refresh is awaiting discovery, lookup takes the provider-scoped composition path.
		expect(registry.find(hiddenModel!.provider, hiddenModel!.id)).toBeUndefined();
		await refreshPromise;
		expect(
			registry.getAll().find(model => model.provider === hiddenModel!.provider && model.id === hiddenModel!.id),
		).toBeUndefined();
	});

	test("provider-scoped lookups do not intern other providers' transient projections", async () => {
		const localId = registry.getAll().find(model => model.provider === "github-copilot")?.id;
		await authStorage.credentials.set("changing-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		let projectionCount = 0;
		registry.registerProvider(
			"changing-provider",
			{
				api: "custom-changing-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Changing OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						projectionCount += 1;
						return models.map(model =>
							model.provider === "changing-provider"
								? { ...model, name: `projection-${projectionCount}` }
								: model,
						);
					},
				},
			},
			"ext://oauth",
		);

		const refreshPromise = registry.refresh("offline");
		expect(registry.find("github-copilot", localId!)).toBeDefined();
		expect(registry.find("changing-provider", "runtime-model")?.name).toBe("projection-3");
		await refreshPromise;
	});

	test("registering another provider reapplies whole-catalog modifyModels projections", async () => {
		await authStorage.credentials.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => models.filter(model => model.provider !== "later-provider"),
				},
			},
			"ext://oauth",
		);

		registry.registerProvider(
			"later-provider",
			{
				api: "custom-later-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				apiKey: "RUNTIME_KEY",
				models: [baseModel],
			},
			"ext://runtime",
		);

		expect(getProviderModels(registry, "later-provider")).toEqual([]);
	});

	test("runtime transport overrides reapply whole-catalog modifyModels projections", async () => {
		const proxyBaseUrl = "https://proxy.example.invalid/v1";
		await authStorage.credentials.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.filter(model => model.provider !== "github-copilot" || model.baseUrl !== proxyBaseUrl),
				},
			},
			"ext://oauth",
		);
		expect(getProviderModels(registry, "github-copilot").length).toBeGreaterThan(0);

		registry.registerProvider("github-copilot", { baseUrl: proxyBaseUrl }, "ext://runtime");

		expect(getProviderModels(registry, "github-copilot")).toEqual([]);
	});

	test("online discovery reapplies modifiers to an unprojected full catalog", async () => {
		const target = registry.getAll().find(model => model.provider === "github-copilot");
		await authStorage.credentials.set("renaming-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"renaming-provider",
			{
				api: "custom-renaming-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Renaming OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.map(model =>
							model.provider === target?.provider && model.id === target.id
								? { ...model, name: `${model.name} projected` }
								: model,
						),
				},
			},
			"ext://oauth",
		);
		registry.registerProvider(
			"dynamic-provider",
			{
				api: "custom-dynamic-api",
				baseUrl: "https://example.invalid/",
				apiKey: "RUNTIME_KEY",
				streamSimple,
				fetchDynamicModels: async () => [{ ...baseModel, id: "dynamic-model" }],
			},
			"ext://runtime",
		);

		expect(registry.find(target!.provider, target!.id)?.name).toBe(`${target!.name} projected`);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(target!.provider, target!.id)?.name).toBe(`${target!.name} projected`);
	});

	test("a modifyModels that mutates in place then throws cannot corrupt the catalog", async () => {
		await authStorage.credentials.set("mutating-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		try {
			const targetBefore = registry.getAll()[0];
			const targetSnapshot = structuredClone(targetBefore!);
			const localBefore = registry.getAll().filter(model => model.provider === "github-copilot").length;
			expect(localBefore).toBeGreaterThan(0);

			registry.registerProvider(
				"mutating-provider",
				{
					api: "custom-mutating-api",
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: "Mutating OAuth",
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						// Corrupts a model record and its nested cost, wipes the array,
						// then fails. None of those mutations may reach the canonical
						// unprojected catalog used for fallback or later refreshes.
						modifyModels: models => {
							models[0]!.name = "Corrupted by failing hook";
							models[0]!.cost.input = -1;
							models.length = 0;
							throw new Error("mutated then failed");
						},
					},
				},
				"ext://oauth",
			);

			expect(registry.find(targetBefore!.provider, targetBefore!.id)).toEqual(targetSnapshot);
			expect(registry.getAll().filter(model => model.provider === "github-copilot")).toHaveLength(localBefore);
			expect(getProviderModels(registry, "mutating-provider").map(model => model.id)).toEqual(["runtime-model"]);

			await registry.refresh("offline");
			expect(registry.find(targetBefore!.provider, targetBefore!.id)).toEqual(targetSnapshot);
			expect(registry.getAll().filter(model => model.provider === "github-copilot")).toHaveLength(localBefore);
			expect(getProviderModels(registry, "mutating-provider").map(model => model.id)).toEqual(["runtime-model"]);
		} finally {
			warn.mockRestore();
		}
	});

	test("prefers a configured provider base URL over a model-level one", () => {
		// The other half of the precedence contract, and the half a green suite
		// cannot prove: every other `getProviderBaseUrl` caller in these tests
		// stubs the method. `getProviderHeaders` is documented as provider-level
		// "without including per-model overrides", so a provider-scoped accessor
		// must not answer with some model's own baseUrl.
		const providerName = "github-copilot";
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						baseUrl: "https://gateway.internal",
						api: "openai-completions",
						auth: "none",
						models: [{ ...baseModel, id: "glm-5.3", baseUrl: "https://model-level.example/v1" }],
					},
				},
			}),
		);
		const configured = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });

		// The model really does carry a different baseUrl, so this is a genuine
		// conflict rather than a vacuous assertion.
		expect(configured.find(providerName, "glm-5.3")?.baseUrl).toBe("https://model-level.example/v1");
		expect(configured.getProviderBaseUrl(providerName)).toBe("https://gateway.internal");
	});
});
