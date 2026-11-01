import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { DEFAULT_SEARCH_CHAIN } from "@oh-my-pi/pi-coding-agent/web/search/selection";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

/** Records each independent selector and fails so the chain keeps walking. */
class RecordingProvider extends SearchProvider {
	readonly id = "searxng";
	readonly label = "Recording";

	constructor(private readonly attempted: string[]) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		this.attempted.push(`${params.model.provider}/${params.model.id}`);
		throw new Error("try next");
	}
}

describe("independent default web chain", () => {
	let authStorage: AuthStorage;
	let attempted: string[];

	beforeEach(async () => {
		await Settings.init({ inMemory: true });
		authStorage = createInMemoryAuthStorage();
		attempted = [];
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(new RecordingProvider(attempted));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		authStorage.close();
	});

	it("walks the retained native order without constructing a model registry", async () => {
		const result = await runSearchQuery({ query: "anything" }, { authStorage });

		expect(attempted).toEqual(DEFAULT_SEARCH_CHAIN);
		expect(attempted).not.toContain("web/hosted");
		expect(result.details.error).toContain("All web search providers failed");
	});

	it("executes an explicit private selector as a single attempt", async () => {
		await runSearchQuery({ query: "anything", model: "web/firecrawl" }, { authStorage });

		expect(attempted).toEqual(["web/firecrawl"]);
	});

	it("keeps walking after unavailable engines and stops on a successful native response", async () => {
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => ({
			id: "searxng",
			label: id,
			isAvailable: () => id !== "searxng",
			isExplicitlyAvailable: () => true,
			search: async params => {
				attempted.push(`${params.model.provider}/${params.model.id}`);
				if (id !== "firecrawl") throw new Error("try next");
				return { provider: "firecrawl", sources: [{ title: "Private result", url: "https://example.com" }] };
			},
		}));

		const result = await runSearchQuery({ query: "anything" }, { authStorage });

		expect(attempted).toEqual(["web/firecrawl"]);
		expect(result.details.error).toBeUndefined();
		expect(result.content[0]?.text).not.toContain("answered by");
	});

	it.each(["web/hosted", "web/gemini", "openai/gpt-6.1-sol", "openrouter/google/gemini-2.5-flash"])(
		"rejects removed search selector %s instead of substituting another engine",
		async model => {
			const result = await runSearchQuery({ query: "anything", model }, { authStorage });

			expect(attempted).toEqual([]);
			expect(result.details.error).toContain("No web search model matches selector");
		},
	);
});
