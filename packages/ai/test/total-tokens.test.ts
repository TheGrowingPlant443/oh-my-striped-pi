/**
 * Test totalTokens across Copilot wire formats.
 *
 * totalTokens represents the total number of tokens processed by the LLM,
 * including input (with cache) and output (with thinking). This is the
 * base for calculating context size for the next request.
 *
 * - OpenAI Completions: Uses native total_tokens field
 * - OpenAI Responses: Uses native total_tokens field
 * - Anthropic: Computed as input + output + cacheRead + cacheWrite
 * - OpenAI-compatible models: Uses native total_tokens field
 */

import { describe, expect, it } from "bun:test";
import { complete } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi, Usage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveApiKey } from "./oauth";

const githubCopilotToken = await resolveApiKey("github-copilot");

// Generate a long system prompt to trigger caching (>2k bytes for most providers)
const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

async function testTotalTokensWithCache<TApi extends Api>(
	llm: Model<TApi>,
	options: OptionsForApi<TApi> = {} as OptionsForApi<TApi>,
): Promise<{ first: Usage; second: Usage }> {
	// First request - no cache
	const context1: Context = {
		systemPrompt: [LONG_SYSTEM_PROMPT],
		messages: [
			{
				role: "user",
				content: "What is 2 + 2? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response1 = await complete(llm, context1, options);
	expect(response1.stopReason).toBe("stop");

	// Second request - should trigger cache read (same system prompt, add conversation)
	const context2: Context = {
		systemPrompt: [LONG_SYSTEM_PROMPT],
		messages: [
			...context1.messages,
			response1, // Include previous assistant response
			{
				role: "user",
				content: "What is 3 + 3? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response2 = await complete(llm, context2, options);
	expect(response2.stopReason).toBe("stop");

	return { first: response1.usage, second: response2.usage };
}

function logUsage(label: string, usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	console.log(`  ${label}:`);
	console.log(
		`    input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}, cacheWrite: ${usage.cacheWrite}`,
	);
	console.log(`    totalTokens: ${usage.totalTokens}, computed: ${computed}`);
}

function assertTotalTokensEqualsComponents(usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	expect(usage.totalTokens).toBe(computed);
}

describe("totalTokens field", () => {
	describe("GitHub Copilot (OAuth)", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("github-copilot", "gpt-4o");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("github-copilot", "claude-sonnet-4");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});
});
