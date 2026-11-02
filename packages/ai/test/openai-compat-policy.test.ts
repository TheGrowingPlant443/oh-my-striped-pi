import { describe, expect, it } from "bun:test";
import type { ResponseCreateParamsStreaming } from "@oh-my-striped-pi/pi-ai/providers/openai-responses-wire";
import {
	applyChatCompletionsCompatPolicy,
	applyResponsesCompatPolicy,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "@oh-my-striped-pi/pi-ai/providers/openai-shared";
import type { Model, ModelSpec, OpenAICompat } from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { Effort } from "@oh-my-striped-pi/pi-catalog/effort";

function chatModel(compat: OpenAICompat): Model<"openai-completions"> {
	return buildModel({
		id: "compat-reasoner",
		name: "Compat Reasoner",
		api: "openai-completions",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	} satisfies ModelSpec<"openai-completions">);
}

function responsesModel(compat: OpenAICompat): Model<"openai-responses"> {
	return buildModel({
		id: "compat-reasoner",
		name: "Compat Reasoner",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	} satisfies ModelSpec<"openai-responses">);
}

function chatParams(): OpenAICompletionsParams {
	return { model: "compat-reasoner", messages: [], stream: true };
}

function responsesParams(): ResponseCreateParamsStreaming {
	return { model: "compat-reasoner", input: [], stream: true };
}

describe("OpenAI compat policy", () => {
	it("suppresses reasoning on forced tool choice for both endpoints", () => {
		const compat: OpenAICompat = {
			disableReasoningOnForcedToolChoice: true,
		};
		const toolChoice = { type: "function", name: "search" };
		const chatPolicy = resolveOpenAICompatPolicy(chatModel(compat), {
			endpoint: "chat-completions",
			reasoning: Effort.High,
			toolChoice,
		});
		const responsesPolicy = resolveOpenAICompatPolicy(responsesModel(compat), {
			endpoint: "responses",
			reasoning: Effort.High,
			toolChoice,
		});

		expect(chatPolicy.reasoning.enabled).toBe(false);
		expect(responsesPolicy.reasoning.enabled).toBe(false);
		expect(chatPolicy.reasoning.disableReason).toBe("forced-tool-choice");
		expect(responsesPolicy.reasoning.disableReason).toBe("forced-tool-choice");
	});

	it("omits effort for both wire adapters from one catalog flag", () => {
		const compat: OpenAICompat = { omitReasoningEffort: true };
		const chatBody = chatParams();
		const responseBody = responsesParams();

		applyChatCompletionsCompatPolicy(
			chatBody,
			resolveOpenAICompatPolicy(chatModel(compat), { endpoint: "chat-completions", reasoning: Effort.High }),
		);
		applyResponsesCompatPolicy(
			responseBody,
			resolveOpenAICompatPolicy(responsesModel(compat), { endpoint: "responses", reasoning: Effort.High }),
			undefined,
		);

		expect(chatBody.reasoning_effort).toBeUndefined();
		expect(responseBody.reasoning).toBeUndefined();
	});

	it("leaves Responses input unchanged when reasoning is not requested", () => {
		const responseBody = responsesParams();

		applyResponsesCompatPolicy(
			responseBody,
			resolveOpenAICompatPolicy(responsesModel({}), { endpoint: "responses" }),
			undefined,
		);

		expect(responseBody.reasoning).toBeUndefined();
		expect(responseBody.input).toEqual([]);
	});
});
