import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { type Context, type Model, OPENAI_MAX_OUTPUT_TOKENS } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Generic output-cap policy is exercised with explicit compatibility flags, not removed vendor catalog rows.

const ctx: Context = {
	systemPrompt: ["hi"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

afterEach(() => {
	vi.restoreAllMocks();
});

function captureResponsesBody(): { fetchMock: FetchImpl; captured: Record<string, unknown> } {
	const captured: Record<string, unknown> = {};
	const fetchMock: FetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		Object.assign(captured, body);
		const event = {
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		};
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	return { fetchMock, captured };
}

async function drainResponses(model: Model<"openai-responses">, maxTokens?: number): Promise<Record<string, unknown>> {
	const { fetchMock, captured } = captureResponsesBody();
	const stream = streamSimple(model, ctx, {
		apiKey: "test-key",
		...(maxTokens === undefined ? {} : { maxTokens }),
		fetch: fetchMock,
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

function completionsSse(): Response {
	const events: unknown[] = [
		{
			id: "c",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "c",
			object: "chat.completion.chunk",
			created: 0,
			model: "m",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureCompletionsBody(
	model: Model<"openai-completions">,
	maxTokens?: number,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return completionsSse();
	};

	const result = await streamSimple(model, ctx, {
		apiKey: "k",
		...(maxTokens === undefined ? {} : { maxTokens }),
		fetch: fetchMock,
	}).result();
	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected OpenAI completions request payload");
	return payload;
}

function completionsModel(
	maxTokens: number | null,
	clampOutputToModelMax = false,
	alwaysSendMaxTokens = true,
): Model<"openai-completions"> {
	return buildModel({
		id: "output-cap-fixture",
		name: "Output Cap Fixture",
		api: "openai-completions",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens,
		compat: { clampOutputToModelMax, alwaysSendMaxTokens, maxTokensField: "max_tokens" },
	});
}

function responsesModel(
	maxTokens: number | null,
	clampOutputToModelMax = false,
	alwaysSendMaxTokens = true,
): Model<"openai-responses"> {
	return buildModel({
		id: "output-cap-fixture",
		name: "Output Cap Fixture",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens,
		compat: { clampOutputToModelMax, alwaysSendMaxTokens },
	});
}

describe("OpenAI-family output-token cap", () => {
	it("clamps responses default output to the 64k ceiling", async () => {
		const body = await drainResponses(responsesModel(200_000));
		expect(body.max_output_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});

	it("honors an explicit model-cap override for responses", async () => {
		const body = await drainResponses(responsesModel(131_072, true), 131_072);
		expect(body.max_output_tokens).toBe(131_072);
	});

	it("honors an explicit model-cap override for completions", async () => {
		const body = await captureCompletionsBody(completionsModel(384_000, true), 384_000);
		expect(body.max_tokens).toBe(384_000);
	});

	it("clamps completions requested output to the 64k ceiling", async () => {
		const body = await captureCompletionsBody(completionsModel(131_072), 131_072);
		expect(body.max_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});

	it("never raises a requested output below the ceiling", async () => {
		const body = await captureCompletionsBody(completionsModel(131_072), 8_000);
		expect(body.max_tokens).toBe(8_000);
	});

	it("respects a model cap below the requested output", async () => {
		const body = await captureCompletionsBody(completionsModel(32_000), 131_072);
		expect(body.max_tokens).toBe(32_000);
	});

	it("sends explicit caller caps even when the endpoint does not require them", async () => {
		const completions = await captureCompletionsBody(completionsModel(131_072, false, false), 2_048);
		const responses = await drainResponses(responsesModel(131_072, false, false), 2_048);
		expect(completions.max_tokens).toBe(2_048);
		expect(responses.max_output_tokens).toBe(2_048);
	});

	it("keeps the 64k fallback when model-cap override has no model cap", async () => {
		const completions = await captureCompletionsBody(completionsModel(null, true), 100_000);
		const responses = await drainResponses(responsesModel(null, true), 100_000);
		expect(completions.max_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
		expect(responses.max_output_tokens).toBe(OPENAI_MAX_OUTPUT_TOKENS);
	});
});
