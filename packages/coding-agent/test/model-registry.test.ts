import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type FetchImpl, type Model, type OpenAICompat, type ThinkingConfig } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { getBundledModels } from "@oh-my-striped-pi/pi-catalog/models";
import { modelKind } from "@oh-my-striped-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { cfgExtendedContext } from "@oh-my-striped-pi/pi-coding-agent/session/context-settings";
import { removeSyncWithRetries } from "@oh-my-striped-pi/pi-utils";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	const spies: Array<{ mockRestore: () => void }> = [];
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const customModel = {
		id: "registry-fixture",
		name: "Registry Fixture",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 100_000,
		maxTokens: 8_000,
	};

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-model-registry-"));
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		authStorage.close();
		removeSyncWithRetries(tempDir);
		resetSettingsForTest();
	});

	function writeProviders(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function copilotConfig(overrides: Record<string, unknown> = {}) {
		return {
			baseUrl: "https://proxy.example.com/v1",
			api: "openai-completions",
			auth: "none",
			models: [customModel],
			...overrides,
		};
	}

	function fixtureRegistry(overrides: Record<string, unknown> = {}) {
		writeProviders({ "github-copilot": copilotConfig(overrides) });
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		expect(registry.getError()).toBeUndefined();
		return registry;
	}

	function bundledModel() {
		const model = getBundledModels("github-copilot").find(model => modelKind(model) === "chat");
		if (!model) throw new Error("Expected a bundled Copilot chat model");
		return model;
	}

	function compat(model: Model | undefined) {
		return model?.compatConfig as OpenAICompat | undefined;
	}

	describe("catalog pools", () => {
		test("bundled pools preserve local models and default pools are chat-only", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const all = registry.getAll("all");
			expect(all.length).toBeGreaterThan(0);
			expect(all.some(model => model.provider === "local")).toBe(true);
			expect(registry.getAll().every(model => modelKind(model) === "chat")).toBe(true);
			expect(registry.getAvailable().every(model => modelKind(model) === "chat")).toBe(true);
		});

		test("explicit kind pools retain local tiny models and find remains kind-agnostic", () => {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const tiny = registry.getAll("tiny");
			expect(tiny.length).toBeGreaterThan(0);
			for (const model of tiny) {
				expect(model.provider).toBe("local");
				expect(registry.find(model.provider, model.id)?.id).toBe(model.id);
			}
		});

		test("Copilot credentials make its bundled chat models available", () => {
			authStorage.keys.setRuntime("github-copilot", "copilot-test-key");
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getAvailable().some(model => model.provider === "github-copilot")).toBe(true);
		});
	});

	describe("provider and model overrides", () => {
		test("baseUrl-only overrides all bundled provider models without changing local models", () => {
			const baseline = new ModelRegistry(authStorage, modelsJsonPath);
			const local = baseline.getAll("all").filter(model => model.provider === "local");
			writeProviders({ "github-copilot": { baseUrl: "https://proxy.example.com/v1" } });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const copilot = registry.getAll().filter(model => model.provider === "github-copilot");
			expect(copilot.length).toBeGreaterThan(1);
			for (const model of copilot) expect(model.baseUrl).toBe("https://proxy.example.com/v1");
			for (const model of local) expect(registry.find("local", model.id)?.baseUrl).toBe(model.baseUrl);
		});

		test("headers-only overrides are resolved on built-in models", async () => {
			writeProviders({ "github-copilot": { headers: { "X-Tenant": "provider" } } });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", bundledModel().id)!;
			expect((await registry.resolveModelHeaders(model))?.["X-Tenant"]).toBe("provider");
		});

		test("provider header lookup does not leak model-specific headers", async () => {
			const registry = fixtureRegistry({
				headers: { "X-Provider": "shared" },
				models: [{ ...customModel, headers: { "X-Model": "specific" } }],
			});
			expect(await registry.getProviderHeaders("github-copilot")).toEqual({ "X-Provider": "shared" });
			expect(await registry.resolveModelHeaders(registry.find("github-copilot", customModel.id)!)).toMatchObject({
				"X-Provider": "shared",
				"X-Model": "specific",
			});
		});

		test("authHeader adds bearer auth from the configured key at request time", async () => {
			const registry = fixtureRegistry({ auth: "apiKey", apiKey: "fixture-key", authHeader: true });
			const model = registry.find("github-copilot", customModel.id)!;
			expect(await registry.getApiKey(model)).toBe("fixture-key");
			expect((await registry.resolveModelHeaders(model))?.Authorization).toBe("Bearer fixture-key");
		});

		test("configured custom models merge with bundled models", () => {
			const registry = fixtureRegistry();
			expect(registry.find("github-copilot", customModel.id)?.name).toBe(customModel.name);
			expect(registry.find("local", "falcon-h1-90m")).toBeDefined();
			expect(registry.find("github-copilot", bundledModel().id)).toBeDefined();
		});

		test("local inference definitions need neither an HTTP URL nor credentials", () => {
			writeProviders({
				local: { api: "local-inference", models: [{ ...customModel, kind: "tiny" }] },
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();
			expect(registry.find("local", customModel.id)).toMatchObject({
				api: "local-inference",
				baseUrl: "",
				kind: "tiny",
			});
			expect(registry.getAvailable("tiny").some(model => model.id === customModel.id)).toBe(true);
			expect(authStorage.keys.source("local")).toBeUndefined();
		});

		test("same-id custom definitions replace a bundled row once without retaining bundled headers", async () => {
			const original = bundledModel();
			writeProviders({
				"github-copilot": {
					...copilotConfig({ auth: "apiKey", apiKey: "proxy-key" }),
					headers: { "X-Proxy": "proxy" },
					models: [{ ...customModel, id: original.id }],
				},
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const matches = registry
				.getAll()
				.filter(model => model.provider === "github-copilot" && model.id === original.id);
			expect(matches).toHaveLength(1);
			expect(matches[0]?.name).toBe(customModel.name);
			expect(await registry.resolveModelHeaders(matches[0]!)).toEqual({ "X-Proxy": "proxy" });
		});

		test("model-level baseUrl outranks provider URL without changing sibling routes", () => {
			const registry = fixtureRegistry({
				models: [customModel, { ...customModel, id: "other", baseUrl: "https://other.example.com/v1" }],
			});
			expect(registry.find("github-copilot", customModel.id)?.baseUrl).toBe("https://proxy.example.com/v1");
			expect(registry.find("github-copilot", "other")?.baseUrl).toBe("https://other.example.com/v1");
		});

		test("modelOverrides apply alongside custom models and ignore unknown IDs", () => {
			const registry = fixtureRegistry({
				modelOverrides: {
					[customModel.id]: { name: "Renamed", contextWindow: 50_000 },
					missing: { name: "Not created" },
				},
			});
			expect(registry.find("github-copilot", customModel.id)).toMatchObject({
				name: "Renamed",
				contextWindow: 50_000,
			});
			expect(registry.find("github-copilot", "missing")).toBeUndefined();
		});

		test("partial cost overrides preserve other price fields", () => {
			const registry = fixtureRegistry({
				models: [{ ...customModel, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }],
				modelOverrides: { [customModel.id]: { cost: { input: 99 } } },
			});
			expect(registry.find("github-copilot", customModel.id)?.cost).toMatchObject({
				input: 99,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
			});
		});

		test("model compat overrides deep merge provider extraBody", () => {
			const registry = fixtureRegistry({
				compat: { supportsUsageInStreaming: false, extraBody: { provider: { a: 1 } } },
				modelOverrides: {
					[customModel.id]: { compat: { supportsUsageInStreaming: true, extraBody: { provider: { b: 2 } } } },
				},
			});
			expect(compat(registry.find("github-copilot", customModel.id))).toMatchObject({
				supportsUsageInStreaming: true,
				extraBody: { provider: { a: 1, b: 2 } },
			});
		});

		test("provider compat applies to bundled models", () => {
			writeProviders({ "github-copilot": { compat: { supportsUsageInStreaming: false } } });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(compat(registry.find("github-copilot", bundledModel().id))?.supportsUsageInStreaming).toBe(false);
		});

		test("Responses models retain per-model stateful and configuration-update opt-outs", () => {
			const registry = fixtureRegistry({
				api: "openai-responses",
				compat: { statefulResponses: true, supportsConfigurationUpdate: true },
				models: [
					customModel,
					{
						...customModel,
						id: "stateless",
						compat: { statefulResponses: false, supportsConfigurationUpdate: false },
					},
				],
			});
			expect(compat(registry.find("github-copilot", customModel.id))?.statefulResponses).toBe(true);
			expect(compat(registry.find("github-copilot", "stateless"))).toMatchObject({
				statefulResponses: false,
				supportsConfigurationUpdate: false,
			});
		});

		test("Responses models preserve remote compaction configuration", () => {
			const remoteCompaction = {
				enabled: true,
				api: "openai-responses",
				endpoint: "https://proxy.example.com/v1/responses/compact",
				model: "compact-fixture",
			};
			const registry = fixtureRegistry({
				api: "openai-responses",
				remoteCompaction,
				models: [{ ...customModel, compactionModel: "github-copilot/compact-fixture" }],
			});
			expect(registry.find("github-copilot", customModel.id)?.remoteCompaction).toEqual(remoteCompaction);
			expect(registry.find("github-copilot", customModel.id)?.compactionModel).toBe(
				"github-copilot/compact-fixture",
			);
		});

		test("disableStrictTools is merged into Anthropic compat", () => {
			const registry = fixtureRegistry({ api: "anthropic-messages", disableStrictTools: true });
			expect(registry.find("github-copilot", customModel.id)?.compat).toMatchObject({ disableStrictTools: true });
		});

		test("omitMaxOutputTokens preserves the local output limit", () => {
			const registry = fixtureRegistry({ models: [{ ...customModel, omitMaxOutputTokens: true }] });
			expect(registry.find("github-copilot", customModel.id)).toMatchObject({
				omitMaxOutputTokens: true,
				maxTokens: 8_000,
			});
		});

		test("explicit kind overrides survive rebuilds", async () => {
			writeProviders({ local: { modelOverrides: { "falcon-h1-90m": { kind: "chat" } } } });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(modelKind(registry.find("local", "falcon-h1-90m")!)).toBe("chat");
			await registry.refresh("offline");
			expect(modelKind(registry.find("local", "falcon-h1-90m")!)).toBe("chat");
		});

		test("refresh reloads provider URLs and custom model definitions", async () => {
			const registry = fixtureRegistry();
			writeProviders({
				"github-copilot": copilotConfig({
					baseUrl: "https://second.example.com/v1",
					models: [{ ...customModel, name: "Updated" }],
				}),
			});
			await registry.refresh("offline");
			expect(registry.find("github-copilot", customModel.id)).toMatchObject({
				baseUrl: "https://second.example.com/v1",
				name: "Updated",
			});
		});

		test("removing custom definitions and overrides restores bundled values", async () => {
			const original = bundledModel();
			writeProviders({
				"github-copilot": copilotConfig({ modelOverrides: { [original.id]: { name: "Temporary" } } }),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("github-copilot", original.id)?.name).toBe("Temporary");
			writeProviders({});
			await registry.refresh("offline");
			expect(registry.find("github-copilot", original.id)?.name).toBe(original.name);
			expect(registry.find("github-copilot", customModel.id)).toBeUndefined();
			expect(registry.find("local", "falcon-h1-90m")).toBeDefined();
		});
	});

	describe("thinking and context policies", () => {
		const thinking: ThinkingConfig = {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.High],
			defaultLevel: Effort.High,
		};

		test("custom thinking metadata is preserved verbatim", () => {
			const registry = fixtureRegistry({
				api: "anthropic-messages",
				models: [{ ...customModel, reasoning: true, thinking }],
			});
			expect(registry.find("github-copilot", customModel.id)?.thinking).toEqual(thinking);
		});

		test("model overrides replace canonical thinking metadata without changing capacity", () => {
			const original = bundledModel();
			const baseline = new ModelRegistry(authStorage, modelsJsonPath).find("github-copilot", original.id)!;
			writeProviders({ "github-copilot": { modelOverrides: { [original.id]: { thinking } } } });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("github-copilot", original.id)?.thinking).toEqual(thinking);
			expect(registry.find("github-copilot", original.id)?.contextWindow).toBe(baseline.contextWindow);
			expect(registry.find("github-copilot", original.id)?.maxTokens).toBe(baseline.maxTokens);
		});

		test("custom standard and maximum windows follow toggles without retaining an earlier maximum", async () => {
			writeProviders({
				"github-copilot": copilotConfig({
					api: "openai-responses",
					models: [{ ...customModel, contextWindow: 100_000, maxContextWindow: 300_000 }],
				}),
			});
			const settings = Settings.isolated();
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { settings });
			expect(registry.find("github-copilot", customModel.id)?.contextWindow).toBe(100_000);
			cfgExtendedContext.set(settings, true);
			await registry.reapplyModelPolicies();
			expect(registry.find("github-copilot", customModel.id)?.contextWindow).toBe(300_000);
			cfgExtendedContext.set(settings, false);
			await registry.reapplyModelPolicies();
			expect(registry.find("github-copilot", customModel.id)?.contextWindow).toBe(100_000);
			writeProviders({
				"github-copilot": copilotConfig({
					api: "openai-responses",
					models: [{ ...customModel, contextWindow: 100_000, maxContextWindow: 300_000 }],
					modelOverrides: { [customModel.id]: { maxContextWindow: 200_000 } },
				}),
			});
			cfgExtendedContext.set(settings, true);
			await registry.reapplyModelPolicies();
			expect(registry.find("github-copilot", customModel.id)?.contextWindow).toBe(200_000);
		});
	});

	describe("disabled providers", () => {
		test("disabled providers are absent from available pools and cannot resolve credentials", async () => {
			authStorage.keys.setRuntime("github-copilot", "copilot-key");
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				settings: Settings.isolated({ disabledProviders: ["github-copilot"] }),
			});
			expect(registry.getAvailable("all").some(model => model.provider === "github-copilot")).toBe(false);
			expect(registry.find("github-copilot", bundledModel().id)).toBeUndefined();
			expect(await registry.getApiKey(bundledModel())).toBeUndefined();
			expect(await registry.getApiKeyForProvider("github-copilot")).toBeUndefined();
		});

		test("disabled configured discovery never probes its endpoint", async () => {
			writeProviders({ "github-copilot": copilotConfig({ discovery: { type: "openai-models-list" }, models: [] }) });
			const fetch = mock<FetchImpl>(async () => {
				throw new Error("Disabled discovery must not fetch");
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch,
				settings: Settings.isolated({
					disabledProviders: [
						"local",
						"github-copilot",
						"ollama",
						"llama.cpp",
						"lm-studio",
						"apple",
						"vllm",
						"litellm",
					],
				}),
			});
			await registry.refresh("online");
			expect(fetch).not.toHaveBeenCalled();
			expect(registry.getDiscoverableProviders()).not.toContain("github-copilot");
		});
	});

	describe("provider configuration boundaries", () => {
		test.each(["ollama", "llama.cpp", "lm-studio", "vllm", "litellm", "company-provider"])(
			"accepts explicit %s endpoints without running credential commands during catalog reads",
			provider => {
				const marker = path.join(tempDir, "command-ran");
				writeProviders({ [provider]: copilotConfig({ apiKey: `!touch '${marker}'; printf company-key` }) });
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				expect(registry.getError()).toBeUndefined();
				expect(registry.find(provider, customModel.id)?.provider).toBe(provider);
				expect(fs.existsSync(marker)).toBe(false);
			},
		);

		test("a malformed entry rejects the entire config before installing earlier keys", () => {
			const marker = path.join(tempDir, "earlier-command-ran");
			writeProviders({
				"github-copilot": copilotConfig({ apiKey: `!touch '${marker}'; printf supported-key` }),
				company: copilotConfig({ models: [{ ...customModel, contextWindow: -1 }] }),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeDefined();
			expect(authStorage.keys.source("github-copilot")).toBeUndefined();
			expect(fs.existsSync(marker)).toBe(false);
		});

		test("invalid model limits remain visible as a config error", () => {
			writeProviders({ company: copilotConfig({ models: [{ ...customModel, contextWindow: -1 }] }) });
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeDefined();
			expect(registry.find("company", customModel.id)).toBeUndefined();
		});
	});

	describe("YAML model configuration", () => {
		test("provider Responses compat can be opted out per model", () => {
			const modelsPath = path.join(tempDir, "models.yml");
			fs.writeFileSync(
				modelsPath,
				`providers:
  github-copilot:
    api: openai-responses
    baseUrl: https://proxy.example.com/v1
    auth: none
    compat:
      statefulResponses: true
    models:
      - id: chained-model
      - id: stateless-model
        compat:
          statefulResponses: false
`,
			);
			const registry = new ModelRegistry(authStorage, modelsPath);
			expect(registry.getError()).toBeUndefined();
			expect(registry.find("github-copilot", "chained-model")?.compat).toMatchObject({
				statefulResponses: true,
			});
			expect(registry.find("github-copilot", "stateless-model")?.compat).toMatchObject({
				statefulResponses: false,
			});
		});
	});

	describe("retained generic routing", () => {
		test("different APIs sharing a provider baseUrl keep their own route", () => {
			const registry = fixtureRegistry({
				models: [
					{ ...customModel, api: "openai-completions" },
					{ ...customModel, id: "responses-fixture", api: "openai-responses" },
					{ ...customModel, id: "messages-fixture", api: "anthropic-messages" },
				],
			});
			expect(registry.find("github-copilot", customModel.id)?.api).toBe("openai-completions");
			expect(registry.find("github-copilot", "responses-fixture")?.api).toBe("openai-responses");
			expect(registry.find("github-copilot", "messages-fixture")?.api).toBe("anthropic-messages");
		});

		test("native gateway transport survives an offline refresh", async () => {
			const registry = fixtureRegistry({ transport: "pi-native" });
			expect(registry.find("github-copilot", customModel.id)?.transport).toBe("pi-native");
			await registry.refresh("offline");
			expect(registry.find("github-copilot", customModel.id)?.transport).toBe("pi-native");
			expect(registry.find("github-copilot", customModel.id)?.baseUrl).toBe("https://proxy.example.com/v1");
		});

		test("discovered IDs inherit provider fields, not another custom model's fields", async () => {
			writeProviders({
				"github-copilot": copilotConfig({
					discovery: { type: "openai-models-list" },
					headers: { "X-Provider": "shared" },
					models: [
						{
							...customModel,
							baseUrl: "https://model.example.com/v1",
							headers: { "X-Model": "private" },
							compactionModel: "github-copilot/private-compactor",
						},
					],
				}),
			});
			const fetch: FetchImpl = async () =>
				Response.json({ data: [{ id: customModel.id }, { id: "discovered-fixture" }] });
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch });
			await registry.refreshProvider("github-copilot", "online");
			const discovered = registry.find("github-copilot", "discovered-fixture")!;
			expect(discovered).toBeDefined();
			expect(discovered.baseUrl).toBe("https://proxy.example.com/v1");
			expect(discovered.compactionModel).toBeUndefined();
			expect(await registry.resolveModelHeaders(discovered)).toMatchObject({ "X-Provider": "shared" });
			expect((await registry.resolveModelHeaders(discovered))?.["X-Model"]).toBeUndefined();
			expect(registry.find("github-copilot", customModel.id)?.baseUrl).toBe("https://model.example.com/v1");
		});

		test("thinking twins collapse while retaining effort routing and saved selectors", () => {
			const registry = fixtureRegistry({
				api: "anthropic-messages",
				models: [
					{ ...customModel, id: "[Kiro] claude-opus-4-7" },
					{ ...customModel, id: "[Kiro] claude-opus-4-7-thinking" },
				],
			});
			const model = registry.find("github-copilot", "[Kiro] claude-opus-4-7");
			expect(model?.reasoning).toBe(true);
			expect(model?.thinking?.effortRouting?.[Effort.High]).toBe("[Kiro] claude-opus-4-7-thinking");
			expect(model?.thinking?.effortRouting?.off).toBe("[Kiro] claude-opus-4-7");
			expect(registry.find("github-copilot", "[Kiro] claude-opus-4-7-thinking")?.id).toBe(model?.id);
		});
	});

	describe("configured discovery cache", () => {
		const namespace = "github-copilot:openai-models-list-context-v5";
		function cacheModel(provider = "github-copilot") {
			return buildModel({
				...customModel,
				input: ["text"],
				api: "openai-completions",
				provider,
				baseUrl: "https://proxy.example.com/v1",
			});
		}

		test("loads supported generic discovery rows on startup without network access", () => {
			writeProviders({ "github-copilot": copilotConfig({ discovery: { type: "openai-models-list" }, models: [] }) });
			writeModelCache(namespace, Date.now(), [cacheModel()], true, "", path.join(tempDir, "models.db"));
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("github-copilot", customModel.id)).toMatchObject({
				contextWindow: 100_000,
				maxTokens: 8_000,
			});
		});

		test("ignores rows cached in retired generic discovery namespaces", () => {
			writeProviders({ "github-copilot": copilotConfig({ discovery: { type: "openai-models-list" }, models: [] }) });
			writeModelCache(
				"github-copilot:openai-models-list-context-v3",
				Date.now(),
				[cacheModel()],
				true,
				"",
				path.join(tempDir, "models.db"),
			);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.find("github-copilot", customModel.id)).toBeUndefined();
		});

		test("ignores foreign cached provider rows without executing configured commands", () => {
			const marker = path.join(tempDir, "cache-command-ran");
			writeProviders({
				"github-copilot": copilotConfig({
					apiKey: `!touch '${marker}'; printf forbidden-key`,
					headers: { "X-Key": `!touch '${marker}'; printf forbidden-header` },
					discovery: { type: "openai-models-list" },
					models: [],
				}),
			});
			writeModelCache(namespace, Date.now(), [cacheModel("openai")], true, "", path.join(tempDir, "models.db"));
			const setConfig = spyOn(authStorage.keys, "setConfig");
			spies.push(setConfig);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getAll("all").some(model => model.provider === "openai")).toBe(false);
			expect(fs.existsSync(marker)).toBe(false);
		});

		test("removed provider cache namespaces cannot restore providers", () => {
			writeModelCache("openai", Date.now(), [cacheModel("openai")], true, "", path.join(tempDir, "models.db"));
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getAll("all").some(model => model.provider === "openai")).toBe(false);
		});

		test("discovered rows retain configured compat after refresh", async () => {
			writeProviders({
				"github-copilot": copilotConfig({
					discovery: { type: "openai-models-list" },
					compat: { supportsUsageInStreaming: false },
					models: [],
				}),
			});
			const fetch: FetchImpl = async input => {
				expect(String(input)).toBe("https://proxy.example.com/v1/models");
				return Response.json({ data: [{ id: customModel.id }] });
			};
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch });
			await registry.refreshProvider("github-copilot", "online");
			expect(compat(registry.find("github-copilot", customModel.id))?.supportsUsageInStreaming).toBe(false);
		});
	});

	describe("github-copilot oauth endpoint alignment", () => {
		test("getApiKey does not mutate bundled github-copilot baseUrl", async () => {
			await authStorage.credentials.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_individual_token_123",
					refresh: "ghu_individual_token_123",
					expires: Date.now() + 60_000,
				},
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o")!;
			expect(model).toBeDefined();
			const initialBaseUrl = model.baseUrl;
			const first = JSON.parse((await registry.getApiKey(model))!) as { token?: string; enterpriseUrl?: string };
			const second = JSON.parse((await registry.getApiKey(model))!) as { token?: string; enterpriseUrl?: string };
			expect(first.token).toBe("ghu_individual_token_123");
			expect(first.enterpriseUrl).toBeUndefined();
			expect(second.token).toBe("ghu_enterprise_token_456");
			expect(second.enterpriseUrl).toBe("ghe.example.com");
			expect(model.baseUrl).toBe(initialBaseUrl);
		});

		test("refreshProvider uses the enterprise discovery host for peeked credentials", async () => {
			await authStorage.credentials.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);
			const requestedUrls: string[] = [];
			const fetch: FetchImpl = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				requestedUrls.push(url);
				expect(url).toBe("https://copilot-api.ghe.example.com/models");
				const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer ghu_enterprise_token_456");
				return Response.json({ data: [{ id: "gpt-5-mini", name: "GPT-5 mini" }] });
			};
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch });
			await registry.refreshProvider("github-copilot", "online");
			expect(requestedUrls).toContain("https://copilot-api.ghe.example.com/models");
			expect(requestedUrls).not.toContain("https://api.githubcopilot.com/models");
		});
	});
});
