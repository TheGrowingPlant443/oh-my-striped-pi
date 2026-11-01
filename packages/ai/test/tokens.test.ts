import { describe, expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveApiKey } from "./oauth";

const githubCopilotToken = await resolveApiKey("github-copilot");

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// OpenAI-family wires only report usage in the terminal chunk.
	if (llm.api === "openai-completions" || llm.api === "openai-responses") {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else {
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBeGreaterThan(0);
	}
}

describe("Token Statistics on Abort", () => {
	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("github-copilot", "gpt-4o");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("github-copilot", "claude-sonnet-4");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});
});
