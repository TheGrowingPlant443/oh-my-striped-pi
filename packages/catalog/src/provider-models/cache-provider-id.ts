import { PERSONAL_GITHUB_COPILOT_BASE_URL } from "../wire/github-copilot";

export interface ModelCacheProviderIdOptions {
	apiKey?: string;
	baseUrl?: string;
}

/** Copilot catalogs are scoped to the credential's account and plan. */
export function isCredentialScopedModelCacheProvider(providerId: string): boolean {
	return providerId === "github-copilot";
}

export function getDefaultModelDiscoveryBaseUrl(providerId: string): string | undefined {
	switch (providerId) {
		case "ollama":
			return "http://127.0.0.1:11434";
		case "lm-studio":
			return Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
		case "litellm":
			return Bun.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
		case "vllm":
			return "http://127.0.0.1:8000/v1";
		default:
			return undefined;
	}
}

/** Native Ollama and its `/v1` facade describe the same endpoint roster. */
export function resolveOllamaModelCacheProviderId(providerId: string, baseUrl?: string): string {
	const defaultBaseUrl = getDefaultModelDiscoveryBaseUrl("ollama")!;
	let endpoint = defaultBaseUrl;
	try {
		const parsed = new URL(baseUrl ?? defaultBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		const nativePath = trimmedPath.endsWith("/v1") ? trimmedPath.slice(0, -3) : trimmedPath;
		endpoint = `${parsed.protocol}//${parsed.host}${nativePath}`;
	} catch {
		// Invalid endpoints cannot overwrite a valid endpoint's discovered catalog.
		endpoint = baseUrl ?? defaultBaseUrl;
	}
	return `${providerId}:ollama-models-v1:${Bun.hash(endpoint).toString(36)}`;
}

/** Resolve the cache namespace without constructing discovery options. */
export function resolveModelCacheProviderId(providerId: string, options: ModelCacheProviderIdOptions = {}): string {
	if (providerId === "github-copilot") {
		const baseUrl = options.baseUrl ?? PERSONAL_GITHUB_COPILOT_BASE_URL;
		const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
		return `github-copilot:models-v2:${Bun.hash(scope).toString(36)}`;
	}
	if (providerId === "ollama") return resolveOllamaModelCacheProviderId(providerId, options.baseUrl);
	if (providerId === "litellm" || providerId === "vllm" || providerId === "lm-studio") {
		const baseUrl = (options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!).trim().replace(/\/+$/g, "");
		const version = providerId === "litellm" ? "rich-v14" : "models-v2";
		return `${providerId}:${version}:${Bun.hash(baseUrl).toString(36)}`;
	}
	return providerId;
}
