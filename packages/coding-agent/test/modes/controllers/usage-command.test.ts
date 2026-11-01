import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, type UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

describe("renderUsageReports content", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", () => {
		const reports: UsageReport[] = [
			{
				provider: "company-api",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "company-weekly",
						label: "Weekly",
						scope: { provider: "company-api", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 98));
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders request quotas and reset times in the /usage view", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "company-api",
				fetchedAt: now,
				limits: [
					{
						id: "company:requests:chat",
						label: "chat requests",
						scope: { provider: "company-api", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "user@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("chat requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("shows one prepaid balance for a provider whose keys share an account pool", () => {
		// Two stored keys report the same account-wide balance; summing them invents credits.
		const now = Date.now();
		const keyReport = (remaining: number): UsageReport => ({
			provider: "company-api",
			fetchedAt: now,
			limits: [
				{
					id: "company:credits",
					label: "Credit balance",
					scope: { provider: "company-api", windowId: "balance", shared: true },
					amount: { remaining, unit: "credits" },
				},
			],
		});

		const output = stripVTControlCharacters(renderUsageReports([keyReport(100), keyReport(100)], theme, now, 98));
		expect(output).toContain("100 credits left");
		expect(output).not.toContain("200 credits left");
		// The balance must reach the user at all: a remaining-only limit used
		// to fall through to a bare account count.
		expect(output).not.toContain("accts");
	});

	it("keeps unavailable status visible beside a long account label in a narrow terminal", () => {
		const width = 40;
		const output = stripVTControlCharacters(
			renderUsageReports(
				[],
				theme,
				1_790_424_000_000,
				width,
				undefined,
				[],
				[{ provider: "company-api", label: `alex · ${"界".repeat(80)}` }],
			),
		);

		expect(output).toMatch(/alex.*usage unavailable/);
		for (const line of output.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps control characters in unavailable account labels from changing terminal layout", () => {
		const rendered = renderUsageReports(
			[],
			theme,
			1_790_424_000_000,
			80,
			undefined,
			[],
			[{ provider: "company-api", label: "\x1b[2Jalex\r\n\tteam" }],
		);
		const output = stripVTControlCharacters(rendered);

		expect(output).toMatch(/alex +team.*usage unavailable/);
		expect(rendered).not.toContain("\x1b[2J");
		expect(output).not.toContain("\r");
		expect(output).not.toContain("\t");
	});
});

describe("interactive /usage account visibility", () => {
	const now = 1_790_424_000_000;
	const email = "shared@example.test";
	const sessionId = "usage-visibility-test";
	let authStorage: AuthStorage;
	let mounted: UsageDashboardComponent | undefined;
	let terminalRows: PropertyDescriptor | undefined;

	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	beforeEach(async () => {
		terminalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
		vi.spyOn(Date, "now").mockReturnValue(now);
		vi.spyOn(activityClient, "loadDailyActivity").mockImplementation(async push => {
			push([]);
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.usage.setProvider("company-api", { id: "company-api", fetchUsage: async () => null });
		await authStorage.credentials.set(
			"company-api",
			["org-team", "org-personal"].map(orgId => ({
				type: "oauth" as const,
				access: `test-access-${orgId}`,
				refresh: `test-refresh-${orgId}`,
				expires: now + 3_600_000,
				email,
				// company-api has no org-scoped identity, so only distinct account ids keep both rows stored.
				accountId: `account-${orgId}`,
				orgId,
			})),
		);
		await authStorage.credentials.set("company-no-usage", { type: "api_key", key: "test-key" });
		const personal = authStorage.oauth.accounts("company-api").find(account => account.orgId === "org-personal");
		if (!personal || !authStorage.sessions.pin("company-api", sessionId, personal.credentialId)) {
			throw new Error("Expected the personal account to be selectable");
		}
	});

	afterEach(() => {
		mounted?.dispose();
		mounted = undefined;
		authStorage?.close();
		if (terminalRows) Object.defineProperty(process.stdout, "rows", terminalRows);
		else Reflect.deleteProperty(process.stdout, "rows");
		vi.restoreAllMocks();
	});

	function command(
		fetchUsageReports?: () => Promise<UsageReport[] | null>,
		warnings: string[] = [],
	): CommandController {
		const ctx = createInteractiveModeContext({
			session: {
				sessionId,
				model: { provider: "company-api" },
				modelRegistry: { authStorage },
				fetchUsageReports,
				getUsageReportingModelSelectors: () => [],
			},
			ui: {
				showOverlay: component => {
					if (!(component instanceof UsageDashboardComponent)) throw new Error("Expected usage dashboard");
					mounted = component;
					return {
						hide: () => {
							mounted = undefined;
						},
						setHidden: () => {},
						isHidden: () => false,
					};
				},
			},
			showWarning: message => {
				warnings.push(message);
			},
		});
		const selector = new SelectorController(ctx);
		ctx.showUsageDashboard = reports => selector.showUsageDashboard(reports);
		return new CommandController(ctx);
	}

	function display(): string {
		return stripVTControlCharacters(mounted?.render(120).join("\n") ?? "");
	}

	it("renders advisor status before usage refresh returns", async () => {
		const refresh = Promise.withResolvers<UsageReport[] | null>();
		const ctx = createInteractiveModeContext({
			reportContainer: new Container(),
			commandReportRows: () => 20,
			ui: { terminal: { columns: 120, rows: 30 } },
			session: {
				getAdvisorStats: () => ({
					configured: true,
					active: false,
					contextWindow: 0,
					contextTokens: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
					messages: { user: 0, assistant: 0, total: 0 },
					advisors: [],
				}),
				fetchUsageReports: () => refresh.promise,
				modelRegistry: { authStorage },
			},
		});
		const result = new CommandController(ctx).handleAdvisorStatusCommand();
		expect(stripVTControlCharacters(ctx.reportContainer.render(120).join("\n"))).toContain("Advisor Status");
		refresh.resolve([]);
		await result;
	});

	it("warns without opening the dashboard when usage reporting is not configured", async () => {
		const warnings: string[] = [];
		await command(undefined, warnings).handleUsageCommand();

		expect(warnings).toEqual([expect.stringContaining("not configured")]);
		expect(mounted).toBeUndefined();
	});

	it("keeps a missing company subscription visible beside its same-email sibling's real usage", async () => {
		const report: UsageReport = {
			provider: "company-api",
			fetchedAt: now,
			metadata: { email, accountId: "account-org-team", orgId: "org-team" },
			limits: [
				{
					id: "company:5h",
					label: "Company 5 Hour",
					scope: {
						provider: "company-api",
						accountId: "account-org-team",
						orgId: "org-team",
						windowId: "5h",
					},
					window: { id: "5h", label: "5 Hour", resetsAt: now + 3_600_000 },
					amount: { usedFraction: 0.25, unit: "percent" },
					status: "ok",
				},
			],
		};
		await command(async () => [report]).handleUsageCommand();

		const overview = display();
		expect(overview).toContain("2 accts");
		expect(overview).toContain(email);
		expect(overview).toContain("org-personal");
		expect(overview).toContain("usage unavailable");
		expect(overview).toContain("75%");
		expect(overview).not.toContain("company-no-usage");

		mounted?.handleInput("\r");
		const details = display();
		expect(details).toMatch(/shared@example\.test.*org-personal.*usage unavailable/);
		expect(details).toContain("shared@example.test (org-team)");
		expect(details).toContain("75% free");
		expect(details).toContain("in use by this session: shared@example.test (org-personal)");
		expect(details).not.toMatch(/org-team.*usage unavailable/);
	});

	it.each(["empty", "null", "error"] as const)(
		"opens both stored company subscriptions with unknown usage when lookup returns %s",
		async result => {
			await command(async () => {
				if (result === "error") throw new Error("usage endpoint unavailable");
				return result === "null" ? null : [];
			}).handleUsageCommand();

			const overview = display();
			expect(overview).toContain("2 accts");
			expect(overview.match(/shared@example\.test/g)).toHaveLength(2);
			expect(overview).toContain("org-team");
			expect(overview).toContain("org-personal");
			expect(overview.match(/usage unavailable/g)).toHaveLength(2);
			expect(overview).not.toContain("%");
			expect(overview).not.toContain("untouched");
			expect(overview).not.toContain("no limits");
			expect(overview).not.toContain("company-no-usage");

			mounted?.handleInput("\r");
			const details = display();
			expect(details).toMatch(/shared@example\.test.*org-team.*usage unavailable/);
			expect(details).toMatch(/shared@example\.test.*org-personal.*usage unavailable/);
			expect(details).toContain("in use by this session: shared@example.test (org-personal)");
			expect(details).not.toContain("%");
			expect(details).not.toContain("Infinity");

			mounted?.handleInput("\x1b");
			expect(display()).toContain("2 accts");
			mounted?.handleInput("\x1b");
			expect(mounted).toBeUndefined();
		},
	);
});
