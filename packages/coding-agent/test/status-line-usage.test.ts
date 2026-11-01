import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { renderSegment } from "@oh-my-pi/pi-tui/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-tui/status-line/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { StatusLineTestComponents } from "./helpers/status-line";

const statusLines = new StatusLineTestComponents();
beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	statusLines.dispose();
	resetSettingsForTest();
});

function makeComponent(
	reports: unknown,
	options: {
		provider?: string;
		modelId?: string;
		activeIdentity?: { accountId?: string; email?: string; projectId?: string };
	} = {},
): StatusLineComponent {
	const component = statusLines.track(
		new StatusLineComponent(
			{
				state: { messages: [], model: { id: options.modelId, contextWindow: 1000, provider: options.provider } },
				model: { id: options.modelId, contextWindow: 1000, provider: options.provider },
				sessionManager: {
					getUsageStatistics: () => ({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						orchestrationInput: 0,
						orchestrationOutput: 0,
						orchestrationCacheRead: 0,
						premiumRequests: 0,
						cost: 0,
					}),
				},
				fetchUsageReports: async () => reports,
				modelRegistry: {
					authStorage: {
						oauth: {
							identity: (provider: string) =>
								provider === options.provider ? options.activeIdentity : undefined,
						},
					},
				},
				getAsyncJobSnapshot: () => ({ running: [] }),
				getContextUsage: () => undefined,
			} as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
			statusLineHost,
		),
	);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: ["usage"],
		sessionAccent: false,
	});
	return component;
}

async function flushUsageRefresh(): Promise<void> {
	const timer = Promise.withResolvers<void>();
	setTimeout(timer.resolve, 0);
	await timer.promise;
	await Promise.resolve();
	await Promise.resolve();
}

describe("usage status-line segment", () => {
	it("renders untiered five-hour and seven-day limits", () => {
		const result = renderSegment("usage", {
			usage: { fiveHour: { percent: 24, resetMinutes: 30 }, sevenDay: { percent: 8, resetHours: 141 } },
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("30m");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
		expect(content).toContain("5d 21h");
	});

	it("renders tiered usage fetched from provider reports", async () => {
		const now = Date.now();
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "5h", tier: "prolite" },
						window: { resetsAt: now + 30 * 60_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						scope: { windowId: "7d", tier: "prolite" },
						window: { resetsAt: now + 141 * 3_600_000 },
						amount: { usedFraction: 0.08 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("prolite");
		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
	});

	it("selects one coherent scope for the active model", async () => {
		const reports = [
			{
				provider: "github-copilot",
				limits: [
					{
						scope: { windowId: "5h", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0 },
					},
					{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					{
						scope: { windowId: "7d", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0 },
					},
				],
			},
		];
		const component = makeComponent(reports, { provider: "github-copilot", modelId: "gpt-5.6-sol" });

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("spark");
		expect(content).not.toContain("5h");
		expect(content).toContain("7d");
		expect(content).toContain("8%");

		const sparkComponent = makeComponent(reports, {
			provider: "github-copilot",
			modelId: "gpt-5.3-codex-spark",
		});
		sparkComponent.refreshUsageInBackground();
		await flushUsageRefresh();
		const sparkContent = stripVTControlCharacters(sparkComponent.getTopBorder(200).content);

		expect(sparkContent).toContain("spark");
		expect(sparkContent).toContain("5h");
		expect(sparkContent).toContain("7d");
		expect(sparkContent).not.toContain("8%");
	});

	it("labels untiered windows with the report's plan tier", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					metadata: { planType: "pro" },
					limits: [
						{
							scope: { provider: "github-copilot", windowId: "5h" },
							window: { resetsAt: now + 30 * 60_000 },
							amount: { usedFraction: 0.21 },
						},
						{
							scope: { provider: "github-copilot", windowId: "7d" },
							window: { resetsAt: now + 141 * 3_600_000 },
							amount: { usedFraction: 0.05 },
						},
					],
				},
			],
			{ provider: "github-copilot" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("pro");
		expect(content).toContain("5h");
		expect(content).toContain("21%");
		expect(content).toContain("7d");
		expect(content).toContain("5%");
	});

	it("keeps windows within the preferred untiered scope", async () => {
		const component = makeComponent([
			{
				limits: [
					{ scope: { windowId: "5h", tier: "stale" }, amount: { usedFraction: 0.5 } },
					{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
					{ scope: { windowId: "7d", tier: "prolite" }, amount: { usedFraction: 0.08 } },
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("prolite");
		expect(content).not.toContain("stale");
		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).not.toContain("7d");
		expect(content).not.toContain("8%");
	});

	it("scopes fetched usage reports to the active provider and account", async () => {
		const component = makeComponent(
			[
				{
					provider: "local",
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.99 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.98 } },
					],
				},
				{
					provider: "github-copilot",
					metadata: { accountId: "other-account" },
					limits: [{ scope: { windowId: "5h", tier: "other" }, amount: { usedFraction: 0.66 } }],
				},
				{
					provider: "github-copilot",
					metadata: { accountId: "active-account" },
					limits: [
						{ scope: { windowId: "5h", tier: "prolite" }, amount: { usedFraction: 0.24 } },
						{ scope: { windowId: "7d", tier: "prolite" }, amount: { usedFraction: 0.08 } },
					],
				},
			],
			{ provider: "github-copilot", activeIdentity: { accountId: "active-account" } },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("prolite");
		expect(content).toContain("24%");
		expect(content).toContain("8%");
		expect(content).not.toContain("99%");
		expect(content).not.toContain("98%");
		expect(content).not.toContain("66%");
		expect(content).not.toContain("other");
	});

	it("invalidates cached usage when the active provider changes", async () => {
		let provider = "github-copilot";
		const model = { contextWindow: 1000, provider };
		const reports = [
			{
				provider: "local",
				limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } }],
			},
			{
				provider: "github-copilot",
				metadata: { accountId: "active-account" },
				limits: [{ scope: { windowId: "5h", tier: "prolite" }, amount: { usedFraction: 0.8 } }],
			},
		];
		const session = {
			state: { messages: [], model },
			model,
			sessionManager: {
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
			fetchUsageReports: async () => reports,
			modelRegistry: {
				authStorage: {
					oauth: {
						identity: (requestedProvider: string) =>
							requestedProvider === provider && provider === "github-copilot"
								? { accountId: "active-account" }
								: undefined,
					},
				},
			},
			getAsyncJobSnapshot: () => ({ running: [] }),
			getContextUsage: () => undefined,
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
		const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["usage"],
			sessionAccent: false,
		});

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("80%");

		provider = "local";
		model.provider = provider;

		const immediate = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(immediate).not.toContain("80%");
		await flushUsageRefresh();
		const refreshed = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(refreshed).toContain("24%");
	});

	it("invalidates cached usage when the active model changes within a provider", async () => {
		const model = { id: "gpt-5.6-sol", contextWindow: 1000, provider: "github-copilot" };
		const reports = [
			{
				provider: "github-copilot",
				metadata: { accountId: "active-account" },
				limits: [
					{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					{
						scope: { windowId: "5h", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0.42 },
					},
					{
						scope: { windowId: "7d", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0.11 },
					},
				],
			},
		];
		const session = {
			state: { messages: [], model },
			model,
			sessionManager: {
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
			fetchUsageReports: async () => reports,
			modelRegistry: {
				authStorage: {
					oauth: {
						identity: (requestedProvider: string) =>
							requestedProvider === "github-copilot" ? { accountId: "active-account" } : undefined,
					},
				},
			},
			getAsyncJobSnapshot: () => ({ running: [] }),
			getContextUsage: () => undefined,
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
		const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["usage"],
			sessionAccent: false,
		});

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const solContent = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(solContent).not.toContain("spark");
		expect(solContent).not.toContain("5h");
		expect(solContent).toContain("8%");

		model.id = "gpt-5.3-codex-spark";
		const immediate = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(immediate).not.toContain("8%");
		await flushUsageRefresh();
		const sparkContent = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(sparkContent).toContain("spark");
		expect(sparkContent).toContain("5h");
		expect(sparkContent).toContain("42%");
	});

	it("keeps active-provider rate-limit header reports with account metadata", async () => {
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					metadata: { source: "ratelimit-headers", accountId: "other-account" },
					limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.66 } }],
				},
				{
					provider: "github-copilot",
					metadata: { source: "ratelimit-headers", accountId: "active-account" },
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					],
				},
			],
			{ provider: "github-copilot", activeIdentity: { accountId: "active-account" } },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
		expect(content).not.toContain("66%");
	});

	it("sanitizes tier labels before rendering", () => {
		const result = renderSegment("usage", {
			usage: {
				tier: "\u001b[31mbad\t tier\nvalue\u001b[0m",
				fiveHour: { percent: 50 },
			},
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("bad tier value");
		expect(result.content).not.toContain("\u001b[31m");
		expect(result.content).not.toContain("\t");
		expect(result.content).not.toContain("\n");
	});

	it("hides null usage", () => {
		const result = renderSegment("usage", { usage: null } as unknown as SegmentContext);

		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("hides usage without visible windows", () => {
		const result = renderSegment("usage", { usage: {} } as unknown as SegmentContext);

		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("renders five-hour usage without seven-day usage", () => {
		const result = renderSegment("usage", { usage: { fiveHour: { percent: 80 } } } as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("5h");
		expect(content).toContain("80%");
		expect(content).not.toContain("7d");
	});

	it("renders rolling and weekly provider windows", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					limits: [
						{
							id: "rolling-5h",
							scope: { windowId: "5h" },
							window: { id: "5h", durationMs: 5 * 3_600_000, resetsAt: now + 90 * 60_000 },
							amount: { used: 12, usedFraction: 0.12, unit: "percent" },
						},
						{
							id: "weekly",
							scope: { windowId: "7d" },
							window: { id: "7d", durationMs: 7 * 86_400_000, resetsAt: now + 100 * 3_600_000 },
							amount: { used: 8, usedFraction: 0.08, unit: "percent" },
						},
					],
				},
			],
			{ provider: "github-copilot" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("12%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
	});

	it("keeps Copilot monthly premium requests out of the subscription-window footer", async () => {
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					limits: [{ id: "copilot:premium", scope: { windowId: "monthly" }, amount: { usedFraction: 0.42 } }],
				},
			],
			{ provider: "github-copilot" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("mo");
		expect(content).not.toContain("42%");
	});

	it("uses a distinct error color at the eighty-percent threshold", () => {
		const high = renderSegment("usage", { usage: { fiveHour: { percent: 80 } } } as unknown as SegmentContext);
		const low = renderSegment("usage", { usage: { fiveHour: { percent: 24 } } } as unknown as SegmentContext);
		const highWithoutValue = high.content.replace("80%", "PCT");
		const lowWithoutValue = low.content.replace("24%", "PCT");

		expect(high.visible).toBe(true);
		expect(low.visible).toBe(true);
		expect(stripVTControlCharacters(highWithoutValue)).toBe(stripVTControlCharacters(lowWithoutValue));
		expect(highWithoutValue).not.toBe(lowWithoutValue);
	});

	it("maps non-canonical window ids onto subscription windows by reported span", async () => {
		// A reported span identifies non-canonical quota windows.
		const now = Date.now();
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "300time_unit_minute" },
						window: { durationMs: 5 * 3_600_000, resetsAt: now + 30 * 60_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						scope: { windowId: "weekly" },
						window: { durationMs: 7 * 86_400_000, resetsAt: now + 141 * 3_600_000 },
						amount: { usedFraction: 0.08 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
	});

	it("renders daily provider usage", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					limits: [
						{
							label: "Daily usage",
							scope: { provider: "github-copilot", windowId: "daily" },
							window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 11 * 60_000 },
							amount: { usedFraction: 0.054 },
						},
					],
				},
			],
			{ provider: "github-copilot" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("1d");
		expect(content).toContain("5%");
		expect(content).toContain("11m");
	});

	it("ignores non-canonical windows without a reported span", async () => {
		const component = makeComponent([
			{
				limits: [
					{ scope: { windowId: "default" }, window: {}, amount: { usedFraction: 0.24 } },
					{
						scope: { windowId: "monthly" },
						window: { durationMs: 30 * 86_400_000 },
						amount: { usedFraction: 0.5 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("24%");
		expect(content).not.toContain("50%");
	});

	it("prefers canonical window ids over a conflicting reported span", async () => {
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "5h" },
						window: { durationMs: 7 * 86_400_000 },
						amount: { usedFraction: 0.24 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).not.toContain("7d");
	});
});
