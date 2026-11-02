import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-striped-pi/pi-ai";
import { streamSimple } from "@oh-my-striped-pi/pi-ai/stream";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-striped-pi/pi-catalog/types";

interface CapturedPayload {
	reasoning?: { effort?: string; enabled?: boolean };
	reasoning_effort?: string;
}

type RouteApi = "openai-completions" | "openai-responses";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const fixture = {
	id: "gpt-5.1",
	name: "gpt-5.1",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	compat: { supportsReasoningParams: true, reasoningDisableMode: "omit" },
	thinking: {
		mode: "effort",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
} satisfies Omit<ModelSpec<"openai-completions">, "api">;

async function capturePayload<TApi extends RouteApi>(
	model: Model<TApi>,
	options: SimpleStreamOptions,
): Promise<CapturedPayload> {
	let captured: CapturedPayload | undefined;
	const fetchMock: FetchImpl = async () =>
		new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });

	await streamSimple(model, context, {
		...options,
		apiKey: "test-key",
		fetch: fetchMock,
		onPayload: payload => {
			captured = payload as CapturedPayload;
		},
	}).result();

	if (!captured) throw new Error("request payload was not captured");
	return captured;
}

const chatCompletions = buildModel<"openai-completions">({ ...fixture, api: "openai-completions" });
const responses = buildModel<"openai-responses">({ ...fixture, api: "openai-responses" });

describe("OpenAI route reasoning disablement", () => {
	it("drops reasoning effort on a forced-off chat-completions request", async () => {
		const active = await capturePayload(chatCompletions, { reasoning: Effort.Medium });
		expect(active.reasoning_effort).toBe(Effort.Medium);

		// `OpenAICompletionsOptions` has no forceReasoningOff field, so the mapping
		// folds it into disableReasoning — otherwise a forced-off side turn still
		// pays for reasoning.
		const forcedOff = await capturePayload(chatCompletions, { reasoning: Effort.Medium, forceReasoningOff: true });
		expect(forcedOff.reasoning_effort).toBeUndefined();
	});

	it("sends effort none for a forced-off Copilot Responses request", async () => {
		const active = await capturePayload(responses, { reasoning: Effort.Medium });
		expect(active.reasoning?.effort).toBe(Effort.Medium);

		const forcedOff = await capturePayload(responses, { reasoning: Effort.Medium, forceReasoningOff: true });
		expect(forcedOff.reasoning).toEqual({ effort: "none" });
	});
});
