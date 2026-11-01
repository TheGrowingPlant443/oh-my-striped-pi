import { describe, expect, test } from "bun:test";
import { shouldEnableAppendOnlyContext } from "@oh-my-pi/pi-coding-agent/config/append-only-context-mode";

const COPILOT = {
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
};

describe("shouldEnableAppendOnlyContext", () => {
	test("honors explicit on and off settings", () => {
		expect(shouldEnableAppendOnlyContext("on", COPILOT)).toBe(true);
		expect(shouldEnableAppendOnlyContext("off", COPILOT)).toBe(false);
	});

	test("auto enables when model compat explicitly supports stored requests", () => {
		expect(
			shouldEnableAppendOnlyContext("auto", {
				...COPILOT,
				compatConfig: { supportsStore: true },
			}),
		).toBe(true);
	});

	test("auto remains off without catalog or explicit prefix-cache signals", () => {
		expect(shouldEnableAppendOnlyContext("auto", COPILOT)).toBe(false);
	});

	test("malformed baseUrl never crashes the resolver", () => {
		expect(shouldEnableAppendOnlyContext("auto", { ...COPILOT, baseUrl: "not a url" })).toBe(false);
	});
});
