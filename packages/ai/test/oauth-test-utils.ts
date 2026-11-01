import { vi } from "bun:test";
import * as registry from "../src/registry/registry";
import * as oauth from "../src/registry/oauth";
import type { OAuthLoginCallbacks, OAuthProviderInterface } from "../src/registry/oauth/types";

const getProviderDefinition = registry.getProviderDefinition;
const getOAuthApiKey = oauth.getOAuthApiKey;

/** Exercise generic storage with a mocked Copilot login/exchange, never a custom production provider. */
export function mockOAuthProvider(provider: OAuthProviderInterface): void {
	if (provider.id !== "github-copilot") throw new Error("OAuth fixtures must use github-copilot");
	const definition = getProviderDefinition(provider.id);
	if (!definition) throw new Error("Missing Copilot auth definition");
	vi.spyOn(registry, "getProviderDefinition").mockImplementation(id =>
		id === provider.id
			? {
					...definition,
					login: callbacks => provider.login(callbacks as OAuthLoginCallbacks),
					refreshToken: provider.refreshToken,
				}
			: getProviderDefinition(id),
	);
	vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (id, credential, signal) => {
		if (id !== provider.id) throw new Error(`Unexpected OAuth fixture provider: ${id}`);
		return provider.refreshToken ? provider.refreshToken(credential, signal) : credential;
	});
	mockOAuthApiKey(provider.getApiKey);
}

/** Generic pool tests compare bearer selection, not Copilot's structured request metadata. */
export function mockOAuthApiKey(getApiKey?: OAuthProviderInterface["getApiKey"]): void {
	vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (id, credentials) => {
		const result = await getOAuthApiKey(id, credentials);
		return result ? { ...result, apiKey: getApiKey?.(result.newCredentials) ?? result.newCredentials.access } : null;
	});
}

export function resetOAuthMocks(_sourceId?: string): void {
	vi.restoreAllMocks();
}
