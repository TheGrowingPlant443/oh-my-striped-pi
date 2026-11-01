import type { Api, Model, ProviderSessionState } from "../types";

/** Root key for Anthropic's per-session provider state. */
export const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";
/** Caller-map anchor for session-scoped opaque injected clients. */
export const ANTHROPIC_OPAQUE_CLIENT_ANCHOR_KEY = "anthropic-opaque-clients";

/** Normalize an Anthropic base URL to its origin path without `/v1`. */
export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return undefined;
	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

/** Build the endpoint-and-model-scoped Anthropic session-state key. */
export function anthropicProviderSessionStateKey(baseUrl: string, modelId: string): string {
	return `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:${baseUrl}\u0000${modelId}`;
}

/** Re-arm fast mode across materialized Anthropic session-state entries. */
export function clearAnthropicFastModeFallback(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): void {
	if (!providerSessionState) return;
	const prefix = `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:`;
	for (const [key, value] of providerSessionState) {
		if (key !== ANTHROPIC_PROVIDER_SESSION_STATE_KEY && !key.startsWith(prefix)) continue;
		Object.assign(value, { fastModeDisabled: false });
	}
	const anchor = providerSessionState.get(ANTHROPIC_OPAQUE_CLIENT_ANCHOR_KEY);
	if (anchor && "fastModeRearmGeneration" in anchor && typeof anchor.fastModeRearmGeneration === "number") {
		anchor.fastModeRearmGeneration++;
	}
}

/** Inspect the direct model's fast-mode fallback without materializing state. */
export function isAnthropicFastModeFallbackDisabled(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	model: Model<Api>,
): boolean {
	if (!providerSessionState || model.api !== "anthropic-messages") return false;
	const baseUrl = normalizeAnthropicBaseUrl(model.baseUrl) ?? "";
	const key = anthropicProviderSessionStateKey(baseUrl, model.id);
	const state = providerSessionState.get(key);
	return state !== undefined && "fastModeDisabled" in state && state.fastModeDisabled === true;
}
