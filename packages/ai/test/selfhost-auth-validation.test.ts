import { describe, expect, test } from "bun:test";
import { buildProviderDefinition } from "../src/registry/build";
import {
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "../src/registry/api-key-validation";

describe("declarative self-hosted API-key authentication", () => {
	test("supports optional keys without treating an empty prompt as authentication", async () => {
		const definition = buildProviderDefinition({
			id: "company",
			name: "Company",
			apiKeyFormat: "bearer",
			allowsMissingApiKey: true,
			login: { kind: "api-key", prompt: "Private endpoint key", emptyFallback: "" },
			refresh: { kind: "none" },
		});
		expect(definition.allowsMissingApiKey).toBe(true);
		expect(await definition.login?.({ onPrompt: async () => "   " })).toBe("");
		expect(await definition.login?.({ onPrompt: async () => " operator-key " })).toBe("operator-key");
		expect(definition.refreshToken).toBeUndefined();
	});

	test("preserves required endpoint validation and surfaces authentication failures", async () => {
		const definition = buildProviderDefinition({
			id: "company",
			name: "Company",
			apiKeyFormat: "bearer",
			login: {
				kind: "api-key",
				prompt: "Private endpoint key",
				validate: { kind: "models-endpoint", url: "https://inference.company.example/v1/models" },
			},
		});
		let requested: string | undefined;
		let authorization: string | null | undefined;
		await expect(
			definition.login?.({
				onPrompt: async () => "operator-key",
				fetch: async (url, init) => {
					requested = String(url);
					authorization = new Headers(init?.headers).get("Authorization");
					return new Response("invalid key", { status: 401 });
				},
			}),
		).rejects.toThrow("API key validation failed (401)");
		expect(requested).toBe("https://inference.company.example/v1/models");
		expect(authorization).toBe("Bearer operator-key");
	});

	test("refuses missing validation endpoints without invoking fetch", async () => {
		let requests = 0;
		const fetch = async () => {
			requests++;
			return new Response("{}");
		};
		await expect(
			validateOpenAICompatibleApiKey({
				provider: "company",
				apiKey: "private",
				baseUrl: "",
				model: "company-model",
				fetch,
			}),
		).rejects.toThrow("explicit base URL");
		await expect(
			validateApiKeyAgainstModelsEndpoint({ provider: "company", apiKey: "private", modelsUrl: "", fetch }),
		).rejects.toThrow("explicit models URL");
		expect(requests).toBe(0);
	});
});
