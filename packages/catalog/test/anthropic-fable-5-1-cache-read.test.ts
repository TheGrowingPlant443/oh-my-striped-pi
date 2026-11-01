import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
describe("anthropic Fable 5.1 bundled row", () => {
	// `getProviderModels` consumes models.json verbatim and never reruns
	// `buildModel`, so an offline/static startup reports whatever the committed
	// row says. The rule fix only reaches users once the row is regenerated.
	test("ships the corrected cache-read rate", () => {
		const bundled = getBundledModels("github-copilot").find(model => model.id === "claude-fable-5.1");
		expect(bundled?.cost?.cacheRead).toBe(0.25);
	});

	test("still ships Fable 5 at the uncut rate", () => {
		const bundled = getBundledModels("github-copilot").find(model => model.id === "claude-fable-5");
		expect(bundled?.cost?.cacheRead).toBe(1);
	});
});
