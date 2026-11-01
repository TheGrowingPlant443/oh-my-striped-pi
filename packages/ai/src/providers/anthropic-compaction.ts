import type { Model } from "../types";
import type { AnthropicMessagesClientLike } from "./anthropic-client";

function isCompactionCapableModel(model: Model<"anthropic-messages">): boolean {
	return model.compat.supportsServerCompaction === true && model.remoteCompaction?.enabled !== false;
}

/** Whether the model declares on-demand compaction support. */
export function supportsAnthropicCompaction(model: Model<"anthropic-messages">): boolean {
	return isCompactionCapableModel(model);
}

/** Read a caller-owned client's endpoint for request and compaction routing. */
export function injectedClientBaseUrl(client: AnthropicMessagesClientLike): string | undefined {
	const candidate = "baseURL" in client ? client.baseURL : undefined;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Whether a caller-owned Anthropic client targets a compaction-capable endpoint. */
export function supportsAnthropicCompactionOnClient(
	model: Model<"anthropic-messages">,
	client: AnthropicMessagesClientLike,
): boolean {
	const baseUrl = injectedClientBaseUrl(client);
	if (baseUrl !== undefined) return supportsAnthropicCompaction(model);
	return isCompactionCapableModel(model) && model.remoteCompaction?.enabled === true;
}
