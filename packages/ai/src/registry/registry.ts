import type { KnownProvider } from "@oh-my-striped-pi/pi-catalog";
import { authProviders } from "@oh-my-striped-pi/pi-catalog/compat/auth";
import type { AuthProviderId, LoginProviderId } from "@oh-my-striped-pi/pi-catalog/compat/auth-ids";
import { buildProviderDefinition } from "./build";
import type { ProviderDefinition } from "./types";

/** Login and refresh definitions from the retained catalog auth rules. */
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = authProviders().map(policy =>
	buildProviderDefinition(policy),
);

const BY_ID: Record<string, ProviderDefinition> = Object.fromEntries(PROVIDER_REGISTRY.map(p => [p.id, p]));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return Object.hasOwn(BY_ID, id) ? BY_ID[id] : undefined;
}

/** Local inference needs no login policy. */
type _MissingCatalogProviders = Exclude<KnownProvider, AuthProviderId | "local">;
type _CheckRegistryComplete = _MissingCatalogProviders extends never
	? true
	: ["auth rules are missing catalog providers", _MissingCatalogProviders];
true satisfies _CheckRegistryComplete;

/** Loginable providers (those whose auth policy declares a `login` flow). */
export type OAuthProviderUnion = LoginProviderId;
