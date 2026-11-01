import type { Model } from "../types";
import { normalizeAnthropicBaseUrl } from "./anthropic-state";
import { resolveGitHubCopilotBaseUrl } from "./github-copilot-headers";

export function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	const baseUrl =
		model.provider === "github-copilot"
			? (resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl)
			: model.baseUrl;
	return normalizeAnthropicBaseUrl(baseUrl);
}
