import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { supportsOutputTokenLimit } from "@oh-my-striped-pi/pi-catalog/compat/output-limits";
import { requiresNativeTools, requiresToolFreeHistoryForToolOptOut } from "@oh-my-striped-pi/pi-catalog/compat/tools";
import { getBundledModels } from "@oh-my-striped-pi/pi-catalog/models";
import type { KnownApi, Model } from "@oh-my-striped-pi/pi-catalog/types";

function copilotFixture(api: KnownApi): Model {
	const found = getBundledModels("github-copilot").find(model => model.api === api);
	if (!found) throw new Error(`missing bundled Copilot fixture for ${api}`);
	return found;
}

const COPILOT_APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;

test("all Copilot wires preserve caller output caps", () => {
	for (const api of COPILOT_APIS) {
		expect(supportsOutputTokenLimit(copilotFixture(api))).toBe(true);
	}
});

test("model-level omission vetoes output caps on an encoding-capable wire", () => {
	const model = copilotFixture("openai-completions");
	expect(supportsOutputTokenLimit({ ...model, omitMaxOutputTokens: true })).toBe(false);
	expect(supportsOutputTokenLimit({ ...model, omitMaxOutputTokens: false })).toBe(true);
});

test("Copilot wires do not require native tools or a tool-free history for opt-out", () => {
	for (const api of COPILOT_APIS) {
		const model = copilotFixture(api);
		expect(requiresNativeTools(model)).toBe(false);
		expect(requiresToolFreeHistoryForToolOptOut(model)).toBe(false);
	}
});

test("local inference keeps the generic capability defaults", () => {
	const model = buildModel({
		id: "capability-fixture",
		name: "Capability fixture",
		provider: "local",
		api: "local-inference",
		baseUrl: "local://inference",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
	expect(supportsOutputTokenLimit(model)).toBe(true);
	expect(requiresNativeTools(model)).toBe(false);
	expect(requiresToolFreeHistoryForToolOptOut(model)).toBe(false);
});
