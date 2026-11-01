import { describe, expect, test } from "bun:test";
import { buildDiscoveredModel, buildModel } from "@oh-my-pi/pi-catalog/build";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { providerEntry, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { resolveDiscoveryApi } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	lmStudioModelManagerOptions,
	resolveModelCacheProviderId,
	resolveOllamaModelCacheProviderId,
	vllmModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models";
import { apiServesKind, runnerApiKind, type ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(provider: string): ModelSpec<"openai-completions"> {
	return {
		id: "qwen3.8-27b",
		name: "Qwen",
		api: "openai-completions",
		provider,
		baseUrl: "https://inference.company.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	};
}

describe("self-hosted catalog contracts", () => {
	test("custom provider names never resolve inherited object properties as built-in policies", () => {
		for (const provider of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			expect(authPolicyFor(provider)).toBeUndefined();
			expect(providerEntry(provider)).toBeUndefined();
			expect(seedModels(provider)).toEqual([]);
		}
	});

	test("declared local-server identity survives company DNS and custom aliases", () => {
		for (const provider of ["ollama", "lm-studio", "vllm", "llama.cpp"]) {
			const built = buildDiscoveredModel(spec("company"), provider);
			expect(built.provider).toBe("company");
			expect(built.providerType).toBe(provider);
			expect(built.compat).toMatchObject({
				replayReasoningContent: true,
				qwenPreserveThinking: true,
				toolSchemaFlavor: "grammar",
				streamFirstEventTimeoutMs: 0,
				streamIdleTimeoutMs: 300000,
				clampOutputToModelMax: true,
			});
		}
	});

	test("Qwen local templates retain their exact effort vocabulary", () => {
		for (const provider of ["llama.cpp", "lm-studio", "vllm"]) {
			const built = buildModel(spec(provider));
			expect(built.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.XHigh]);
			expect(built.thinking?.requiresEffort).toBe(true);
			expect(built.compat.qwenTemplateReasoningEffort).toBe(true);
		}
		expect(resolveDiscoveryApi({ ...spec("company"), api: "openai-responses" }, "llama.cpp")).toBe(
			"openai-completions",
		);
		expect(providerEntry("llama.cpp")).toBeUndefined();
	});

	test("proxy identity does not accidentally inherit loopback server replay or clamping", () => {
		const built = buildModel({ ...spec("litellm"), baseUrl: "http://localhost:4000/v1" });
		expect(built.compat.replayReasoningContent).toBe(false);
		expect(built.compat.clampOutputToModelMax).toBe(false);
		expect(built.compat.sessionHeader).toBe("x-litellm-session-id");
	});

	test("stored keyless markers never become discovery bearer credentials", async () => {
		for (const [factory, marker] of [
			[lmStudioModelManagerOptions, "lm-studio-local"],
			[vllmModelManagerOptions, "vllm-local"],
		] as const) {
			const options = factory({
				baseUrl: "https://inference.company.example/v1",
				apiKey: marker,
				fetch: async (_input, init) => {
					expect(new Headers(init?.headers).get("authorization")).toBeNull();
					return Response.json({ data: [{ id: "local-code" }] });
				},
			});
			expect(await options.fetchDynamicModels?.()).toHaveLength(1);
		}
	});

	test("endpoint-scoped caches preserve Ollama facade equivalence without leaking URLs", () => {
		const root = "https://inference.company.example/ollama";
		expect(resolveOllamaModelCacheProviderId("ollama", root)).toBe(
			resolveOllamaModelCacheProviderId("ollama", `${root}/v1/`),
		);
		for (const provider of ["ollama", "lm-studio", "vllm", "litellm"]) {
			const scope = resolveModelCacheProviderId(provider, { baseUrl: root });
			expect(scope).not.toContain(root);
			expect(scope).not.toBe(resolveModelCacheProviderId(provider, { baseUrl: "https://other.company.example/v1" }));
		}
	});

	test("generic runner vocabulary carries technical kinds, not public provider registrations", () => {
		for (const [api, kind] of [
			["openai-images", "image"],
			["openai-speech", "tts"],
			["openai-transcriptions", "stt"],
			["openai-embeddings", "embedding"],
			["openrouter-rerank", "rerank"],
			["typesafe", "judge"],
			["openai-decisions", "judge"],
		] as const) {
			expect(runnerApiKind(api)).toBe(kind);
			expect(apiServesKind(api, kind)).toBe(true);
			expect(apiServesKind(api, "chat")).toBe(false);
		}
		expect(buildModel({ ...spec("company"), id: "deepseek-v4-pro" }).compat.streamMarkupHealingPattern).toBe("dsml");
		expect(buildModel(spec("github-copilot")).compat.streamMarkupHealingPattern).toBeUndefined();
	});
});
