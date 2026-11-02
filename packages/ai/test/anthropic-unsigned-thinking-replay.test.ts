import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-striped-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";

/** Explicit unsigned-wire overrides preserve reasoning and tool pairing; all paths sanitize UTF-8. */
function makeModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
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
		compat: { signingEndpoint: false, replayUnsignedThinking: true },
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text = "continue"): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistantThinking(thinking: string, tail: AssistantMessage["content"][number][] = []): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking, thinkingSignature: "" }, ...tail],
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
interface WireToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
type WireBlock = WireThinkingBlock | WireTextBlock | WireToolUseBlock | { type: string; [key: string]: unknown };

function assistantWireBlocks(messages: Message[], model: Model<"anthropic-messages">): WireBlock[] {
	const params = convertAnthropicMessages(messages, model);
	const assistant = params.find(p => p.role === "assistant");
	return (assistant?.content as WireBlock[] | undefined) ?? [];
}

describe("Anthropic unsigned replay compatibility overrides (#2005)", () => {
	it("preserves unsigned thinking when explicitly enabled", () => {
		const blocks = assistantWireBlocks(
			[
				makeUser("solve x"),
				makeAssistantThinking("plan: read the file, then edit", [{ type: "text", text: "Sure." }]),
			],
			makeModel(),
		);
		expect(blocks[0]).toEqual({
			type: "thinking",
			thinking: "plan: read the file, then edit",
			signature: "",
		});
		expect(blocks[1]).toEqual({ type: "text", text: "Sure." });
	});

	it("sanitizes lone surrogates in tool arguments regardless of origin API", () => {
		const loneSurrogate = "broken \ud83d end";
		const makeToolCallAssistant = (api: AssistantMessage["api"]): AssistantMessage => ({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "write",
					arguments: { text: loneSurrogate, nested: { parts: [loneSurrogate] } },
				},
			],
			api,
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
		});

		// Cross-API replay: Anthropic's strict UTF-8 validation rejects lone
		// surrogates, so string leaves are deep-sanitized.
		const crossBlocks = assistantWireBlocks([makeUser(), makeToolCallAssistant("openai-responses")], makeModel());
		const crossToolUse = crossBlocks.find(block => block.type === "tool_use") as WireToolUseBlock;
		expect(crossToolUse.input.text).toBe("broken \ufffd end");
		expect((crossToolUse.input.nested as { parts: string[] }).parts[0]).toBe("broken \ufffd end");

		// Same-API replay sanitizes too: the model itself can emit lone-surrogate
		// escapes in its own tool-argument JSON (streamed out fine, 400 on replay).
		const sameBlocks = assistantWireBlocks([makeUser(), makeToolCallAssistant("anthropic-messages")], makeModel());
		const sameToolUse = sameBlocks.find(block => block.type === "tool_use") as WireToolUseBlock;
		expect(sameToolUse.input.text).toBe("broken \ufffd end");
		expect((sameToolUse.input.nested as { parts: string[] }).parts[0]).toBe("broken \ufffd end");
	});

	it("sanitizes payload replacements before SDK JSON serialization", async () => {
		const splitSurrogate = `render \`"icon.ghost": "\\ud83d${String.fromCharCode(0xdc7b)}"\``;
		const { promise: bodyPromise, resolve } = Promise.withResolvers<string>();
		const controller = new AbortController();
		const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = init?.body;
			resolve(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array));
			controller.abort();
			return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		streamAnthropic(
			makeModel(),
			{ systemPrompt: [], messages: [makeUser("continue")] },
			{
				apiKey: "sk-ant-test",
				signal: controller.signal,
				fetch: fakeFetch,
				onPayload: payload => {
					const request = payload as { messages?: Array<{ role: string; content: unknown }> };
					if (!Array.isArray(request.messages)) throw new Error("Anthropic payload missing messages");
					request.messages.push({
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "toolu_surrogate",
								name: "write",
								input: { text: splitSurrogate },
							},
						],
					});
					return request;
				},
			},
		);

		const body = await bodyPromise;
		expect(body).not.toContain("\\udc7b");
		expect(body).toContain("\ufffd");
	});

	it("keeps thinking → tool_use pairing intact across continuation conversion", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_reasoning_1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 0,
		};
		const model = makeModel();
		const messages: Message[] = [
			makeUser("read README"),
			makeAssistantThinking("I need to call the read tool", [
				{ type: "toolCall", id: "toolu_reasoning_1", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult,
		];
		const params = convertAnthropicMessages(messages, model);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user"]);
		const assistantBlocks = params[1].content as WireBlock[];
		expect(assistantBlocks[0]?.type).toBe("thinking");
		expect(assistantBlocks[1]?.type).toBe("tool_use");
		expect((assistantBlocks[1] as WireToolUseBlock).id).toBe("toolu_reasoning_1");
	});
});
