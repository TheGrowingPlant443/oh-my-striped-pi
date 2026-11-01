/** Shared transcript, local recording, encrypted collaboration, and tool intent types. */

// ═══════════════════════════════════════════════════════════════════════════
// Content blocks
// ═══════════════════════════════════════════════════════════════════════════

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	/** e.g. "image/png". */
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}

export type AssistantContent = TextContent | ThinkingContent | RedactedThinkingContent | ToolCallContent;

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════════════

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g. auto-continue). */
	synthetic?: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	usage: WireUsage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type WireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

// ═══════════════════════════════════════════════════════════════════════════
// Session entries (rendered subset; cast `as SessionEntry` at the JSON
// boundary and skip unknown `type`s in a tolerant `default:`)
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

export interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: WireMessage;
}

export interface CustomMessageEntry extends EntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format. */
	model: string;
	role?: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
}

export type SessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

/** Parameter key used for intent tracing (e.g. prompt explanation/reasoning) */
export const INTENT_FIELD = "i";

export * from "./collab";
export * from "./stream";
export * from "./tsp";
