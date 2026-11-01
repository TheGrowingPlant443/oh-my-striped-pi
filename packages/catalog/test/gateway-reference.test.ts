import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { buildModelReferenceIndex, inheritReferenceThinking, resolveModelReference } from "../src/identity/reference";
import type { ModelSpec } from "../src/types";
import { Effort } from "../src/effort";

const reference = buildModel({
	id: "claude-opus-4-6",
	name: "Claude",
	provider: "github-copilot",
	api: "anthropic-messages",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
		effortRouting: { low: "wire-low", high: "wire-high" },
	},
} satisfies ModelSpec<"anthropic-messages">);

describe("Portkey gateway model references", () => {
	test("@modal ids do not fuzzy-match bundled catalog entries", () => {
		const index = buildModelReferenceIndex([reference]);
		expect(resolveModelReference("@modal/GLM-5-2-FP8", index)).toBeUndefined();
	});

	test("strips compiled discovery and collapse markers for proxy recovery", () => {
		const index = buildModelReferenceIndex([reference]);
		for (const id of [
			"claude-opus-4-6-fp8",
			"claude-opus-4-6-search",
			"claude-opus-4-6-thinking",
			"claude-opus-4-6-free",
		]) {
			expect(resolveModelReference(id, index)?.id).toBe("claude-opus-4-6");
		}
	});

	test("cross-provider references do not inherit wire routing thinking", () => {
		expect(inheritReferenceThinking(undefined, reference, "gateway")).toBeUndefined();
	});
});
