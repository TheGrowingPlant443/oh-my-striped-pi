import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function customModel(compat?: ModelSpec<"openai-completions">["compat"]): Model<"openai-completions"> {
	return buildModel({
		id: "hy4-preview",
		name: "HY4 Preview",
		provider: "github-copilot",
		baseUrl: "https://example.com/v1",
		api: "openai-completions",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 8_192,
		compat,
	});
}

function context(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
}

function createFetch(capture: (body: Record<string, unknown>) => void): FetchImpl {
	async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (typeof init?.body === "string") capture(JSON.parse(init.body) as Record<string, unknown>);
		const payload = [
			`data: ${JSON.stringify({
				id: "chatcmpl-12562",
				object: "chat.completion.chunk",
				created: 0,
				model: "hy4-preview",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-12562",
				object: "chat.completion.chunk",
				created: 0,
				model: "hy4-preview",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}`,
			"data: [DONE]",
		].join("\n\n");
		return new Response(`${payload}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

describe("Copilot OpenAI-completions compatibility (#12562)", () => {
	it("streams through the retained completions wire with declared overrides", async () => {
		const model = customModel({
			maxTokensField: "max_tokens",
			supportsSamplingParams: false,
		});

		let request: Record<string, unknown> | undefined;
		const result = await streamSimple(model, context(), {
			apiKey: "test-key",
			fetch: createFetch(body => {
				request = body;
			}),
			temperature: 0.7,
			maxTokens: 321,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(request?.max_tokens).toBe(321);
		expect(request?.max_completion_tokens).toBeUndefined();
		expect(request?.temperature).toBeUndefined();
	});
});
