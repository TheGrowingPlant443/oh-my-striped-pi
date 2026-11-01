import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { scrapeWithFirecrawl } from "@oh-my-pi/pi-coding-agent/web/firecrawl";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import { asGlobalFetch } from "../helpers/fetch-mock";

const originalBaseUrl = process.env.FIRECRAWL_BASE_URL;
const originalApiUrl = process.env.FIRECRAWL_API_URL;
const originalKey = process.env.FIRECRAWL_API_KEY;
const markdown = `# Private article\n\n${"Substantive reader content. ".repeat(12)}`;
const html = `<html><body><article><h1>Article</h1><p>${"Substantive local article body. ".repeat(12)}</p></article></body></html>`;

beforeEach(() => {
	delete process.env.FIRECRAWL_BASE_URL;
	delete process.env.FIRECRAWL_API_URL;
	delete process.env.FIRECRAWL_API_KEY;
	vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	if (originalBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
	else process.env.FIRECRAWL_BASE_URL = originalBaseUrl;
	if (originalApiUrl === undefined) delete process.env.FIRECRAWL_API_URL;
	else process.env.FIRECRAWL_API_URL = originalApiUrl;
	if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY;
	else process.env.FIRECRAWL_API_KEY = originalKey;
});

describe("private reader boundary", () => {
	it("keeps native rendering without forwarding the URL when no private endpoint is configured", async () => {
		process.env.FIRECRAWL_API_KEY = "unused-key";
		const request = vi.fn(() => new Response("unexpected"));
		const result = await renderHtmlToText(
			"https://example.com/article",
			html,
			1,
			Settings.isolated({ "providers.fetch": "firecrawl" }),
			undefined,
			null,
			asGlobalFetch(request),
		);
		expect(result.method).toBe("native");
		expect(result.ok).toBe(true);
		expect(request).not.toHaveBeenCalled();
	});

	it.each([undefined, "company-reader-key"])("supports private keyless and custom-key deployments (%s)", async key => {
		process.env.FIRECRAWL_BASE_URL = "http://reader.internal/private/v1";
		if (key) process.env.FIRECRAWL_API_KEY = key;
		const request = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe("http://reader.internal/private/v1/scrape");
			expect(new Headers(init?.headers).get("authorization")).toBe(key ? `Bearer ${key}` : null);
			expect(JSON.parse(String(init?.body))).toEqual({ url: "https://example.com/article", formats: ["markdown"] });
			return new Response(JSON.stringify({ success: true, data: { markdown } }));
		});
		const result = await renderHtmlToText(
			"https://example.com/article",
			html,
			1,
			Settings.isolated({ "providers.fetch": "firecrawl" }),
			undefined,
			null,
			asGlobalFetch(request),
		);
		expect(result.method).toBe("firecrawl");
		expect(result.content).toBe(markdown);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects an unconfigured direct reader call before making a request", async () => {
		const request = vi.fn(() => new Response("unexpected"));
		await expect(
			scrapeWithFirecrawl("https://example.com/article", { fetch: asGlobalFetch(request) }, null),
		).rejects.toThrow("requires FIRECRAWL_BASE_URL");
		expect(request).not.toHaveBeenCalled();
	});

	it("falls back to native when the private reader stalls until its budget expires", async () => {
		process.env.FIRECRAWL_BASE_URL = "http://reader.internal";
		const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			const signal = init?.signal;
			const abort = () => reject(new DOMException("aborted", "AbortError"));
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			return promise;
		});
		const result = await renderHtmlToText(
			"https://example.com/article",
			html,
			0.05,
			Settings.isolated({ "providers.fetch": "firecrawl" }),
			undefined,
			null,
			asGlobalFetch(request),
		);
		expect(result.method).toBe("native");
		expect(result.ok).toBe(true);
		expect(request).toHaveBeenCalled();
	});

	it("propagates user cancellation instead of accepting a local fallback", async () => {
		process.env.FIRECRAWL_BASE_URL = "http://reader.internal";
		const controller = new AbortController();
		controller.abort(new Error("user-cancel"));
		await expect(
			renderHtmlToText(
				"https://example.com/article",
				html,
				1,
				Settings.isolated({ "providers.fetch": "firecrawl" }),
				controller.signal,
				null,
			),
		).rejects.toThrow("user-cancel");
	});
});
