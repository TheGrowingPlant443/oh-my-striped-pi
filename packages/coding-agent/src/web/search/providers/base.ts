import type { Api, AuthStorage, FetchImpl, Model } from "@oh-my-striped-pi/pi-ai";
import type { StructuredQuery } from "../query";
import type { SearchProviderId, SearchResponse } from "../types";

/**
 * Shared web search parameters passed to providers.
 *
 * Providers use `authStorage` for API keys; endpoint-specific SearXNG
 * authentication comes from its configured settings.
 */
export interface SearchParams {
	query: string;
	/**
	 * Structured view of `query`, parsed once by the search pipeline:
	 * Google-style directives (`site:`, `before:`/`after:`, `inurl:`,
	 * `intitle:`, `filetype:`, quoted phrases, `OR` groups, `-exclusions`)
	 * extracted into fields.
	 *
	 * Providers SHOULD map constraints onto native API parameters
	 * (domain/date filters) or engine query syntax (`formatQuery`) where the
	 * upstream supports them, and lean lenient otherwise: the pipeline
	 * post-filters every response with `applyQueryConstraints`, which
	 * relaxes any constraint that would eliminate all results — so a
	 * best-effort search always beats an empty one. When absent (direct
	 * provider calls), parse with `parseSearchQuery(params.query)`.
	 */
	parsedQuery?: StructuredQuery;
	limit?: number;
	/**
	 * Temporal filter narrowing results to the specified time window.
	 *
	 * Providers MUST interpret this as a pure time filter. Providers MUST NOT
	 * use recency as an implicit signal to change topic scope, content domain,
	 * or ranking strategy.
	 *
	 * Providers that do not support temporal filtering MUST ignore this field
	 * silently; they MUST NOT approximate it by rewriting the query or altering
	 * any other request parameter.
	 */
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
	/** Hard timeout for this provider's search transport, in milliseconds. */
	timeoutMs?: number;
	fetch?: FetchImpl;
	numSearchResults?: number;
	/**
	 * Providers must use this handle for API keys rather than opening an
	 * independent credential store.
	 */
	authStorage: AuthStorage;
	/** Search-only descriptor selecting this engine. */
	model: Model<Api>;
	/** Whether the selected model came from an explicit role-chain entry. */
	explicit?: boolean;
	/**
	 * Optional session id used as the round-robin / sticky key when selecting
	 * among multiple credentials for the same provider. Pass through from the
	 * caller's agent session when available; otherwise omit.
	 */
	sessionId?: string;
}

/** Base class for web search providers. */
export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	/**
	 * Indicates whether this provider has the credentials/config it needs to
	 * service a request right now. Implementations consult the passed
	 * {@link AuthStorage} — never a sibling store.
	 *
	 * Drives role-chain admission: providers that return `false` are skipped.
	 * Explicit selection uses {@link isExplicitlyAvailable} instead. The model
	 * is supplied for providers whose authentication depends on its transport.
	 */
	abstract isAvailable(authStorage: AuthStorage, model?: Model<Api>): Promise<boolean> | boolean;

	/**
	 * Availability for an explicitly selected endpoint; defaults to the same
	 * configuration requirements as the automatic chain.
	 */
	isExplicitlyAvailable(authStorage: AuthStorage, model?: Model<Api>): Promise<boolean> | boolean {
		return this.isAvailable(authStorage, model);
	}

	/**
	 * Execute a search. Credentials MUST be resolved through `params.authStorage`.
	 */
	abstract search(params: SearchParams): Promise<SearchResponse>;
}
