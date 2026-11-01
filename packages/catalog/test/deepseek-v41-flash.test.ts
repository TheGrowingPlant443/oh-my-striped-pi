import { describe, expect, test } from "bun:test";
import { resolveCascade } from "../src/compat/cascade";

/**
 * DeepSeek V4.1 Flash is natively multimodal (vision encoder + projector,
 * image-text pre-training) but its release id carries no `vision` token, and
 * the deepseek class default strips image inputs.
 */
describe("DeepSeek V4.1 Flash", () => {
	test("publisher-namespaced ids keep the exemption", () => {
		// Gateways that resell the upstream prefix its namespace onto the id, so
		// the carve-out has to key on the release name rather than the exact id.
		const stripImageInput = (model: string) =>
			resolveCascade({
				provider: "omni",
				api: "openai-completions",
				class: "deepseek",
				family: "flash",
				model,
				reasoning: true,
			}).wire.stripImageInput;

		expect(stripImageInput("ds/deepseek-flash")).toBe(false);
		expect(stripImageInput("deepseek/deepseek-flash")).toBe(false);
		// Namespacing must not turn into suffix matching: the retired V4 reseller
		// id still ends in `-v4` and stays text-only.
		expect(stripImageInput("deepseek-flash-v4")).toBe(true);
	});
});
