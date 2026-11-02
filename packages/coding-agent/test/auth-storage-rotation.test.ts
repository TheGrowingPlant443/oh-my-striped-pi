import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type OAuthCredential, type UsageProvider, resolvedApiKeyBearer, withAuth } from "@oh-my-striped-pi/pi-ai";
import * as oauth from "@oh-my-striped-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-striped-pi/pi-ai/oauth/types";
import { getProviderDefinition } from "@oh-my-striped-pi/pi-ai/registry";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-striped-pi/pi-utils";
import { createApiKeyResolver } from "../src/config/api-key-resolver";

describe("AuthStorage account rotation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let usageExhausted = false;

	const targetProvider = "github-copilot";
	const unrelatedProvider = "mcp_oauth:rotation-isolation";
	let nextLoginCredential: OAuthCredentials | undefined;

	const findSessionWhereFreshSelectionChanges = async (
		provider: string,
		initialCredentials: OAuthCredential[],
		finalCredentials: OAuthCredential[],
	): Promise<{ sessionId: string; stickyKey: string; freshKey: string }> => {
		const control = await AuthStorage.create(":memory:", {
			usageProviderResolver: () => undefined,
		});
		try {
			await control.credentials.set(provider, finalCredentials);
			await authStorage.credentials.set(provider, initialCredentials);

			for (let attempt = 0; attempt < 128; attempt += 1) {
				const sessionId = `issue-4982-session-${attempt}`;
				const stickyKey = await authStorage.keys.get(provider, sessionId);
				const freshKey = await control.keys.get(provider, sessionId);
				if (stickyKey && freshKey && stickyKey !== freshKey) {
					return { sessionId, stickyKey, freshKey };
				}
			}
		} finally {
			control.close();
		}

		throw new Error("expected at least one session whose fresh credential selection changes after login");
	};
	const usageProvider: UsageProvider = {
		id: targetProvider,
		async fetchUsage(params) {
			const accountId = params.credential.accountId ?? "unknown";
			return {
				provider: targetProvider,
				fetchedAt: Date.now(),
				limits: [
					{
						id: `requests-${accountId}`,
						label: "Requests",
						scope: { provider: targetProvider, accountId },
						amount: { unit: "requests", used: usageExhausted ? 100 : 10, limit: 100 },
						status: usageExhausted ? "exhausted" : "ok",
					},
				],
			};
		},
	};
	const createRotationStorage = (dbPath: string) =>
		AuthStorage.create(dbPath, {
			usageProviderResolver: provider => (provider === targetProvider ? usageProvider : undefined),
		});

	beforeEach(async () => {
		tempDir = "";
		usageExhausted = false;
		nextLoginCredential = undefined;
		const definition = getProviderDefinition(targetProvider);
		if (!definition?.login || !definition.refreshToken) throw new Error("Expected built-in Copilot OAuth hooks");
		vi.spyOn(definition, "login").mockImplementation(async () => {
			if (!nextLoginCredential) throw new Error("missing queued Copilot credential");
			return nextLoginCredential;
		});
		vi.spyOn(definition, "refreshToken").mockImplementation(async credential => credential);

		authStorage = await createRotationStorage(":memory:");

		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider] as OAuthCredentials | undefined;
			if (!credential) return null;
			return {
				apiKey: credential.access,
				newCredentials: credential,
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("returns a fallback key when every OAuth account is usage-limited", async () => {
		authStorage.close();
		authStorage = await AuthStorage.create(":memory:", {
			usageProviderResolver: () => usageProvider,
			rankingStrategyResolver: () => ({
				findWindowLimits: usage => ({ primary: usage.limits[0] }),
				windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
			}),
		});
		await authStorage.credentials.set(targetProvider, [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "issue-55-session";
		const firstKey = await authStorage.keys.get(targetProvider, sessionId);
		expect(firstKey).toMatch(/^access-/);

		usageExhausted = true;
		await authStorage.usage.invalidate(targetProvider);
		const { switched } = await authStorage.limits.markReached(targetProvider, sessionId);
		expect(switched).toBe(true);

		const exhaustedFallbackKey = await authStorage.keys.get(targetProvider, sessionId);
		expect(exhaustedFallbackKey).toMatch(/^access-/);
	});

	test("usage-limit rotation can match the failed bearer when session stickiness is missing", async () => {
		await authStorage.credentials.set(targetProvider, [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "missing-sticky-session";
		const result = await authStorage.limits.markReached(targetProvider, sessionId, { apiKey: "access-1" });
		expect(result.switched).toBe(true);
		expect(await authStorage.keys.get(targetProvider, sessionId)).toBe("access-2");
	});
	test("marks selected credential ineligible and rotates to sibling on usage limit", async () => {
		await authStorage.credentials.set(targetProvider, [
			{
				type: "oauth",
				access: "access-A",
				refresh: "refresh-A",
				expires: Date.now() + 60_000,
				accountId: "acct-A",
			},
			{
				type: "oauth",
				access: "access-B",
				refresh: "refresh-B",
				expires: Date.now() + 60_000,
				accountId: "acct-B",
			},
		]);

		const sessionId = "usage-limit-rotation-session";
		const selected = await authStorage.keys.get(targetProvider, sessionId);
		if (selected !== "access-A" && selected !== "access-B") throw new Error("Expected a selected OAuth credential");

		const result = await authStorage.limits.markReached(targetProvider, sessionId, { apiKey: selected });
		expect(result.switched).toBe(true);

		const sibling = selected === "access-A" ? "access-B" : "access-A";
		expect(await authStorage.keys.get(targetProvider, sessionId)).toBe(sibling);
		expect(await authStorage.keys.get(targetProvider, `${sessionId}-fresh`)).toBe(sibling);
	});

	test("usage-limit rotation trusts the failed bearer over stale session stickiness", async () => {
		await authStorage.credentials.set(targetProvider, [
			{
				type: "oauth",
				access: "plus-access",
				refresh: "plus-refresh",
				expires: Date.now() + 60_000,
				accountId: "plus-acct",
			},
			{
				type: "oauth",
				access: "k12-access",
				refresh: "k12-refresh",
				expires: Date.now() + 60_000,
				accountId: "k12-acct",
			},
		]);

		const sessionId = "stale-sticky-session";
		const stickyKey = await authStorage.keys.get(targetProvider, sessionId);
		const failedKey = stickyKey === "plus-access" ? "k12-access" : "plus-access";
		const result = await authStorage.limits.markReached(targetProvider, sessionId, { apiKey: failedKey });
		expect(result.switched).toBe(true);
		expect(await authStorage.keys.get(targetProvider, sessionId)).toBe(stickyKey);
	});

	test("ModelRegistry distinguishes forced renewal from provider 401 recovery", async () => {
		let mints = 0;
		const definition = getProviderDefinition(targetProvider);
		if (!definition?.refreshToken) throw new Error("Expected built-in Copilot refresh hook");
		vi.spyOn(definition, "refreshToken").mockImplementation(async credential => {
			mints += 1;
			return { ...credential, access: `mint-${mints}`, expires: Date.now() + 3_600_000 };
		});
		await authStorage.credentials.set(targetProvider, [
			{ type: "oauth", access: "initial", refresh: "refresh", expires: Date.now() + 3_600_000 },
		]);
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const resolver = registry.resolver(targetProvider, { sessionId: "intent" });
		expect(await registry.getApiKeyForProvider(targetProvider, "intent", { forceRefresh: true })).toBe("mint-1");
		expect(await registry.getApiKeyForProvider(targetProvider, "intent", { forceRefresh: true })).toBe("mint-2");
		expect(
			resolvedApiKeyBearer(
				await resolver({
					lastChance: false,
					error: Object.assign(new Error("unauthorized"), { status: 401 }),
				}),
			),
		).toBe("mint-2");
		expect(
			resolvedApiKeyBearer(
				await resolver({
					lastChance: false,
					error: Object.assign(new Error("server error"), { status: 500 }),
				}),
			),
		).toBe("mint-3");
		expect(mints).toBe(3);
	});

	test("API key resolver re-resolves after a concurrent OAuth refresh makes a 401 bearer stale", async () => {
		const resolvedKeys = ["stale-access", "refreshed-access"];
		const rotationTargets: Array<string | undefined> = [];
		vi.spyOn(authStorage.limits, "rotate").mockImplementation(async (_provider, _sessionId, options) => {
			rotationTargets.push(options?.apiKey);
			return { switched: false };
		});
		const registry: Parameters<typeof createApiKeyResolver>[0] = {
			async getApiKeyWithCredentialForProvider() {
				const apiKey = resolvedKeys.shift();
				return apiKey === undefined ? undefined : { apiKey };
			},
			authStorage,
		};
		const resolver = createApiKeyResolver(registry, targetProvider, {
			sessionId: "concurrent-oauth-refresh",
		});

		const initial = await resolver({ lastChance: false, error: undefined });
		const refreshed = await resolver({
			lastChance: true,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
			previousKey: resolvedApiKeyBearer(initial),
		});

		expect(resolvedApiKeyBearer(initial)).toBe("stale-access");
		expect(resolvedApiKeyBearer(refreshed)).toBe("refreshed-access");
		expect(rotationTargets).toEqual(["stale-access"]);
	});

	test("API key resolver stops when a usage-limit rotation has no unblocked sibling", async () => {
		const resolvedKeys = ["quota-blocked-B", "quota-blocked-A"];
		vi.spyOn(authStorage.limits, "rotate").mockResolvedValue({ switched: false });
		const registry: Parameters<typeof createApiKeyResolver>[0] = {
			async getApiKeyWithCredentialForProvider() {
				const apiKey = resolvedKeys.shift();
				return apiKey === undefined ? undefined : { apiKey };
			},
			authStorage,
		};
		const attemptedKeys: string[] = [];

		await expect(
			withAuth(createApiKeyResolver(registry, targetProvider), async key => {
				attemptedKeys.push(key);
				throw Object.assign(new Error("Account usage limit reached. Try again later."), {
					status: 429,
				});
			}),
		).rejects.toThrow("usage limit");

		expect(attemptedKeys).toEqual(["quota-blocked-B"]);
		expect(resolvedKeys).toEqual(["quota-blocked-A"]);
	});

	test("API key resolver waits out a sibling's sub-second block instead of surfacing a drained account's quota error", async () => {
		await authStorage.credentials.set(targetProvider, [
			{ type: "oauth", access: "healthy", refresh: "r-h", expires: Date.now() + 3_600_000, accountId: "healthy" },
			{ type: "oauth", access: "drained", refresh: "r-d", expires: Date.now() + 3_600_000, accountId: "drained" },
		]);
		// Park the drained account briefly so the request starts on the healthy one.
		await authStorage.limits.markReached(targetProvider, undefined, { apiKey: "drained", retryAfterMs: 50 });
		const attemptedKeys: string[] = [];
		const startedAt = Date.now();

		const result = await withAuth(
			new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }).resolver(targetProvider),
			async key => {
				attemptedKeys.push(key);
				if (key === "drained") {
					throw Object.assign(new Error("Account usage limit reached. retry-after-ms=411184670"), { status: 429 });
				}
				if (attemptedKeys.length === 1) {
					throw Object.assign(new Error("Account usage limit reached. retry-after-ms=300"), { status: 429 });
				}
				return "ok";
			},
		);

		// healthy → quota 429 (blocked 0.3 s); drained frees first and fails for
		// days; the request then waits for, and resends, the healthy bearer.
		expect(result).toBe("ok");
		expect(attemptedKeys).toEqual(["healthy", "drained", "healthy"]);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
	});

	test("API key resolver does not wait on a sibling blocked longer than a few seconds", async () => {
		await authStorage.credentials.set(targetProvider, [
			{ type: "oauth", access: "first", refresh: "r-1", expires: Date.now() + 3_600_000, accountId: "first" },
			{ type: "oauth", access: "second", refresh: "r-2", expires: Date.now() + 3_600_000, accountId: "second" },
		]);
		await authStorage.limits.markReached(targetProvider, undefined, { apiKey: "second", retryAfterMs: 60_000 });
		const attemptedKeys: string[] = [];
		const startedAt = Date.now();

		await expect(
			withAuth(
				new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }).resolver(targetProvider),
				async key => {
					attemptedKeys.push(key);
					throw Object.assign(new Error("Account usage limit reached. Try again later."), {
						status: 429,
					});
				},
			),
		).rejects.toThrow("usage limit");

		expect(attemptedKeys).toEqual(["first"]);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	test("provider login invalidates only that provider's persisted session stickiness", async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-auth-rotation-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage.close();
		authStorage = await createRotationStorage(path.join(tempDir, "testauth.db"));
		const targetInitialCredentials: OAuthCredential[] = [
			{
				type: "oauth",
				access: "target-access-a",
				refresh: "target-refresh-a",
				expires: Date.now() + 3600_000,
				accountId: "target-acct-a",
				email: "target-a@example.com",
			},
			{
				type: "oauth",
				access: "target-access-b",
				refresh: "target-refresh-b",
				expires: Date.now() + 3600_000,
				accountId: "target-acct-b",
				email: "target-b@example.com",
			},
		];
		const targetAddedCredential: OAuthCredential = {
			type: "oauth",
			access: "target-access-c",
			refresh: "target-refresh-c",
			expires: Date.now() + 3600_000,
			accountId: "target-acct-c",
			email: "target-c@example.com",
		};
		const targetFinalCredentials = [...targetInitialCredentials, targetAddedCredential];
		const { sessionId, stickyKey, freshKey } = await findSessionWhereFreshSelectionChanges(
			targetProvider,
			targetInitialCredentials,
			targetFinalCredentials,
		);

		await authStorage.credentials.set(unrelatedProvider, [
			{
				type: "oauth",
				access: "unrelated-access-a",
				refresh: "unrelated-refresh-a",
				expires: Date.now() + 3600_000,
				accountId: "unrelated-acct-a",
				email: "unrelated-a@example.com",
			},
			{
				type: "oauth",
				access: "unrelated-access-b",
				refresh: "unrelated-refresh-b",
				expires: Date.now() + 3600_000,
				accountId: "unrelated-acct-b",
				email: "unrelated-b@example.com",
			},
		]);
		const unrelatedSessionId = "issue-4982-unrelated-session";
		const unrelatedStickyKey = await authStorage.keys.get(unrelatedProvider, unrelatedSessionId);
		expect(unrelatedStickyKey).toMatch(/^unrelated-access-/);

		const { type: _type, ...loginCredential } = targetAddedCredential;
		nextLoginCredential = loginCredential;
		await authStorage.oauth.login(targetProvider, {
			onAuth: () => {},
			onPrompt: async () => "",
		});
		nextLoginCredential = undefined;

		authStorage.close();
		authStorage = await createRotationStorage(path.join(tempDir, "testauth.db"));
		await authStorage.credentials.reload();

		const reloadedTargetKey = await authStorage.keys.get(targetProvider, sessionId);
		expect(reloadedTargetKey).toBe(freshKey);
		expect(reloadedTargetKey).not.toBe(stickyKey);
		expect(await authStorage.keys.get(unrelatedProvider, unrelatedSessionId)).toBe(unrelatedStickyKey);
	});
});
