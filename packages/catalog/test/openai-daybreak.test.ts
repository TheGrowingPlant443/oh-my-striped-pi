import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";

const DAYBREAK_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

describe("OpenAI Daybreak and GPT-5.6 models", () => {
	test("exposes every GPT-5.6 wire effort and its sampling restrictions on Copilot", () => {
		for (const id of ["gpt-daybreak-blue-latest", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
			const spec = {
				id,
				name: id,
				provider: "github-copilot",
				api: "openai-responses" as const,
				baseUrl: "https://api.githubcopilot.com",
				reasoning: true,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};
			const model = buildModel(spec);
			expect(getSupportedEfforts(model)).toEqual(DAYBREAK_EFFORTS);
			expect(model.thinking?.requiresEffort).not.toBe(true);
			expect(model.compat).toMatchObject({
				supportsSamplingParams: false,
			});
		}
	});
});
