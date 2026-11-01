import * as AIError from "../error";

// Search credentials are independent of model-provider authentication.
const SEARCH_CREDENTIAL_PROVIDERS: Readonly<Record<string, true>> = { firecrawl: true };

export function isSearchCredentialProvider(provider: string): boolean {
	return Object.hasOwn(SEARCH_CREDENTIAL_PROVIDERS, provider);
}

/** MCP owns its OAuth exchange independently of model-provider authentication. */
export function isMcpCredentialProvider(provider: string): boolean {
	return provider.startsWith("mcp_oauth:") || provider.startsWith("mcp_oauth_");
}

export function assertSupportedOAuthCredentialProvider(provider: string): void {
	assertSupportedCredentialProvider(provider);
}

export function assertSupportedCredentialProvider(provider: string): void {
	if (!provider.trim() || provider.includes("\0")) {
		throw new AIError.ConfigurationError("Credential provider must be a nonempty name without NUL characters");
	}
}

export function assertSupportedAuthCredential(provider: string, type: "api_key" | "oauth"): void {
	if (type === "api_key") assertSupportedCredentialProvider(provider);
	else assertSupportedOAuthCredentialProvider(provider);
}
