import { describe, expect, it } from "bun:test";
import {
	type ResolveOpenAIOutputTokenInput,
	resolveOpenAIOutputTokenParam,
} from "@oh-my-striped-pi/pi-ai/providers/openai-shared";

const OPENAI_MAX_OUTPUT_TOKENS = 64_000;

function tokenInput(overrides: Partial<ResolveOpenAIOutputTokenInput> = {}): ResolveOpenAIOutputTokenInput {
	return {
		field: "max_completion_tokens",
		maxTokens: undefined,
		modelMaxTokens: 131_072,
		omitMaxOutputTokens: false,
		alwaysSendMaxTokens: false,
		...overrides,
	};
}

describe("resolveOpenAIOutputTokenParam", () => {
	it("returns the requested cap clamped to the provider ceiling", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: 200_000 }))).toEqual({
			field: "max_completion_tokens",
			value: OPENAI_MAX_OUTPUT_TOKENS,
		});
	});

	it("clamps to the model cap when it is below the provider ceiling", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: 50_000, modelMaxTokens: 32_000 }))).toEqual({
			field: "max_completion_tokens",
			value: 32_000,
		});
	});

	it("honors a raised provider clamp (GLM-5.2 reasoning) above the default ceiling", () => {
		expect(
			resolveOpenAIOutputTokenParam(
				tokenInput({ maxTokens: 120_000, modelMaxTokens: 131_072, providerOutputClamp: 131_072 }),
			),
		).toEqual({ field: "max_completion_tokens", value: 120_000 });
	});

	it("selects the wire field name the endpoint requested", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ field: "max_tokens", maxTokens: 1024 }))?.field).toBe(
			"max_tokens",
		);
		expect(resolveOpenAIOutputTokenParam(tokenInput({ field: "max_output_tokens", maxTokens: 1024 }))?.field).toBe(
			"max_output_tokens",
		);
	});

	it("returns undefined when no cap was requested and the endpoint does not require one", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: undefined }))).toBeUndefined();
	});

	it("defaults from the model cap when alwaysSendMaxTokens and the caller omitted one", () => {
		// Kimi-family TPM math: clamp(model cap, provider ceiling).
		expect(resolveOpenAIOutputTokenParam(tokenInput({ alwaysSendMaxTokens: true, maxTokens: undefined }))).toEqual({
			field: "max_completion_tokens",
			value: OPENAI_MAX_OUTPUT_TOKENS,
		});
	});

	it("falls back to the provider ceiling when alwaysSendMaxTokens and no model cap exists", () => {
		expect(
			resolveOpenAIOutputTokenParam(
				tokenInput({ alwaysSendMaxTokens: true, maxTokens: undefined, modelMaxTokens: undefined }),
			),
		).toEqual({ field: "max_completion_tokens", value: OPENAI_MAX_OUTPUT_TOKENS });
	});

	it("drops the field entirely when omitMaxOutputTokens is set", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: 4096, omitMaxOutputTokens: true }))).toBeUndefined();
	});

	it("treats a null caller cap like an omitted one", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: null }))).toBeUndefined();
	});
});
