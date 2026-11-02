import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-striped-pi/pi-ai";
import {
	annotateUsagePolicy,
	buildRedactionMap,
	computeProviderWindowStats,
	formatUsageBreakdown,
	formatUsageHistory,
} from "@oh-my-striped-pi/pi-coding-agent/cli/usage-cli";

const report: UsageReport = {
	provider: "github-copilot",
	fetchedAt: 1_000,
	metadata: { email: "alice@example.test" },
	limits: [
		{
			id: "premium",
			label: "Premium requests",
			scope: { provider: "github-copilot" },
			window: { id: "month", label: "Monthly", durationMs: 30 * 86_400_000 },
			amount: { unit: "percent", usedFraction: 0.25 },
		},
	],
};

describe("Copilot usage formatting", () => {
	it("renders quota, account identity and remaining capacity", () => {
		const text = Bun.stripANSI(formatUsageBreakdown([report], [], 1_000));
		expect(text).toContain("alice@example.test");
		expect(text).toContain("25.0% used");
		expect(text).toContain("Premium requests");
		expect(computeProviderWindowStats([report])).toMatchObject([
			{ durationMs: 30 * 86_400_000, accounts: 1, usedAccounts: 0.25, remainingAccounts: 0.75 },
		]);
	});
	it("redacts identities without exposing the original", () => {
		const map = buildRedactionMap(["alice@example.test", "alina@example.test"]);
		expect(map.get("alice@example.test")).not.toBe(map.get("alina@example.test"));
		const text = Bun.stripANSI(formatUsageBreakdown([report], [], 1_000, map));
		expect(text).not.toContain("alice@example.test");
		expect(text).toContain(map.get("alice@example.test")!);
	});
	it("keeps account policy diagnostics", () => {
		const result = annotateUsagePolicy([report], [], [], {
			globalReservePct: 10,
			getAccountPolicy: () => ({
				provider: "github-copilot",
				account: { email: "alice@example.test" },
				priority: 1,
				reservePct: 20,
			}),
		});
		expect(result.reports[0]?.policy).toMatchObject({ state: "eligible", remainingPct: 75 });
	});
	it("renders an empty history without vendor reset notices", () => {
		const text = Bun.stripANSI(formatUsageHistory([], 0, 1_000));
		expect(text).not.toContain("saved reset");
	});
});
