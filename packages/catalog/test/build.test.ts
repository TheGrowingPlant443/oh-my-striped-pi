import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDiscoveredModel, buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-striped-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-striped-pi/pi-catalog/effort";
import { readModelCache, writeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { fingerprintStaticModels, resolveProviderModels } from "@oh-my-striped-pi/pi-catalog/model-manager";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-striped-pi/pi-catalog/provider-models/bundled-references";
import type { Api, Model, ModelSpec } from "@oh-my-striped-pi/pi-catalog/types";

function completionsSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id: "some-model",
		name: "Some Model",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function responsesSpec(overrides: Partial<ModelSpec<"openai-responses">> = {}): ModelSpec<"openai-responses"> {
	return {
		id: "some-model",
		name: "Some Model",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...overrides,
	};
}

describe("buildModel", () => {
	it("keeps aliased discovery on the retained Copilot backend policy across rebuilds", () => {
		const raw = responsesSpec({
			id: "gpt-5.5",
			provider: "workbench",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: true,
		});
		const discovered = buildDiscoveredModel(raw, "github-copilot");
		expect(discovered).toMatchObject({
			provider: "workbench",
			providerType: "github-copilot",
			api: "openai-responses",
			compat: { supportsStrictMode: true },
		});
		expect(buildModel(toModelSpec(discovered))).toEqual(discovered);
	});

	it("resolves a complete compat record for an openai-completions spec with no compat", () => {
		const model = buildModel(completionsSpec());

		expect(model.compat).toBeDefined();
		expect(typeof model.compat.supportsStore).toBe("boolean");
		expect(model.compat.maxTokensField).toBe("max_completion_tokens");
		expect(model.compat.thinkingFormat).toBe("openai");
		expect(model.compatConfig).toBeUndefined();
	});

	it("built models survive a JSON roundtrip, so generator-materialized rows need no rebuild", () => {
		// models.ts consumes models.json rows verbatim as complete Models; this
		// holds only if buildModel output is pure JSON (no functions, no
		// undefined-valued fields that JSON would drop).
		const generated = [buildModel(completionsSpec({ reasoning: true })), buildModel(responsesSpec())];
		for (const model of generated) {
			expect(JSON.parse(JSON.stringify(model)) as Model<Api>).toEqual(model);
		}
	});

	it("lets sparse overrides win over detection and keeps the verbatim config", () => {
		const sparse = { supportsDeveloperRole: true } as const;
		const model = buildModel(
			completionsSpec({
				provider: "groq",
				baseUrl: "https://api.groq.com/openai/v1",
				compat: sparse,
			}),
		);

		// Detection would say false for a non-OpenAI host; the override wins.
		expect(model.compat.supportsDeveloperRole).toBe(true);
		// The verbatim sparse object is preserved by reference.
		expect(model.compatConfig).toBe(sparse);
	});

	it("leaves whenThinking undefined for non-opencode reasoning specs", () => {
		const model = buildModel(completionsSpec({ reasoning: true }));
		expect(model.compat.whenThinking).toBeUndefined();
	});

	it("materializes glyph-tokenization eligibility for Anthropic-compatible wire models", () => {
		const anthropic = buildModel({
			id: "claude-opus-4-8",
			name: "Some Model",
			api: "anthropic-messages",
			provider: "anthropic-compatible",
			baseUrl: "https://api.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});

		expect(anthropic.requiresGlyphTokenization).toBe(true);
		expect(buildModel(completionsSpec()).requiresGlyphTokenization).toBe(false);
		expect(buildModel({ ...completionsSpec(), id: "claude-opus-4-8" }).requiresGlyphTokenization).toBe(true);
		expect(
			buildModel({
				id: "other-model",
				name: "Other Model",
				api: "anthropic-messages",
				provider: "anthropic-compatible",
				baseUrl: "https://api.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			}).requiresGlyphTokenization,
		).toBe(false);
		expect(getBundledModel("github-copilot", "claude-opus-4.8").requiresGlyphTokenization).toBe(true);
	});

	it("strips gateway author prefixes and extrinsic tags from display names", () => {
		const cases: [string, string][] = [
			["Anthropic: Claude Opus 4.6 (Fast) ($$$$)", "Claude Opus 4.6 (Fast)"],
			["Claude Opus 4.5 (latest)", "Claude Opus 4.5"],
			["Gemini 2.5 Flash (Thinking) (Antigravity)", "Gemini 2.5 Flash (Thinking)"],
			["Stealth: Claude Opus 4.6 (20% off)", "Claude Opus 4.6"],
			["NousResearch: Hermes 2 Pro (retires Jun 5)", "Hermes 2 Pro"],
			["Z.ai: GLM 5", "GLM 5"],
		];
		for (const [raw, cleaned] of cases) {
			expect(buildModel(completionsSpec({ name: raw })).name).toBe(cleaned);
		}
	});

	it("keeps variant tags that map to distinct wire ids", () => {
		const keep = [
			"Trinity Large Preview (free)",
			"Grok 4.1 Fast (Non-Reasoning)",
			"GPT-4o (2024-08-06)",
			"Claude Haiku 3.5 (EU)",
			"Llama-3.3+(3.1v3.3)-70B-Hanami-x1",
		];
		for (const name of keep) {
			expect(buildModel(completionsSpec({ name })).name).toBe(name);
		}
	});
	it("requires explicit computer-use capability rather than inferring it from a provider", () => {
		const spec = responsesSpec({ id: "gpt-5.6-terra", provider: "github-copilot", reasoning: true });
		expect(buildModel(spec).supportsComputerUse).toBe(false);
		expect(buildModel({ ...spec, supportsComputerUse: true }).supportsComputerUse).toBe(true);
		expect(buildModel({ ...spec, supportsComputerUse: false }).supportsComputerUse).toBe(false);
	});
	it("preserves explicit computer capability when a built model is rerouted", () => {
		const direct = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses" as const,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		} satisfies ModelSpec<"openai-responses">;
		const reroute = (model: Model<"openai-responses">, baseUrl: string) =>
			buildModel({ ...model, baseUrl, compat: model.compatConfig } as ModelSpec<"openai-responses">);

		expect(reroute(buildModel(direct), "https://gateway.example/v1").supportsComputerUse).toBe(false);
		const inferred = buildModel(direct);
		expect(
			buildModel({
				...inferred,
				provider: "gpt-proxy",
				compat: inferred.compatConfig,
			} as ModelSpec<"openai-responses">).supportsComputerUse,
		).toBe(false);
		expect(
			reroute(buildModel({ ...direct, supportsComputerUse: true }), "https://gateway.example/v1")
				.supportsComputerUse,
		).toBe(true);
		expect(reroute(buildModel({ ...direct, supportsComputerUse: false }), direct.baseUrl).supportsComputerUse).toBe(
			false,
		);
	});

	it("materializes an explicit thinking variant without mutating its base compatibility", () => {
		const model = buildModel(
			completionsSpec({
				reasoning: true,
				compat: { whenThinking: { requiresReasoningContentForToolCalls: true } },
			}),
		);
		expect(model.compat.requiresReasoningContentForToolCalls).toBe(false);
		expect(model.compat.whenThinking?.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("classifies custom local endpoints without a built-in backend provider", () => {
		for (const baseUrl of ["http://127.0.0.1:8080/v1", "http://192.168.1.10/v1", "http://box.local./v1"]) {
			for (const spec of [completionsSpec({ baseUrl }), responsesSpec({ baseUrl })]) {
				const compat = buildModel(spec).compat;
				expect(compat.clampOutputToModelMax).toBe(true);
				expect(compat.streamFirstEventTimeoutMs).toBe(0);
				expect(compat.streamIdleTimeoutMs).toBe(300000);
			}
		}
		expect(buildModel(responsesSpec()).compat.clampOutputToModelMax).toBe(false);
	});
});

describe("openai-completions wire-quirk compat detection", () => {
	it("keeps image input for the natively multimodal DeepSeek V4.1 Flash lineage", () => {
		// DeepSeek V4.1 Flash is image-text-to-text, but its id carries no
		// `vision` token, so the class-wide strip rule dropped every attachment
		// the model reads on hosts without their own carve-out.
		expect(
			resolveModelPolicy(completionsSpec({ provider: "vllm", id: "deepseek-v4.1-flash", input: ["text", "image"] }))
				.compat.stripImageInput,
		).toBe(false);
		// Hosts that were carved out individually must keep working without them.
		expect(
			resolveModelPolicy(
				completionsSpec({
					provider: "openrouter",
					id: "deepseek/deepseek-v4.1-flash",
					baseUrl: "https://openrouter.ai/api/v1",
					input: ["text", "image"],
				}),
			).compat.stripImageInput,
		).toBe(false);
		// Text-only DeepSeek SKUs keep the wire guard.
		expect(
			resolveModelPolicy(completionsSpec({ provider: "vllm", id: "deepseek-v4-flash", input: ["text", "image"] }))
				.compat.stripImageInput,
		).toBe(true);
		// The lineage glob covers dated SKUs, not just the bare id.
		expect(
			resolveModelPolicy(
				completionsSpec({ provider: "vllm", id: "deepseek-v4.1-flash-0731", input: ["text", "image"] }),
			).compat.stripImageInput,
		).toBe(false);
		// A V4.1 id that also carries a `vision` token matches both exceptions at
		// equal rank; the explicit priority keeps that resolvable instead of
		// throwing AmbiguousOverlapError.
		expect(
			resolveModelPolicy(
				completionsSpec({ provider: "vllm", id: "deepseek-v4.1-flash-vision-exp", input: ["text", "image"] }),
			).compat.stripImageInput,
		).toBe(false);
		// Non-Flash V4.1 lineages are not established as multimodal and keep the guard.
		expect(
			resolveModelPolicy(completionsSpec({ provider: "vllm", id: "deepseek-v4.1-pro", input: ["text", "image"] }))
				.compat.stripImageInput,
		).toBe(true);
	});

	it("flags cumulative reasoning deltas for MiniMax provider or id", () => {
		expect(resolveModelPolicy(completionsSpec({ id: "MiniMax-M2" })).compat.reasoningDeltasMayBeCumulative).toBe(
			true,
		);
		expect(resolveModelPolicy(completionsSpec()).compat.reasoningDeltasMayBeCumulative).toBe(false);
	});
});

describe("Responses configuration_update compat", () => {
	/** The gpt-6-astra id served by a custom Responses-compatible proxy. */
	function astraProxySpec(overrides: Partial<ModelSpec<"openai-responses">> = {}): ModelSpec<"openai-responses"> {
		return responsesSpec({
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			provider: "astra-proxy",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			contextWindow: 400_000,
			maxTokens: 128_000,
			...overrides,
		});
	}

	it("turns supportsConfigurationUpdate on for the GPT-6 family on any host and leaves GPT-5.6 off", () => {
		// The class rule is keyed on the GPT-6 revision, not on the host: a custom
		// proxy serving any GPT-6 id gets the item, earlier generations never do.
		for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]) {
			expect(buildModel(astraProxySpec({ id, name: id })).compat.supportsConfigurationUpdate).toBe(true);
		}
		expect(
			buildModel(astraProxySpec({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" })).compat.supportsConfigurationUpdate,
		).toBe(false);
	});

	it("lets a spec-level compat override switch configuration_update off for a custom endpoint", () => {
		// Spec-authored overrides are the last compat layer, so a models.yml
		// `compat.supportsConfigurationUpdate: false` beats the class rule.
		const model = buildModel(astraProxySpec({ compat: { supportsConfigurationUpdate: false } }));
		expect(model.compat.supportsConfigurationUpdate).toBe(false);
	});
});

describe("GitHub Copilot catalog corrections", () => {
	it("prices Copilot Haiku 5.5 cache legs per tier without a second long-context tier", () => {
		// `billing.token_prices` carries no cache prices for Haiku 5.5, so both
		// discovered tiers arrive with $0 cache legs.
		const base = buildModel(
			completionsSpec({
				id: "claude-haiku-5.5",
				provider: "github-copilot",
				cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		expect(base.cost).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
		// The `-1m` sibling is the long tier itself; a nested tier would charge it 5x twice.
		const long = buildModel(
			completionsSpec({
				id: "claude-haiku-5.5-1m",
				provider: "github-copilot",
				cost: { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		expect(long.cost).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 });
	});
});

describe("model cache materialized round trip", () => {
	it("fingerprints current static content without mutating caller arrays", () => {
		const staticModels = [completionsSpec({ id: "fingerprint-model" })];
		const initial = fingerprintStaticModels(staticModels);
		staticModels[0]!.name = "Changed in place";
		expect(fingerprintStaticModels(staticModels)).not.toBe(initial);

		const frozen = Object.freeze([completionsSpec({ id: "frozen-fingerprint-model" })]);
		expect(() => fingerprintStaticModels(frozen)).not.toThrow();
	});

	it("uses generator-materialized bundled rows without rebuilding them", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-bundled-models-"));
		const bundled = getBundledModel("github-copilot", "claude-fable-5.1");
		try {
			const offline = await resolveProviderModels(
				{ providerId: "github-copilot", cacheDbPath: path.join(tempDir, "models.db") },
				"offline",
			);
			expect(offline.models.find(model => model.id === bundled.id)).toBe(bundled);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("persists and directly restores fully resolved models", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-model-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const sparse = { supportsDeveloperRole: true } as const;
		const spec = completionsSpec({ provider: "spec-cache-test", compat: sparse });
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => [spec],
				},
				"online",
			);
			expect(online.models[0]?.compat.supportsDeveloperRole).toBe(true);

			// The persisted row is the resolved model, while retaining the sparse
			// authoring provenance needed by later explicit override rebuilds.
			const db = new Database(dbPath);
			const row = db
				.query<{ models: string }, [string]>("SELECT models FROM model_cache WHERE provider_id = ?")
				.get("spec-cache-test");
			expect(row).toBeDefined();
			const persisted = JSON.parse(row?.models ?? "[]") as Model<"openai-completions">[];
			expect(persisted[0]?.compat.supportsDeveloperRole).toBe(true);
			expect(persisted[0]?.compatConfig).toEqual(sparse);
			expect(persisted[0]?.identity).toEqual(online.models[0]?.identity);
			// A compatible materialized row is trusted rather than sent back
			// through buildModel. Policy changes invalidate the whole row instead.
			persisted[0]!.compat.supportsDeveloperRole = false;
			db.run("UPDATE model_cache SET models = ? WHERE provider_id = ?", [
				JSON.stringify(persisted),
				"spec-cache-test",
			]);
			db.close();
			const offline = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
				},
				"offline",
			);
			const model = offline.models.find(candidate => candidate.id === spec.id);
			expect(model?.compat.supportsDeveloperRole).toBe(false);
			expect(model?.compatConfig).toEqual(sparse);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps local runner kinds when authoritative chat discovery collides or empties", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-kind-discovery-"));
		const providerId = "kind-discovery-test";
		const runner: ModelSpec = {
			...completionsSpec({ id: "speech-collision", provider: providerId }),
			kind: "tts",
			api: "local-inference",
			supportsTools: false,
		};
		const transcription: ModelSpec = { ...runner, id: "transcription-static-only", kind: "stt" };
		let discovered: ModelSpec[] = [
			completionsSpec({ id: runner.id, provider: providerId }),
			completionsSpec({ id: "live-chat", provider: providerId }),
			{ ...runner, id: "live-speech" },
		];
		const options = {
			providerId,
			staticModels: [runner, transcription, completionsSpec({ id: "retired-chat", provider: providerId })],
			dynamicModelsAuthoritative: true,
			cacheDbPath: path.join(tempDir, "models.db"),
			fetchDynamicModels: async () => discovered,
		};
		try {
			const refreshed = await resolveProviderModels(options, "online");
			expect(refreshed.models.map(model => model.id).sort()).toEqual([
				"live-chat",
				"live-speech",
				runner.id,
				transcription.id,
			]);
			expect(refreshed.models.find(model => model.id === runner.id)).toMatchObject({
				kind: "tts",
				api: "local-inference",
				supportsTools: false,
			});
			const cached = await resolveProviderModels(options, "offline");
			expect(cached.models.find(model => model.id === runner.id)?.api).toBe("local-inference");
			discovered = [{ ...runner, name: "Refreshed Speech", contextWindow: 32000 }];
			const explicitRefresh = await resolveProviderModels(options, "online");
			expect(explicitRefresh.models.find(model => model.id === runner.id)).toMatchObject({
				name: "Refreshed Speech",
				kind: "tts",
				contextWindow: 32000,
			});
			discovered = [];
			const emptied = await resolveProviderModels(options, "online");
			expect(emptied.models.map(model => model.id).sort()).toEqual([runner.id, transcription.id]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves static long-context pricing through dynamic refresh and cache restore", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-tiered-cost-"));
		const dbPath = path.join(tempDir, "models.db");
		const staticModel = completionsSpec({
			id: "tiered-model",
			provider: "tiered-cost-test",
			cost: {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				longContext: {
					inputThreshold: 272_000,
					input: 2,
					output: 3,
					cacheRead: 0.2,
					cacheWrite: 2.5,
				},
			},
		});
		const dynamicModel = completionsSpec({
			...staticModel,
			cost: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		const options = {
			providerId: "tiered-cost-test",
			staticModels: [staticModel],
			cacheDbPath: dbPath,
		};
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => [dynamicModel] },
				"online",
			);
			expect(online.models[0]?.cost).toEqual({
				...dynamicModel.cost,
				longContext: staticModel.cost.longContext,
			});

			const offline = await resolveProviderModels<"openai-completions">(options, "offline");
			expect(offline.models[0]?.cost.longContext).toEqual(staticModel.cost.longContext);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores rows materialized under a stale build or rules policy without deleting them", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-stale-policy-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const model = buildModel(completionsSpec({ provider: "stale-policy-cache-test" }));
		try {
			writeModelCache("stale-policy-cache-test", Date.now(), [model], true, "", dbPath);
			writeModelCache("other-policy-cache-test", Date.now(), [model], true, "", dbPath);
			const db = new Database(dbPath);
			db.run("UPDATE model_cache SET materialization_policy = ?", ["stale-builder:stale-rules"]);
			db.close();

			// Another app version's rows read as absent but are not mass-deleted on
			// open; each provider's next write replaces its own row lazily.
			expect(readModelCache("stale-policy-cache-test", Infinity, Date.now, dbPath)).toBeNull();
			const countRows = () => {
				const verified = new Database(dbPath, { readonly: true });
				const row = verified.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache").get();
				verified.close();
				return row?.count;
			};
			expect(countRows()).toBe(2);

			writeModelCache("stale-policy-cache-test", Date.now(), [model], true, "", dbPath);
			expect(readModelCache("stale-policy-cache-test", Infinity, Date.now, dbPath)?.models).toHaveLength(1);
			expect(readModelCache("other-policy-cache-test", Infinity, Date.now, dbPath)).toBeNull();
			expect(countRows()).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("invalidates schema-v10 rows that predate computer-use capability provenance", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-legacy-computer-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const model = buildModel({
			id: "legacy-inferred-computer",
			name: "Legacy inferred computer",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		} satisfies ModelSpec<"openai-responses">);
		try {
			writeModelCache("legacy-computer-cache-test", Date.now(), [model], true, "", dbPath);
			const db = new Database(dbPath);
			db.run("UPDATE model_cache SET version = 10 WHERE provider_id = ?", ["legacy-computer-cache-test"]);
			db.close();

			expect(readModelCache("legacy-computer-cache-test", Infinity, Date.now, dbPath)).toBeNull();
			const verified = new Database(dbPath, { readonly: true });
			const row = verified.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache").get();
			verified.close();
			expect(row?.count).toBe(0);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps header-free v11/v12 rows until their own provider is rewritten", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-v12-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const model = buildModel(completionsSpec({ provider: "v12-cache-test" }));
		try {
			writeModelCache("v11-cache-test", Date.now(), [model], true, "", dbPath);
			writeModelCache("v12-cache-test", Date.now(), [model], true, "", dbPath);
			writeModelCache("current-cache-test", Date.now(), [model], true, "", dbPath);
			const db = new Database(dbPath);
			db.run("UPDATE model_cache SET version = 11 WHERE provider_id = ?", ["v11-cache-test"]);
			db.run("UPDATE model_cache SET version = 12 WHERE provider_id = ?", ["v12-cache-test"]);
			db.close();
			const versions = () => {
				const verified = new Database(dbPath, { readonly: true });
				const rows = verified
					.query<{ provider_id: string; version: number }, []>(
						"SELECT provider_id, version FROM model_cache ORDER BY provider_id",
					)
					.all();
				verified.close();
				return Object.fromEntries(rows.map(row => [row.provider_id, row.version]));
			};

			const current = versions()["current-cache-test"];

			// Opening the cache for an unrelated provider must not purge them.
			expect(readModelCache("current-cache-test", Infinity, Date.now, dbPath)?.models).toHaveLength(1);
			expect(readModelCache("v12-cache-test", Infinity, Date.now, dbPath)).toBeNull();
			expect(versions()).toEqual({ "current-cache-test": current, "v11-cache-test": 11, "v12-cache-test": 12 });

			writeModelCache("v12-cache-test", Date.now(), [model], true, "", dbPath);
			expect(readModelCache("v12-cache-test", Infinity, Date.now, dbPath)?.models).toHaveLength(1);
			expect(versions()).toEqual({ "current-cache-test": current, "v11-cache-test": 11, "v12-cache-test": current });
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves computer-use provenance across cache restarts and endpoint reroutes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-computer-use-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const common = {
			name: "GPT-5.4",
			requestModelId: "gpt-5.4",
			api: "openai-responses" as const,
			reasoning: true,
			input: ["text", "image"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
		const direct = {
			...common,
			id: "inferred-direct",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		} satisfies ModelSpec<"openai-responses">;
		const proxy = {
			...common,
			id: "inferred-proxy",
			provider: "gpt-proxy",
			baseUrl: "https://gateway.example/v1",
		} satisfies ModelSpec<"openai-responses">;
		const explicitTrue = { ...direct, id: "explicit-true", supportsComputerUse: true };
		const explicitFalse = { ...proxy, id: "explicit-false", supportsComputerUse: false };
		const reroute = (model: Model<"openai-responses">, provider: string, baseUrl: string) =>
			buildModel({ ...model, provider, baseUrl, compat: model.compatConfig } as ModelSpec<"openai-responses">);

		try {
			await resolveProviderModels<"openai-responses">(
				{
					providerId: "computer-use-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => [direct, proxy, explicitTrue, explicitFalse],
				},
				"online",
			);

			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ models: string }, [string]>("SELECT models FROM model_cache WHERE provider_id = ?")
				.get("computer-use-cache-test");
			db.close();
			const persisted = JSON.parse(row?.models ?? "[]") as Array<Record<string, unknown>>;
			expect(persisted.find(model => model.id === direct.id)?.supportsComputerUseConfig).toBeNull();
			expect(persisted.find(model => model.id === proxy.id)?.supportsComputerUseConfig).toBeNull();
			expect(persisted.find(model => model.id === explicitTrue.id)?.supportsComputerUseConfig).toBe(true);
			expect(persisted.find(model => model.id === explicitFalse.id)?.supportsComputerUseConfig).toBe(false);

			const offline = await resolveProviderModels<"openai-responses">(
				{ providerId: "computer-use-cache-test", staticModels: [], cacheDbPath: dbPath },
				"offline",
			);
			const byId = new Map(offline.models.map(model => [model.id, model]));
			const cachedDirect = byId.get(direct.id);
			const cachedProxy = byId.get(proxy.id);
			const cachedExplicitTrue = byId.get(explicitTrue.id);
			const cachedExplicitFalse = byId.get(explicitFalse.id);
			expect(cachedDirect?.supportsComputerUseConfig).toBeUndefined();
			expect(cachedProxy?.supportsComputerUseConfig).toBeUndefined();
			expect(reroute(cachedDirect!, "gpt-proxy", proxy.baseUrl).supportsComputerUse).toBe(false);
			expect(reroute(cachedProxy!, "custom", direct.baseUrl).supportsComputerUse).toBe(false);
			expect(cachedExplicitTrue?.supportsComputerUseConfig).toBe(true);
			expect(cachedExplicitFalse?.supportsComputerUseConfig).toBe(false);
			expect(reroute(cachedExplicitTrue!, "gpt-proxy", proxy.baseUrl).supportsComputerUse).toBe(true);
			expect(reroute(cachedExplicitFalse!, "openai", direct.baseUrl).supportsComputerUse).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("uses current static limits for same-id cache rows when the static fingerprint changed", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-static-fingerprint-"));
		const dbPath = path.join(tempDir, "models.db");
		const staleSameId = buildModel(
			completionsSpec({
				id: "catalog-updated-model",
				name: "Catalog Updated Model (cached)",
				provider: "spec-cache-test",
				contextWindow: 64_000,
				maxTokens: 4_000,
			}),
		);
		const cachedOnly = buildModel(
			completionsSpec({
				id: "cache-only-model",
				name: "Cache Only Model",
				provider: "spec-cache-test",
				contextWindow: 96_000,
				maxTokens: 6_000,
			}),
		);
		const updatedStatic = completionsSpec({
			id: staleSameId.id,
			name: "Catalog Updated Model",
			provider: "spec-cache-test",
			contextWindow: 256_000,
			maxTokens: 32_000,
		});

		try {
			writeModelCache(
				"spec-cache-test",
				Date.now(),
				[staleSameId, cachedOnly],
				true,
				"merge-v3:stale-static-catalog",
				dbPath,
			);

			const offline = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [updatedStatic],
					cacheDbPath: dbPath,
				},
				"offline",
			);

			const sameId = offline.models.find(candidate => candidate.id === updatedStatic.id);
			expect(sameId?.contextWindow).toBe(256_000);
			expect(sameId?.maxTokens).toBe(32_000);

			const cacheOnly = offline.models.find(candidate => candidate.id === cachedOnly.id);
			expect(cacheOnly?.contextWindow).toBe(96_000);
			expect(cacheOnly?.maxTokens).toBe(6_000);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("retries an empty discovery result after the short interval and caches recovery", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-empty-discovery-"));
		const dbPath = path.join(tempDir, "models.db");
		const recoveredModel = completionsSpec({ id: "recovered-model", provider: "empty-discovery-test" });
		let discoveredModels: readonly ModelSpec<"openai-completions">[] = [];
		let fetches = 0;
		let currentTime = 1_000_000;
		const options = {
			providerId: "empty-discovery-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			now: () => currentTime,
			fetchDynamicModels: async () => {
				fetches++;
				return discoveredModels;
			},
		};
		try {
			const empty = await resolveProviderModels(options, "online");
			expect(empty.models).toEqual([]);
			// Authoritative for the cycle (drives downstream pruning) yet not pinned
			// into the cache as authoritative (keeps the short retry interval).
			expect(empty.stale).toBe(false);
			expect(fetches).toBe(1);

			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ authoritative: number }, [string]>("SELECT authoritative FROM model_cache WHERE provider_id = ?")
				.get(options.providerId);
			db.close();
			expect(row?.authoritative).toBe(0);

			discoveredModels = [recoveredModel];
			currentTime += 5 * 60 * 1_000 - 1;
			const beforeRetry = await resolveProviderModels(options, "online-if-uncached");
			expect(beforeRetry.models).toEqual([]);
			expect(fetches).toBe(1);

			currentTime++;
			const recovered = await resolveProviderModels(options, "online-if-uncached");
			expect(recovered.models.map(model => model.id)).toEqual([recoveredModel.id]);
			expect(recovered.stale).toBe(false);
			expect(fetches).toBe(2);

			currentTime++;
			const cached = await resolveProviderModels(options, "online-if-uncached");
			expect(cached.models.map(model => model.id)).toEqual([recoveredModel.id]);
			expect(cached.stale).toBe(false);
			expect(fetches).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("refreshes an existing empty cache row when discovery fails to preserve retry backoff", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-empty-failure-backoff-"));
		const dbPath = path.join(tempDir, "models.db");
		const recoveredModel = completionsSpec({ id: "recovered-model", provider: "empty-failure-backoff-test" });
		let discoveredModels: readonly ModelSpec<"openai-completions">[] | null = [];
		let fetches = 0;
		let currentTime = 1_000_000;
		const options = {
			providerId: "empty-failure-backoff-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			now: () => currentTime,
			fetchDynamicModels: async () => {
				fetches++;
				return discoveredModels;
			},
		};
		try {
			const empty = await resolveProviderModels(options, "online");
			expect(empty.models).toEqual([]);
			expect(fetches).toBe(1);

			currentTime += 5 * 60 * 1_000;
			discoveredModels = null;
			const failedRefresh = await resolveProviderModels(options, "online-if-uncached");
			expect(failedRefresh.models).toEqual([]);
			expect(fetches).toBe(2);

			// The failed refresh advances the existing empty row's timestamp, so
			// another launch waits for the normal backoff instead of retrying now.
			discoveredModels = [recoveredModel];
			const backedOff = await resolveProviderModels(options, "online-if-uncached");
			expect(backedOff.models).toEqual([]);
			expect(fetches).toBe(2);

			currentTime += 5 * 60 * 1_000;
			const recovered = await resolveProviderModels(options, "online-if-uncached");
			expect(recovered.models.map(model => model.id)).toEqual([recoveredModel.id]);
			expect(fetches).toBe(3);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("does not cache an empty row when discovery fails, so the next launch retries immediately (#10964)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-failed-discovery-"));
		const dbPath = path.join(tempDir, "models.db");
		const recoveredModel = completionsSpec({ id: "vendor-7/model-7", provider: "failed-discovery-test" });
		let fetches = 0;
		let fail = true;
		const currentTime = 1_000_000;
		const options = {
			providerId: "failed-discovery-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			now: () => currentTime,
			fetchDynamicModels: async () => {
				fetches++;
				// A timeout/network failure surfaces to the manager as null (distinct
				// from a successful but empty [] catalog, which stays cached).
				return fail ? null : [recoveredModel];
			},
		};
		try {
			const failed = await resolveProviderModels(options, "online");
			expect(failed.models).toEqual([]);
			expect(fetches).toBe(1);

			// With no prior catalog and nothing static, the failure writes no cache
			// row. Had it persisted an empty non-authoritative snapshot, the next
			// launch inside the 5-min window would serve that empty catalog and skip
			// discovery, hiding every discovery-only model. The clock does not advance,
			// so a retry here proves the row is absent rather than aged out.
			fail = false;
			const recovered = await resolveProviderModels(options, "online-if-uncached");
			expect(recovered.models.map(model => model.id)).toEqual([recoveredModel.id]);
			expect(recovered.stale).toBe(false);
			expect(fetches).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("reports an authoritative catalog emptying as non-stale so removed models prune", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-empty-transition-"));
		const dbPath = path.join(tempDir, "models.db");
		const model = completionsSpec({ id: "going-away", provider: "empty-transition-test" });
		let discoveredModels: readonly ModelSpec<"openai-completions">[] = [model];
		const options = {
			providerId: "empty-transition-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => discoveredModels,
		};
		try {
			const populated = await resolveProviderModels(options, "online");
			expect(populated.models.map(candidate => candidate.id)).toEqual([model.id]);
			expect(populated.stale).toBe(false);

			discoveredModels = [];
			const emptied = await resolveProviderModels(options, "online");
			expect(emptied.models).toEqual([]);
			// The successful empty fetch must stay authoritative so ModelRegistry
			// prunes the removed model instead of leaving it selectable forever.
			expect(emptied.stale).toBe(false);

			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ authoritative: number }, [string]>("SELECT authoritative FROM model_cache WHERE provider_id = ?")
				.get(options.providerId);
			db.close();
			expect(row?.authoritative).toBe(0);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("restores static model headers on fresh cache reads", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-static-headers-"));
		const dbPath = path.join(tempDir, "models.db");
		const staticModel = completionsSpec({
			id: "header-static-model",
			provider: "header-cache-test",
			headers: { "X-Project-Id": "project-42" },
		});
		let fetches = 0;
		const options = {
			providerId: "header-cache-test",
			staticModels: [staticModel],
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => {
				fetches++;
				return [];
			},
		};
		try {
			const online = await resolveProviderModels(options, "online");
			expect(online.models[0]?.headers).toEqual({ "X-Project-Id": "project-42" });
			expect(fetches).toBe(1);

			const offline = await resolveProviderModels(options, "offline");
			expect(offline.models[0]?.headers).toEqual({ "X-Project-Id": "project-42" });
			expect(fetches).toBe(1);

			const fresh = await resolveProviderModels(options, "online-if-uncached");
			expect(fresh.models[0]?.headers).toEqual({ "X-Project-Id": "project-42" });
			expect(fetches).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("refetches dynamic-only models whose headers cannot be restored", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-dynamic-headers-"));
		const dbPath = path.join(tempDir, "models.db");
		const dynamicModel = completionsSpec({
			id: "header-dynamic-model",
			provider: "header-cache-test",
			headers: { "X-Required-Route": "route-42" },
		});
		let fetches = 0;
		const options = {
			providerId: "header-cache-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => {
				fetches++;
				return [dynamicModel];
			},
		};
		try {
			const online = await resolveProviderModels(options, "online");
			expect(online.models[0]?.headers).toEqual({ "X-Required-Route": "route-42" });
			expect(fetches).toBe(1);

			const fresh = await resolveProviderModels(options, "online-if-uncached");
			expect(fresh.models[0]?.headers).toEqual({ "X-Required-Route": "route-42" });
			expect(fetches).toBe(2);

			const offline = await resolveProviderModels(options, "offline");
			expect(offline.models).toEqual([]);
			expect(offline.stale).toBe(true);
			expect(fetches).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a synthesized request-model variant across an offline restart", async () => {
		// Regression for #6037/#6284: Copilot `-1m` long-context variants are
		// synthesized dynamically with transport headers and a `requestModelId`
		// pointing at a same-provider base. Their headers are omitted from the
		// cache but recoverable from the base's static headers, so they must NOT
		// be flagged unrestorable and dropped on the next offline read.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-request-model-variant-"));
		const dbPath = path.join(tempDir, "models.db");
		const headers = { "X-GitHub-Api-Version": "2026-06-01" };
		const base = completionsSpec({ id: "sol", provider: "variant-cache-test", headers });
		const variant = completionsSpec({
			id: "sol-1m",
			provider: "variant-cache-test",
			requestModelId: "sol",
			headers,
			contextWindow: 1_000_000,
		});
		const options = {
			providerId: "variant-cache-test",
			staticModels: [base],
			cacheDbPath: dbPath,
		};
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => [base, variant] },
				"online",
			);
			expect(online.models.find(candidate => candidate.id === "sol-1m")).toBeDefined();

			const offline = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => null },
				"offline",
			);
			const restored = offline.models.find(candidate => candidate.id === "sol-1m");
			expect(restored).toBeDefined();
			expect(restored?.headers).toEqual(headers);
			expect(offline.models.find(candidate => candidate.id === "sol")?.headers).toEqual(headers);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("refetches a current request-model alias whose headers differ from its static base", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-custom-alias-"));
		const dbPath = path.join(tempDir, "models.db");
		const baseHeaders = { "X-Route": "static" };
		const customHeaders = { "X-Route": "tenant-specific" };
		const base = completionsSpec({ id: "base", provider: "alias-cache-test", headers: baseHeaders });
		const aliasSpec = completionsSpec({
			id: "custom-alias",
			provider: "alias-cache-test",
			requestModelId: "base",
			headers: customHeaders,
		});
		const alias = buildModel(aliasSpec);
		let fetches = 0;
		const options = {
			providerId: "alias-cache-test",
			staticModels: [base],
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => {
				fetches++;
				return [aliasSpec];
			},
		};
		try {
			writeModelCache("alias-cache-test", Date.now(), [alias], true, "", dbPath, [buildModel(base)]);

			const refreshed = await resolveProviderModels<"openai-completions">(options, "online-if-uncached");
			expect(fetches).toBe(1);
			expect(refreshed.models.find(candidate => candidate.id === alias.id)?.headers).toEqual(customHeaders);

			const offline = await resolveProviderModels<"openai-completions">(options, "offline");
			expect(offline.models.find(candidate => candidate.id === alias.id)).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("recovers a legacy stale-marked request-model variant via requestModelId", async () => {
		// Legacy cache rows (written by the old id-only writer) flag `-1m`
		// variants unrestorable because it never matched their base's headers.
		// The restore path must still recover them through `requestModelId`.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-legacy-variant-"));
		const dbPath = path.join(tempDir, "models.db");
		const headers = { "X-GitHub-Api-Version": "2026-06-01" };
		const base = completionsSpec({ id: "sol", provider: "variant-cache-test", headers });
		const variant = buildModel(
			completionsSpec({
				id: "sol-1m",
				provider: "variant-cache-test",
				requestModelId: "sol",
				headers,
				contextWindow: 1_000_000,
			}),
		);
		try {
			// Emulate a legacy write: no static header source, so the variant is
			// flagged unrestorable even though its base carries the headers.
			writeModelCache("variant-cache-test", Date.now(), [variant], true, "", dbPath);
			const db = new Database(dbPath);
			db.run("UPDATE model_cache SET header_restore_version = 0 WHERE provider_id = ?", ["variant-cache-test"]);
			db.close();

			const offline = await resolveProviderModels<"openai-completions">(
				{ providerId: "variant-cache-test", staticModels: [base], cacheDbPath: dbPath },
				"offline",
			);
			const restored = offline.models.find(candidate => candidate.id === "sol-1m");
			expect(restored).toBeDefined();
			expect(restored?.headers).toEqual(headers);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("explicit thinking ladders", () => {
	it("preserves explicit effort budgets", () => {
		const spec: ModelSpec<"openai-completions"> = {
			id: "custom-reasoner",
			name: "Custom Reasoner",
			provider: "custom",
			api: "openai-completions",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 1000000,
			maxTokens: 65536,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.High] },
		};
		expect(
			resolveModelPolicy({
				...spec,
				thinking: { mode: "budget", efforts: [Effort.Low, Effort.High], effortBudgets: { high: 1234 } },
			}).thinking?.effortBudgets,
		).toEqual({ high: 1234 });
	});
});
