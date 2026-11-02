import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-striped-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-striped-pi/pi-coding-agent/modes/status-line-host";
import { initTheme } from "@oh-my-striped-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeSession(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	getSessionId: () => string = () => "conversation-1",
): AgentSession {
	const messages: unknown[] = [];
	return {
		fetchUsageReports,
		messages,
		state: { messages, model: { contextWindow: 200_000, provider: "github-copilot" } },
		model: { contextWindow: 200_000, provider: "github-copilot" },
		isStreaming: false,
		isFastModeActive: () => false,
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
			getSessionName: () => "test",
			getSessionId,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

function usageReport(percent: number): unknown[] {
	return [
		{
			provider: "github-copilot",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "github-copilot:5h",
					label: "Copilot 5 Hour",
					scope: { provider: "github-copilot", windowId: "5h" },
					window: { id: "5h", label: "5h", resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: percent / 100 },
				},
			],
		},
	];
}

async function refreshUsage(component: StatusLineComponent, advanceMs = 0): Promise<void> {
	if (advanceMs > 0) vi.advanceTimersByTime(advanceMs);
	component.refreshUsageInBackground();
	vi.advanceTimersByTime(0);
	await flushMicrotasks();
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("StatusLineComponent usage refresh", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("does not invoke usage fetching synchronously on the render path", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return [];
			}),
			statusLineHost,
		);

		component.refreshUsageInBackground();
		expect(calls).toBe(0);

		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("does not queue a usage refresh from the final render after disposal", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return [];
			}),
			statusLineHost,
		);
		component.dispose();
		component.getTopBorder(120);
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(0);
	});

	it("passes a startup timeout signal to the background usage fetch", async () => {
		let signal: AbortSignal | undefined;
		const component = new StatusLineComponent(
			makeSession(async nextSignal => {
				signal = nextSignal;
				return [];
			}),
			statusLineHost,
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("backs off after the startup timeout when usage fetching hangs", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(() => {
				calls++;
				return Promise.withResolvers<unknown>().promise;
			}),
			statusLineHost,
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		component.refreshUsageInBackground();
		expect(calls).toBe(1);

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("applies late usage reports that resolve after the startup timeout", async () => {
		const late = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(
			makeSession(() => late.promise),
			statusLineHost,
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).not.toContain("5h");

		late.resolve(usageReport(42));
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).toContain("5h 42%");
	});

	it("re-fetches usage immediately when the session rotates to another org under the same email", async () => {
		let calls = 0;
		let orgId = "org-team";
		const base = makeSession(async () => {
			calls++;
			return usageReport(10);
		}) as unknown as Record<string, unknown>;
		// Same provider + email + account throughout — only the org rotates.
		base.state = {
			messages: [],
			model: { contextWindow: 200_000, provider: "github-copilot" },
		};
		base.modelRegistry = {
			authStorage: {
				oauth: {
					identity: () => ({
						email: "shared@example.com",
						accountId: "account-shared",
						orgId,
					}),
				},
			},
		};
		const component = new StatusLineComponent(base as unknown as AgentSession, statusLineHost);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Same org within the cache TTL: served from cache, no refetch.
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Org rotation under the same email/account must invalidate the cache.
		orgId = "org-max";
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);
	});

	it("discards a timed-out report after a newer refresh applies", async () => {
		const stale = Promise.withResolvers<unknown>();
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return calls === 1 ? stale.promise : usageReport(10);
			}),
			statusLineHost,
		);
		component.updateSettings({ preset: "custom", leftSegments: ["usage"], rightSegments: [] });

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();
		await refreshUsage(component, 5 * 60_000);
		expect(calls).toBe(2);

		stale.resolve(usageReport(42));
		await flushMicrotasks();
		await refreshUsage(component, 5 * 60_000);

		expect(calls).toBe(3);
		expect(plain(component.getTopBorder(80).content)).toContain("5h 10%");
		component.dispose();
	});
});
