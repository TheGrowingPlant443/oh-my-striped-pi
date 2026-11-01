import type { SearchProviderId, SearchResponse } from "@oh-my-pi/pi-tui/tools/web-search-types";

export * from "@oh-my-pi/pi-tui/tools/web-search-types";

export interface SearchResultDetails {
	response: SearchResponse;
	error?: string;
}

/** Default hard timeout for each web-search provider transport. */
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 60;

/** Maximum configurable hard timeout for each web-search provider transport. */
export const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300;

/** Independent search engines selected through `web/*`, outside the model registry. */
export type SearchEngineId = SearchProviderId;

/** Provider-specific error with optional HTTP status */
export class SearchProviderError extends Error {
	constructor(
		public readonly provider: SearchProviderId,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "SearchProviderError";
	}
}
