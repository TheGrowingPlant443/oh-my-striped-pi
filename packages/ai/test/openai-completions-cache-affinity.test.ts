import { describe, expect, it } from "bun:test";
import {
	type OpenAICompletionsOptions,
	streamOpenAICompletions,
} from "@oh-my-striped-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-striped-pi/pi-ai/stream";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

const bundledModel = getBundledModel<"openai-completions">("github-copilot", "gpt-4o");
const cacheModel = buildModel({
	...bundledModel,
	api: "openai-completions",
	compat: {
		...bundledModel.compatConfig,
		supportsPromptCacheBreakpoints: true,
		promptCacheBreakpointTtl: "30m",
	},
});

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function chatCompletionsSse(): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "chatcmpl-affinity",
			object: "chat.completion.chunk",
			created: 0,
			model: cacheModel.id,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});

	return new Response(
		`data: ${chunk({ role: "assistant", content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function captureRequest(
	options: OpenAICompletionsOptions,
	requestModel: Model<"openai-completions"> = cacheModel,
	requestContext: Context = context,
): Promise<{ headers: Headers; body: Record<string, unknown> }> {
	let requestHeaders: Headers | undefined;
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(input instanceof URL ? input.href : input, init);
		requestHeaders = request.headers;
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		return chatCompletionsSse();
	};

	await streamOpenAICompletions(requestModel, requestContext, {
		apiKey: "test-key",
		...options,
		fetch: fetchMock,
	}).result();

	if (!requestHeaders || !body) throw new Error("Expected a serialized Chat Completions request");
	return { headers: requestHeaders, body };
}

async function captureSimpleRequest(
	options: SimpleStreamOptions,
	requestModel: Model<"openai-completions"> = cacheModel,
	requestContext: Context = context,
): Promise<{ headers: Headers; body: Record<string, unknown> }> {
	let requestHeaders: Headers | undefined;
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(input instanceof URL ? input.href : input, init);
		requestHeaders = request.headers;
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		return chatCompletionsSse();
	};

	await streamSimple(requestModel, requestContext, { apiKey: "test-key", ...options, fetch: fetchMock }).result();

	if (!requestHeaders || !body) throw new Error("Expected a serialized Chat Completions request");
	return { headers: requestHeaders, body };
}

describe("OpenAI Chat Completions explicit prompt cache policy", () => {
	const historicalContext: Context = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "stable history" }], timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "current prompt" }], timestamp: 1 },
		],
	};

	it("leaves the wire shape unchanged when the policy is unset", async () => {
		const { body } = await captureRequest({ sessionId: "cache-key" }, cacheModel, historicalContext);

		expect(body).not.toHaveProperty("prompt_cache_options");
		expect(body).not.toHaveProperty("prompt_cache_key");
	});

	it("routes explicit policy through streamSimple and marks existing text-only history", async () => {
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "openai-completions",
			provider: "github-copilot",
			model: cacheModel.id,
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
		};
		const textOnlyHistory: Context = {
			messages: [
				{ role: "user", content: "stable history", timestamp: 0 },
				previousAssistant,
				{ role: "user", content: "current prompt", timestamp: 2 },
			],
		};
		const { body } = await captureSimpleRequest(
			{ sessionId: "cache-key", promptCache: { mode: "explicit" } },
			cacheModel,
			textOnlyHistory,
		);

		expect(body.prompt_cache_key).toBe("cache-key");
		expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		const messages = body.messages;
		if (!Array.isArray(messages)) throw new Error("Expected Chat Completions messages");
		expect(messages).toHaveLength(3);
		expect(messages[0]).toMatchObject({
			content: [{ type: "text", text: "stable history", prompt_cache_breakpoint: { mode: "explicit" } }],
		});
		expect(messages[1]).toMatchObject({ content: "previous answer" });
		expect(messages[2]).toMatchObject({ content: "current prompt" });
	});

	it("leaves boundary selection automatic in implicit mode", async () => {
		const { body } = await captureRequest(
			{ sessionId: "cache-key", promptCache: { mode: "implicit" } },
			cacheModel,
			historicalContext,
		);

		expect(body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(JSON.stringify(body.messages)).not.toContain("prompt_cache_breakpoint");
	});

	it("rejects the Responses-only 12h lifetime before sending a request", async () => {
		let sent = false;
		const fetchMock: FetchImpl = async () => {
			sent = true;
			return chatCompletionsSse();
		};
		const result = await streamOpenAICompletions(cacheModel, context, {
			apiKey: "test-key",
			promptCache: { mode: "implicit", ttl: "12h" },
			fetch: fetchMock,
		}).result();

		expect(sent).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("12h prompt caching is only available on the Responses API");
	});

	it("does not synthesize first-turn content or a caller-disabled breakpoint", async () => {
		const firstTurn: Context = {
			messages: [{ role: "user", content: "only prompt", timestamp: 0 }],
		};
		const first = await captureRequest({ promptCache: { mode: "explicit" } }, cacheModel, firstTurn);
		const none = await captureRequest(
			{ promptCache: { mode: "explicit", breakpoint: "none" } },
			cacheModel,
			historicalContext,
		);

		for (const body of [first.body, none.body]) {
			const messages = body.messages;
			if (!Array.isArray(messages)) throw new Error("Expected Chat Completions messages");
			for (const message of messages) {
				expect(message).not.toMatchObject({ content: [{ prompt_cache_breakpoint: { mode: "explicit" } }] });
			}
		}
	});
});
