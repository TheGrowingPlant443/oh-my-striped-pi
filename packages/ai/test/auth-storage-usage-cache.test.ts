import { beforeEach as beforeEachOAuthFixture, afterEach as afterEachOAuthFixture } from "bun:test";
import { mockOAuthApiKey, resetOAuthMocks } from "./oauth-test-utils";
beforeEachOAuthFixture(() => mockOAuthApiKey());
afterEachOAuthFixture(() => resetOAuthMocks());
/**
 * Tests for per-credential usage-cache contracts:
 *
 *   1. Per-credential cache stores the last successful report; failures
 *      DON'T overwrite a stale-but-good entry with null.
 *   2. With a stale-but-good entry, a failure serves the previous value
 *      (cached for a short cool-down) instead of dropping the credential
 *      from the report.
 *   3. Without a previous value (a cold failure), a failure caches `null` for
 *      the failure backoff window — a repeat poll within the window is served
 *      from cache (no refetch); the entry expires and the next poll retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-striped-pi/pi-ai/auth-storage";
import { usageCacheIdentity } from "@oh-my-striped-pi/pi-ai/auth/usage-cache";
import type { UsageProvider, UsageReport } from "@oh-my-striped-pi/pi-ai/usage";
import { fixtureUsageProvider } from "./usage-test-utils";

function copilotReports(reports: UsageReport[] | null): UsageReport[] {
	return (reports ?? []).filter(r => r.provider === "github-copilot");
}

/**
 * Force every cache entry to look stale to AuthStorage WITHOUT dropping the
 * value. The cache layer is two-tier: the store-level `expiresAtSec` controls
 * whether `getCache` returns anything at all, and the JSON payload's own
 * `expiresAt` is what AuthStorage compares against `Date.now()` to decide if
 * the entry is fresh. Mutating only the inner expiresAt simulates time
 * passing while keeping the last-good value reachable for the failure path.
 */
function expireCachePayloads(store: ObservableStore): void {
	for (const [key, entry] of store.cache) {
		try {
			const parsed = JSON.parse(entry.value);
			parsed.expiresAt = 1; // positive but already in the past (epoch ms)
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
}

/**
 * Minimal in-memory `AuthCredentialStore` exposing the cache so we can
 * assert what AuthStorage writes to it during usage fetches.
 */
function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
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

function oauthRow(id: number, email: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "github-copilot", credential, disabledCause: null };
}

function makeReport(account: string): UsageReport {
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
		metadata: { email: account, accountId: `account-${account}` },
	};
}

describe("AuthStorage usage cache: last-good failure fallback", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		// Restrict the resolver to the fixture so polling never contacts real usage endpoints.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
		});
		await storage.credentials.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	it("caches a successful report and replays it on a second poll", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return goldReport;
		});

		const first = copilotReports(await storage.usage.reports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		const second = copilotReports(await storage.usage.reports());
		expect(second).toHaveLength(1);
		// Cache hit — provider was NOT called a second time.
		expect(calls).toBe(1);
	});

	it("cold-fetches instead of replaying a report stored under the previous provider cache version", async () => {
		const previousVersionKey =
			"usage_cache:report:2:github-copilot:default:oauth|account:account-1|email:a@example.com";
		store.cache.set(previousVersionKey, {
			value: JSON.stringify({ value: makeReport("a@example.com"), expiresAt: Date.now() + 60_000 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});
		const base = makeReport("a@example.com");
		const freshReport = { ...base, metadata: { ...base.metadata, source: "fresh-v3-fetch" } };
		const fetchSpy = vi.spyOn(fixtureUsageProvider, "fetchUsage").mockResolvedValue(freshReport);

		const reports = copilotReports(await storage.usage.reports());

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(reports[0]?.metadata?.source).toBe("fresh-v3-fetch");
	});

	it("uses the configured usage provider's cache version instead of the built-in version", async () => {
		const oldKey = "usage_cache:report:3:github-copilot:default:oauth|account:account-1|email:a@example.com";
		store.cache.set(oldKey, {
			value: JSON.stringify({ value: makeReport("a@example.com"), expiresAt: Date.now() + 60_000 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});
		const base = makeReport("a@example.com");
		let calls = 0;
		const customProvider: UsageProvider = {
			...fixtureUsageProvider,
			cacheVersion: 4,
			async fetchUsage() {
				calls += 1;
				return { ...base, metadata: { ...base.metadata, source: "custom-provider" } };
			},
		};
		storage.close();
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? customProvider : undefined),
		});
		await storage.credentials.reload();

		const reports = copilotReports(await storage.usage.reports());

		expect(calls).toBe(1);
		expect(reports[0]?.metadata?.source).toBe("custom-provider");
	});

	it("keys reports by a runtime usage provider's cache version, not the configured resolver's", async () => {
		const base = makeReport("a@example.com");
		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockResolvedValue({
			...base,
			metadata: { ...base.metadata, source: "built-in" },
		});
		// A second process on the same agent.db, without the extension provider.
		const extensionless = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
		});
		await extensionless.credentials.reload();
		let overrideCalls = 0;
		storage.usage.setProvider("github-copilot", {
			...fixtureUsageProvider,
			cacheVersion: 2564,
			async fetchUsage() {
				overrideCalls += 1;
				return { ...base, metadata: { ...base.metadata, source: "override" } };
			},
		});

		try {
			const shared = copilotReports(await extensionless.usage.reports());
			const overridden = copilotReports(await storage.usage.reports());

			expect(shared[0]?.metadata?.source).toBe("built-in");
			expect(overrideCalls).toBe(1);
			expect(overridden[0]?.metadata?.source).toBe("override");

			// Removing the override restores the configured provider's cached rows.
			storage.usage.removeProvider("github-copilot");
			await extensionless.usage.reports();
			expect(copilotReports(await storage.usage.reports())[0]?.metadata?.source).toBe("built-in");
		} finally {
			extensionless.close();
		}
	});

	it("caches null on a cold failure for the backoff window, then retries after it expires", async () => {
		let calls = 0;
		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		// First poll: cold fetch fails → caches null for the backoff window.
		const first = copilotReports(await storage.usage.reports());
		expect(first).toHaveLength(0);
		expect(calls).toBe(1);

		// Second poll within the window: served from the cold-null cache — no refetch.
		const second = copilotReports(await storage.usage.reports());
		expect(calls).toBe(1);
		expect(second).toHaveLength(0);

		// Expire the backoff entry → the next poll refetches (and fails again).
		expireCachePayloads(store);
		const third = copilotReports(await storage.usage.reports());
		expect(calls).toBe(2);
		expect(third).toHaveLength(0);
	});

	it("serves last-good value through a failure cycle", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			if (calls === 1) return goldReport;
			return null;
		});

		// First poll: real fetch → cached.
		const first = copilotReports(await storage.usage.reports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Force every cached entry to expire so the next poll refetches.
		// Bun's `bun:test` doesn't ship setSystemTime, so we manipulate the
		// observable store cache directly — equivalent to advancing time past
		// the success TTL.
		expireCachePayloads(store);

		// Second poll: cache expired → refetch → provider returns null →
		// AuthStorage falls back to last-good and the report stays populated.
		const second = copilotReports(await storage.usage.reports());
		expect(calls).toBe(2);
		expect(second).toHaveLength(1);
		// The fallback value must be the SAME report (not a synthetic empty one).
		expect(second?.[0]?.limits[0]?.amount.used).toBe(42);
	});

	it("re-attempts the failing credential after the cool-down expires", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			// Succeed on attempt 1, fail on 2, succeed on 3.
			if (calls === 2) return null;
			return goldReport;
		});

		const first = copilotReports(await storage.usage.reports());
		expect(first).toHaveLength(1);
		expect(calls).toBe(1);

		// Expire success cache → poll 2 fetches and 429s → cool-down written.
		expireCachePayloads(store);
		const second = copilotReports(await storage.usage.reports());
		expect(second).toHaveLength(1); // last-good fallback
		expect(calls).toBe(2);

		// Expire the cool-down → poll 3 refetches → success.
		expireCachePayloads(store);
		const third = copilotReports(await storage.usage.reports());
		expect(third).toHaveLength(1);
		expect(calls).toBe(3);
	});

	it("does not replay last-good quota after an explicit invalidation", async () => {
		let calls = 0;
		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return calls === 1 ? makeReport("a@example.com") : null;
		});

		expect(copilotReports(await storage.usage.reports())).toHaveLength(1);
		await storage.usage.invalidate();

		expect(copilotReports(await storage.usage.reports())).toHaveLength(0);
		expect(calls).toBe(2);
	});
});

describe("AuthStorage usage cache: explicit invalidation", () => {
	it("preserves failed-probe cooldown across repeated invalidation and storage recreation", async () => {
		const row = oauthRow(1, "a@example.com");
		const store = makeStore([row]);
		let calls = 0;
		const recovered = makeReport("a@example.com");
		const usageProvider: UsageProvider = {
			id: "github-copilot",
			supports: params => params.provider === "github-copilot",
			async fetchUsage() {
				calls += 1;
				return calls === 1 ? null : recovered;
			},
		};
		const options = {
			usageProviderResolver: (provider: string) => (provider === "github-copilot" ? usageProvider : undefined),
		};
		let storage = new AuthStorage(store, options);
		await storage.credentials.reload();
		try {
			expect(await storage.usage.reports()).toEqual([]);
			await storage.usage.invalidate("github-copilot");
			expect(await storage.usage.reports()).toEqual([]);
			storage.close();
			storage = new AuthStorage(store, options);
			await storage.credentials.reload();
			await storage.usage.invalidate("github-copilot");
			expect(await storage.usage.reports()).toEqual([]);
			expect(calls).toBe(1);

			expireCachePayloads(store);
			expect(await storage.usage.reports()).toEqual([recovered]);
			expect(calls).toBe(2);
		} finally {
			storage.close();
		}
	});

	it("shares an in-flight failure across invalidation and concurrent usage consumers", async () => {
		const store = makeStore([oauthRow(1, "a@example.com")]);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<UsageReport | null>();
		let calls = 0;
		const usageProvider: UsageProvider = {
			id: "github-copilot",
			supports: params => params.provider === "github-copilot",
			async fetchUsage() {
				calls += 1;
				started.resolve();
				return release.promise;
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? usageProvider : undefined),
		});
		await storage.credentials.reload();
		try {
			const initial = storage.usage.reports();
			await started.promise;
			await storage.usage.invalidate("github-copilot");
			const refreshed = storage.usage.reports();
			await storage.usage.invalidate("github-copilot");
			const peer = storage.usage.reports();
			release.resolve(null);

			expect(await Promise.all([initial, refreshed, peer])).toEqual([[], [], []]);
			expect(calls).toBe(1);
			await storage.usage.invalidate("github-copilot");
			expect(await storage.usage.reports()).toEqual([]);
			expect(calls).toBe(1);
		} finally {
			release.resolve(null);
			storage.close();
		}
	});

	it("replaces an invalidated in-flight success with one shared fresh probe", async () => {
		const store = makeStore([oauthRow(1, "a@example.com")]);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<UsageReport | null>();
		const stale = makeReport("a@example.com");
		const fresh: UsageReport = {
			...stale,
			fetchedAt: stale.fetchedAt + 1,
			limits: stale.limits.map(limit => ({ ...limit, amount: { ...limit.amount, used: 0 } })),
		};
		let calls = 0;
		let active = 0;
		let peak = 0;
		const usageProvider: UsageProvider = {
			id: "github-copilot",
			supports: params => params.provider === "github-copilot",
			async fetchUsage() {
				calls += 1;
				active += 1;
				peak = Math.max(peak, active);
				try {
					if (calls !== 1) return fresh;
					started.resolve();
					return await release.promise;
				} finally {
					active -= 1;
				}
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? usageProvider : undefined),
		});
		await storage.credentials.reload();
		try {
			const initial = storage.usage.reports();
			await started.promise;
			await storage.usage.invalidate("github-copilot");
			const refreshed = storage.usage.reports();
			const peer = storage.usage.reports();
			release.resolve(stale);

			expect(await Promise.all([initial, refreshed, peer])).toEqual([[fresh], [fresh], [fresh]]);
			expect(calls).toBe(2);
			expect(peak).toBe(1);
			expect(await storage.usage.reports()).toEqual([fresh]);
			expect(calls).toBe(2);
		} finally {
			release.resolve(null);
			storage.close();
		}
	});

	it("answers an in-flight probe that races a block write without probing again", async () => {
		const store = makeStore([oauthRow(1, "a@example.com")]);
		store.upsertCredentialBlock = () => {};
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<UsageReport | null>();
		const report = makeReport("a@example.com");
		let calls = 0;
		const usageProvider: UsageProvider = {
			id: "github-copilot",
			supports: params => params.provider === "github-copilot",
			async fetchUsage() {
				calls += 1;
				started.resolve();
				return release.promise;
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? usageProvider : undefined),
		});
		await storage.credentials.reload();
		try {
			const pending = storage.usage.reports();
			await started.promise;
			// Every 429 writes a block while other sessions poll usage; that must
			// not multiply requests against a per-IP rate-limited endpoint.
			storage.blocks.upsert({
				credentialId: 1,
				providerKey: "github-copilot:oauth",
				blockScope: "tier:fable",
				blockedUntilMs: Date.now() + 60_000,
			});
			release.resolve(report);

			expect(await pending).toEqual([report]);
			expect(calls).toBe(1);
		} finally {
			release.resolve(null);
			storage.close();
		}
	});

	it("clears cached API-key reports before the next usage read", async () => {
		const store = makeStore([
			{
				id: 1,
				provider: "github-copilot",
				credential: { type: "api_key", key: "copilot-key" },
				disabledCause: null,
			},
		]);
		let calls = 0;
		const usageProvider: UsageProvider = {
			id: "github-copilot",
			supports: params => params.provider === "github-copilot" && params.credential.type === "api_key",
			async fetchUsage() {
				calls += 1;
				return {
					provider: "github-copilot",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "github-copilot:requests:5h",
							label: "Request Quota",
							scope: { provider: "github-copilot", windowId: "5h" },
							amount: { used: calls === 1 ? 80 : 20, limit: 100, unit: "requests" },
							status: "ok",
						},
					],
				};
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? usageProvider : undefined),
		});
		await storage.credentials.reload();
		try {
			const initial = await storage.usage.reports();
			expect(initial?.[0]?.limits[0]?.amount.used).toBe(80);

			await storage.usage.invalidate();

			const refreshed = await storage.usage.reports();
			expect(refreshed?.[0]?.limits[0]?.amount.used).toBe(20);
			expect(calls).toBe(2);
		} finally {
			storage.close();
		}
	});

	it("serializes a persisted refresh and returns an upgraded plan", async () => {
		const store = makeStore([
			{
				id: 1,
				provider: "github-copilot",
				credential: {
					type: "oauth",
					access: "access-free",
					refresh: "refresh-free",
					expires: Date.now() + 3_600_000,
					accountId: "account-free",
					email: "free@example.com",
				},
				disabledCause: null,
			},
			{
				id: 2,
				provider: "github-copilot",
				credential: {
					type: "oauth",
					access: "access-upgraded",
					refresh: "refresh-upgraded",
					expires: Date.now() + 3_600_000,
					accountId: "account-upgraded",
					email: "upgraded@example.com",
				},
				disabledCause: null,
			},
			{
				id: 3,
				provider: "github-copilot",
				credential: {
					type: "oauth",
					access: "access-other",
					refresh: "refresh-other",
					expires: Date.now() + 3_600_000,
					accountId: "account-other",
					email: "other@example.com",
				},
				disabledCause: null,
			},
		]);
		let upgraded = false;
		const refreshStarted = new Map<string, PromiseWithResolvers<void>>();
		const refreshReleases = new Map<string, PromiseWithResolvers<void>>();
		for (const accountId of ["account-free", "account-upgraded", "account-other"]) {
			refreshStarted.set(accountId, Promise.withResolvers<void>());
			refreshReleases.set(accountId, Promise.withResolvers<void>());
		}
		const startedAccounts: string[] = [];
		const usageProvider: UsageProvider = {
			id: "github-copilot",
			supports: params => params.provider === "github-copilot" && params.credential.type === "oauth",
			async fetchUsage(params) {
				const accountId = params.credential.accountId;
				if (!accountId) return null;
				if (upgraded) {
					const started = refreshStarted.get(accountId);
					const release = refreshReleases.get(accountId);
					if (!started || !release) throw new Error(`unexpected account ${accountId}`);
					startedAccounts.push(accountId);
					started.resolve();
					await release.promise;
				}
				return {
					provider: "github-copilot",
					fetchedAt: Date.now(),
					limits: [
						{
							id: "github-copilot:7d",
							label: "7 days",
							scope: { provider: "github-copilot", windowId: "7d" },
							amount: { used: 0, limit: 100, unit: "percent" },
							status: "ok",
						},
					],
					metadata: {
						accountId,
						email: params.credential.email,
						planType: upgraded && accountId === "account-upgraded" ? "pro" : "free",
					},
				};
			},
		};
		const initialStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? usageProvider : undefined),
		});
		await initialStorage.credentials.reload();
		try {
			expect(await initialStorage.usage.reports()).toHaveLength(3);
			await initialStorage.usage.invalidate();
		} finally {
			initialStorage.close();
		}

		upgraded = true;
		const refreshedStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? usageProvider : undefined),
		});
		await refreshedStorage.credentials.reload();
		try {
			const refresh = refreshedStorage.usage.reports();
			const freeStarted = refreshStarted.get("account-free");
			const freeRelease = refreshReleases.get("account-free");
			if (!freeStarted || !freeRelease) throw new Error("missing free-account refresh gates");
			await freeStarted.promise;
			expect(startedAccounts).toEqual(["account-free"]);
			freeRelease.resolve();

			const upgradedStarted = refreshStarted.get("account-upgraded");
			const upgradedRelease = refreshReleases.get("account-upgraded");
			if (!upgradedStarted || !upgradedRelease) throw new Error("missing upgraded-account refresh gates");
			await upgradedStarted.promise;
			expect(startedAccounts).toEqual(["account-free", "account-upgraded"]);
			upgradedRelease.resolve();

			const otherStarted = refreshStarted.get("account-other");
			const otherRelease = refreshReleases.get("account-other");
			if (!otherStarted || !otherRelease) throw new Error("missing other-account refresh gates");
			await otherStarted.promise;
			expect(startedAccounts).toEqual(["account-free", "account-upgraded", "account-other"]);
			otherRelease.resolve();

			const reports = await refresh;
			expect(reports?.find(report => report.metadata?.accountId === "account-upgraded")?.metadata?.planType).toBe(
				"pro",
			);
		} finally {
			refreshedStorage.close();
		}
	});
});

describe("AuthStorage usage cache: jitter", () => {
	it("writes per-credential cache TTLs with ±25% jitter so refreshes decorrelate", async () => {
		const store = makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com")]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
		});
		await storage.credentials.reload();
		try {
			const goldA = makeReport("a@example.com");
			const goldB = makeReport("b@example.com");
			vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async params => {
				return params.credential.email === "a@example.com" ? goldA : goldB;
			});

			await storage.usage.reports();

			// The store-level TTL is bumped to the 24h durable-retention floor so
			// `getStale` can recover last-good values; the freshness TTL we actually
			// jitter lives in the JSON payload. Read that, not the store TTL.
			const freshExpiries: number[] = [];
			for (const entry of store.cache.values()) {
				if (entry.value.length === 0) continue;
				const parsed = JSON.parse(entry.value);
				if (typeof parsed?.expiresAt === "number") freshExpiries.push(parsed.expiresAt);
			}
			expect(freshExpiries.length).toBeGreaterThanOrEqual(2);
			const now = Date.now();
			for (const expiry of freshExpiries) {
				const delta = expiry - now;
				expect(delta).toBeGreaterThan(3.5 * 60_000);
				expect(delta).toBeLessThan(6.5 * 60_000);
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: terminal refresh failure", () => {
	// Usage polling is non-critical: refresh failure must not disable a
	// credential whose current access token can still satisfy the probe.
	it("keeps credential and probes with current access after a definitive refresh failure", async () => {
		const row = oauthRow(1, "a@example.com");
		if (row.credential.type !== "oauth") throw new Error("expected OAuth test credential");
		row.credential.expires = Date.now() + 30_000;
		const rows = [row];
		const cache = new Map<string, CacheEntry>();
		let disableCalls = 0;
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(candidate => !candidate.disabledCause),
			updateAuthCredential() {},
			async deleteAuthCredential() {
				return false;
			},
			tryDisableAuthCredentialIfMatches() {
				disableCalls += 1;
				return true;
			},
			replaceAuthCredentials: async () => rows,
			upsertAuthCredential: async () => rows,
			async deleteAuthCredentials() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("OAuth refresh failed: 400 invalid_grant: refresh token revoked");
			},
		});
		await storage.credentials.reload();

		const fetchSpy = vi.spyOn(fixtureUsageProvider, "fetchUsage").mockResolvedValue(makeReport("a@example.com"));
		try {
			const reports = copilotReports(await storage.usage.reports());

			expect(reports).toHaveLength(1);
			expect(reports[0]?.metadata?.email).toBe("a@example.com");
			expect(disableCalls).toBe(0);
			expect(rows[0]?.disabledCause).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy.mock.calls[0]?.[0].credential.accessToken).toBe("oat-1");
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("suppresses last-good fallback when an expired OAuth access token has a definitive refresh failure", async () => {
		const row = oauthRow(3, "expired@example.com");
		if (row.credential.type !== "oauth") throw new Error("expected OAuth test credential");
		row.credential.expires = Date.now() - 1000;
		const store = makeStore([row]);
		const cacheKey = "usage_cache:report:3:github-copilot:default:oauth|account:account-3|email:expired@example.com";
		store.cache.set(cacheKey, {
			value: JSON.stringify({ value: makeReport("expired@example.com"), expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("OAuth refresh failed: 400 invalid_grant: refresh token revoked");
			},
		});
		await storage.credentials.reload();
		const fetchSpy = vi.spyOn(fixtureUsageProvider, "fetchUsage").mockResolvedValue(null);
		try {
			expect(copilotReports(await storage.usage.reports())).toHaveLength(0);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(row.disabledCause).toBeNull();
			const cached = JSON.parse(store.cache.get(cacheKey)!.value);
			expect(cached.value).toBeNull();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});

	it("preserves last-good fallback for transient (non-definitive) refresh failures", async () => {
		// Mirror image: a 502 from the token endpoint is transient — we keep the
		// row, fall back to the prior good report, and try again next poll.
		const row = oauthRow(2, "b@example.com");
		(row.credential as { expires: number }).expires = Date.now() - 1000;
		const rows = [row];

		const cache = new Map<string, CacheEntry>();
		const store: ObservableStore = {
			cache,
			close() {},
			listAuthCredentials: () => rows.filter(r => !r.disabledCause),
			updateAuthCredential() {},
			async deleteAuthCredential() {
				return false;
			},
			tryDisableAuthCredentialIfMatches() {
				return true;
			},
			replaceAuthCredentials: async () => rows,
			upsertAuthCredential: async () => rows,
			async deleteAuthCredentials() {},
			getCache(key: string, options?: { includeExpired?: boolean }) {
				const entry = cache.get(key);
				if (!entry) return null;
				if (!options?.includeExpired && entry.expiresAtSec * 1000 <= Date.now()) return null;
				return entry.value;
			},
			setCache(key: string, value: string, expiresAtSec: number) {
				cache.set(key, { value, expiresAtSec });
			},
			cleanExpiredCache() {},
		};

		const lastGood = makeReport("b@example.com");
		const cacheKey = "usage_cache:report:3:github-copilot:default:oauth|account:account-2|email:b@example.com";
		cache.set(cacheKey, {
			value: JSON.stringify({ value: lastGood, expiresAt: 1 }),
			expiresAtSec: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000),
		});

		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
			refreshOAuthCredential: async () => {
				throw new Error("fetch failed: connect ECONNREFUSED 1.2.3.4:443");
			},
		});
		await storage.credentials.reload();

		// The provider probe runs with the stale credential and fails — we don't
		// need a real upstream response, just a deterministic null so the lastGood
		// path is the one being tested.
		vi.spyOn(fixtureUsageProvider, "fetchUsage").mockResolvedValue(null);

		try {
			const reports = copilotReports(await storage.usage.reports());
			expect(reports).toHaveLength(1);
			expect(reports[0]?.metadata?.email).toBe("b@example.com");
			expect(rows[0].disabledCause).toBeNull();
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: org-only identity stability", () => {
	it("keeps the cache entry across a token rotation for an org-only credential", async () => {
		// Identity recovery failed at login: the credential carries neither
		// accountId nor email — only the org. The usage-cache identity must key
		// off the org instead of a token hash, or every OAuth refresh would
		// churn the cache key and fragment the usage history.
		const credential: AuthCredential = {
			type: "oauth",
			access: "oat-initial",
			refresh: "refresh-initial",
			expires: Date.now() + 3_600_000,
			orgId: "org-team-1111",
		};
		const row: StoredAuthCredential = { id: 1, provider: "github-copilot", credential, disabledCause: null };
		const store = makeStore([row]);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "github-copilot" ? fixtureUsageProvider : undefined),
		});
		await storage.credentials.reload();
		try {
			let calls = 0;
			vi.spyOn(fixtureUsageProvider, "fetchUsage").mockImplementation(async () => {
				calls += 1;
				return makeReport("org-only");
			});

			const first = copilotReports(await storage.usage.reports());
			expect(first).toHaveLength(1);
			expect(calls).toBe(1);
			const reportKeysBefore = [...store.cache.keys()].filter(key => key.startsWith("usage_cache:report:")).sort();
			expect(reportKeysBefore).toHaveLength(1);

			// An OAuth refresh rotates both tokens. The rotated credential must
			// resolve to the SAME cache entry — served from cache, no refetch.
			row.credential = { ...credential, access: "oat-rotated", refresh: "refresh-rotated" };
			await storage.credentials.reload();

			const second = copilotReports(await storage.usage.reports());
			expect(second).toHaveLength(1);
			expect(calls).toBe(1);
			const reportKeysAfter = [...store.cache.keys()].filter(key => key.startsWith("usage_cache:report:")).sort();
			expect(reportKeysAfter).toEqual(reportKeysBefore);
			for (const key of reportKeysAfter) {
				expect(key).toContain("org:org-team-1111");
				expect(key).not.toContain("secret:");
			}
		} finally {
			storage.close();
			vi.restoreAllMocks();
		}
	});
});

describe("AuthStorage usage cache: organization scope identity", () => {
	it("isolates usage caches across organizations, WorkOS selections and residency", () => {
		const credential = {
			type: "oauth" as const,
			accessToken: "token",
			accountId: "user",
			orgId: "org-a",
			activeOrganizationId: "workos-a",
			region: "global",
			inferenceRegion: "us" as const,
		};
		const key = usageCacheIdentity(credential);
		expect(key).toBe(usageCacheIdentity({ ...credential, accessToken: "refreshed" }));
		expect(key).not.toBe(usageCacheIdentity({ ...credential, orgId: "org-b" }));
		expect(key).not.toBe(usageCacheIdentity({ ...credential, activeOrganizationId: "workos-b" }));
		expect(key).not.toBe(usageCacheIdentity({ ...credential, region: "eu" }));
		expect(key).not.toBe(usageCacheIdentity({ ...credential, inferenceRegion: "global" }));
	});
});
