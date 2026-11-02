import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { completeSimple, stream, streamSimple, type Api, type Model } from "../src";
import { resolveOpenAIRequestSetup } from "../src/providers/openai-shared";

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
const model = buildModel({
	id: "company-model",
	name: "Company model",
	provider: "company",
	api: "openai-completions",
	baseUrl: "https://inference.company.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 512,
});

describe("configured provider execution", () => {
	test("rejects unknown APIs before resolving headers or credentials", () => {
		let effects = 0;
		const invalid = {
			...model,
			api: "misspelled-api",
			resolveHeaders: async () => {
				effects++;
				return {};
			},
		} as Model<Api>;
		expect(() => stream(invalid, context)).toThrow("Unhandled API");
		expect(() =>
			streamSimple(invalid, context, {
				apiKey: async () => {
					effects++;
					return "secret";
				},
			}),
		).toThrow("Unhandled API");
		expect(effects).toBe(0);
	});

	test("keeps built-in Copilot and local identities on their actual transports", () => {
		expect(() =>
			streamSimple({ ...model, provider: "github-copilot", api: "ollama-chat" } as Model<Api>, context),
		).toThrow("Unsupported API");
		expect(() => streamSimple({ ...model, provider: "local" }, context)).toThrow("Unsupported API");
	});

	test("requires an explicit generic endpoint before credential resolution", () => {
		let effects = 0;
		const missingEndpoint = { ...model, baseUrl: "" };
		expect(() =>
			streamSimple(missingEndpoint, context, {
				apiKey: async () => {
					effects++;
					return "secret";
				},
			}),
		).toThrow("requires an explicit base URL");
		expect(() => resolveOpenAIRequestSetup(missingEndpoint, { messages: context.messages })).toThrow(
			"explicit base URL",
		);
		expect(effects).toBe(0);
	});

	test("does not borrow global OpenAI credentials for a keyless company endpoint", () => {
		const previous = Bun.env.OPENAI_API_KEY;
		Bun.env.OPENAI_API_KEY = "must-not-forward";
		try {
			const setup = resolveOpenAIRequestSetup(model, { messages: context.messages });
			expect(setup.baseUrl).toBe(model.baseUrl);
			expect(setup.headers.Authorization).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previous;
		}
	});

	test("streams a configured keyless company endpoint without changing provider identity", async () => {
		let authorization: string | null | undefined;
		const result = await completeSimple(model, context, {
			apiKey: "N/A",
			fetch: async (_url, init) => {
				authorization = new Headers(init?.headers).get("Authorization");
				return new Response(
					`data: ${JSON.stringify({
						choices: [{ index: 0, delta: { content: "company answer" }, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})}\n\ndata: [DONE]\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		expect(authorization).toBeNull();
		expect(result.provider).toBe("company");
		expect(result.api).toBe("openai-completions");
		expect(result.content).toEqual([{ type: "text", text: "company answer" }]);
	});

	test("streams native Ollama without a key and preserves the configured endpoint", async () => {
		let requestUrl: string | undefined;
		let authorization: string | null | undefined;
		const ollama = buildModel({
			...model,
			provider: "ollama",
			api: "ollama-chat",
			baseUrl: "http://127.0.0.1:11434",
		});
		const response = await completeSimple(ollama, context, {
			fetch: async (url, init) => {
				requestUrl = String(url);
				authorization = new Headers(init?.headers).get("Authorization");
				return new Response('{"message":{"content":"local answer"},"done":true,"done_reason":"stop"}\n');
			},
		});
		expect(requestUrl).toBe("http://127.0.0.1:11434/api/chat");
		expect(authorization).toBeNull();
		expect(response.provider).toBe("ollama");
		expect(response.api).toBe("ollama-chat");
		expect(response.content).toEqual([{ type: "text", text: "local answer" }]);
	});
});
