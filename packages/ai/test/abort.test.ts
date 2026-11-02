import { describe, expect, it } from "bun:test";
import { complete, stream } from "@oh-my-striped-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi } from "@oh-my-striped-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { resolveApiKey } from "./oauth";

const githubCopilotToken = await resolveApiKey("github-copilot");

async function testAbortSignal<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "What is 15 + 27? Think step by step. Then list 50 first names.",
				timestamp: Date.now(),
			},
		],
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });
	for await (const event of response) {
		if (abortFired) return;
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			text += event.delta;
		}
		if (text.length >= 50) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	// If we get here without throwing, the abort didn't work
	expect(msg.stopReason).toBe("aborted");
	expect(msg.content.length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push({
		role: "user",
		content: "Please continue, but only generate 5 names.",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

async function testImmediateAbort<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const controller = new AbortController();

	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const response = await complete(llm, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

describe("GitHub Copilot Abort Tests", () => {
	for (const modelId of ["gpt-4o", "claude-sonnet-4"]) {
		describe(modelId, () => {
			it.skipIf(!githubCopilotToken)(
				"should abort mid-stream",
				async () => {
					await testAbortSignal(getBundledModel("github-copilot", modelId), { apiKey: githubCopilotToken });
				},
				{ retry: 3 },
			);

			it.skipIf(!githubCopilotToken)(
				"should handle immediate abort",
				async () => {
					await testImmediateAbort(getBundledModel("github-copilot", modelId), { apiKey: githubCopilotToken });
				},
				{ retry: 3 },
			);
		});
	}
});
