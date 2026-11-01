/** Generic Anthropic protocol versions and Copilot signature compatibility. */
import { hostMatchesUrl } from "../hosts";

/** `anthropic-version` values this codebase knows how to speak. */
export const ANTHROPIC_API_VERSIONS = ["2023-06-01", "2026-10-21"] as const;
export type AnthropicApiVersion = (typeof ANTHROPIC_API_VERSIONS)[number];

/** Version every non-official Anthropic-compatible endpoint receives. */
export const LEGACY_ANTHROPIC_API_VERSION: AnthropicApiVersion = "2023-06-01";

/**
 * Whether Messages requests on `version` may carry `temperature`, `top_p`,
 * or `top_k`. API version 2026-10-21 rejects all three with a 400, even at
 * their default values.
 */
export function anthropicApiVersionAcceptsSamplingParams(version: AnthropicApiVersion): boolean {
	return version === "2023-06-01";
}

/** Copilot enforces Anthropic thinking signatures on replay. */
export function isAnthropicSigningProxyUrl(baseUrl?: string): boolean {
	return hostMatchesUrl(baseUrl, "githubCopilot");
}
