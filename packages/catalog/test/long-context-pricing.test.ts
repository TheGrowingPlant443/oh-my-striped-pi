import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Usage } from "@oh-my-pi/pi-catalog/types";

function usage(fields: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): Usage {
	return {
		...fields,
		totalTokens: fields.input + fields.output + fields.cacheRead + fields.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("long-context pricing tier", () => {
	const sol = buildModel({
		id: "tiered-model",
		name: "Tiered Model",
		provider: "github-copilot",
		api: "openai-responses",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: {
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 0,
			longContext: { inputThreshold: 272000, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 },
		},
	});
	const standard = sol.cost;
	const tier = sol.cost.longContext;
	if (!tier) throw new Error("gpt-5.6-sol lost its long-context tier");

	it("bills at standard rates at or below the input threshold", () => {
		const input = tier.inputThreshold - 200_000;
		const atThreshold = usage({ input, output: 10_000, cacheRead: 200_000, cacheWrite: 0 });
		calculateCost(sol, atThreshold);
		expect(atThreshold.cost.input).toBeCloseTo((standard.input / 1e6) * input, 10);
		expect(atThreshold.cost.output).toBeCloseTo((standard.output / 1e6) * 10_000, 10);
		expect(atThreshold.cost.cacheRead).toBeCloseTo((standard.cacheRead / 1e6) * 200_000, 10);
	});

	it("bills the whole request at tier rates once prompt input crosses the threshold", () => {
		const input = tier.inputThreshold - 200_000 + 1;
		const overThreshold = usage({ input, output: 10_000, cacheRead: 200_000, cacheWrite: 0 });
		calculateCost(sol, overThreshold);
		expect(overThreshold.cost.input).toBeCloseTo((tier.input / 1e6) * input, 10);
		expect(overThreshold.cost.output).toBeCloseTo((tier.output / 1e6) * 10_000, 10);
		expect(overThreshold.cost.cacheRead).toBeCloseTo((tier.cacheRead / 1e6) * 200_000, 10);
		expect(overThreshold.cost.total).toBeCloseTo(
			overThreshold.cost.input + overThreshold.cost.output + overThreshold.cost.cacheRead,
			10,
		);
	});
});
