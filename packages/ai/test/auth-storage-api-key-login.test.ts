import { beforeEach as beforeEachOAuthFixture, afterEach as afterEachOAuthFixture } from "bun:test";
import { mockOAuthApiKey, mockOAuthProvider, resetOAuthMocks } from "./oauth-test-utils";
beforeEachOAuthFixture(() => mockOAuthApiKey());
afterEachOAuthFixture(() => resetOAuthMocks());
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-striped-pi/pi-ai/auth-storage";
import * as envApiKey from "@oh-my-striped-pi/pi-ai/env-api-key";
import { removeWithRetries } from "../../utils/src/temp";

function countCredentialRows(dbPath: string, provider: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.query("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?").get(provider) as
			| { count?: number }
			| undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function countCredentialRowsByDisabledState(dbPath: string, provider: string, disabled: boolean): number {
	const disabledClause = disabled ? "IS NOT NULL" : "IS NULL";
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.query(
				`SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ? AND disabled_cause ${disabledClause}`,
			)
			.get(provider) as { count?: number } | undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

describe("AuthStorage api-key login upsert", () => {
	// Most tests neutralize the env leg so ambient shell / ~/.env keys cannot
	// hide the stored credential behavior under test. Login-persisted API keys
	// have their own precedence coverage below.
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-login-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		mockOAuthProvider({
			id: "github-copilot",
			name: "API-key persistence fixture",
			login: callbacks => callbacks.onPrompt({ message: "API key" }),
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("reuses the stored api-key row when re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "same-kagi-key",
		};

		await authStorage.oauth.login("github-copilot", controller);
		await authStorage.oauth.login("github-copilot", controller);

		expect(countCredentialRows(dbPath, "github-copilot")).toBe(1);
		const credentials = store.listAuthCredentials("github-copilot");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-kagi-key");
		expect(store.getApiKey("github-copilot")).toBe("same-kagi-key");
		expect(await authStorage.keys.get("github-copilot", "session-kagi-relogin")).toBe("same-kagi-key");
	});

	it("appends a different api-key row when re-login returns a new key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		const keys = ["first-kagi-key", "second-kagi-key"];
		const controller = {
			onAuth: () => {},
			onPrompt: async () => keys.shift() ?? "",
		};

		await authStorage.oauth.login("github-copilot", controller);
		await authStorage.oauth.login("github-copilot", controller);

		expect(countCredentialRows(dbPath, "github-copilot")).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "github-copilot", false)).toBe(2);
		expect(countCredentialRowsByDisabledState(dbPath, "github-copilot", true)).toBe(0);

		const credentials = store.listAuthCredentials("github-copilot");
		expect(credentials.map(entry => entry.credential)).toEqual([
			{ type: "api_key", key: "first-kagi-key", source: "login" },
			{ type: "api_key", key: "second-kagi-key", source: "login" },
		]);
		const rotatedKeys = [
			await authStorage.keys.get("github-copilot"),
			await authStorage.keys.get("github-copilot"),
		].sort();
		expect(rotatedKeys).toEqual(["first-kagi-key", "second-kagi-key"]);
	});

	it("hard-deletes superseded api-key rows when a different key replaces them", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		await store.saveApiKey("github-copilot", "old-key-123");
		await store.saveApiKey("github-copilot", "new-key-456");

		expect(countCredentialRows(dbPath, "github-copilot")).toBe(1);
		expect(countCredentialRowsByDisabledState(dbPath, "github-copilot", false)).toBe(1);
		expect(countCredentialRowsByDisabledState(dbPath, "github-copilot", true)).toBe(0);
		expect(store.getApiKey("github-copilot")).toBe("new-key-456");
	});
});
