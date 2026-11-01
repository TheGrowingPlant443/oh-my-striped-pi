import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import {
	getOAuthApiKey,
	getOAuthProviders,
	registerOAuthProvider,
	refreshOAuthToken,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { getEnvApiKey, getEnvApiKeyName, resolveProviderApiKey } from "../src/env-api-key";

const credentials: OAuthCredentials = { refresh: "r", access: "a", expires: Date.now() + 3_600_000 };
afterEach(() => unregisterOAuthProviders("company-auth-test"));

describe("configured provider authentication", () => {
	test.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
		"does not inherit built-in auth or env policies for %s",
		provider => {
			expect(getProviderDefinition(provider)).toBeUndefined();
			expect(getEnvApiKey(provider)).toBeUndefined();
			expect(getEnvApiKeyName(provider)).toBeUndefined();
		},
	);
	test("optional-key login markers are not sent as bearer tokens", async () => {
		const definition = getProviderDefinition("lm-studio");
		expect(definition?.allowsMissingApiKey).toBe(true);
		const key = await definition?.login?.({ onPrompt: async () => "" });
		expect(typeof key).toBe("string");
		expect(resolveProviderApiKey("lm-studio", key as string)).toBe("N/A");
		expect(resolveProviderApiKey("lm-studio", "real-key")).toBe("real-key");
		expect(getProviderDefinition("apple")?.allowsMissingApiKey).toBe(true);
	});

	test("rejects unknown interactive OAuth without invoking callbacks", async () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		let prompts = 0;
		try {
			await expect(
				storage.oauth.login("unknown-company-provider", {
					onAuth: () => {
						prompts++;
					},
					onPrompt: async () => {
						prompts++;
						return "secret";
					},
				}),
			).rejects.toThrow("Unknown OAuth provider");
			expect(prompts).toBe(0);
		} finally {
			storage.close();
		}
	});

	test("registers custom company OAuth through login, key projection and refresh", async () => {
		registerOAuthProvider({
			id: "company-oauth",
			name: "Company OAuth",
			sourceId: "company-auth-test",
			login: async callbacks => ({ ...credentials, access: await callbacks.onPrompt({ message: "Token" }) }),
			getApiKey: credential => `company:${credential.access}`,
			refreshToken: async credential => ({ ...credential, access: "refreshed" }),
		});
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		try {
			await storage.oauth.login("company-oauth", { onAuth: () => {}, onPrompt: async () => "operator-token" });
			expect(store.listAuthCredentials("company-oauth")).toHaveLength(1);
			expect(await storage.keys.get("company-oauth")).toBe("company:operator-token");
			expect((await getOAuthApiKey("company-oauth", { "company-oauth": credentials }))?.apiKey).toBe("company:a");
			expect((await refreshOAuthToken("company-oauth", credentials)).access).toBe("refreshed");
			expect(getOAuthProviders().some(provider => provider.id === "company-oauth")).toBe(true);
			unregisterOAuthProviders("company-auth-test");
			expect(getOAuthProviders().some(provider => provider.id === "company-oauth")).toBe(false);
		} finally {
			storage.close();
		}
	});

	test("preserves generic credential administration and config-key precedence", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store, {
			configValueResolver: async value => (value === "!company-key" ? "configured" : value),
		});
		try {
			await storage.credentials.set("company", { type: "api_key", key: "stored" });
			storage.keys.setConfig("company", "!company-key");
			expect(await storage.keys.get("company")).toBe("configured");
			expect(await storage.keys.getWithCredential("company")).toMatchObject({ apiKey: "configured" });
			storage.keys.removeConfig("company");
			expect(await storage.keys.get("company")).toBe("stored");
			expect(store.listAuthCredentials("company")).toHaveLength(1);
		} finally {
			storage.close();
		}
	});
});
