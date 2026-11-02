import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-striped-pi/pi-ai";
import { Effort } from "@oh-my-striped-pi/pi-catalog/effort";
import { ModelRegistry, kNoAuth } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import {
	discoverModelsByProviderType,
	discoveryProbeTimeoutMs,
} from "@oh-my-striped-pi/pi-coding-agent/config/model-discovery";
import { resolveCliModel } from "@oh-my-striped-pi/pi-coding-agent/config/model-resolver";
import { ProviderDiscoverySchema } from "@oh-my-striped-pi/pi-coding-agent/config/models-config-schema";
import { resetSettingsForTest } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-striped-pi/pi-utils";

describe("Self-hosted model discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;
	const savedEnv = new Map<string, string | undefined>();
	beforeEach(async () => {
		resetSettingsForTest();
		for (const key of [
			"OLLAMA_BASE_URL",
			"OLLAMA_HOST",
			"OLLAMA_CONTEXT_LENGTH",
			"LLAMA_CPP_BASE_URL",
			"LM_STUDIO_BASE_URL",
		]) {
			savedEnv.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		tempDir = path.join(os.tmpdir(), `pi-selfhost-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(":memory:");
	});
	afterEach(() => {
		resetSettingsForTest();
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		savedEnv.clear();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter(m => m.provider === provider);
	}

	function withEnv(
		name:
			| "LITELLM_BASE_URL"
			| "LLAMA_CPP_BASE_URL"
			| "LM_STUDIO_BASE_URL"
			| "OLLAMA_BASE_URL"
			| "OLLAMA_CONTEXT_LENGTH"
			| "OLLAMA_HOST",
		value: string | undefined,
	) {
		const original = Bun.env[name];
		if (value === undefined) {
			delete Bun.env[name];
		} else {
			Bun.env[name] = value;
		}
		return {
			[Symbol.dispose]() {
				if (original === undefined) {
					delete Bun.env[name];
				} else {
					Bun.env[name] = original;
				}
			},
		};
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function mockOllamaDiscovery(
		modelNames: string[],
		endpoint = "http://127.0.0.1:11434",
		showPayload: Record<string, unknown> = { capabilities: ["completion"] },
	): FetchImpl {
		return async input => {
			const url = String(input);
			if (url === `${endpoint}/api/tags`) {
				return new Response(JSON.stringify({ models: modelNames.map(name => ({ name })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === `${endpoint}/api/show`) {
				return new Response(JSON.stringify(showPayload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
	}

	test("auto-discovers ollama models without provider config", async () => {
		const fetchMock = mockOllamaDiscovery(["phi4-mini"]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();
		const ollamaModels = getModelsForProvider(registry, "ollama");
		expect(ollamaModels.some(m => m.id === "phi4-mini")).toBe(true);
		expect(registry.getAvailable().some(m => m.provider === "ollama" && m.id === "phi4-mini")).toBe(true);
		expect(await registry.getApiKey(ollamaModels[0])).toBe(kNoAuth);
	});

	test("only marks unconfigured implicit local endpoints as optional", async () => {
		{
			using _ollamaBaseUrl = withEnv("OLLAMA_BASE_URL", undefined);
			using _ollamaHost = withEnv("OLLAMA_HOST", undefined);
			using _llamaCpp = withEnv("LLAMA_CPP_BASE_URL", undefined);
			using _lmStudio = withEnv("LM_STUDIO_BASE_URL", undefined);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath });
			await registry.refresh("offline");

			expect(
				["ollama", "llama.cpp", "lm-studio"].map(id => registry.getProviderDiscoveryState(id)?.optional),
			).toEqual([true, true, true]);
		}

		{
			using _ollama = withEnv("OLLAMA_BASE_URL", "http://ollama.example:11434");
			using _llamaCpp = withEnv("LLAMA_CPP_BASE_URL", "http://llama-cpp.example:8080");
			using _lmStudio = withEnv("LM_STUDIO_BASE_URL", "http://lm-studio.example:1234/v1");
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath });
			await registry.refresh("offline");

			expect(
				["ollama", "llama.cpp", "lm-studio"].map(id => registry.getProviderDiscoveryState(id)?.optional),
			).toEqual([false, false, false]);
		}
	});

	test("uses OLLAMA_HOST for implicit ollama discovery", async () => {
		using _baseUrl = withEnv("OLLAMA_BASE_URL", undefined);
		using _host = withEnv("OLLAMA_HOST", "ollama.lan:12345");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://ollama.lan:12345");
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.baseUrl).toBe("http://ollama.lan:12345/v1");
		expect(registry.getProviderDiscoveryState("ollama")?.optional).toBe(false);
	});

	test("keeps OLLAMA_BASE_URL precedence over OLLAMA_HOST", async () => {
		using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://omsp-ollama.example:2222");
		using _host = withEnv("OLLAMA_HOST", "ollama-host.example:3333");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://omsp-ollama.example:2222");
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.baseUrl).toBe("http://omsp-ollama.example:2222/v1");
		expect(registry.getProviderDiscoveryState("ollama")?.optional).toBe(false);
	});

	test("resolves a bare id shared with implicit ollama to the models.yml provider", async () => {
		using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://ollama.lan:11434");
		writeRawModelsJson({
			omlx: {
				baseUrl: "http://omlx.lan:11434/v1",
				api: "openai-completions",
				apiKey: "sk-omlx-test",
				models: [{ id: "phi-4-4bit", name: "Phi-4 4-bit", contextWindow: 128000, maxTokens: 8192 }],
			},
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			cacheDbPath,
			fetch: mockOllamaDiscovery(["phi-4-4bit"], "http://ollama.lan:11434"),
		});
		await registry.refresh();
		expect(registry.find("ollama", "phi-4-4bit")).toBeDefined();

		const resolved = resolveCliModel({ cliModel: "phi-4-4bit", modelRegistry: registry });
		expect(resolved.model?.provider).toBe("omlx");
		expect(resolved.model?.baseUrl).toBe("http://omlx.lan:11434/v1");
	});

	test("warns with the env var only when an env-redirected implicit endpoint fails discovery", async () => {
		// Echo the request URL like real fetch errors do, so credential leaks through the error are caught too.
		const unreachable: FetchImpl = async input => {
			throw new Error(`EHOSTUNREACH: connect failed ${String(input)}`);
		};
		{
			using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://reviewer:topsecret@ollama.typo:11434");
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: unreachable });
			await registry.refresh();
			const warnings = registry.drainConfigWarnings().filter(warning => warning.includes("ollama"));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("OLLAMA_BASE_URL");
			expect(warnings[0]).toContain("http://ollama.typo:11434");
			expect(warnings[0]).toContain("EHOSTUNREACH");
			expect(warnings[0]).not.toContain("topsecret");
			expect(warnings[0]).not.toContain("reviewer");
		}
		{
			// The default loopback probe is optional: a missing local Ollama stays silent.
			using _baseUrl = withEnv("OLLAMA_BASE_URL", undefined);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: unreachable });
			await registry.refresh();
			expect(registry.drainConfigWarnings()).toEqual([]);
		}
	});

	test("refreshes implicit Ollama discovery when the configured endpoint changes", async () => {
		const requested: string[] = [];
		{
			using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://old-ollama.example:11434/v1/");
			const fetchOld = mockOllamaDiscovery(["old-model"], "http://old-ollama.example:11434");
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				cacheDbPath,
				fetch: async (input, init) => {
					requested.push(String(input));
					return fetchOld(input, init);
				},
			});
			await registry.refresh();
			expect(registry.find("ollama", "old-model")).toBeDefined();
		}

		{
			using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://new-ollama.example:11434");
			const fetchNew = mockOllamaDiscovery(["new-model"], "http://new-ollama.example:11434");
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				cacheDbPath,
				fetch: async (input, init) => {
					requested.push(String(input));
					return fetchNew(input, init);
				},
			});
			// The old endpoint has a fresh cache row, but default refresh must
			// miss that namespace and discover against the new endpoint.
			await registry.refresh();
			expect(registry.find("ollama", "old-model")).toBeUndefined();
			expect(registry.find("ollama", "new-model")?.baseUrl).toBe("http://new-ollama.example:11434/v1");
		}

		expect(requested).toContain("http://old-ollama.example:11434/api/tags");
		expect(requested).toContain("http://new-ollama.example:11434/api/tags");
	});

	test("uses OLLAMA_CONTEXT_LENGTH for implicit ollama context accounting", async () => {
		using _contextLength = withEnv("OLLAMA_CONTEXT_LENGTH", "16384");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.contextWindow).toBe(16384);
		expect(model?.maxTokens).toBe(16384);
	});

	test("lets OLLAMA_CONTEXT_LENGTH override ollama show metadata", async () => {
		using _contextLength = withEnv("OLLAMA_CONTEXT_LENGTH", "32768");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://127.0.0.1:11434", {
			model_info: {
				"phi4.context_length": 4096,
			},
			capabilities: ["completion"],
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.contextWindow).toBe(32768);
		expect(model?.maxTokens).toBe(32768);
	});

	test("prefers Ollama runtime num_ctx over training context metadata", async () => {
		const fetchMock = mockOllamaDiscovery(["qwen3:27b"], "http://127.0.0.1:11434", {
			parameters: "temperature 0.6\nnum_ctx 123904\n",
			model_info: {
				"qwen3.context_length": 262144,
			},
			capabilities: ["completion", "thinking"],
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "qwen3:27b");
		expect(model?.contextWindow).toBe(123904);
		expect(model?.maxTokens).toBe(32_768);
	});

	test("implicit llama.cpp discovery falls back to port 9931 when 8080 is unreachable", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url.startsWith("http://127.0.0.1:8080/")) {
				throw new TypeError("Unable to connect");
			}
			if (url === "http://127.0.0.1:9931/models") {
				return new Response(JSON.stringify({ data: [{ id: "gemma-3-4b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:9931/props") {
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();
		const model = registry.find("llama.cpp", "gemma-3-4b");
		expect(model?.baseUrl).toBe("http://127.0.0.1:9931/v1");
		expect(model?.contextWindow).toBe(16384);
	});

	test("implicit llama.cpp discovery reports a 9931 auth rejection as unauthenticated, not an 8080 outage", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url.startsWith("http://127.0.0.1:8080/")) {
				throw new TypeError("Unable to connect");
			}
			if (url.startsWith("http://127.0.0.1:9931/")) {
				return new Response("unauthorized", { status: 401 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();
		expect(registry.getProviderDiscoveryState("llama.cpp")?.status).toBe("unauthenticated");
	});

	test("implicit llama.cpp discovery does not bypass a failing 8080 server for 9931", async () => {
		const requested: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requested.push(url);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response("internal error", { status: 500 });
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response("internal error", { status: 500 });
			}
			if (url === "http://127.0.0.1:9931/models") {
				return new Response(JSON.stringify({ data: [{ id: "other-server-model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();
		expect(registry.find("llama.cpp", "other-server-model")).toBeUndefined();
		expect(registry.getProviderDiscoveryState("llama.cpp")?.status).toBe("unavailable");
		expect(requested.some(url => url.startsWith("http://127.0.0.1:9931/"))).toBe(false);
	});

	test("llama.cpp discovery routes Qwen models to chat-completions with the top-level disable dialect", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "qwen3-8b" },
							{ id: "ternary-bonsai-27b-q2_0" },
							{ id: "bonsai-2-27b" },
							{ id: "llama-3.1-8b" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: { n_ctx: 32768, params: { max_tokens: -1, n_predict: -1 } },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { cacheDbPath, fetch: fetchMock });
		await registry.refresh();

		for (const id of ["qwen3-8b", "ternary-bonsai-27b-q2_0", "bonsai-2-27b"]) {
			const qwen = registry.find("llama.cpp", id);
			expect(qwen?.reasoning).toBe(true);
			expect(qwen?.api).toBe("openai-completions");
			expect(qwen?.baseUrl).toBe("http://127.0.0.1:8080/v1");
			expect(qwen?.compat).toMatchObject({
				thinkingFormat: "qwen",
				reasoningDisableMode: "qwen-enable-thinking-false",
				qwenPreserveThinking: true,
			});
		}

		// Bonsai 2 is Qwen3.8-based: its template takes `reasoning_effort` with a
		// wire-exact low/medium/xhigh ladder and raises on anything else.
		const bonsai2 = registry.find("llama.cpp", "bonsai-2-27b");
		expect(bonsai2?.thinking).toMatchObject({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
			requiresEffort: true,
		});
		expect(bonsai2?.compat).toMatchObject({ qwenTemplateReasoningEffort: true });
		const bonsai1 = registry.find("llama.cpp", "ternary-bonsai-27b-q2_0");
		expect(bonsai1?.compat).toMatchObject({ qwenTemplateReasoningEffort: false });

		const plain = registry.find("llama.cpp", "llama-3.1-8b");
		expect(plain?.reasoning).toBe(false);
		expect(plain?.api).toBe("openai-responses");
		expect(plain?.baseUrl).toBe("http://127.0.0.1:8080/v1");
		expect(plain?.compat).not.toMatchObject({ reasoningDisableMode: "qwen-enable-thinking-false" });
	});

	test("discoveryProbeTimeoutMs keeps loopback fast but gives non-loopback hosts a larger budget", () => {
		// Regression: the loopback-tuned probe timeout was applied to every host,
		// so a remote/LAN LLAMA_CPP_BASE_URL with normal round-trip latency timed
		// out and the model list came back empty (#7087). Loopback keeps the tight
		// budget; anything reached over the network gets a strictly larger one.
		const loopbackMs = 250;
		for (const host of [
			"http://127.0.0.1:8080",
			"http://127.5.6.7:8080",
			"http://localhost:8080",
			"http://[::1]:8080",
			"http://0.0.0.0:8080",
		]) {
			expect(discoveryProbeTimeoutMs(host, loopbackMs)).toBe(loopbackMs);
		}
		const remoteBudgets = [
			"http://remote-llama.test:8080",
			"http://192.168.1.50:8080",
			"http://172.18.0.3:8080",
			"http://10.0.0.4:8080",
			"http://box.local:8080",
		].map(host => discoveryProbeTimeoutMs(host, loopbackMs));
		for (const budget of remoteBudgets) {
			expect(budget).toBeGreaterThan(loopbackMs);
		}
		// A consistent budget for every non-loopback host, independent of the tight cap.
		expect(new Set(remoteBudgets).size).toBe(1);
		expect(discoveryProbeTimeoutMs("http://remote-llama.test:8080", 150)).toBe(remoteBudgets[0]);
	});

	test("discoveryProbeTimeoutMs uses explicit customTimeoutMs when provided", () => {
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, 30_000)).toBe(30_000);
		expect(discoveryProbeTimeoutMs("http://remote-llama.test:8080", 250, 30_000)).toBe(30_000);
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, 5_000)).toBe(5_000);
		// Invalid custom timeouts fall back to standard loopback/remote resolution
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, -100)).toBe(250);
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, 0)).toBe(250);
	});

	test("ProviderDiscoverySchema validates timeoutMs", () => {
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: 30_000 })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "ollama", timeoutMs: 5_000 })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: -500 })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: 0 })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: Number.NaN })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: "30000" })).toBe(false);
	});
	test("ProviderDiscoverySchema restricts injectV1 to openai-models-list", () => {
		expect(ProviderDiscoverySchema.allows({ type: "openai-models-list", injectV1: false })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "openai-models-list", injectV1: true })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "lm-studio", injectV1: false })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "proxy", injectV1: false })).toBe(false);
	});
	test("ProviderDiscoverySchema restricts advertisedReasoning to discovery that reads /v1/models rows", () => {
		for (const type of ["openai-models-list", "lm-studio", "proxy"] as const) {
			expect(ProviderDiscoverySchema.allows({ type, advertisedReasoning: false })).toBe(true);
		}
		// Ollama and llama.cpp derive capabilities from their own native probes.
		expect(ProviderDiscoverySchema.allows({ type: "ollama", advertisedReasoning: false })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", advertisedReasoning: false })).toBe(false);
		// LiteLLM's authoritative reasoning metadata comes from
		// `/model_group/info`, so the flag would be a silent no-op whenever that
		// rich probe succeeds. Reject it instead of accepting an ignored setting.
		expect(ProviderDiscoverySchema.allows({ type: "litellm", advertisedReasoning: false })).toBe(false);
	});

	test("company Ollama credentials authenticate tags and metadata without leaking into cached model headers", async () => {
		const requests: string[] = [];
		const models = await discoverModelsByProviderType(
			{
				provider: "company-ollama",
				api: "ollama-chat",
				baseUrl: "https://inference.company.example",
				discovery: { type: "ollama" },
			},
			{
				getBearerApiKeyResolver: async () => "company-ollama-key",
				fetch: async (input, init) => {
					const url = String(input);
					requests.push(url);
					expect(new Headers(init?.headers).get("authorization")).toBe("Bearer company-ollama-key");
					if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "private-model" }] });
					expect(url).toBe("https://inference.company.example/api/show");
					return Response.json({ capabilities: ["completion", "thinking"], parameters: "num_ctx 16384" });
				},
			},
		);
		expect(requests).toHaveLength(2);
		expect(models[0]?.provider).toBe("company-ollama");
		expect(models[0]?.contextWindow).toBe(16384);
		expect(new Headers(models[0]?.headers).has("authorization")).toBe(false);
	});
});
