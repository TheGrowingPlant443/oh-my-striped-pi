import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Copilot replays its signed turns and rejects foreign signatures from imported history. */
function makeAnthropicModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "github-copilot",
		id: "reasoning-model",
		name: "Reasoning Anthropic-Compatible Model",
		baseUrl: "https://api.githubcopilot.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "reasoning-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...overrides,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

interface WireThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}
interface WireTextBlock {
	type: "text";
	text: string;
}
interface WireRedactedBlock {
	type: "redacted_thinking";
	data: string;
}
interface WireToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
type WireBlock =
	| WireThinkingBlock
	| WireTextBlock
	| WireRedactedBlock
	| WireToolUseBlock
	| { type: string; [key: string]: unknown };

describe("Anthropic prior-turn thinking preservation (#2257, #2265)", () => {
	it("keeps the signature on prior turns when the source model matches the target", () => {
		// Same provider+api+id throughout: signatures are valid and must ride
		// the wire untouched (prompt-cache stability + Anthropic's all-or-none
		// invariant).
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant([
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig_same" },
				{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "summarising", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ stopReason: "stop" },
			),
			makeUser("And now in Spanish"),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("plan");
		expect(thinking?.signature).toBe("sig_same");
	});

	it("strips foreign signatures and drops redacted thinking on the Copilot wire", () => {
		const target = makeAnthropicModel({
			provider: "github-copilot",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.githubcopilot.com",
		});
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "sig_custom" },
					{ type: "redactedThinking", data: "foreign-encrypted-blob" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ provider: "kimi-code", model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "official latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{
					provider: "github-copilot",
					model: "claude-sonnet-4-6",
					stopReason: "stop",
				},
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe(renderDemotedThinking(target.id, "visible reasoning"));
		expect(priorBlocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(priorBlocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
	});

	it("strips retained-tail thinking produced before a client-side compaction", () => {
		const target = makeAnthropicModel({
			provider: "github-copilot",
			id: "claude-fable-5-1",
			baseUrl: "https://api.githubcopilot.com",
		});
		const messages: Message[] = [
			{
				role: "user",
				content: "Compacted session summary",
				historyRewriteAt: 100,
				timestamp: 100,
			},
			makeAssistant(
				[
					{ type: "thinking", thinking: "reasoning from the old prefix", thinkingSignature: "sig_old" },
					{ type: "text", text: "Retained visible answer." },
				],
				{
					provider: "github-copilot",
					model: target.id,
					stopReason: "stop",
					timestamp: 50,
				},
			),
			makeUser("Continue after compaction."),
			makeAssistant(
				[
					{ type: "thinking", thinking: "reasoning from the new prefix", thinkingSignature: "sig_new" },
					{ type: "text", text: "New answer." },
				],
				{
					provider: "github-copilot",
					model: target.id,
					stopReason: "stop",
					timestamp: 200,
				},
			),
			makeUser("One more step."),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(param => param.role === "assistant");
		const retainedBlocks = assistants[0]?.content;
		const newBlocks = assistants[1]?.content;
		if (!Array.isArray(retainedBlocks) || !Array.isArray(newBlocks)) {
			throw new Error("expected assistant content blocks");
		}
		expect(retainedBlocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(retainedBlocks).toContainEqual({ type: "text", text: "Retained visible answer." });
		expect(newBlocks.find(block => block.type === "thinking")).toEqual({
			type: "thinking",
			thinking: "reasoning from the new prefix",
			signature: "sig_new",
		});
	});

	it("does not demote same-model Copilot unsigned thinking to text", () => {
		// Same-model Anthropic replay is not a dialect transition. If a committed
		// tool-use turn lacks a usable thinking signature, the native thinking block
		// is unreplayable, but serializing it as target-dialect text would
		// incorrectly apply the cross-model fallback intended for real transitions.
		for (const modelCase of [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-fable-5", name: "Claude Fable 5" },
		]) {
			const target = makeAnthropicModel({
				provider: "github-copilot",
				id: modelCase.id,
				name: modelCase.name,
				baseUrl: "https://api.githubcopilot.com",
			});
			const reasoning = `Need to inspect the layout before editing with ${modelCase.id}.`;
			const toolCallId = `toolu_${modelCase.id.replaceAll("-", "_")}`;
			const messages: Message[] = [
				makeUser("Fix the layout"),
				makeAssistant(
					[
						{ type: "thinking", thinking: reasoning, thinkingSignature: "" },
						{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
					],
					{ provider: "github-copilot", model: modelCase.id },
				),
				toolResult(toolCallId, "view body"),
				makeUser("Continue."),
			];

			const params = convertAnthropicMessages(messages, target);
			const assistant = params.find(p => p.role === "assistant");
			if (!assistant) throw new Error("expected assistant wire message");
			const blocks = assistant.content as WireBlock[];
			const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
			expect(textBlocks).toHaveLength(0);
			expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
			const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
			expect(toolUse?.id).toBe(toolCallId);
		}
	});

	it("drops same-model Anthropic thinking blocks with undefined signatures (regression test for 018b3dc61, restoring 93996bc48)", () => {
		// Regression: commit 018b3dc61 narrowed the drop guard to catch only
		// empty-string signatures, but same-model thinking blocks from aborted
		// or prior turns may have undefined signatures (marked by the
		// untrustworthy-turn recovery at :410-414). These must also be dropped,
		// not demoted to text, because demotion triggers the reasoning_extraction
		// safety classifier and causes hard refusals from Fable 5 and Opus 4.8.
		for (const modelCase of [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-fable-5", name: "Claude Fable 5" },
		]) {
			const target = makeAnthropicModel({
				provider: "github-copilot",
				id: modelCase.id,
				name: modelCase.name,
				baseUrl: "https://api.githubcopilot.com",
			});
			const reasoning = `Internal reasoning that should not leak for ${modelCase.id}.`;
			const toolCallId = `toolu_${modelCase.id.replaceAll("-", "_")}`;
			const messages: Message[] = [
				makeUser("Fix the layout"),
				makeAssistant(
					[
						{ type: "thinking", thinking: reasoning, thinkingSignature: undefined },
						{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
					],
					{ provider: "github-copilot", model: modelCase.id },
				),
				toolResult(toolCallId, "view body"),
				makeUser("Continue."),
			];

			const params = convertAnthropicMessages(messages, target);
			const assistant = params.find(p => p.role === "assistant");
			if (!assistant) throw new Error("expected assistant wire message");
			const blocks = assistant.content as WireBlock[];
			// Must not produce a native thinking block
			expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
			// Must not demote to text (neither <thinking> tags nor plain text containing the reasoning)
			const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
			expect(textBlocks).toHaveLength(0);
			// Tool call must still be present
			const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
			expect(toolUse?.id).toBe(toolCallId);
		}
	});

	it("drops redacted siblings when same-model unsigned visible thinking is discarded", () => {
		const target = makeAnthropicModel({
			provider: "github-copilot",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.githubcopilot.com",
		});
		const toolCallId = "toolu_redacted_dropped";
		const messages: Message[] = [
			makeUser("Fix the layout"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Private discarded reasoning.", thinkingSignature: undefined },
					{ type: "redactedThinking", data: "encrypted-sibling" },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
				],
				{ provider: "github-copilot", model: "claude-sonnet-4-6" },
			),
			toolResult(toolCallId, "view body"),
			makeUser("Continue."),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistant = params.find(p => p.role === "assistant");
		if (!assistant) throw new Error("expected assistant wire message");
		const blocks = assistant.content as WireBlock[];
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(blocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
		expect(blocks.filter((b): b is WireTextBlock => b.type === "text")).toHaveLength(0);
		const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe(toolCallId);
	});

	it("keeps redacted siblings when signed same-model thinking survives beside a discarded final block", () => {
		const target = makeAnthropicModel({
			provider: "github-copilot",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.githubcopilot.com",
		});
		const messages: Message[] = [
			makeUser("Fix the layout"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Completed signed reasoning.", thinkingSignature: "sig_complete" },
					{ type: "redactedThinking", data: "encrypted-complete-sibling" },
					{ type: "text", text: "Visible anchor." },
					{ type: "thinking", thinking: "Partial final reasoning.", thinkingSignature: "sig_partial" },
				],
				{ provider: "github-copilot", model: "claude-sonnet-4-6", stopReason: "error" },
			),
			makeUser("Continue."),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistant = params.find(p => p.role === "assistant");
		if (!assistant) throw new Error("expected assistant wire message");
		const blocks = assistant.content as WireBlock[];
		const thinking = blocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("Completed signed reasoning.");
		expect(thinking?.signature).toBe("sig_complete");
		const redacted = blocks.find(b => b.type === "redacted_thinking") as WireRedactedBlock | undefined;
		expect(redacted?.data).toBe("encrypted-complete-sibling");
		expect(blocks.some(b => b.type === "thinking" && b.thinking === "Partial final reasoning.")).toBe(false);
	});
});

describe("Latest-turn foreign thinking signatures (model switch mid tool-loop)", () => {
	// Removed-provider history remains readable, but its signatures cannot verify on Copilot.
	const officialFable = () =>
		makeAnthropicModel({
			provider: "github-copilot",
			id: "claude-fable-5",
			name: "Claude Fable 5",
			baseUrl: "https://api.githubcopilot.com",
		});
	const KIMI_SIG = "kimi-issued-foreign-signature";

	it("strips an imported foreign signature from the latest in-flight tool-use turn", () => {
		const reasoning = "The PR body is final and verified. One formatting nit remains.";
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Fix the PR body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: reasoning, thinkingSignature: KIMI_SIG },
					{ type: "text", text: "한 군데 렌더링 닛: 빈 줄 하나 추가." },
					{ type: "toolCall", id: "toolu_send", name: "send", arguments: { text: "patch" } },
				],
				{ provider: "kimi-code", model: "k3" },
			),
			toolResult("toolu_send", "sent"),
			makeUser("<user_interjection>switch happened here</user_interjection>"),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(p => p.role === "assistant");
		expect(assistants).toHaveLength(1);
		const blocks = assistants[0].content as WireBlock[];
		// Imported foreign signatures must not reach Copilot's signature validator.
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(JSON.stringify(blocks)).not.toContain(KIMI_SIG);
		// The reasoning survives as demoted text ahead of the visible text.
		const texts = blocks.filter(b => b.type === "text") as WireTextBlock[];
		expect(texts[0]?.text).toBe(renderDemotedThinking(target.id, reasoning));
		expect(texts.some(t => t.text.includes("렌더링"))).toBe(true);
		// The pending tool loop stays intact.
		const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe("toolu_send");
	});

	it("keeps the latest same-model Copilot turn byte-for-byte", () => {
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Fix the PR body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "own reasoning", thinkingSignature: "sig_fable" },
					{ type: "toolCall", id: "toolu_send", name: "send", arguments: {} },
				],
				{ provider: "github-copilot", model: "claude-fable-5" },
			),
			toolResult("toolu_send", "sent"),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		const thinking = blocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("own reasoning");
		expect(thinking?.signature).toBe("sig_fable");
	});

	it("strips an imported foreign signature from the latest abandoned tool-use turn", () => {
		// stopReason !== "toolUse" with toolCall blocks = abandoned turn. The
		// byte-for-byte exemption only covers Anthropic's own latest response,
		// not a foreign one.
		const reasoning = "kimi reasoning on an abandoned turn";
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Do the thing"),
			makeAssistant(
				[
					{ type: "thinking", thinking: reasoning, thinkingSignature: KIMI_SIG },
					{ type: "toolCall", id: "toolu_left", name: "read", arguments: { path: "a" } },
				],
				{ provider: "kimi-code", model: "k3", stopReason: "stop" },
			),
			toolResult("toolu_left", "placeholder"),
			makeUser("continue"),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(JSON.stringify(blocks)).not.toContain(KIMI_SIG);
		const text = blocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe(renderDemotedThinking(target.id, reasoning));
	});

	it("keeps the latest ABANDONED same-model turn untouched (byte-for-byte rule)", () => {
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Do the thing"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "fable reasoning", thinkingSignature: "sig_fable" },
					{ type: "toolCall", id: "toolu_left", name: "read", arguments: { path: "a" } },
				],
				{ provider: "github-copilot", model: "claude-fable-5", stopReason: "stop" },
			),
			toolResult("toolu_left", "placeholder"),
			makeUser("continue"),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		const thinking = blocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("fable reasoning");
		expect(thinking?.signature).toBe("sig_fable");
	});

	it("drops a foreign redacted_thinking sibling on the latest turn for signing targets", () => {
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Fix it"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible", thinkingSignature: KIMI_SIG },
					{ type: "redactedThinking", data: "foreign-blob" },
					{ type: "toolCall", id: "toolu_x", name: "read", arguments: {} },
				],
				{ provider: "kimi-code", model: "k3" },
			),
			toolResult("toolu_x", "ok"),
		];

		const params = convertAnthropicMessages(messages, target);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		expect(blocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
	});
});
