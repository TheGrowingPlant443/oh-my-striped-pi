/**
 * Known model-endpoint host classification — the single vocabulary for the
 * `provider === id || baseUrl.includes(marker)` idiom that gates wire-level
 * behavior (compat detection, routing, header shaping, watchdog floors).
 *
 * Markers are case-insensitive substrings matched against the base URL, NOT
 * parsed hostnames: proxies regularly embed the upstream host in a path
 * segment, and the historical call sites all used substring semantics.
 * Callers that need strict hostname matching parse the URL themselves.
 */

interface HostClassSpec {
	/** Provider ids that imply this host class regardless of baseUrl. */
	readonly providers?: readonly string[];
	/** Lowercase ASCII substrings matched case-insensitively against the base URL. */
	readonly urlMarkers: readonly string[];
}

export const KNOWN_HOSTS = {
	githubCopilot: { providers: ["github-copilot"], urlMarkers: ["githubcopilot.com", "copilot-api."] },
} as const satisfies Record<string, HostClassSpec>;

export type KnownHost = keyof typeof KNOWN_HOSTS;

// Host checks fan out across every compatibility field for a model. Bound the
// cache because custom providers may contribute arbitrary endpoints at runtime.
const MAX_URL_HOST_MATCHES = 512;
const urlHostMatches = new Map<string, Map<KnownHost, boolean>>();

function getUrlHostMatches(baseUrl: string): Map<KnownHost, boolean> {
	let matches = urlHostMatches.get(baseUrl);
	if (matches !== undefined) return matches;
	if (urlHostMatches.size === MAX_URL_HOST_MATCHES) urlHostMatches.clear();
	matches = new Map<KnownHost, boolean>();
	urlHostMatches.set(baseUrl, matches);
	return matches;
}

/** URL-only host check (for call sites that have no provider id, e.g. raw env config). */
export function hostMatchesUrl(baseUrl: string | undefined, host: KnownHost): boolean {
	if (!baseUrl) return false;
	const matches = getUrlHostMatches(baseUrl);
	const cached = matches.get(host);
	if (cached !== undefined) return cached;
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	for (const marker of spec.urlMarkers) {
		if (includesAsciiCaseInsensitive(baseUrl, marker)) {
			matches.set(host, true);
			return true;
		}
	}
	matches.set(host, false);
	return false;
}

/** Provider-or-URL host check — the canonical `provider === id || baseUrl.includes(marker)` idiom. */
export function modelMatchesHost(model: { provider: string; baseUrl: string }, host: KnownHost): boolean {
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	if (spec.providers) {
		for (const provider of spec.providers) {
			if (model.provider === provider) return true;
		}
	}
	return hostMatchesUrl(model.baseUrl, host);
}

function includesAsciiCaseInsensitive(value: string, lowerNeedle: string): boolean {
	const needleLength = lowerNeedle.length;
	const end = value.length - needleLength;
	for (let start = 0; start <= end; start++) {
		let offset = 0;
		for (; offset < needleLength; offset++) {
			if ((value.charCodeAt(start + offset) | 0x20) !== lowerNeedle.charCodeAt(offset)) break;
		}
		if (offset === needleLength) return true;
	}
	return false;
}
