// ============================================================================
// High-level API
// ============================================================================

import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import * as AIError from "../../error";
import { getProviderDefinition, PROVIDER_REGISTRY } from "../registry";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types";

export * from "./device-code";
export type * from "./types";

const builtInOAuthProviders: OAuthProviderInfo[] = PROVIDER_REGISTRY.filter(
	provider => provider.login && provider.showInLoginList !== false,
).map(provider => ({
	id: provider.id,
	name: provider.name,
	available: provider.available ?? true,
	storeCredentialsAs: provider.storeCredentialsAs,
}));

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/** Register an operator/extension-owned OAuth implementation. */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	if (!provider.id.trim() || provider.id.includes("\0")) {
		throw new AIError.ConfigurationError("OAuth provider id must be a nonempty name without NUL characters");
	}
	customOAuthProviders.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string): void {
	customOAuthProviders.delete(id);
}

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

/** Remove only the registrations belonging to the unloading extension. */
export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders) {
		if (provider.sourceId === sourceId) customOAuthProviders.delete(id);
	}
}

/**
 * Refresh a built-in OAuth grant, cancelling provider work when refresh ownership ends.
 */
export async function refreshOAuthToken(
	provider: OAuthProviderId,
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!credentials) {
		throw new AIError.OAuthError(`No OAuth credentials found for ${provider}`, {
			kind: "validation",
			provider,
		});
	}
	const def = getOAuthProvider(provider) ?? getProviderDefinition(provider);
	if (!def?.login) {
		throw new AIError.OAuthError(`Unknown OAuth provider: ${provider}`, {
			kind: "validation",
			provider,
		});
	}
	// Providers without a real refresher (static bearer tokens / API keys that
	// don't expire) return the credentials unchanged.
	return def.refreshToken ? def.refreshToken(credentials, signal) : credentials;
}
/**
 * Build API-key bytes for a provider from an already-fresh OAuth credential.
 *
 * Refresh is owned by AuthStorage. This helper deliberately refuses expired
 * credentials so it cannot POST broker redaction sentinels to upstream token
 * endpoints as a side channel.
 *
 * For providers that need credential metadata at request time, returns
 * JSON-encoded credentials plus expiry metadata for diagnostics/edge guards.
 * @returns API key string, or null if no credentials
 * @throws Error if the credential is expired and must be refreshed upstream
 */
export async function getOAuthApiKey(
	provider: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const creds = credentials[provider];
	if (!creds) {
		return null;
	}

	const policy = authPolicyFor(provider);
	// Refresh is the sole responsibility of `AuthStorage` (which calls
	// `refreshOAuthToken` directly with broker-aware single-flighting). If we
	// reach here with an expired credential, the outer pipeline failed to
	// refresh before this call OR the refresh slot is the broker sentinel —
	// either way, posting the credential to a provider endpoint would only
	// trigger a `__remote__`-against-real-provider failure that gets classified
	// as `invalid_grant` and disables the row. Refuse loudly instead.
	if (Date.now() >= creds.expires) {
		throw new AIError.OAuthError(
			`OAuth credential for ${provider} is expired and must be refreshed via AuthStorage before getOAuthApiKey is called`,
			{ kind: "validation", provider },
		);
	}
	// Providers declaring `api-key-format "structured"` need request-time
	// credential metadata, so the API key is the JSON-encoded credential.
	const custom = getOAuthProvider(provider);
	const apiKey = custom?.getApiKey
		? custom.getApiKey(creds)
		: policy?.apiKeyFormat === "structured"
			? JSON.stringify({
					apiEndpoint: creds.apiEndpoint,
					token: creds.access,
					enterpriseUrl: creds.enterpriseUrl,
					projectId: creds.projectId,
					refreshToken: creds.refresh,
					expiresAt: creds.expires,
					email: creds.email,
					accountId: creds.accountId,
				})
			: creds.access;
	return { newCredentials: creds, apiKey };
}

/**
 * Get list of OAuth providers.
 */
export function getOAuthProviders(): OAuthProviderInfo[] {
	const custom = Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
		storeCredentialsAs: provider.storeCredentialsAs,
	}));
	return [...builtInOAuthProviders.filter(provider => !customOAuthProviders.has(provider.id)), ...custom];
}

/** Login aliases store under their declared target identity. */
export function getOAuthCredentialProvider(providerId: string): string {
	return getOAuthProviders().find(provider => provider.id === providerId)?.storeCredentialsAs ?? providerId;
}
