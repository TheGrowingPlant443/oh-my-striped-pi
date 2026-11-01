import { expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import {
	isCredentialScopedModelCacheProvider,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";

test("lightweight cache resolver matches every descriptor default and configured scope", () => {
	for (const descriptor of PROVIDER_DESCRIPTORS) {
		for (const config of [{}, { apiKey: "cache-test-key", baseUrl: "https://catalog.example/v1" }]) {
			const options = descriptor.createModelManagerOptions(config);
			expect(resolveModelCacheProviderId(descriptor.providerId, config)).toBe(
				options.cacheProviderId ?? descriptor.providerId,
			);
		}
	}
});

test("only Copilot catalogs are credential scoped", () => {
	expect(isCredentialScopedModelCacheProvider("github-copilot")).toBe(true);
	expect(isCredentialScopedModelCacheProvider("local")).toBe(false);
	expect(resolveModelCacheProviderId("local", { apiKey: "ignored", baseUrl: "https://ignored.example" })).toBe(
		"local",
	);
});

test("Copilot isolates credentials and endpoints without exposing either", () => {
	const config = { apiKey: "account-a-secret", baseUrl: "https://copilot.example/v1" };
	const scope = resolveModelCacheProviderId("github-copilot", config);
	expect(resolveModelCacheProviderId("github-copilot", config)).toBe(scope);
	expect(resolveModelCacheProviderId("github-copilot", { ...config, apiKey: "account-b-secret" })).not.toBe(scope);
	expect(
		resolveModelCacheProviderId("github-copilot", { ...config, baseUrl: "https://enterprise.example/v1" }),
	).not.toBe(scope);
	expect(scope).not.toContain(config.apiKey);
	expect(scope).not.toContain(config.baseUrl);
});
