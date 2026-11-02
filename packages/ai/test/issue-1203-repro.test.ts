import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-striped-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-striped-pi/pi-ai/types";
import { copilotCompletionsModel } from "./helpers";

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
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

function stopChunk(model: Model<"openai-completions">): unknown {
	return {
		id: "chatcmpl-minimax-cn",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
}

describe("issue #1203 — cumulative reasoning deltas", () => {
	it("dedupes cumulative reasoning snapshots after answer text has started", async () => {
		const base = copilotCompletionsModel("gpt-4o");
		const model: Model<"openai-completions"> = {
			...base,
			compat: { ...base.compat, reasoningDeltasMayBeCumulative: true },
		};
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							reasoning_content: "The user just",
						},
					},
				],
			},
			{
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							content: "Hello!",
							reasoning_content: "The user just said hi.",
						},
					},
				],
			},
			{
				// Visible text continues, yet the host keeps echoing the same
				// cumulative reasoning snapshot. currentBlock is now "text", so the
				// old (block-scoped) dedup would re-emit the entire snapshot as a
				// second thinking block.
				id: "chatcmpl-minimax-cn",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							content: " How can I help?",
							reasoning_content: "The user just said hi.",
						},
					},
				],
			},
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{
				type: "thinking",
				thinking: "The user just said hi.",
				thinkingSignature: "reasoning_content",
				summary: false,
			},
			{ type: "text", text: "Hello! How can I help?" },
		]);
	});
});
