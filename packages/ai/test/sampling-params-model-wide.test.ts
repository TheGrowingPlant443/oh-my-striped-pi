import { afterEach, describe, expect, test } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-striped-pi/pi-ai/api-registry";
import { stream, streamSimple } from "@oh-my-striped-pi/pi-ai/stream";
import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-striped-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-striped-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { type GeneratedProvider, getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";

// Sampling support follows model lineage on both retained providers.

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function bundled<TApi extends Api>(provider: GeneratedProvider, id: string): Model<TApi> {
	const model = getBundledModel<TApi>(provider, id);
	if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
	return model;
}

const emptyResponse = async () => new Response(new Uint8Array(), { status: 200 });

/** The body as sent: providers may build `temperature: undefined`, which serialization drops. */
const wire = (payload: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(payload));

function simplePayload(model: Model<Api>): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	void streamSimple(model, context, {
		apiKey: "test-key",
		maxTokens: 16,
		temperature: 0,
		topP: 0.9,
		frequencyPenalty: 1,
		fetch: emptyResponse,
		onPayload: payload => resolve(wire(payload)),
	});
	return promise;
}

afterEach(() => {
	clearCustomApis();
});

describe("sampling params are gated by model on retained providers", () => {
	test.each(["gpt-6-luna", "claude-opus-5.5"])("Copilot %s omits sampling params", async id => {
		const payload = await simplePayload(bundled("github-copilot", id));
		expect(payload).not.toHaveProperty("temperature");
		expect(payload).not.toHaveProperty("top_p");
	});

	test("Copilot GPT-4o still sends temperature", async () => {
		const payload = await simplePayload(bundled("github-copilot", "gpt-4o"));
		expect(payload.temperature).toBe(0);
	});

	test("the local inference adapter receives no unsupported sampling options", () => {
		let received: SimpleStreamOptions | undefined;
		registerCustomApi("local-inference", (_model, _context, options) => {
			received = options;
			return new AssistantMessageEventStream();
		});
		const model: Model<Api> = {
			...bundled("github-copilot", "gpt-6-luna"),
			api: "local-inference",
			provider: "local",
		};
		void streamSimple(model, context, {
			temperature: 0,
			topP: 0.9,
			frequencyPenalty: 1,
			presencePenalty: 1,
		});
		expect(received).toBeDefined();
		expect(received).not.toHaveProperty("temperature");
		expect(received).not.toHaveProperty("topP");
		expect(received).not.toHaveProperty("frequencyPenalty");
		expect(received).not.toHaveProperty("presencePenalty");
	});

	test("an explicit compat override re-enables sampling for a custom endpoint", async () => {
		const model = buildModel({
			id: "gpt-5",
			name: "gpt-5",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			compat: { supportsSamplingParams: true },
		});
		const payload = await simplePayload(model);
		expect(payload.temperature).toBe(0);
	});

	test("the non-simple stream() entry applies the same gate", async () => {
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		void stream(bundled<"openai-responses">("github-copilot", "gpt-6-luna"), context, {
			apiKey: "test-key",
			maxTokens: 16,
			temperature: 0,
			fetch: emptyResponse,
			onPayload: payload => resolve(wire(payload)),
		});
		expect(await promise).not.toHaveProperty("temperature");
	});
});
