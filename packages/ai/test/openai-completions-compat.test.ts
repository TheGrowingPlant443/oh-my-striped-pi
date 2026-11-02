import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-striped-pi/pi-ai/dialect";
import {
	convertMessages,
	parseChunkUsage,
	streamOpenAICompletions,
} from "@oh-my-striped-pi/pi-ai/providers/openai-completions";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	OpenAICompat,
	Tool,
	ToolResultMessage,
} from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";

const gpt4oMiniSpec: ModelSpec<"openai-completions"> = (() => {
	const {
		compat: _resolved,
		compatConfig,
		...rest
	} = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;
	return { ...rest, compat: compatConfig };
})();

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function toObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}

	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

async function captureOpenAICompletionsPayload(
	model: Model<"openai-completions">,
	context: Context = baseContext(),
	options?: {
		apiKey?: string;
		reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		temperature?: number;
		sessionId?: string;
		cacheRetention?: "none" | "short" | "long";
	},
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const fetchMock = createMockFetch(["[DONE]"]);
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
		...options,
	});
	return promise;
}

function getPayloadMessages(payload: unknown): Record<string, unknown>[] {
	const payloadObject = toObject(payload);
	const messages = payloadObject?.messages;
	if (!Array.isArray(messages)) throw new Error("payload messages missing");
	return messages.map(message => {
		const messageObject = toObject(message);
		if (!messageObject) throw new Error("payload message is not an object");
		return messageObject;
	});
}

function getLastPayloadContent(payload: unknown): unknown {
	const lastMessage = getPayloadMessages(payload).at(-1);
	if (!lastMessage) throw new Error("payload has no messages");
	return lastMessage.content;
}

function getLastTextPart(content: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(content)) return undefined;
	for (let index = content.length - 1; index >= 0; index--) {
		const part = toObject(content[index]);
		if (part?.type === "text") return part;
	}
	return undefined;
}

describe("openai-completions compatibility", () => {
	it("omits sampling params for OpenAI reasoning models", async () => {
		const model = buildModel({
			...gpt4oMiniSpec,
			id: "gpt-5.6-luna",
			provider: "github-copilot",
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		expect(model.compat.supportsSamplingParams).toBe(false);

		const payload = await captureOpenAICompletionsPayload(model, undefined, { temperature: 0 });
		expect(toObject(payload)?.temperature).toBeUndefined();
	});

	it("serializes assistant text content as a plain string", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const compat = model.compat;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: " world" },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [assistantMessage] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		if (assistant?.role !== "assistant") {
			throw new Error("assistant message missing");
		}
		// Ordinary adjacent text blocks (bridge stitching, imported transcripts,
		// streaming chunk splits) preserve their original byte sequence on
		// flatten. The demoted-thinking separator is inserted by the flatten
		// itself, gated on the kDemotedThinking marker, so unmarked blocks like
		// these are never touched.
		expect(assistant.content).toBe("hello world");
	});

	it("prepends thinking text to string assistant content when requiresThinkingAsText is set", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "chain of thought" },
				{ type: "text", text: "final answer" },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(
			model,
			{ messages: [assistantMessage] },
			{
				...model.compat,
				requiresThinkingAsText: true,
			},
		);
		const assistant = messages.find(message => message.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("assistant message missing");
		// Regression: thinking+text replay used to call `.unshift` on the string
		// content set above (TypeError). Both blocks must survive as one string.
		expect(assistant.content).toBe(`${renderDemotedThinking(model.id, "chain of thought")} final answer`);
	});

	it("emits thinking-only assistant content as a plain string when requiresThinkingAsText is set", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "only thoughts" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(
			model,
			{ messages: [assistantMessage] },
			{
				...model.compat,
				requiresThinkingAsText: true,
			},
		);
		const assistant = messages.find(message => message.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("assistant message missing");
		expect(assistant.content).toBe(renderDemotedThinking(model.id, "only thoughts"));
	});

	it("preserves multiple system prompts as leading system messages for chat completions", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			model.compat,
		);

		expect(messages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("uses developer messages for reasoning chat models only when the target supports them", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			reasoning: true,
			compat: { supportsDeveloperRole: true },
		} as ModelSpec<"openai-completions">);

		const supportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			model.compat,
		);

		expect(supportedMessages.slice(0, 3)).toEqual([
			{ role: "developer", content: "stable instructions" },
			{ role: "developer", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);

		const unsupportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...model.compat, supportsDeveloperRole: false },
		);

		expect(unsupportedMessages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("coalesces ordered system prompts when the host disables multi-system support", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...model.compat, supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("coalesces system prompts on a developer-role reasoning model when multi-system is disabled", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			reasoning: true,
			compat: { supportsDeveloperRole: true },
		} as ModelSpec<"openai-completions">);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...model.compat, supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "developer", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("emits separate system prompts when explicitly enabled", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			compat: { supportsMultipleSystemMessages: false },
		} as ModelSpec<"openai-completions">);

		const detected = model.compat;
		expect(detected.supportsMultipleSystemMessages).toBe(false);

		const overridden = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detected, supportsMultipleSystemMessages: true },
		);

		expect(overridden.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("reads usage from choice usage fallback", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Hello" },
						usage: {
							prompt_tokens: 12,
							completion_tokens: 3,
							prompt_tokens_details: { cached_tokens: 2 },
						},
					},
				],
			},
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(3);
		expect(result.usage.cacheRead).toBe(2);
		expect(result.usage.totalTokens).toBe(15);
	});

	it("preserves opaque tool-call IDs when replaying a custom Chat Completions turn", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "gateway-model",
			name: "Gateway Model",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://gateway.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} satisfies ModelSpec<"openai-completions">);
		const toolCallId = "call_abc||gateway_state||opaque";
		const assistant = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: createMockFetch([
				{
					id: "chatcmpl-opaque-tool-id",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: toolCallId,
										type: "function",
										function: { name: "read", arguments: '{"path":"README.md"}' },
									},
								],
							},
						},
					],
				},
				{
					id: "chatcmpl-opaque-tool-id",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				},
				"[DONE]",
			]),
		}).result();
		const streamedToolCall = assistant.content.find(content => content.type === "toolCall");
		expect(streamedToolCall?.id).toBe(toolCallId);

		const payload = await captureOpenAICompletionsPayload(model, {
			messages: [
				{ role: "user", content: "Read README", timestamp: 1 },
				assistant,
				{
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 2,
				},
			],
		});
		const replayMessages = getPayloadMessages(payload);
		const assistantPayload = replayMessages.find(message => message.role === "assistant");
		const toolCalls = assistantPayload?.tool_calls;
		if (!Array.isArray(toolCalls)) throw new Error("assistant tool_calls missing");
		expect(toObject(toolCalls[0])?.id).toBe(toolCallId);
		expect(replayMessages.find(message => message.role === "tool")?.tool_call_id).toBe(toolCallId);
	});

	it("keeps unindexed batched tool-call arguments isolated", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-batched-tools",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ function: { name: "bash", arguments: '{"command":"echo hello"}' } },
								{ function: { name: "bash", arguments: '{"command":"echo goodbye"}' } },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-batched-tools",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		const calls = result.content.filter(content => content.type === "toolCall");
		expect(calls.map(call => call.arguments)).toEqual([{ command: "echo hello" }, { command: "echo goodbye" }]);
	});

	it("routes unindexed batched tool-call continuation chunks back by array offset", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-batched-continuation",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ function: { name: "bash", arguments: '{"command":"echo hello"' } },
								{ function: { name: "bash", arguments: '{"command":"echo goodbye"' } },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-batched-continuation",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ function: { arguments: "}" } }, { function: { arguments: "}" } }],
						},
					},
				],
			},
			{
				id: "chatcmpl-batched-continuation",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		const calls = result.content.filter(content => content.type === "toolCall");
		expect(calls.map(call => call.arguments)).toEqual([{ command: "echo hello" }, { command: "echo goodbye" }]);
	});

	it("falls through zero cached-token candidates to later non-zero usage fields", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const cases: Array<{
			name: string;
			usage: object;
			expectedCacheRead: number;
		}> = [
			{
				name: "root zero falls through to nested prompt token details",
				usage: {
					prompt_tokens: 50_000,
					completion_tokens: 3,
					cached_tokens: 0,
					prompt_tokens_details: { cached_tokens: 49_216 },
				},
				expectedCacheRead: 49_216,
			},
			{
				name: "missing root uses prompt cache hit tokens",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					prompt_cache_hit_tokens: 41,
				},
				expectedCacheRead: 41,
			},
			{
				name: "standard nested prompt token details",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					prompt_tokens_details: { cached_tokens: 37 },
				},
				expectedCacheRead: 37,
			},
			{
				name: "all candidates missing or zero",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					cached_tokens: 0,
					prompt_cache_hit_tokens: 0,
					prompt_tokens_details: { cached_tokens: 0 },
				},
				expectedCacheRead: 0,
			},
			{
				name: "multiple non-zero fields preserve priority order",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					cached_tokens: 11,
					prompt_cache_hit_tokens: 13,
					prompt_tokens_details: { cached_tokens: 17 },
				},
				expectedCacheRead: 11,
			},
		];

		for (const testCase of cases) {
			const usage = parseChunkUsage(testCase.usage, model, undefined);
			expect(usage.cacheRead).toBe(testCase.expectedCacheRead);
			expect(usage.input).toBe(
				(testCase.usage as { prompt_tokens: number }).prompt_tokens - testCase.expectedCacheRead,
			);
		}
	});

	it("treats finish_reason end as stop", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "done" } }],
			},
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "end" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "done" });
	});
	it("surfaces empty length completions as context-window errors when configured", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "github-copilot" as Model["provider"],
			id: "local-12b",
			baseUrl: "https://api.githubcopilot.com",
			compat: { emptyLengthFinishIsContextError: true },
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-empty-length",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "length" }],
				usage: {
					prompt_tokens: 8191,
					completion_tokens: 1,
					total_tokens: 8192,
				},
			},
			"[DONE]",
		]);

		const stream = streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		});
		const resultPromise = stream.result();
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(eventTypes).toContain("error");
		expect(result.errorMessage).toBe(
			"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.",
		);
		expect(result.content).toEqual([]);
		expect(result.usage.input).toBe(8191);
		expect(result.usage.output).toBe(1);
	});
	it("preserves empty non-Ollama length completions for recovery", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "github-copilot" as Model["provider"],
			baseUrl: "https://gateway.example/v1",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-empty-length",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "length" }],
			},
			"[DONE]",
		]);

		const stream = streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		});
		const resultPromise = stream.result();
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await resultPromise;

		expect(result.stopReason).toBe("length");
		expect(eventTypes).toContain("done");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([]);
	});

	it("injects compat.extraBody into OpenAI payload", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			compat: {
				extraBody: {
					gateway: "m1-01",
					controller: "mlx",
				},
			},
		} as ModelSpec<"openai-completions">);

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});

		const payload = await promise;
		expect(payload).toEqual(
			expect.objectContaining({
				gateway: "m1-01",
				controller: "mlx",
			}),
		);
	});

	it("preserves the streamed reasoning field name when replay requires reasoning content", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { reasoning_text: "inspect tool output" },
					},
				],
			},
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.content).toContainEqual({
			type: "thinking",
			thinking: "inspect tool output",
			thinkingSignature: "reasoning_text",
			summary: false,
		});

		const compat = { ...model.compat, requiresReasoningContentForToolCalls: true };
		const messages = convertMessages(model, { messages: [result] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		const assistantObject = toObject(assistant);
		expect(assistantObject?.reasoning_text).toBe("inspect tool output");
		expect(assistantObject?.reasoning_content).toBeUndefined();
	});
});

describe("explicit forced-tool compatibility", () => {
	it("downgrades unsupported forced tool_choice without suppressing thinking", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			id: "kimi-k2.7-code",
			reasoning: true,
			compat: {
				supportsReasoningParams: true,
				supportsForcedToolChoice: false,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
				whenThinking: {
					requiresReasoningContentForToolCalls: true,
					allowsSyntheticReasoningContentForToolCalls: false,
					reasoningContentField: "reasoning_content",
				},
			},
		} as ModelSpec<"openai-completions">);
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Plan first, then call the tool.",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [readTool],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				toolChoice: { type: "tool", name: "read" },
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as {
			messages: Array<Record<string, unknown>>;
			reasoning_effort?: unknown;
			tool_choice?: unknown;
		};
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant?.reasoning_content).toBe("Plan first, then call the tool.");
		expect(payload.reasoning_effort).toBe("high");
		expect(payload.tool_choice).toBe("auto");
	});
});

describe("NVIDIA NIM DeepSeek special-token stripping", () => {
	function nvidiaDeepseekModel(): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			id: "deepseek-ai/deepseek-v4-flash",
			reasoning: true,
			compat: { stripDeepseekSpecialTokens: true },
		} as ModelSpec<"openai-completions">);
	}

	it("strips leaked <\uff5cDSML\uff5c...\uff5c> markers from visible content", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Sure thing.<\uff5cDSML\uff5ctool_calls\uff5c>I'll help." },
					},
				],
			},
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Sure thing.I'll help.");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("\uff5c");
	});

	it("holds back partial token split across chunks", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "Hello <\uff5ctool_calls" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "_begin\uff5c>world" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Hello world");
	});

	it("flushes a dangling partial open delimiter at end of stream", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "trailing <\uff5c" } }],
			},
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		// At end-of-stream we have no way to know whether the partial is a real token,
		// so we emit it verbatim rather than swallow legitimate text forever.
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("trailing <\uff5c");
	});

	it("leaves visible content alone for non-deepseek nvidia models", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			id: "meta/llama-3.3-70b-instruct",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "keep <\uff5cas-is\uff5c> please" } }],
			},
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("keep <\uff5cas-is\uff5c> please");
	});
});

describe("anthropic cache control for OpenAI-compatible chat completions", () => {
	function claudeProxyModel(compat?: OpenAICompat): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			id: "claude-opus-4-8",
			compat,
		} as ModelSpec<"openai-completions">);
	}

	function cacheContext(): Context {
		return { messages: [{ role: "user", content: "cache me", timestamp: 0 }] };
	}

	it("injects Anthropic cache_control when compat requests Anthropic cache markers", async () => {
		const payload = await captureOpenAICompletionsPayload(
			claudeProxyModel({ cacheControlFormat: "anthropic" }),
			cacheContext(),
		);
		const content = getLastPayloadContent(payload);
		const textPart = getLastTextPart(content);

		expect(textPart?.text).toBe("cache me");
		expect(textPart?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("anchors Anthropic cache_control on the trailing tool result during a tool loop", async () => {
		const model = claudeProxyModel({ cacheControlFormat: "anthropic" });
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read",
					name: "read",
					arguments: { path: "screenshot.png" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "Read image file [image/webp]" }],
			isError: false,
			timestamp: 2,
		};
		const payload = await captureOpenAICompletionsPayload(model, {
			messages: [{ role: "user", content: "cache me", timestamp: 0 }, assistantMessage, toolResultMessage],
		});
		const messages = getPayloadMessages(payload);
		const [user, assistant, tool] = messages;

		// Empty tool-call replay content must stay a string: an empty text part
		// with cache_control is rejected by Anthropic/OpenRouter.
		expect(assistant?.content).toBe("");
		expect(getLastTextPart(user?.content)?.cache_control).toBeUndefined();
		expect(tool?.role).toBe("tool");
		expect(tool?.content).toEqual([
			{ type: "text", text: "Read image file [image/webp]", cache_control: { type: "ephemeral" } },
		]);
	});

	it("does not infer Anthropic cache_control for custom Claude ids without compat", async () => {
		const payload = await captureOpenAICompletionsPayload(claudeProxyModel(), cacheContext());

		expect(getLastPayloadContent(payload)).toBe("cache me");
	});
});
