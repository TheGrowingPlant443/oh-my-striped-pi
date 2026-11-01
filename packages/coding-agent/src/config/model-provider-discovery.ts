import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { ModelResolutionSource } from "@oh-my-pi/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";

export const STARTUP_MODEL_CACHE_PROVIDER_IDS: readonly string[] = PROVIDER_DESCRIPTORS.map(
	descriptor => descriptor.providerId,
);

// Keyless-mode markers: each api-key login's KDL `empty-fallback` (e.g.
// `lm-studio-local`), stored on an empty paste and never sent as a bearer.
const LOCAL_PROVIDER_PLACEHOLDERS = new Set<string>(
	authProviders().flatMap(entry =>
		entry.login?.kind === "api-key" && entry.login.emptyFallback ? [entry.login.emptyFallback] : [],
	),
);

/**
 * Hard bound for extension-provided fetchDynamicModels to prevent indefinite hangs
 * during runtime provider discovery. Uses a cancellable manual timer (not AbortSignal.timeout)
 * so a successful fast path does not leave an armed timeout signal for concurrent GC.
 */
export const RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS = 15_000;
// Built-in discovery preflight mirror of the catalog model-manager's private
// cache timings (model-manager.ts: DEFAULT_CACHE_TTL_MS / NON_AUTHORITATIVE_RETRY_MS).
// Built-in descriptors never override cacheTtlMs, so agreeing with these values
// makes the OAuth-refresh preflight fire exactly when the manager will fetch.
export const BUILT_IN_DISCOVERY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export const BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;
export const kNoAuth = "N/A";

export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}

export function isDiscoveryBearerApiKey(apiKey: string | undefined | null): apiKey is string {
	return isAuthenticated(apiKey) && !LOCAL_PROVIDER_PLACEHOLDERS.has(apiKey);
}

/**
 * Wraps a model-discovery operation with a hard timeout. Uses a cancellable
 * manual timer (not AbortSignal.timeout) so that a fast successful path does
 * not leave an armed timeout signal for concurrent GC. The inner operation
 * does not receive a signal because not every discovery contract accepts one.
 */
export async function withModelDiscoveryTimeout<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
	const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		timeoutReject(new Error(`model discovery timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	try {
		return await Promise.race([run(), timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

export interface BuiltInDiscoveryResult {
	models: Model<Api>[];
	authoritativeProviders: Set<string>;
	/** Providers whose successful endpoint refresh replaces their prior dynamic discovery slice. */
	replaceRuntimeProviders: Set<string>;
}

export type ProviderDiscoveryStatus = "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";

export interface ProviderDiscoveryState {
	provider: string;
	status: ProviderDiscoveryStatus;
	optional: boolean;
	stale: boolean;
	fetchedAt?: number;
	source?: ModelResolutionSource;
	models: string[];
	error?: string;
}

export function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.credentials.all()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}
