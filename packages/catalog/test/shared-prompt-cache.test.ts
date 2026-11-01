import { describe, expect, test } from "bun:test";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { buildModel } from "../src/build";
import { resolveCatalogPolicy } from "../src/compat/catalog-policy";
import { resolveCascadeRules } from "../src/compat/cascade";
import type { Model } from "../src/types";

describe("task sibling prompt-cache opt-in", () => {
	test("retained providers do not opt in to shared sibling caches", () => {
		for (const provider of ["local", "github-copilot"]) {
			expect(
				resolveCatalogPolicy({ provider, api: "openai-responses", id: "gpt-6-luna", reasoning: true })
					.sharedPromptCache,
			).not.toBe(true);
		}
	});

	test("allows a narrower false rule to disable sharing and rejects string booleans", () => {
		const cascade = compileCascade([
			{
				file: "providers/test.kdl",
				text: 'provider "test" { shared-prompt-cache #true; models "disabled" { shared-prompt-cache #false } }',
			},
		]);
		expect(
			resolveCascadeRules(cascade, {
				provider: "test",
				api: "openai-responses",
				class: "unknown",
				model: "disabled",
				reasoning: false,
			}).catalog.sharedPromptCache,
		).toBe(false);
		expect(() =>
			compileCascade([
				{
					file: "providers/test.kdl",
					text: 'provider "test" { shared-prompt-cache "false" }',
				},
			]),
		).toThrow(/shared-prompt-cache.*rejects value/);
	});
});

describe("catalog policy memo key", () => {
	const model = (id: string, requestModelId?: string): Model =>
		buildModel({
			id,
			name: id,
			requestModelId,
			provider: "github-copilot",
			api: "anthropic-messages",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		});

	test("re-resolves a logical alias when its wire id changes or disappears", () => {
		for (const wireFirst of [true, false]) {
			const id = `memo-alias-${wireFirst}`;
			if (!wireFirst) expect(resolveCatalogPolicy(model(id)).promptCacheLookback).toBeUndefined();
			expect(resolveCatalogPolicy(model(id, "claude-sonnet-4-6")).promptCacheLookback).toBe(20);
			expect(resolveCatalogPolicy(model(id)).promptCacheLookback).toBeUndefined();
			expect(resolveCatalogPolicy(model(id, "gpt-6-luna")).promptCacheLookback).toBeUndefined();
		}
	});

	test("a recognized logical family takes precedence over its wire alias", () => {
		for (const wireFirst of [true, false]) {
			const native = model("claude-sonnet-4-6");
			const rerouted = model("claude-sonnet-4-6", "gpt-6-luna");
			for (const candidate of wireFirst ? [rerouted, native] : [native, rerouted]) {
				expect(resolveCatalogPolicy(candidate).promptCacheLookback).toBe(20);
			}
		}
	});
});
