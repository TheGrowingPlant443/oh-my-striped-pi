import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";
import { githubCopilotUsageProvider } from "./github-copilot";

/** Resolves the usage-based ranking strategy for a provider. */
export type RankingStrategyResolver = (provider: Provider) => CredentialRankingStrategy | undefined;

/** Built-in usage providers, in probe order. */
export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] = [githubCopilotUsageProvider];

/** Built-in usage provider for `provider`. */
export function defaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return provider === "github-copilot" ? githubCopilotUsageProvider : undefined;
}

/** Retained providers do not use quota-based credential ranking. */
export function defaultRankingStrategy(_provider: Provider): CredentialRankingStrategy | undefined {
	return undefined;
}
