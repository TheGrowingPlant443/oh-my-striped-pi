// Explicit reasoning-history replay remains independent of the current turn's thinking setting.
import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Message, Model, ModelSpec, ThinkingContent, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | undefined {
	for (const message of messages) {
		if (isPlainObject(message) && message.role === "assistant") return message;
	}
	return undefined;
}

function replayModel(overrides?: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-completions",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 131_072,
		...overrides,
		compat: {
			replayReasoningContent: true,
			requiresReasoningContentForToolCalls: false,
			...overrides?.compat,
		},
	} satisfies ModelSpec<"openai-completions">);
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantWithReasoning(reasoning: string, answer: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "github-copilot",
		model: "qwen-3.6-27b",
		content: [
			{ type: "thinking", thinking: reasoning, thinkingSignature: "reasoning_content" } satisfies ThinkingContent,
			{ type: "text", text: answer },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("explicit reasoning-history replay (#3528)", () => {
	it("replays reasoning_content on plain-text assistant turns without tool calls", () => {
		const target = replayModel();
		const messages: Message[] = [
			userMessage("Review the unpushed commit."),
			assistantWithReasoning(
				"Let me review the unpushed changes comprehensively.",
				"## Review: 1 unpushed commit + 1 unstaged change",
			),
			userMessage("Before you finish: if this turn produced anything reusable, capture it now."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");

		expect(assistant.content).toBe("## Review: 1 unpushed commit + 1 unstaged change");
		expect(assistant.reasoning_content).toBe("Let me review the unpushed changes comprehensively.");
	});

	it("replays reasoning_content when the model omits reasoning capability", () => {
		// When the model emits reasoning at runtime the stream parser still
		// records it as a thinking block; the encoder MUST replay it as
		// `reasoning_content` independently of whether this turn requests thinking.
		const target = replayModel({ reasoning: false });
		const messages: Message[] = [
			userMessage("Plan a refactor."),
			assistantWithReasoning(
				"Trace the call graph through service.ts and the registry.",
				"Step 1: extract the loader. Step 2: rewire the factory.",
			),
			userMessage("Continue."),
		];

		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = findAssistantMessage(wire);
		expect(assistant).toBeDefined();
		if (!assistant) throw new Error("assistant message missing");
		expect(assistant.reasoning_content).toBe("Trace the call graph through service.ts and the registry.");
	});

	it("demotes cross-API thinking instead of replaying it as native reasoning", () => {
		// `replayReasoningContent` is a same-wire cache concern. It keeps
		// turns cache-stable when the prior assistant already emitted an
		// OpenAI-compatible reasoning field, but it must not preserve foreign
		// Anthropic reasoning as native semantic context.
		const target = replayModel({ reasoning: false });
		const anthropicSourceTurn: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "github-copilot",
			model: "claude-opus-4-8",
			content: [
				{
					type: "thinking",
					thinking: "Cross-vendor reasoning chain that must survive the switch.",
					thinkingSignature: "EvAnthropicOpaqueContinuationBlob==",
				} satisfies ThinkingContent,
				{ type: "text", text: "Switched-in answer." },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{
				messages: [userMessage("Plan the migration."), anthropicSourceTurn, userMessage("Continue on Copilot.")],
			},
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning_content).toBeUndefined();
		expect(found?.content).toBe(
			`${renderDemotedThinking(target.id, "Cross-vendor reasoning chain that must survive the switch.")}\nSwitched-in answer.`,
		);
		expect("EvAnthropicOpaqueContinuationBlob==" in (found ?? {})).toBe(false);
	});

	it("honors the streamed signature when it identifies a recognized wire field", () => {
		// Replay the recognized field name rather than inventing a signature key.
		const target = replayModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "github-copilot",
			model: "qwen-3.6-27b",
			content: [
				{ type: "thinking", thinking: "trace A", thinkingSignature: "reasoning" } satisfies ThinkingContent,
				{ type: "text", text: "answer A" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning).toBe("trace A");
		expect(found?.reasoning_content).toBeUndefined();
	});

	it("falls back to reasoningContentField for opaque thinking signatures", () => {
		// Anthropic/OpenAI-Responses thinking blocks ride a binary continuation
		// signature that is meaningless as a chat-completions field name. Use
		// the configured `reasoningContentField` (default `reasoning_content`)
		// rather than synthesizing a key from the opaque signature.
		const target = replayModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "github-copilot",
			model: "qwen-3.6-27b",
			content: [
				{
					type: "thinking",
					thinking: "trace B",
					thinkingSignature: "rs_0123456789abcdef",
				} satisfies ThinkingContent,
				{ type: "text", text: "answer B" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.reasoning_content).toBe("trace B");
		expect("rs_0123456789abcdef" in (found ?? {})).toBe(false);
	});

	it("does NOT replay reasoning_content when the target has no reasoning blocks", () => {
		// Pure-text turn with no thinking content stays minimal — the
		// replay branch only fires when there is actually something to preserve.
		const target = replayModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "github-copilot",
			model: "qwen-3.6-27b",
			content: [{ type: "text", text: "plain answer" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const wire = convertMessages(
			target,
			{ messages: [userMessage("hi"), assistant, userMessage("next")] },
			target.compat,
		);
		const found = findAssistantMessage(wire) as Record<string, unknown> | undefined;
		expect(found?.content).toBe("plain answer");
		expect(found?.reasoning_content).toBeUndefined();
		expect(found?.reasoning).toBeUndefined();
	});
});
