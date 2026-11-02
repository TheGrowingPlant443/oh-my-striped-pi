import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { resolvePromptCacheLookback } from "@oh-my-striped-pi/pi-catalog/compat/prompt-cache-lookback";

const base = {
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("prompt-cache-lookback", () => {
	test("Claude carries its 20-position lookback on every host; other lines have no bound", () => {
		const copilot = buildModel({
			...base,
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
		});
		const namespaced = buildModel({
			...base,
			id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://custom.example/v1",
		});
		const gpt = buildModel({
			...base,
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});

		expect(resolvePromptCacheLookback(copilot)).toBe(20);
		expect(resolvePromptCacheLookback(namespaced)).toBe(20);
		expect(resolvePromptCacheLookback(gpt)).toBeUndefined();
	});
});
