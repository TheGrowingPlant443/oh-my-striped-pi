import { describe, expect, it } from "bun:test";
import { stream } from "@oh-my-striped-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-striped-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { resolveApiKey } from "./oauth";

const githubCopilotToken = await resolveApiKey("github-copilot");

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: `What is ${(Math.random() * 100) | 0} + ${(Math.random() * 100) | 0}? Think step by step.`,
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!githubCopilotToken)("Copilot xhigh reasoning", () => {
	describe("gpt-5.4 (supports xhigh)", () => {
		it("should work with openai-responses", async () => {
			const model = getBundledModel("github-copilot", "gpt-5.4");
			const s = stream(model, makeContext(), { reasoning: "xhigh", apiKey: githubCopilotToken });
			let hasThinking = false;

			for await (const event of s) {
				if (event.type === "thinking_start" || event.type === "thinking_delta") {
					hasThinking = true;
				}
			}

			const response = await s.result();
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			expect(response.content.some(b => b.type === "text")).toBe(true);
			expect(hasThinking || response.content.some(b => b.type === "thinking")).toBe(true);
		});
	});

	describe("gpt-5-mini (does not support xhigh)", () => {
		it("should error with openai-responses when using xhigh", async () => {
			const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;
			const s = stream(model, makeContext(), { reasoning: "xhigh", apiKey: githubCopilotToken });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});

		it("should error with openai-completions when using xhigh", async () => {
			const model: Model<"openai-completions"> = {
				...(getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-completions">),
				api: "openai-completions",
			};
			const s = stream(model, makeContext(), { reasoning: "xhigh", apiKey: githubCopilotToken });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});
	});
});
