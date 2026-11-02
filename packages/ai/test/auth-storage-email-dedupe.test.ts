import { beforeEach as beforeEachOAuthFixture, afterEach as afterEachOAuthFixture } from "bun:test";
import { mockOAuthApiKey, resetOAuthMocks, mockOAuthProvider } from "./oauth-test-utils";
beforeEachOAuthFixture(() => mockOAuthApiKey());
afterEachOAuthFixture(() => resetOAuthMocks());
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-striped-pi/pi-ai";
import { removeWithRetries } from "../../utils/src/temp";

const LEGACY_TIMESTAMP = 1_700_000_000;

function createCredential(args: { suffix: string; accountId: string; email: string }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 60_000,
		accountId: args.accountId,
		email: args.email,
	};
}

function readDisabledCauses(db: Database, provider: string): string[] {
	const rows = db
		.query(
			"SELECT disabled_cause FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
		)
		.all(provider) as Array<{ disabled_cause?: string | null }>;
	return rows.flatMap(row => (typeof row.disabled_cause === "string" ? [row.disabled_cause] : []));
}

function readStoredIdentityRows(
	db: Database,
	provider: string,
): Array<{ identity_key: string | null; disabled_cause: string | null }> {
	return db
		.query("SELECT identity_key, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id ASC")
		.all(provider) as Array<{ identity_key: string | null; disabled_cause: string | null }>;
}

function readAuthSchemaVersion(db: Database): number | null {
	const row = db.query("SELECT version FROM auth_schema_version WHERE id = 1").get() as
		| { version?: number }
		| undefined;
	return typeof row?.version === "number" ? row.version : null;
}

function readTableSql(db: Database, tableName: string): string | null {
	const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
		| { sql?: string | null }
		| undefined;
	return row?.sql ?? null;
}

/** Runs `fn` with a fresh temp dir; only for tests that need real on-disk SQLite semantics. */
async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

describe("AuthStorage credential persistence and schema migrations", () => {
	let db: Database | null = null;
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(() => {
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		authStorage = new AuthStorage(store);
	});

	afterEach(() => {
		store?.close();
		store = null;
		authStorage = null;
		db = null;
	});

	it("does not disable credentials for different accounts with different emails", async () => {
		if (!authStorage || !store || !db) throw new Error("test setup failed");

		const credA = createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" });
		const credB = createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" });
		const credC = createCredential({ suffix: "third", accountId: "account-c", email: "user-c@example.com" });

		// Simulate login flow: each login merges existing + new
		await authStorage.credentials.set("github-copilot", credA);
		await authStorage.credentials.set("github-copilot", [credA, credB]);
		await authStorage.credentials.set("github-copilot", [credA, credB, credC]);

		// All three accounts should remain active — no credential was replaced
		const credentials = store.listAuthCredentials("github-copilot");
		expect(credentials).toHaveLength(3);
		expect(readDisabledCauses(db, "github-copilot")).toEqual([]);
	});

	it("saveOAuth preserves unrelated accounts across reauth", async () => {
		if (!store || !db) throw new Error("test setup failed");

		await store.saveOAuth(
			"github-copilot",
			createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" }),
		);
		await store.saveOAuth(
			"github-copilot",
			createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" }),
		);
		await store.saveOAuth(
			"github-copilot",
			createCredential({ suffix: "third", accountId: "account-c", email: "user-c@example.com" }),
		);

		const credentials = store.listAuthCredentials("github-copilot");
		expect(credentials).toHaveLength(3);
		expect(readDisabledCauses(db, "github-copilot")).toEqual([]);
	});

	it("saveOAuth does not delete accounts missing from stale AuthStorage cache", async () => {
		// File-backed: two stores on one path model separate processes sharing the db.
		await withTempDir("pi-ai-auth-email-dedupe-", async tempDir => {
			const dbPath = path.join(tempDir, "agent.db");
			const staleStore = await SqliteAuthCredentialStore.open(dbPath);
			const freshStore = await SqliteAuthCredentialStore.open(dbPath);
			const staleAuthStorage = new AuthStorage(staleStore);
			try {
				await staleStore.saveOAuth(
					"github-copilot",
					createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" }),
				);
				await staleAuthStorage.credentials.reload();

				// Another writer adds a second account after staleAuthStorage has already cached provider state.
				await freshStore.saveOAuth(
					"github-copilot",
					createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" }),
				);

				// Reauth from the stale process should update only account A, not disable account B.
				await staleStore.saveOAuth(
					"github-copilot",
					createCredential({ suffix: "reauth", accountId: "account-a", email: "user-a@example.com" }),
				);

				expect(staleStore.listAuthCredentials("github-copilot")).toHaveLength(2);
				const inspect = new Database(dbPath, { readonly: true });
				try {
					expect(readDisabledCauses(inspect, "github-copilot")).toEqual([]);
				} finally {
					inspect.close();
				}
			} finally {
				staleStore.close();
				freshStore.close();
			}
		});
	});

	it("stores the disable cause when a credential is soft-disabled", async () => {
		if (!store || !db) throw new Error("test setup failed");

		await store.replaceAuthCredentials("github-copilot", [
			createCredential({ suffix: "only", accountId: "account-a", email: "only@example.com" }),
		]);

		const [credential] = store.listAuthCredentials("github-copilot");
		if (!credential) throw new Error("expected stored credential");

		const disabledCause = "oauth refresh failed: invalid_grant";
		await store.deleteAuthCredential(credential.id, disabledCause);

		expect(store.listAuthCredentials("github-copilot")).toHaveLength(0);
		expect(readDisabledCauses(db, "github-copilot")).toEqual([disabledCause]);
	});

	it("creates fresh auth schema without unixepoch defaults", async () => {
		const freshDb = new Database(":memory:");
		const freshStore = new SqliteAuthCredentialStore(freshDb);
		try {
			expect(readAuthSchemaVersion(freshDb)).toBe(8);
			expect(readTableSql(freshDb, "auth_credentials")).not.toContain("unixepoch(");
			expect(readTableSql(freshDb, "auth_credentials")).toContain("strftime('%s','now')");
		} finally {
			freshStore.close();
		}
	});

	it("preserves newer auth schema versions instead of downgrading them", async () => {
		const futureDb = new Database(":memory:");
		futureDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 9);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);

		const reopenedStore = new SqliteAuthCredentialStore(futureDb);
		try {
			expect(readAuthSchemaVersion(futureDb)).toBe(9);
		} finally {
			reopenedStore.close();
		}
	});

	it("reopens a current-schema db without issuing write transactions", async () => {
		// File-backed: reopens persisted data and observes PRAGMA data_version from a second connection.
		await withTempDir("pi-ai-auth-email-dedupe-", async tempDir => {
			const reopenDbPath = path.join(tempDir, "reopen-noop-agent.db");
			const first = await SqliteAuthCredentialStore.open(reopenDbPath);
			// api_key rows never derive an identity_key, so this leaves a NULL row
			// the boot-time backfill scan must skip without a no-op UPDATE.
			await first.saveApiKey("github-copilot", "sk-reopen-noop");
			first.close();

			// PRAGMA data_version, read from a second connection, increments whenever
			// another connection commits a write; reopening a current-schema store
			// (already-WAL pragmas, IF NOT EXISTS DDL, current version row, and an
			// underivable NULL identity_key row) must not move it.
			const observer = new Database(reopenDbPath, { readonly: true });
			try {
				const before = (observer.query("PRAGMA data_version").get() as { data_version: number }).data_version;
				const reopened = await SqliteAuthCredentialStore.open(reopenDbPath);
				try {
					expect(reopened.listAuthCredentials("github-copilot")).toHaveLength(1);
					expect(readAuthSchemaVersion(observer)).toBe(8);
				} finally {
					reopened.close();
				}
				const after = (observer.query("PRAGMA data_version").get() as { data_version: number }).data_version;
				expect(after).toBe(before);
			} finally {
				observer.close();
			}
		});
	});

	it("migrates v3 auth schema away from unixepoch defaults", async () => {
		const legacyDb = new Database(":memory:");
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 3);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.query(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"github-copilot",
				"oauth",
				JSON.stringify(
					createCredential({
						suffix: "legacy-v3",
						accountId: "legacy-v3-account",
						email: "legacy-v3@example.com",
					}),
				),
				null,
				"email:legacy-v3@example.com",
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);

		const migratedStore = new SqliteAuthCredentialStore(legacyDb);
		try {
			expect(readAuthSchemaVersion(legacyDb)).toBe(8);
			expect(readTableSql(legacyDb, "auth_credentials")).not.toContain("unixepoch(");
			expect(readTableSql(legacyDb, "auth_credentials")).toContain("strftime('%s','now')");
			expect(readStoredIdentityRows(legacyDb, "github-copilot")).toEqual([
				{ identity_key: "email:legacy-v3@example.com", disabled_cause: null },
			]);
		} finally {
			migratedStore.close();
		}
	});

	it("backfills identity_key when migrating v1 auth schema", async () => {
		const legacyDb = new Database(":memory:");
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 1);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.query(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"github-copilot",
				"oauth",
				JSON.stringify(
					createCredential({
						suffix: "legacy-v1",
						accountId: "legacy-v1-account",
						email: "legacy-v1@example.com",
					}),
				),
				null,
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);

		const migratedStore = new SqliteAuthCredentialStore(legacyDb);
		try {
			expect(readStoredIdentityRows(legacyDb, "github-copilot")).toEqual([
				{ identity_key: "account:legacy-v1-account", disabled_cause: null },
			]);
		} finally {
			migratedStore.close();
		}
	});

	it("backfills disabled cause and identity_key when migrating legacy disabled rows", async () => {
		const legacyDb = new Database(":memory:");
		legacyDb.run(`
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.query(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"github-copilot",
				"oauth",
				JSON.stringify(
					createCredential({ suffix: "legacy", accountId: "legacy-account", email: "legacy@example.com" }),
				),
				1,
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);

		const migratedStore = new SqliteAuthCredentialStore(legacyDb);
		try {
			expect(migratedStore.listAuthCredentials("github-copilot")).toHaveLength(0);
			expect(readStoredIdentityRows(legacyDb, "github-copilot")).toEqual([
				{ identity_key: "account:legacy-account", disabled_cause: "disabled" },
			]);
		} finally {
			migratedStore.close();
		}
	});
});

describe("AuthStorage OAuth login upgrade and multi-account coexistence", () => {
	afterEach(() => {
		resetOAuthMocks("auth-storage-login-upgrade-test");
	});

	it("allows multiple OAuth accounts to coexist and replaces legacy api_key rows on OAuth login", async () => {
		const db = new Database(":memory:");
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(db));

		try {
			// 1. Setup a legacy api_key credential
			await authStorage.credentials.set("github-copilot", { type: "api_key", key: "sk-legacy-key" });
			expect(await authStorage.keys.get("github-copilot")).toBe("sk-legacy-key");

			// 2. Register custom oauth provider
			let loginReturns: (Omit<OAuthCredential, "type"> & { type?: string }) | null = null;
			mockOAuthProvider({
				id: "github-copilot",
				name: "Unit Login Upgrade",
				sourceId: "auth-storage-login-upgrade-test",
				login: async () => {
					if (!loginReturns) throw new Error("no credentials");
					const { type: _type, ...rest } = loginReturns;
					return rest;
				},
				refreshToken: async () => {
					if (!loginReturns) throw new Error("no credentials");
					const { type: _type, ...rest } = loginReturns;
					return rest;
				},
			});

			// 3. Login first OAuth account
			loginReturns = {
				refresh: "refresh-token-1",
				access: "access-token-1",
				expires: Date.now() + 60_000,
				accountId: "account-1",
				email: "user-1@example.com",
			};
			await authStorage.oauth.login("github-copilot", {
				onAuth: () => {},
				onPrompt: async () => "",
			});

			// Legacy api_key should be gone/replaced, and first oauth account is active.
			// getApiKey should now return the first OAuth access token (since the api_key is gone).
			expect(await authStorage.keys.get("github-copilot")).toBe("access-token-1");
			const firstRows = readStoredIdentityRows(db, "github-copilot");
			expect(firstRows).toEqual([
				{ identity_key: null, disabled_cause: "replaced by oauth login" },
				{ identity_key: "account:account-1", disabled_cause: null },
			]);

			// 4. Login second OAuth account
			loginReturns = {
				refresh: "refresh-token-2",
				access: "access-token-2",
				expires: Date.now() + 60_000,
				accountId: "account-2",
				email: "user-2@example.com",
			};
			await authStorage.oauth.login("github-copilot", {
				onAuth: () => {},
				onPrompt: async () => "",
			});

			// Both OAuth accounts should coexist! No accounts should be disabled
			const secondRows = readStoredIdentityRows(db, "github-copilot");
			expect(secondRows).toEqual([
				{ identity_key: null, disabled_cause: "replaced by oauth login" },
				{ identity_key: "account:account-1", disabled_cause: null },
				{ identity_key: "account:account-2", disabled_cause: null },
			]);
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage persistent session stickiness", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-auth-test-"));
		dbPath = path.join(tempDir, "auth.db");
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("persists session-sticky credentials across AuthStorage restarts", async () => {
		// 1. Initialize AuthStorage and log in two accounts
		let authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));

		try {
			const credential1: OAuthCredential = {
				type: "oauth",
				refresh: "refresh-token-1",
				access: "access-token-1",
				expires: Date.now() + 3600_000,
				projectId: "project-1",
				email: "user-1@example.com",
			};
			const credential2: OAuthCredential = {
				type: "oauth",
				refresh: "refresh-token-2",
				access: "access-token-2",
				expires: Date.now() + 3600_000,
				projectId: "project-2",
				email: "user-2@example.com",
			};
			await authStorage.credentials.set("github-copilot", [credential1, credential2]);

			// 2. Resolve initial key for session-1
			const key1 = await authStorage.keys.get("github-copilot", "session-1");
			expect(key1).toBe("access-token-2");

			// 3. Rotate session-1's sticky credential to the sibling
			await authStorage.limits.rotate("github-copilot", "session-1");
			const key2 = await authStorage.keys.get("github-copilot", "session-1");
			expect(key2).toBe("access-token-1");

			// 4. Close AuthStorage to simulate process restart
			authStorage.close();

			// 5. Re-instantiate AuthStorage using the same DB
			authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));
			await authStorage.credentials.reload();

			// 6. Retrieve the sticky key again for session-1 (should still be access-token-1)
			const key3 = await authStorage.keys.get("github-copilot", "session-1");
			expect(key3).toBe("access-token-1");

			authStorage.close();
		} finally {
			// No-op
		}
	});

	it("drops persisted session stickiness after a lower-index credential is removed", async () => {
		const provider = "github-copilot";
		const mk = (suffix: string): OAuthCredential => ({
			type: "oauth",
			refresh: `refresh-${suffix}`,
			access: `access-${suffix}`,
			expires: Date.now() + 3600_000,
			projectId: `project-${suffix}`,
			email: `user-${suffix}@example.com`,
		});
		const initialCredentials = [mk("a"), mk("b"), mk("c"), mk("d")];
		const remainingCredentials = initialCredentials.slice(1);

		let authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));
		await authStorage.credentials.set(provider, initialCredentials);
		let rows = authStorage.credentials.list(provider);

		const control = new AuthStorage(
			new SqliteAuthCredentialStore(new Database(path.join(tempDir, "sticky-control.db"))),
		);
		await control.credentials.set(provider, remainingCredentials);
		let session: string | undefined;
		let stuckId = -1;
		let stuckIndex = -1;
		let stuckToken: string | undefined;
		let freshToken: string | undefined;
		try {
			for (let i = 0; i < 256 && session === undefined; i++) {
				const candidate = `sticky-probe-${i}`;
				const token = await authStorage.keys.get(provider, candidate);
				const expectedFreshToken = await control.keys.get(provider, candidate);
				const index = rows.findIndex(row => (row.credential as OAuthCredential).access === token);
				if (index >= 1 && index <= rows.length - 2 && token !== expectedFreshToken) {
					session = candidate;
					stuckIndex = index;
					stuckId = rows[index].id;
					stuckToken = token;
					freshToken = expectedFreshToken;
				}
			}
		} finally {
			control.close();
		}
		expect(session).toBeDefined();
		expect(freshToken).toBeDefined();

		expect(await authStorage.credentials.removeById(provider, rows[0].id)).toBe(true);
		authStorage.close();

		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));
		await authStorage.credentials.reload();
		rows = authStorage.credentials.list(provider);
		expect(rows.findIndex(row => row.id === stuckId)).toBe(stuckIndex - 1);

		const resolved = await authStorage.keys.get(provider, session);
		authStorage.close();
		expect(resolved).toBe(freshToken);
		expect(resolved).not.toBe(stuckToken);
	});
});
