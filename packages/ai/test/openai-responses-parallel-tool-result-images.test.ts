import { describe, expect, it } from "bun:test";
import type { ResponseInput } from "@oh-my-striped-pi/pi-ai/providers/openai-responses-wire";
import { buildResponsesInput } from "@oh-my-striped-pi/pi-ai/providers/openai-shared";
import type { Context, Model } from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";

const genericModel = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeContext(model: Model): Context {
	return {
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_read_36", name: "read", arguments: { path: "a.png" } },
					{ type: "toolCall", id: "call_read_37", name: "read", arguments: { path: "b.png" } },
					{ type: "toolCall", id: "call_bash_38", name: "bash", arguments: { command: "true" } },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call_read_36",
				toolName: "read",
				content: [
					{ type: "text", text: "first" },
					{ type: "image", mimeType: "image/png", data: "AAAA" },
				],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_read_37",
				toolName: "read",
				content: [
					{ type: "text", text: "second" },
					{ type: "image", mimeType: "image/png", data: "BBBB" },
				],
				isError: false,
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "call_bash_38",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 4,
			},
			{ role: "user", content: "continue", timestamp: 5 },
		],
	};
}

function expectOrderedToolResults(items: ResponseInput): void {
	expect(items.slice(0, 3).map(item => ("call_id" in item ? item.call_id : undefined))).toEqual([
		"call_read_36",
		"call_read_37",
		"call_bash_38",
	]);
	expect(items.slice(3)).toEqual([
		{
			type: "function_call_output",
			call_id: "call_read_36",
			output: [
				{ type: "input_text", text: "first" },
				{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
			],
		},
		{
			type: "function_call_output",
			call_id: "call_read_37",
			output: [
				{ type: "input_text", text: "second" },
				{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,BBBB" },
			],
		},
		{ type: "function_call_output", call_id: "call_bash_38", output: "done" },
		{ role: "user", content: [{ type: "input_text", text: "continue" }] },
	]);
}

describe("parallel Responses tool-result images", () => {
	it("encodes generic Responses images inside their tool outputs", () => {
		const items = buildResponsesInput({
			model: genericModel,
			context: makeContext(genericModel),
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});

		expectOrderedToolResults(items);
	});
});
