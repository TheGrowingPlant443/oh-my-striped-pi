import { beforeEach as beforeEachOAuthFixture, afterEach as afterEachOAuthFixture } from "bun:test";
import { mockOAuthApiKey, resetOAuthMocks } from "./oauth-test-utils";
beforeEachOAuthFixture(() => mockOAuthApiKey());
afterEachOAuthFixture(() => resetOAuthMocks());
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-striped-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage config-override apiKey", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-config-override-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedOAuth(provider: string, access: string): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(provider, [
			{
				type: "oauth",
				access,
				refresh: `${access}-refresh`,
				expires: Date.now() + 60 * 60_000,
			},
		]);
	}

	test("setConfigApiKey beats OAuth access token for getApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("github-copilot", "oauth-from-broker");
			authStorage.keys.setConfig("github-copilot", "gateway-bearer");

			expect(await authStorage.keys.get("github-copilot")).toBe("gateway-bearer");
			expect(await authStorage.keys.peek("github-copilot")).toBe("gateway-bearer");
		});
	});

	test("runtime override (--api-key) still beats setConfigApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("github-copilot", "oauth-from-broker");
			authStorage.keys.setConfig("github-copilot", "gateway-bearer");
			authStorage.keys.setRuntime("github-copilot", "cli-flag-bearer");

			expect(await authStorage.keys.get("github-copilot")).toBe("cli-flag-bearer");
		});
	});

	test("removeConfigApiKey restores OAuth resolution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("github-copilot", "oauth-from-broker");
			authStorage.keys.setConfig("github-copilot", "gateway-bearer");
			expect(await authStorage.keys.get("github-copilot")).toBe("gateway-bearer");

			authStorage.keys.removeConfig("github-copilot");
			expect(await authStorage.keys.get("github-copilot")).toBe("oauth-from-broker");
		});
	});

	test("clearConfigApiKeys drops every config override at once", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("github-copilot", "oauth-github-copilot");
			await seedOAuth("local", "oauth-codex");
			authStorage.keys.setConfig("github-copilot", "gateway-bearer-A");
			authStorage.keys.setConfig("local", "gateway-bearer-B");

			authStorage.keys.clearConfig();

			expect(await authStorage.keys.get("github-copilot")).toBe("oauth-github-copilot");
			expect(await authStorage.keys.get("local")).toBe("oauth-codex");
		});
	});

	test("setConfigApiKey suppresses OAuth account_uuid attribution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.credentials.set("github-copilot", [
				{
					type: "oauth",
					access: "oauth-with-account",
					refresh: "r",
					expires: Date.now() + 60 * 60_000,
					accountId: "acc-123",
				},
			]);
			// Sanity: without override, accountId is exposed.
			expect(authStorage.oauth.identity("github-copilot")?.accountId).toBe("acc-123");

			authStorage.keys.setConfig("github-copilot", "gateway-bearer");
			// With an explicit config bearer in play, OAuth account attribution
			// must NOT leak — outbound auth is the gateway bearer, not OAuth.
			expect(authStorage.oauth.identity("github-copilot")?.accountId).toBeUndefined();
		});
	});

	test("describeCredentialSource reports config override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("github-copilot", "oauth-from-broker");
			authStorage.keys.setConfig("github-copilot", "gateway-bearer");
			expect(authStorage.keys.describe("github-copilot")).toBe("config override (models.yml)");
		});
	});
});
