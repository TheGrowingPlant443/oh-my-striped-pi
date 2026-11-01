import { beforeEach as beforeEachOAuthFixture, afterEach as afterEachOAuthFixture } from "bun:test";
import { mockOAuthApiKey, resetOAuthMocks } from "./oauth-test-utils";
beforeEachOAuthFixture(() => mockOAuthApiKey());
afterEachOAuthFixture(() => resetOAuthMocks());
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "github-copilot";
const PROVIDER_KEY = "github-copilot:oauth";
const FUTURE_BLOCK_MS = 1_899_999_999_000;
const EXPIRED_BLOCK_MS = 1;
const LEGACY_TIMESTAMP = 1_700_000_000;

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function readAuthSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function tableExists(dbPath: string, tableName: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName) as { present?: number } | undefined;
		return row?.present === 1;
	} finally {
		db.close();
	}
}

function readCredentialBlockRows(dbPath: string): Array<{
	credential_id: number;
	provider_key: string;
	block_scope: string;
	blocked_until_ms: number;
	updated_at: number;
}> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks ORDER BY credential_id, provider_key, block_scope",
			)
			.all() as Array<{
			credential_id: number;
			provider_key: string;
			block_scope: string;
			blocked_until_ms: number;
			updated_at: number;
		}>;
	} finally {
		db.close();
	}
}

describe("AuthStorage credential block persistence", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-blocks-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("honors explicit ranking-scope and unscoped blocks written by a previous AuthStorage instance", async () => {
		const firstStore = await SqliteAuthCredentialStore.open(dbPath);
		await firstStore.saveOAuth(PROVIDER, oauthCredential("1"));
		await firstStore.saveOAuth(PROVIDER, oauthCredential("2"));
		await firstStore.saveOAuth(PROVIDER, oauthCredential("3"));
		const rows = firstStore.listAuthCredentials(PROVIDER);
		const firstStorage = new AuthStorage(firstStore);
		await firstStorage.credentials.reload();
		try {
			firstStorage.blocks.upsert({
				credentialId: rows[0]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			firstStorage.blocks.upsert({
				credentialId: rows[1]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		} finally {
			firstStorage.close();
		}

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedStorage = new AuthStorage(reopenedStore, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => ({
				findWindowLimits: () => ({}),
				windowDefaults: { primaryMs: 0, secondaryMs: 0 },
				blockScope: () => "tier:fable",
			}),
		});
		await reopenedStorage.credentials.reload();
		try {
			const fableKey = await reopenedStorage.keys.get(PROVIDER, "session-3", { modelId: "claude-fable-5" });
			expect(fableKey).toBe("access-3");
		} finally {
			reopenedStorage.close();
		}
	});

	it("keeps the later expiry when a shorter block is upserted for the same key", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			const longerBlock = FUTURE_BLOCK_MS + 60_000;
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: longerBlock,
			});
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});

			// `updatedAtMs` is the row's DB write time (issue #4980: same-deadline
			// refreshes must be observable), so only its presence is asserted.
			expect(storage.blocks.list([row.id])).toEqual([
				{
					credentialId: row.id,
					providerKey: PROVIDER_KEY,
					blockScope: "tier:fable",
					blockedUntilMs: longerBlock,
					updatedAtMs: expect.any(Number),
				},
			]);
		} finally {
			storage.close();
		}
	});

	it("does not resurrect a cleared block after a sibling instance reinserts a shorter one", async () => {
		const options = { usageProviderResolver: () => undefined, rankingStrategyResolver: () => undefined };
		const storeA = await SqliteAuthCredentialStore.open(dbPath);
		await storeA.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = storeA.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storeB = await SqliteAuthCredentialStore.open(dbPath);
		const a = new AuthStorage(storeA, options);
		const b = new AuthStorage(storeB, options);
		await a.credentials.reload();
		await b.credentials.reload();
		const threeDays = 3 * 24 * 60 * 60_000;
		try {
			await a.limits.markReached(PROVIDER, "a", {
				credentialId: row.id,
				retryAfterMs: threeDays,
				providerTimed: true,
			});
			// B redeems a reset, then hits a fresh short block before A reads the store again.
			storeB.deleteCredentialBlock(row.id, PROVIDER_KEY, "");
			await b.limits.markReached(PROVIDER, "b", { credentialId: row.id, retryAfterMs: 60_000, providerTimed: true });

			const result = await a.limits.markReached(PROVIDER, "a", {
				credentialId: row.id,
				retryAfterMs: 60_000,
				providerTimed: true,
			});

			const shortDeadline = Date.now() + 120_000;
			expect(result.blockedUntilMs).toBeLessThan(shortDeadline);
			expect(storeA.getCredentialBlock(row.id, PROVIDER_KEY, "")).toBeLessThan(shortDeadline);
		} finally {
			a.close();
			b.close();
		}
	});

	it("retires a mirrored in-memory block once a sibling process deletes its row", async () => {
		const options = { usageProviderResolver: () => undefined, rankingStrategyResolver: () => undefined };
		const storeA = await SqliteAuthCredentialStore.open(dbPath);
		await storeA.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = storeA.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storeB = await SqliteAuthCredentialStore.open(dbPath);
		const a = new AuthStorage(storeA, options);
		await a.credentials.reload();
		try {
			await a.limits.markReached(PROVIDER, "a", {
				credentialId: row.id,
				retryAfterMs: 3_600_000,
				providerTimed: true,
			});

			storeB.deleteCredentialBlock(row.id, PROVIDER_KEY, "");

			// A still-live mirror would win the longest-wins merge and keep the hour-long deadline.
			const result = await a.limits.markReached(PROVIDER, "a", {
				credentialId: row.id,
				retryAfterMs: 60_000,
				providerTimed: true,
			});
			expect(result.blockedUntilMs).toBeLessThan(Date.now() + 120_000);
		} finally {
			a.close();
			storeB.close();
		}
	});

	it("keeps an explicit session pin after hundreds of newer sessions push it out of memory", async () => {
		const options = { usageProviderResolver: () => undefined, rankingStrategyResolver: () => undefined };
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("1"));
		await store.saveOAuth(PROVIDER, oauthCredential("2"));
		const [first, second] = store.listAuthCredentials(PROVIDER);
		if (!first || !second) throw new Error("expected credential rows");
		const storage = new AuthStorage(store, options);
		await storage.credentials.reload();
		try {
			expect(storage.sessions.pin(PROVIDER, "pinned-session", second.id)).toBe(true);
			for (let index = 0; index < 300; index++) {
				expect(storage.sessions.pin(PROVIDER, `filler-${index}`, first.id)).toBe(true);
			}
			expect(await storage.keys.get(PROVIDER, "pinned-session")).toBe("access-2");
		} finally {
			storage.close();
		}
	});

	it("drops expired rows from reads and clears persisted blocks through the public delete wrapper", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: EXPIRED_BLOCK_MS,
			});

			expect(storage.blocks.list([row.id])).toEqual([
				{
					credentialId: row.id,
					providerKey: PROVIDER_KEY,
					blockScope: "tier:fable",
					blockedUntilMs: FUTURE_BLOCK_MS,
					updatedAtMs: expect.any(Number),
				},
			]);
			const generationBeforeScopedDelete = storage.credentials.generation;
			storage.blocks.delete(row.id, PROVIDER_KEY, "tier:fable");
			expect(storage.blocks.list([row.id])).toEqual([]);
			expect(storage.credentials.generation).toBe(generationBeforeScopedDelete + 1);
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});

			const generationBeforeDelete = storage.credentials.generation;
			storage.blocks.deleteAll(row.id);
			expect(storage.blocks.list([row.id])).toEqual([]);
			expect(storage.credentials.generation).toBe(generationBeforeDelete + 1);
		} finally {
			storage.close();
		}
	});

	it("keeps a block attached to the same credential row after a sibling is disabled", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("1"));
		await store.saveOAuth(PROVIDER, oauthCredential("2"));
		await store.saveOAuth(PROVIDER, oauthCredential("3"));
		const rows = store.listAuthCredentials(PROVIDER);
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			storage.blocks.upsert({
				credentialId: rows[1]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		} finally {
			storage.close();
		}

		const disablingStore = await SqliteAuthCredentialStore.open(dbPath);
		await disablingStore.deleteAuthCredential(rows[0]!.id, "disabled for test");
		disablingStore.close();

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedStorage = new AuthStorage(reopenedStore);
		await reopenedStorage.credentials.reload();
		try {
			const key = await reopenedStorage.keys.get(PROVIDER, "a");
			expect(key).toBe("access-3");
		} finally {
			reopenedStorage.close();
		}
	});

	it("keeps steady-state scoped block reads read-only while another connection owns the writer lock", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("read-only"));
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: PROVIDER_KEY,
			blockScope: "chat",
			blockedUntilMs,
		});
		expect(readCredentialBlockRows(dbPath)).toContainEqual(
			expect.objectContaining({
				credential_id: row.id,
				provider_key: PROVIDER_KEY,
				block_scope: "chat",
				blocked_until_ms: blockedUntilMs,
			}),
		);

		const writer = new Database(dbPath);
		let writerLocked = false;
		try {
			writer.run("BEGIN IMMEDIATE");
			writerLocked = true;

			expect(store.getCredentialBlock(row.id, PROVIDER_KEY, "chat")).toBe(blockedUntilMs);
			expect(store.getCredentialBlock(row.id, PROVIDER_KEY, "shared")).toBeUndefined();
			const reconcileAfterMs = store.getCredentialBlockReconcileAfter(row.id, PROVIDER_KEY, "chat");
			expect(reconcileAfterMs).toBeGreaterThan(Date.now());
			expect(reconcileAfterMs).toBeLessThan(blockedUntilMs);
		} finally {
			if (writerLocked) writer.run("ROLLBACK");
			writer.close();
			store.close();
		}
	});

	it("answers block reads when the expired-row sweep finds the writer lock held", async () => {
		const seed = await SqliteAuthCredentialStore.open(dbPath);
		await seed.saveOAuth(PROVIDER, oauthCredential("busy"));
		const [row] = seed.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		seed.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});
		seed.close();

		// A fresh store sweeps on its first block read; the held lock makes that sweep fail busy.
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const writer = new Database(dbPath);
		let writerLocked = false;
		try {
			writer.run("PRAGMA busy_timeout = 0");
			writer.run("BEGIN IMMEDIATE");
			writerLocked = true;

			expect(store.getCredentialBlockScopes(row.id, PROVIDER_KEY)).toEqual(new Map([["", FUTURE_BLOCK_MS]]));
			expect(store.listCredentialBlocks([row.id]).map(block => block.blockedUntilMs)).toEqual([FUTURE_BLOCK_MS]);
		} finally {
			if (writerLocked) writer.run("ROLLBACK");
			writer.close();
			store.close();
		}
	});

	it("backfills refresh leases for a v5 auth database", async () => {
		const legacyDb = new Database(dbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 5);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const expiresAtMs = Date.now() + 3_600_000;
			expect(migratedStore.tryAcquireCredentialRefreshLease(1, "test-owner", expiresAtMs)).toBe(true);
			expect(migratedStore.getCredentialRefreshLeaseExpiresAt(1)).toBe(expiresAtMs);
			expect(readAuthSchemaVersion(dbPath)).toBe(8);
		} finally {
			migratedStore.close();
		}
	});

	it("migrates a v4 auth database to current version 8 without dropping credential rows", async () => {
		const legacyDb = new Database(dbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 4);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				PROVIDER,
				"oauth",
				JSON.stringify({
					access: "legacy-access",
					refresh: "legacy-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "legacy-account",
					email: "legacy@example.com",
				}),
				null,
				"email:legacy@example.com",
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const rows = migratedStore.listAuthCredentials(PROVIDER);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.credential).toMatchObject({ type: "oauth", access: "legacy-access" });
			expect(readAuthSchemaVersion(dbPath)).toBe(8);
			expect(tableExists(dbPath, "auth_credential_blocks")).toBe(true);
		} finally {
			migratedStore.close();
		}
	});
});
