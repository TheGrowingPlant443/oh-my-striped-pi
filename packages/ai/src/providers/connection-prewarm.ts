import { isCatalogEndpointUrl } from "@oh-my-pi/pi-catalog/compat/catalog-endpoint";
import { logger } from "@oh-my-pi/pi-utils";
import type { Api, FetchImpl, Model } from "../types";
import { lastDispatchOrigin, transportFetch } from "../utils/transport-fetch";

/**
 * Minimum gap between warm-ups of one origin. Idle pooled sockets outlive it
 * by minutes (Copilot drops them after ~2.5–5 min, most hosts later), so a
 * tighter cadence would only add requests.
 */
const PREWARM_INTERVAL_MS = 30_000;
const PREWARM_TIMEOUT_MS = 10_000;

const prewarmedAt = new Map<string, number>();

/**
 * Warm only the origin reached by the retained provider's last inference request;
 * before its first request there is nothing to warm.
 */
function resolvePrewarmTarget(model: Model<Api>): { origin: string; init: RequestInit } | undefined {
	const origin = lastDispatchOrigin(model);
	if (!origin || !isCatalogEndpointUrl(model, origin)) return undefined;
	return { origin, init: {} };
}

/**
 * Opens, or keeps alive, a pooled connection to {@link model}'s API host so
 * the next turn skips DNS + TCP + TLS. Sends a credential-less `HEAD` (nothing
 * is billed; hosts answer 401/404/405) through the same transport — proxy,
 * extra CA, Cowork profile, TLS options — as real requests, because sockets
 * pool per transport configuration and a warm-up made any other way (e.g.
 * `fetch.preconnect`, which also throws on Windows) is never reused.
 * Throttled per origin; best effort, never throws.
 */
export async function prewarmModelConnection(model: Model<Api>, options?: { fetch?: FetchImpl }): Promise<void> {
	let origin: string | undefined;
	try {
		const target = resolvePrewarmTarget(model);
		if (!target) return;
		origin = target.origin;
		const now = Date.now();
		const last = prewarmedAt.get(origin);
		if (last !== undefined && now - last < PREWARM_INTERVAL_MS) return;
		prewarmedAt.set(origin, now);
		const response = await transportFetch(model, options?.fetch)(origin, {
			...target.init,
			method: "HEAD",
			headers: {},
			signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
		});
		await response.body?.cancel();
	} catch (error) {
		logger.debug("Model connection prewarm failed", {
			origin,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Test hook: forgets every warm-up so the next call is not throttled. */
export function resetConnectionPrewarmForTesting(): void {
	prewarmedAt.clear();
}
