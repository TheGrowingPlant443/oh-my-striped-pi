import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { SearchProvider } from "./providers/base";
import { getSearchProviderLabel, type SearchEngineId, SearchProviderError } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

/** Search-only descriptors; never registered as model providers. */
export const SEARCH_ENGINE_MODELS = (["searxng", "firecrawl"] satisfies SearchEngineId[]).map(id =>
	buildModel({
		id,
		name: getSearchProviderLabel(id),
		provider: "web",
		api: "web-search",
		baseUrl: "web://search",
		kind: "search",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		supportsTools: false,
	}),
);

export function getSearchEngineModel(id: string) {
	return SEARCH_ENGINE_MODELS.find(model => model.id === id);
}

/**
 * Search-first-use boundary: every provider module (and its HTTP/MCP/browser
 * dependencies) loads only when a search actually selects it, so the
 * provider modules stay out of interactive startup. Instances are memoized
 * per id, matching the previous singleton-per-provider behavior.
 */
type ProviderLoader = () => Promise<SearchProvider>;

type ProviderRegistry<TId extends string> = { [Id in TId]: ProviderLoader };

const PROVIDER_LOADERS: ProviderRegistry<SearchEngineId> = {
	searxng: () => import("./providers/searxng").then(m => new m.SearXNGProvider()),
	firecrawl: () => import("./providers/firecrawl").then(m => new m.FirecrawlProvider()),
};

const providerInstances = new Map<string, Promise<SearchProvider>>();

function loadProvider(id: string, loader: ProviderLoader): Promise<SearchProvider> {
	let instance = providerInstances.get(id);
	if (!instance) {
		instance = loader();
		providerInstances.set(id, instance);
	}
	return instance;
}

/** One candidate that failed during a search, in attempt order. */
export interface SearchProviderFailure {
	provider: { id: string; label: string };
	error: unknown;
}

/** Format one provider failure for the user-facing fallback summary. */
export function formatSearchProviderFailure(error: unknown, provider: { id: string; label: string }): string {
	if (error instanceof SearchProviderError) {
		if (error.status === 401 || error.status === 403) {
			return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format the ordered provider fallback failures for terminal/tool output. */
export function formatSearchProviderFailures(failures: readonly SearchProviderFailure[]): string {
	return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
}

/** Whether `id` names an independent `web/<id>` search engine. */
export function isRegisteredSearchEngine(id: string): id is SearchEngineId {
	return Object.hasOwn(PROVIDER_LOADERS, id);
}

/** Resolve an independent engine after validating its search selector. */
export function getSearchProvider(id: string): Promise<SearchProvider> {
	if (!isRegisteredSearchEngine(id)) return Promise.reject(new Error(`Unknown search provider: ${id}`));
	return loadProvider(id, PROVIDER_LOADERS[id]);
}
