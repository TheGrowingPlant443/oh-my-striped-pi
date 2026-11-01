/**
 * Pull plain-text user/assistant messages out of a session manager.
 *
 * Retention uses plain-text conversation records, excluding tool calls, tool
 * results and internal reasoning. Source timestamps survive for temporal recall.
 */

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "../session/session-entries";
import { type MemoryMessage, hasSubstantiveContent } from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
}

/**
 * Walk session entries top-to-bottom, returning a flat user/assistant list.
 *
 * Implementation choices:
 * - Skip entries whose type isn't `"message"` (compaction, branch_summary,
 *   custom_message, tool exec records, ...). Those don't represent a
 *   conversational turn, only the LLM's plain-text utterances do.
 * - Skip messages whose role isn't `"user"` or `"assistant"`. We deliberately
 *   ignore `toolResult`, `bashExecution`, `hookMessage`, etc. — they're noise
 *   for memory purposes.
 * - For assistant messages, only `text` blocks contribute. Thinking and
 *   toolCall blocks are intentionally dropped: the user never saw them, so
 *   retaining them would prime recall on internal monologue.
 */
export function extractMessages(sessionManager: ReadonlySessionManagerLike): MemoryMessage[] {
	const messages: MemoryMessage[] = [];

	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
		if (!hasSubstantiveContent(text)) continue;
		messages.push({ role, content: text, timestamp: entry.timestamp });
	}

	return messages;
}

/**
 * Count user turns exactly as `extractMessages(sessionManager).filter(m => m.role === "user").length`,
 * without extracting assistant text or allocating the message list. Not memoized: messages may be
 * rewritten in place (e.g. image stripping), so each call re-inspects current content.
 */
export function countUserTurns(sessionManager: ReadonlySessionManagerLike): number {
	let count = 0;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		if (hasSubstantiveContent(extractUserText(entry.message))) count++;
	}
	return count;
}

function extractUserText(msg: { content: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: unknown; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			parts.push(maybeText.text);
		}
	}
	return parts.join("\n");
}

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}
