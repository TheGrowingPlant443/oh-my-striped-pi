import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";

const modelSpec = {
	provider: "company",
	id: "company-model",
	name: "Company model",
	api: "openai-completions",
	baseUrl: "https://inference.company.example/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 512,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-completions">;
const model = buildModel(modelSpec);

describe("configured deep-import wire clients", () => {
	it("streams generic company completions without sending a fake key", async () => {
		let url: string | undefined;
		let authorization: string | null | undefined;
		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				fetch: async (input, init) => {
					url = String(input);
					authorization = new Headers(init?.headers).get("Authorization");
					return new Response(
						`data: ${JSON.stringify({
							id: "company-response",
							choices: [
								{ index: 0, delta: { role: "assistant", content: "company answer" }, finish_reason: "stop" },
							],
							usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
						})}\n\ndata: [DONE]\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				},
			},
		).result();
		expect(url).toBe("https://inference.company.example/v1/chat/completions");
		expect(authorization).toBeNull();
		expect(result.provider).toBe("company");
		expect(result.content).toEqual([{ type: "text", text: "company answer" }]);
	});

	it("heals leaked reasoning from a configured server's visible channel", async () => {
		const result = await streamOpenAICompletions(
			model,
			{ messages: [] },
			{
				fetch: async () =>
					new Response(
						`data: ${JSON.stringify({
							id: "reasoning-response",
							choices: [
								{
									index: 0,
									delta: { content: "<think>private reasoning</think>company answer" },
									finish_reason: "stop",
								},
							],
							usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
						})}\n\ndata: [DONE]\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					),
			},
		).result();
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "thinking", thinking: "private reasoning" }),
		);
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "company answer" }));
	});

	it("preserves explicit company authentication headers", () => {
		const setup = resolveOpenAIRequestSetup(
			{ ...model, headers: { Authorization: "Company private-token" } },
			{
				apiKey: "N/A",
				messages: [],
			},
		);
		expect(setup.headers.Authorization).toBe("Company private-token");
	});

	it("does not send stored optional-login markers to a self-hosted server", () => {
		const setup = resolveOpenAIRequestSetup(
			{ ...model, provider: "lm-studio" },
			{
				apiKey: "lm-studio-local",
				messages: [],
			},
		);
		expect(setup.headers.Authorization).toBeUndefined();
	});

	it("requires explicit Anthropic-compatible endpoints before building a client", () => {
		const anthropic = buildModel<"anthropic-messages">({ ...modelSpec, api: "anthropic-messages", baseUrl: "" });
		let fetchCalls = 0;
		expect(() =>
			buildAnthropicClientOptions({
				model: anthropic,
				apiKey: "N/A",
				fetch: async () => {
					fetchCalls++;
					throw new Error("missing endpoint must not fetch");
				},
			}),
		).toThrow("requires a base URL");
		expect(fetchCalls).toBe(0);
	});

	it("sends requests to configured Anthropic-compatible company endpoints", async () => {
		const anthropic = buildModel<"anthropic-messages">({ ...modelSpec, api: "anthropic-messages" });
		let url: string | undefined;
		let request: RequestInit | undefined;
		let headers: Headers | undefined;
		const client = new AnthropicMessagesClient(
			buildAnthropicClientOptions({
				model: anthropic,
				apiKey: "N/A",
				fetch: async (input, init) => {
					url = String(input);
					request = init;
					headers = new Headers(init?.headers);
					return new Response(null, { status: 204 });
				},
			}),
		);
		const response = await client.messages
			.create({
				model: anthropic.id,
				max_tokens: 1,
				messages: [{ role: "user", content: "hi" }],
			})
			.asResponse();
		expect(response.status).toBe(204);
		expect(url).toBe("https://inference.company.example/v1/messages");
		expect(request?.method).toBe("POST");
		expect(request?.body).toBe(
			JSON.stringify({
				model: anthropic.id,
				max_tokens: 1,
				messages: [{ role: "user", content: "hi" }],
			}),
		);
		expect(headers?.get("Authorization")).toBeNull();
		expect(headers?.get("x-api-key")).toBeNull();
	});
});
