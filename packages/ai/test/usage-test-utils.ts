import type { UsageProvider } from "../src/usage";

/** Mutable fetch seam for quota caching and account-health tests, independent of vendor payloads. */
export const fixtureUsageProvider: UsageProvider = {
	id: "github-copilot",
	cacheVersion: 3,
	validatesCredentials: true,
	fetchUsage: async () => null,
};
