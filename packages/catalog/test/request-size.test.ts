import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	resolveImageCountBudget,
	resolveInlineImageByteBudget,
	resolveRequestBodyByteLimit,
} from "@oh-my-pi/pi-catalog/compat/request-size";

function imageModel(imageCountBudget?: number) {
	return buildModel({
		id: "gpt-5.5",
		name: "GPT",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 64000,
		imageCountBudget,
	});
}

describe("request size budgets", () => {
	test("explicit image limits override the deployment policy", () => {
		expect(resolveImageCountBudget(imageModel(7))).toBe(7);
	});

	test("a model without a documented host budget stays unbounded", () => {
		const model = imageModel();
		expect(resolveImageCountBudget(model)).toBeUndefined();
		expect(resolveInlineImageByteBudget(model)).toBeUndefined();
		expect(resolveRequestBodyByteLimit(model)).toBeUndefined();
	});
});
