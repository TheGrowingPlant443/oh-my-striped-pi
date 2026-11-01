import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { CacheWarmer, getPromptCacheTtlMs } from "../src/session/cache-warmer";

const originalAgentDir = getAgentDir();
const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

let tempDir: TempDir;
let authStorage: AuthStorage;

const COPILOT_CACHE_MODEL = "copilot-cache-fixture";

describe("ModelRegistry default custom models config", () => {
	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-registry-default-config-");
		setAgentDir(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		await tempDir.remove().catch(() => {});
	});

	test("loads custom provider models from default models.yaml when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "github-copilot",
			modelId: "yaml-model",
			modelName: "YAML default model",
			baseUrl: "https://yaml-default.example.com/v1",
		});

		const [model] = loadDefaultRegistryModels({
			provider: "github-copilot",
			modelId: "yaml-model",
		});

		expect(model?.name).toBe("YAML default model");
		expect(model?.baseUrl).toBe("https://yaml-default.example.com/v1");
	});

	test("retains STB decoder metadata on a custom Copilot model", () => {
		writeModelsYaml("models.yml", {
			provider: "github-copilot",
			modelId: "copilot-vision",
			modelName: "Copilot vision",
			baseUrl: "http://127.0.0.1:8080/v1",
			imageInputDecoder: "stb",
		});

		const [model] = loadDefaultRegistryModels({ provider: "github-copilot", modelId: "copilot-vision" });

		expect(model?.imageInputDecoder).toBe("stb");
	});

	test("prefers default models.yml over models.yaml when both exist", () => {
		writeModelsYaml("models.yml", {
			provider: "github-copilot",
			modelId: "from-yml",
			modelName: "YML winner",
			baseUrl: "https://yml-winner.example.com/v1",
		});
		writeModelsYaml("models.yaml", {
			provider: "github-copilot",
			modelId: "from-yaml",
			modelName: "YAML loser",
			baseUrl: "https://yaml-loser.example.com/v1",
		});

		const [ymlModel, yamlModel] = loadDefaultRegistryModels(
			{ provider: "github-copilot", modelId: "from-yml" },
			{ provider: "github-copilot", modelId: "from-yaml" },
		);

		expect(ymlModel?.baseUrl).toBe("https://yml-winner.example.com/v1");
		expect(yamlModel).toBeUndefined();
	});

	test("prefers default models.yaml over legacy models.json when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "github-copilot",
			modelId: "from-yaml",
			modelName: "YAML winner over JSON",
			baseUrl: "https://yaml-over-json.example.com/v1",
		});
		writeModelsJson({
			provider: "github-copilot",
			modelId: "from-json",
			modelName: "JSON loser",
			baseUrl: "https://json-loser.example.com/v1",
		});

		const [yamlModel, jsonModel] = loadDefaultRegistryModels(
			{ provider: "github-copilot", modelId: "from-yaml" },
			{ provider: "github-copilot", modelId: "from-json" },
		);

		expect(yamlModel?.baseUrl).toBe("https://yaml-over-json.example.com/v1");
		expect(jsonModel).toBeUndefined();
	});
	describe("prompt cache lifetime configuration", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		test("an explicit empty model override prevents cache warming", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-empty.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    modelOverrides:",
					`      ${JSON.stringify(COPILOT_CACHE_MODEL)}:`,
					"        promptCache: {}",
					"    models:",
					copilotModelDefinition({ short: 300, long: 3600 }),
					"",
				].join("\n"),
			);
			const model = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			const options: SimpleStreamOptions = { cacheRetention: "short" };

			expect(getPromptCacheTtlMs(model, options)).toBeUndefined();
			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("inactive");
				vi.advanceTimersByTime(270_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
		});

		test("a one-tier override schedules from its short lifetime without inheriting long", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-short-only.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    modelOverrides:",
					`      ${JSON.stringify(COPILOT_CACHE_MODEL)}:`,
					"        promptCache:",
					"          short: 90",
					"    models:",
					copilotModelDefinition({ short: 300, long: 3600 }),
					"",
				].join("\n"),
			);
			const model = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			const shortOptions: SimpleStreamOptions = { cacheRetention: "short" };
			const longOptions: SimpleStreamOptions = { cacheRetention: "long" };

			expect(model.promptCache).toEqual({ short: 90 });
			expect(getPromptCacheTtlMs(model, shortOptions)).toBe(90_000);
			expect(getPromptCacheTtlMs(model, longOptions)).toBeUndefined();

			const scheduledAt = Date.now();
			const armed = armRegistryModel(model, shortOptions);
			try {
				expect(armed.warmer.status.state).toBe("scheduled");
				expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 80_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
		});

		test("a custom model retains its explicit short and long lifetimes", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-custom.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    models:",
					copilotModelDefinition({ short: 300, long: 3600 }),
					"",
				].join("\n"),
			);
			const model = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);

			expect(model.promptCache).toEqual({ short: 300, long: 3600 });
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" })).toBe(300_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBe(3_600_000);
		});

		test("custom Copilot lifetime survives an unrelated override and provider fields", async () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-provider-rebuild.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    headers:",
					"      X-Regression: configured-custom-lifetime",
					"    modelOverrides:",
					`      ${JSON.stringify(COPILOT_CACHE_MODEL)}:`,
					"        maxTokens: 4321",
					"    models:",
					copilotModelDefinition({ short: 90 }),
					"",
				].join("\n"),
			);
			const options: SimpleStreamOptions = { cacheRetention: "short" };
			const model = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);

			expect((await registry.resolveModelHeaders(model))?.["X-Regression"]).toBe("configured-custom-lifetime");
			expect(getPromptCacheTtlMs(model, options)).toBe(90_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBeUndefined();
			expect(model.maxTokens).toBe(4321);

			const scheduledAt = Date.now();
			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("scheduled");
				expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 80_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}

			await registry.refresh("offline");
			const rebuiltModel = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			expect((await registry.resolveModelHeaders(rebuiltModel))?.["X-Regression"]).toBe(
				"configured-custom-lifetime",
			);
			expect(getPromptCacheTtlMs(rebuiltModel, options)).toBe(90_000);

			const rebuiltScheduledAt = Date.now();
			const rebuilt = armRegistryModel(rebuiltModel, options);
			try {
				expect(rebuilt.warmer.status.state).toBe("scheduled");
				expect(rebuilt.warmer.status.nextWarmAt).toBe(rebuiltScheduledAt + 80_000);
				expect(rebuilt.streamCalls()).toBe(0);
			} finally {
				rebuilt.warmer.cancel();
			}
		});

		test("runtime lifetime replacement outranks the matching YAML definition after offline rebuild", async () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-runtime-precedence.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    models:",
					copilotModelDefinition({ short: 90 }),
					"",
				].join("\n"),
			);
			expect(requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL).promptCache).toEqual({
				short: 90,
			});

			registry.registerProvider(
				"github-copilot",
				runtimeCopilotProvider({ short: 180 }),
				"ext://runtime-cache-lifetime",
			);
			const options: SimpleStreamOptions = { cacheRetention: "short" };
			const expectRuntimeLifetime = (model: Model) => {
				expect(model.promptCache).toEqual({ short: 180 });
				expect(getPromptCacheTtlMs(model, options)).toBe(180_000);

				const scheduledAt = Date.now();
				const armed = armRegistryModel(model, options);
				try {
					expect(armed.warmer.status.state).toBe("scheduled");
					expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 162_000);
					expect(armed.streamCalls()).toBe(0);
				} finally {
					armed.warmer.cancel();
				}
			};

			expectRuntimeLifetime(requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL));
			await registry.refresh("offline");
			expectRuntimeLifetime(requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL));
		});

		test("empty or absent runtime lifetime does not inherit YAML lifetimes", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-runtime-opt-out.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    models:",
					copilotModelDefinition({ short: 90 }),
					"",
				].join("\n"),
			);
			registry.registerProvider("github-copilot", runtimeCopilotProvider({}), "ext://runtime-cache-opt-out");

			const model = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			const options: SimpleStreamOptions = { cacheRetention: "short" };
			expect(model.promptCache).toEqual({});
			expect(getPromptCacheTtlMs(model, options)).toBeUndefined();

			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("inactive");
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
			registry.clearSourceRegistrations("ext://runtime-cache-opt-out");
			registry.registerProvider("github-copilot", runtimeCopilotProvider(), "ext://runtime-cache-absent");
			const modelWithoutLifetime = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			expect(modelWithoutLifetime.promptCache).toBeUndefined();
			expect(getPromptCacheTtlMs(modelWithoutLifetime, options)).toBeUndefined();
		});

		test("runtime API replacement drops a prior explicit lifetime when the new route has no cache policy", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-runtime-route-replacement.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    models:",
					copilotModelDefinition({ short: 300, long: 3600 }),
					"",
				].join("\n"),
			);
			const options: SimpleStreamOptions = { cacheRetention: "short" };
			const configuredModel = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			expect(getPromptCacheTtlMs(configuredModel, options)).toBe(300_000);

			registry.registerProvider(
				"github-copilot",
				runtimeCopilotProvider(undefined, "openai-completions"),
				"ext://runtime-cache-route-replacement",
			);
			const replacedModel = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			expect(replacedModel.api).toBe("openai-completions");
			expect(getPromptCacheTtlMs(replacedModel, options)).toBeUndefined();

			const armed = armRegistryModel(replacedModel, options);
			try {
				expect(armed.warmer.status.state).toBe("inactive");
			} finally {
				armed.warmer.cancel();
			}
		});

		test("model override lifetime remains highest priority over runtime and YAML definitions", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-override-precedence.yml",
				[
					"providers:",
					"  github-copilot:",
					"    baseUrl: https://api.githubcopilot.com",
					"    api: anthropic-messages",
					"    apiKey: TEST_KEY",
					"    modelOverrides:",
					`      ${JSON.stringify(COPILOT_CACHE_MODEL)}:`,
					"        promptCache:",
					"          short: 120",
					"    models:",
					copilotModelDefinition({ short: 90, long: 3600 }),
					"",
				].join("\n"),
			);
			registry.registerProvider(
				"github-copilot",
				runtimeCopilotProvider({ short: 180 }),
				"ext://runtime-cache-override",
			);
			const model = requireRegistryModel(registry, "github-copilot", COPILOT_CACHE_MODEL);
			const options: SimpleStreamOptions = { cacheRetention: "short" };

			expect(model.promptCache).toEqual({ short: 120 });
			expect(getPromptCacheTtlMs(model, options)).toBe(120_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBeUndefined();

			const scheduledAt = Date.now();
			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("scheduled");
				expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 108_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
		});
	});
});

interface ProviderFixture {
	provider: string;
	modelId: string;
	modelName: string;
	baseUrl: string;
	imageInputDecoder?: "stb";
}

interface ModelLookup {
	provider: string;
	modelId: string;
}

interface ModelSnapshot {
	provider: string;
	id: string;
	name: string;
	baseUrl: string | undefined;
	imageInputDecoder?: "stb";
}

function writeModelsYaml(file: "models.yml" | "models.yaml", fixture: ProviderFixture): void {
	const decoderLine = fixture.imageInputDecoder
		? `        imageInputDecoder: ${fixture.imageInputDecoder}`
		: undefined;
	fs.writeFileSync(
		path.join(tempDir.path(), file),
		[
			"providers:",
			`  ${fixture.provider}:`,
			`    baseUrl: ${fixture.baseUrl}`,
			"    apiKey: TEST_KEY",
			"    api: anthropic-messages",
			"    models:",
			`      - id: ${fixture.modelId}`,
			`        name: ${fixture.modelName}`,
			"        reasoning: false",
			fixture.imageInputDecoder ? "        input: [text, image]" : "        input: [text]",
			...(decoderLine ? [decoderLine] : []),
			"        cost:",
			"          input: 0",
			"          output: 0",
			"          cacheRead: 0",
			"          cacheWrite: 0",
			"        contextWindow: 100000",
			"        maxTokens: 8000",
			"",
		].join("\n"),
	);
}

function writeModelsJson(fixture: ProviderFixture): void {
	fs.writeFileSync(
		path.join(tempDir.path(), "models.json"),
		JSON.stringify({
			providers: {
				[fixture.provider]: {
					baseUrl: fixture.baseUrl,
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: fixture.modelId,
							name: fixture.modelName,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
						},
					],
				},
			},
		}),
	);
}

function loadDefaultRegistryModels(...lookups: ModelLookup[]): Array<ModelSnapshot | undefined> {
	const registry = new ModelRegistry(authStorage);
	return lookups.map(lookup => {
		const model = registry.find(lookup.provider, lookup.modelId);
		if (!model) return undefined;
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			baseUrl: model.baseUrl,
			imageInputDecoder: model.imageInputDecoder,
		};
	});
}
function createPromptCacheRegistry(filename: string, yaml: string): ModelRegistry {
	const modelsPath = path.join(tempDir.path(), filename);
	fs.writeFileSync(modelsPath, yaml);
	return new ModelRegistry(authStorage, modelsPath, {
		fetch: async () => {
			throw new Error("network disabled in prompt-cache configuration test");
		},
	});
}

function requireRegistryModel(registry: ModelRegistry, provider: string, modelId: string): Model {
	const configError = registry.getError();
	if (configError) throw configError;
	const model = registry.find(provider, modelId);
	if (!model) throw new Error(`Missing model ${provider}/${modelId}`);
	return model;
}

function copilotModelDefinition(promptCache: { short: number; long?: number }): string {
	return [
		`      - id: ${COPILOT_CACHE_MODEL}`,
		"        name: Configured Copilot cache fixture",
		"        api: anthropic-messages",
		"        reasoning: false",
		"        input: [text]",
		"        cost:",
		"          input: 3",
		"          output: 15",
		"          cacheRead: 0.3",
		"          cacheWrite: 3.75",
		"        promptCache:",
		`          short: ${promptCache.short}`,
		...(promptCache.long === undefined ? [] : [`          long: ${promptCache.long}`]),
		"        compat:",
		"          supportsLongCacheRetention: true",
		"        contextWindow: 200000",
		"        maxTokens: 8000",
	].join("\n");
}

function runtimeCopilotProvider(
	promptCache?: Model["promptCache"],
	api: NonNullable<ProviderConfigInput["api"]> = "anthropic-messages",
	baseUrl = "https://api.githubcopilot.com",
): ProviderConfigInput {
	return {
		baseUrl,
		apiKey: "TEST_KEY",
		api,
		models: [
			{
				id: COPILOT_CACHE_MODEL,
				name: "Runtime Copilot cache fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8000,
				...(promptCache !== undefined ? { promptCache } : {}),
				...(api === "anthropic-messages"
					? {
							compat: {
								supportsLongCacheRetention: true,
							},
						}
					: {}),
			},
		],
	};
}

function armRegistryModel(
	model: Model,
	options: SimpleStreamOptions,
): {
	warmer: CacheWarmer;
	streamCalls: () => number;
} {
	let streamCalls = 0;
	const warmer = new CacheWarmer({
		stream: () => {
			streamCalls++;
			throw new Error("unexpected paid cache refresh in schedule-only test");
		},
		getPromptTokens: () => 100_000,
		getMode: () => "streaming",
	});
	warmer.start({ model, context: { messages: [] }, options }, () => true);
	return { warmer, streamCalls: () => streamCalls };
}
