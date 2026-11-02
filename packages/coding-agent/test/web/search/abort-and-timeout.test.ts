/**
 * Regression coverage for issue #1221: `web_search` froze when an upstream
 * provider stalled because Bun's WinHTTP fetch could ignore `AbortSignal`,
 * and `executeSearch` masked the eventual `AbortError` as a normal provider
 * failure.
 *
 * The fix has two halves: a hard-timeout safety net wrapped around every
 * provider's outbound fetch (via the shared `withHardTimeout` helper), and
 * an abort re-throw in the provider-fallback loop so the session sees a real
 * cancellation instead of "all providers failed". The provider wiring is
 * spot-checked on an explicitly configured Firecrawl API; the helper itself is
 * exercised directly.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-striped-pi/pi-ai";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { ToolAbortError } from "@oh-my-striped-pi/pi-coding-agent/tools/tool-errors";
import { runSearchQuery } from "@oh-my-striped-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-striped-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-striped-pi/pi-coding-agent/web/search/providers/base";
import { searchFirecrawl } from "@oh-my-striped-pi/pi-coding-agent/web/search/providers/firecrawl";
import { withHardTimeout } from "@oh-my-striped-pi/pi-coding-agent/web/search/providers/utils";
import { SearchProviderError } from "@oh-my-striped-pi/pi-coding-agent/web/search/types";
import { type SearchProviderId, type SearchResponse } from "@oh-my-striped-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

import {
	cfgProvidersWebSearchTimeoutSeconds,
	cfgRetryFallbackChains,
} from "@oh-my-striped-pi/pi-coding-agent/session/settings";

const openAuthStorages: AuthStorage[] = [];
const originalFirecrawlBaseUrl = process.env.FIRECRAWL_BASE_URL;

describe("withHardTimeout", () => {
	it("returns a signal that aborts on the hard timeout when no caller signal is supplied", async () => {
		const signal = withHardTimeout(undefined, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
	});

	it("forwards a caller signal's abort to the composed signal", () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 60_000);
		ac.abort(new Error("user-cancel"));
		expect(signal.aborted).toBe(true);
	});

	it("fires the hard timeout even when the caller signal stays open", async () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
		expect(ac.signal.aborted).toBe(false);
	});
});

describe("Firecrawl provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (originalFirecrawlBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
		else process.env.FIRECRAWL_BASE_URL = originalFirecrawlBaseUrl;
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("hands fetch a composed signal even with no caller signal", async () => {
		process.env.FIRECRAWL_BASE_URL = "http://firecrawl.internal";
		const authStorage = createInMemoryAuthStorage();
		openAuthStorages.push(authStorage);
		authStorage.keys.setRuntime("firecrawl", "firecrawl-test-key");
		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ web: { results: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const model = provider.getSearchEngineModel("firecrawl");
		if (!model) throw new Error("Firecrawl descriptor missing");
		await searchFirecrawl({ query: "ping", fetch: fetchMock, authStorage, model });

		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});
});

describe("executeSearch abort propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	function fakeProvider(
		id: SearchProviderId,
		behaviour: (params: SearchParams) => Promise<SearchResponse>,
	): provider.SearchProvider {
		return {
			id,
			label: id,
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: behaviour,
		};
	}

	async function configureProviderChain(providers: provider.SearchProvider[]) {
		const primary = providers[0];
		if (!primary) throw new Error("Provider chain must contain a primary candidate");
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", `web/${primary.id}`);
		cfgRetryFallbackChains.set(config, { web: providers.slice(1).map(candidate => `web/${candidate.id}`) });
		const authStorage = createInMemoryAuthStorage();
		openAuthStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: config });
		const getProvider = vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			const match = providers.find(candidate => candidate.id === id);
			if (!match) throw new Error(`Unexpected provider: ${id}`);
			return match;
		});
		return { authStorage, modelRegistry, getProvider };
	}

	it("passes the configured provider-request timeout into the search adapter", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "firecrawl",
					sources: [{ title: "Configured result", url: "https://example.com/configured" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", "web/firecrawl");
		cfgRetryFallbackChains.set(config, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 180);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("firecrawl");
		expect(timeoutMs).toBe(180_000);
	});

	it("caps the configured provider-request timeout at five minutes", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "firecrawl",
					sources: [{ title: "Capped result", url: "https://example.com/capped" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", "web/firecrawl");
		cfgRetryFallbackChains.set(config, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 600);

		await runSearchQuery({ query: "anything" }, context);

		expect(timeoutMs).toBe(300_000);
	});

	it("uses the default provider timeout for a non-positive setting", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "firecrawl",
					sources: [{ title: "Default result", url: "https://example.com/default" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", "web/firecrawl");
		cfgRetryFallbackChains.set(config, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 0);

		await runSearchQuery({ query: "anything" }, context);

		expect(timeoutMs).toBe(60_000);
	});

	it("surfaces caller cancellation instead of falling through to the next role candidate", async () => {
		const fallbackSearch = vi.fn();
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async () => {
				throw new DOMException("aborted", "AbortError");
			}),
			fakeProvider("searxng", fallbackSearch),
		]);
		const ac = new AbortController();
		ac.abort();

		await expect(runSearchQuery({ query: "anything" }, { ...context, signal: ac.signal })).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("still reports provider failures when the caller has not aborted", async () => {
		const context = await configureProviderChain([
			fakeProvider("firecrawl", async () => {
				throw new Error("upstream 500");
			}),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.content[0]?.text).toContain("upstream 500");
		expect(result.details.error).toContain("upstream 500");
	});

	it("falls through when the configured role candidate returns no renderable content", async () => {
		const emptySearch = vi.fn(async (): Promise<SearchResponse> => ({ provider: "searxng", sources: [] }));
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "firecrawl",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback", snippet: "fallback body" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("searxng", emptySearch),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(emptySearch).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toContain("Fallback result");
		expect(result.details.response.provider).toBe("firecrawl");
	});

	it("stops loading the role chain after the preferred candidate succeeds", async () => {
		const fallbackSearch = vi.fn();
		const context = await configureProviderChain([
			fakeProvider("searxng", async () => ({
				provider: "searxng",
				sources: [{ title: "Preferred result", url: "https://example.com/preferred" }],
			})),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("searxng");
		expect(context.getProvider).toHaveBeenCalledTimes(1);
		expect(context.getProvider).toHaveBeenCalledWith("searxng");
		expect(fallbackSearch).not.toHaveBeenCalled();
		expect(result.content[0]?.text).not.toContain("Note: answered by");
	});

	it("advances through retry.fallbackChains.web after the preferred candidate fails", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "firecrawl",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("searxng", async () => {
				throw new SearchProviderError("searxng", "Preferred provider failed.", 500);
			}),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("firecrawl");
		expect(context.getProvider).toHaveBeenCalledTimes(2);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toStartWith(
			"Note: answered by firecrawl after searxng failed (Preferred provider failed)\n",
		);
	});

	it("flattens and caps a long multi-line failure reason in the fallback note", async () => {
		const htmlPage = `<html>\n<head><title>502 Bad Gateway</title></head>\n<body>${"x".repeat(2_000)}</body>\n</html>`;
		const context = await configureProviderChain([
			fakeProvider("searxng", async () => {
				throw new SearchProviderError("searxng", `SearXNG API error (502): ${htmlPage}`, 502);
			}),
			fakeProvider("firecrawl", async () => ({
				provider: "firecrawl",
				sources: [{ title: "Fallback result", url: "https://example.com/fallback" }],
			})),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		const [note = ""] = (result.content[0]?.text ?? "").split("\n");
		expect(note).toStartWith(
			"Note: answered by firecrawl after searxng failed (SearXNG API error (502): <html> <head><title>502 Bad Gateway",
		);
		expect(note).toEndWith("…)");
		expect(note.length).toBeLessThan(320);
	});

	it("treats a request model override as a single explicit candidate", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "firecrawl",
			sources: [{ title: "Hidden fallback", url: "https://example.com/fallback" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("searxng", async () => {
				throw new SearchProviderError("searxng", "Explicit SearXNG search failed.", 400);
			}),
			fakeProvider("firecrawl", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything", model: "web/searxng" }, context);

		expect(result.details.error).toContain("Explicit SearXNG search failed.");
		expect(result.details.response.provider).toBe("searxng");
		expect(context.getProvider).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});
});
