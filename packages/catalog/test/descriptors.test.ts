import { describe, expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import { providerEntries, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { buildGeneratedModel } from "../scripts/generate-models";

describe("catalog provider descriptors", () => {
	test("retains on-device/self-hosted descriptors and wire-only llama.cpp policy", () => {
		const ids = ["apple", "github-copilot", "litellm", "lm-studio", "local", "ollama", "vllm"];
		expect(PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId).sort()).toEqual(ids);
		expect(Object.keys(providerEntries()).sort()).toEqual(ids);
		expect(authProviders().map(provider => provider.id)).toEqual([
			"github-copilot",
			"ollama",
			"llama.cpp",
			"lm-studio",
			"vllm",
			"litellm",
			"apple",
		]);
	});

	test("authored offline seeds build without discovery", () => {
		for (const [provider, entry] of Object.entries(providerEntries())) {
			const seeds = seedModels(provider);
			if (provider === "local" || provider === "github-copilot") {
				expect(seeds.length).toBeGreaterThan(0);
				expect(seeds.some(model => model.id === entry.defaultModel)).toBe(true);
			} else {
				expect(seeds).toEqual([]);
			}
			for (const seed of seeds) {
				const built = buildGeneratedModel(seed);
				expect(built.provider).toBe(provider);
				expect(built.id).toBe(seed.id);
				if (provider === "local") {
					expect(built.api).toBe("local-inference");
					expect(["tiny", "tts", "stt"]).toContain(modelKind(built));
				} else {
					expect(built.compat).toBeDefined();
				}
			}
		}
	});

	test("Copilot premium multipliers come from authored model policy", () => {
		const seeds = seedModels("github-copilot");
		for (const [id, multiplier] of [
			["claude-haiku-4.5", 0.33],
			["gpt-5.4-mini", 0.33],
			["claude-opus-4.6", 3],
			["gpt-4o", 0],
			["grok-code-fast-1", 0.25],
		] as const) {
			const seed = seeds.find(model => model.id === id);
			expect(seed).toBeDefined();
			expect(buildGeneratedModel(seed!).premiumMultiplier).toBe(multiplier);
		}
	});

	test("Copilot chat policy overrides Kimi family developer-role defaults", () => {
		const seed = seedModels("github-copilot").find(model => model.id === "kimi-k2.7-code");
		expect(seed).toBeDefined();
		const built = buildGeneratedModel(seed!);
		expect(built.api).toBe("openai-completions");
		if (built.compat === undefined || !("supportsDeveloperRole" in built.compat)) {
			throw new Error("Expected chat-completions compatibility");
		}
		expect(built.compat.supportsDeveloperRole).toBe(false);
	});

	test("every descriptor has a default model and a factory that preserves provider identity", () => {
		for (const descriptor of PROVIDER_DESCRIPTORS) {
			expect(descriptor.defaultModel).toBeTruthy();
			expect(typeof descriptor.createModelManagerOptions).toBe("function");
			expect(descriptor.createModelManagerOptions({ apiKey: "k" }).providerId).toBe(descriptor.providerId);
		}
	});
});
