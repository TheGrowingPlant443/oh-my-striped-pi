import { beforeEach as beforeEachOAuthFixture, afterEach as afterEachOAuthFixture } from "bun:test";
import { mockOAuthApiKey, resetOAuthMocks } from "./oauth-test-utils";
beforeEachOAuthFixture(() => mockOAuthApiKey());
afterEachOAuthFixture(() => resetOAuthMocks());
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { fixtureUsageProvider } from "./usage-test-utils";

const EMAIL = "shared@example.com";
const TEAM_ORG = "org-team-1111";
const MAX_ORG = "org-max-2222";

// ─── Usage report dedupe partitioning ───────────────────────────────────────

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

function makeStore(
	rows: StoredAuthCredential[],
	onUpdate?: (id: number, credential: AuthCredential) => void,
): AuthCredentialStore {
	const cache = new Map<string, CacheEntry>();
	return {
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential(id, credential) {
			onUpdate?.(id, credential);
		},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		async replaceAuthCredentials() {
			return rows;
		},
		async upsertAuthCredential() {
			return rows;
		},
		async deleteAuthCredentials() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(
	id: number,
	orgId?: string,
	orgName?: string,
	overrides?: { accountId?: string; refresh?: string; expires?: number; omitEmail?: boolean },
): StoredAuthCredential {
	return {
		id,
		provider: "github-copilot",
		credential: {
			type: "oauth",
			access: `oat-${id}`,
			refresh: overrides?.refresh ?? `refresh-${id}`,
			expires: overrides?.expires ?? Date.now() + 3_600_000,
			accountId: overrides?.accountId ?? "account-shared",
			email: overrides?.omitEmail ? undefined : EMAIL,
			orgId,
			orgName,
		},
		disabledCause: null,
	};
}

/** Report carrying ONLY email identity — org attribution must come from the credential. */
function emailOnlyReport(): UsageReport {
	return {
		provider: "github-copilot",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "github-copilot:5h",
				label: "5 Hour",
				scope: { provider: "github-copilot", windowId: "5h" },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email: EMAIL, accountId: "account-shared" },
	};
}

describe("usage report identity attribution", () => {
	let storage: AuthStorage | null = null;

	afterEach(() => {
		storage?.close();
		storage = null;
		vi.restoreAllMocks();
	});

	it("attaches the stored org name when the provider response already carries the org id", async () => {
		// A provider-returned org id must not suppress the stored org-name fallback.
		storage = new AuthStorage(makeStore([oauthRow(1, TEAM_ORG, "Team Workspace")]), {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
		});
		await storage.credentials.reload();

		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => ({
			...emailOnlyReport(),
			metadata: { email: EMAIL, accountId: "account-shared", orgId: TEAM_ORG },
		}));

		const reports = ((await storage.usage.reports()) ?? []).filter(r => r.provider === "github-copilot");
		expect(reports).toHaveLength(1);
		expect(reports[0]?.metadata?.orgId).toBe(TEAM_ORG);
		expect(reports[0]?.metadata?.orgName).toBe("Team Workspace");
	});

	it("still merges org-less reports with the same email into one row", async () => {
		storage = new AuthStorage(makeStore([oauthRow(1), oauthRow(2)]), {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
		});
		await storage.credentials.reload();

		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => emailOnlyReport());

		const reports = ((await storage.usage.reports()) ?? []).filter(r => r.provider === "github-copilot");
		expect(reports).toHaveLength(1);
	});
});

describe("broker-backed refresh row addressing", () => {
	let storage: AuthStorage | null = null;

	afterEach(() => {
		storage?.close();
		storage = null;
		vi.restoreAllMocks();
	});

	it("persists a refresh into its account's row, not the first sentinel row", async () => {
		// Broker tokens share a refresh sentinel, which must never identify a sibling account.
		const teamRow = oauthRow(1, TEAM_ORG, "Team Workspace", {
			accountId: "account-team",
			refresh: REMOTE_REFRESH_SENTINEL,
		});
		const maxRow = oauthRow(2, MAX_ORG, "Personal Max", {
			accountId: "account-max",
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: Date.now() - 1_000,
		});
		const updates: number[] = [];
		storage = new AuthStorage(
			makeStore([teamRow, maxRow], id => {
				updates.push(id);
			}),
			{
				usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
				refreshOAuthCredential: async () => ({
					access: "refreshed-access",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: Date.now() + 3_600_000,
				}),
			},
		);
		await storage.credentials.reload();
		expect(storage.oauth.accounts("github-copilot")).toHaveLength(2);

		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => emailOnlyReport());

		await storage.usage.reports();
		// Only the expired sibling (id 2) was rewritten; the first account was never touched.
		expect(updates).toEqual([2]);
	});
});
