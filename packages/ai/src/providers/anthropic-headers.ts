// Build deduplicated beta header string
export function buildBetaHeader(baseBetas: readonly string[], extraBetas: readonly string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

/**
 * Merge an extra Anthropic beta into a caller-provided `anthropic-beta` header,
 * preserving the caller's key casing and deduping the tokens. Returns a
 * single-entry header record for a per-request `headers` override — used to
 * attach a required beta to injected SDK clients that bypass the client-level
 * beta construction.
 */
export function mergeAnthropicBetaHeader(callerHeaders: Record<string, string>, beta: string): Record<string, string> {
	for (const key in callerHeaders) {
		if (key.toLowerCase() === "anthropic-beta") {
			return { [key]: buildBetaHeader(normalizeExtraBetas(callerHeaders[key]), [beta]) };
		}
	}
	return { "anthropic-beta": beta };
}
export const midConversationSystemClearAtBeta = "mid-conversation-system-clear-at-2026-08-21";
export const midConversationToolChangesBeta = "mid-conversation-tool-changes-2026-07-01";
export const midConversationOutputConfigBeta = "mid-conversation-output-config-2026-07-01";
export const contextManagementBeta = "context-management-2025-06-27";
export const structuredOutputsBeta = "structured-outputs-2025-12-15";
export const fallbackCreditBeta = "fallback-credit-2026-06-01";
export const promptCachingScopeBeta = "prompt-caching-scope-2026-01-05";
export const extendedCacheTtlBeta = "extended-cache-ttl-2025-04-11";
export const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
export const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
export const fastModeBeta = "fast-mode-2026-02-01";
export const taskBudgetBeta = "task-budgets-2026-03-13";
export const effortBeta = "effort-2025-11-24";
export const serverSideFallbackBeta = "server-side-fallback-2026-06-01";

/**
 * Merge headers case-insensitively; later sources win and preserve their key casing.
 * Undefined sources are ignored. Differently cased duplicates are removed so the
 * Headers constructor cannot join competing values comma-separated on the wire.
 */
export function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	const keyByLower = new Map<string, string>();
	for (const headers of headerSources) {
		if (!headers) continue;
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			const existing = keyByLower.get(lower);
			if (existing !== undefined && existing !== key) delete merged[existing];
			keyByLower.set(lower, key);
			merged[key] = value;
		}
	}
	return merged;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}
