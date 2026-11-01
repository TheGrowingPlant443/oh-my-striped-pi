import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	collapseBuiltVariants,
	collapseVariants,
	deriveThinkingPairFamilies,
	getVariantAliasSources,
	isCollapsedVariantSpec,
	resolveBareVariantSelector,
	resolveVariantSelector,
	type VariantCollapseTable,
} from "@oh-my-pi/pi-catalog/compat/collapse";
import { stripThinkingVariantSuffix } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function memberSpec(
	id: string,
	overrides: Partial<ModelSpec<"openai-completions">> = {},
): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

const PAIR_THINKING = {
	mode: "budget",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
} as const;

const table: VariantCollapseTable = {
	families: [
		{
			id: "collapse-fixture",
			name: "Collapse fixture",
			members: ["collapse-fixture-minimal", "collapse-fixture-medium", "collapse-fixture-high"],
			routing: {
				off: "collapse-fixture-minimal",
				minimal: "collapse-fixture-minimal",
				low: "collapse-fixture-minimal",
				medium: "collapse-fixture-medium",
				high: "collapse-fixture-high",
			},
			thinking: {
				...PAIR_THINKING,
				effortBudgets: { minimal: 1000, low: 1000, medium: 4000, high: 10000 },
			},
			suppressWhenOff: true,
		},
	],
};

const triplet = () => [
	memberSpec("collapse-fixture-minimal", { maxTokens: 4096 }),
	memberSpec("collapse-fixture-medium", { input: ["text", "image"] }),
	memberSpec("collapse-fixture-high", { contextWindow: 256_000 }),
];

describe("collapseVariants with an explicit table", () => {
	it("unions capabilities and replaces the family's first occurrence while preserving unrelated rows", () => {
		const unrelated = memberSpec("unrelated-fixture");
		const out = collapseVariants([unrelated, ...triplet()], { table });
		expect(out.map(model => model.id)).toEqual(["unrelated-fixture", "collapse-fixture"]);
		expect(out[0]).toBe(unrelated);
		expect(out[1]).toMatchObject({
			name: "Collapse fixture",
			requestModelId: "collapse-fixture-minimal",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 256_000,
			maxTokens: 8192,
			thinking: {
				mode: "budget",
				efforts: PAIR_THINKING.efforts,
				effortBudgets: { minimal: 1000, low: 1000, medium: 4000, high: 10000 },
				suppressWhenOff: true,
				effortRouting: table.families[0]!.routing,
			},
		});
	});

	it("drops absent routes and falls back to the first live member", () => {
		const out = collapseVariants([memberSpec("collapse-fixture-medium")], { table });
		expect(out[0]?.requestModelId).toBe("collapse-fixture-medium");
		expect(out[0]?.thinking?.effortRouting).toEqual({ medium: "collapse-fixture-medium" });
		const model = buildModel(out[0]!);
		expect(resolveWireModelId(model, Effort.Medium)).toBe("collapse-fixture-medium");
		expect(resolveWireModelId(model, Effort.High)).toBe("collapse-fixture-medium");
	});

	it("honors a live defaultMember and falls back when it is absent", () => {
		const preferred = { families: [{ ...table.families[0]!, defaultMember: "collapse-fixture-medium" }] };
		expect(collapseVariants(triplet(), { table: preferred })[0]?.requestModelId).toBe("collapse-fixture-medium");
		expect(collapseVariants([triplet()[0]!], { table: preferred })[0]?.requestModelId).toBe(
			"collapse-fixture-minimal",
		);
	});

	it("is idempotent and dedupes mixed raw and collapsed input", () => {
		const once = collapseVariants(triplet(), { table });
		expect(collapseVariants(once, { table })).toEqual(once);
		expect(collapseVariants([...once, ...triplet()], { table })).toEqual(once);
	});

	it("reconciles retired routes in a stale collapsed row", () => {
		const retiredTable: VariantCollapseTable = {
			families: [
				{
					id: "retired-fixture",
					name: "Retired fixture",
					members: ["retired-fixture-live", "retired-fixture-old"],
					retiredMembers: ["retired-fixture-old"],
					routing: { off: "retired-fixture-live", high: "retired-fixture-live" },
					thinking: { mode: "budget", efforts: [Effort.High] },
				},
			],
		};
		const stale = memberSpec("retired-fixture", {
			reasoning: true,
			requestModelId: "retired-fixture-old",
			thinking: {
				mode: "budget",
				efforts: [Effort.High],
				effortRouting: { off: "retired-fixture-old", high: "retired-fixture-old" },
			},
		});
		const out = collapseVariants([stale], { table: retiredTable });
		expect(out[0]?.requestModelId).toBe("retired-fixture-live");
		expect(out[0]?.thinking?.effortRouting).toEqual({ off: "retired-fixture-live", high: "retired-fixture-live" });
	});

	it("renames a single wire id without inventing a thinking surface", () => {
		const out = collapseVariants([memberSpec("single-fixture-wire", { reasoning: true })], {
			table: {
				families: [{ id: "single-fixture", name: "Single fixture", members: ["single-fixture-wire"], routing: {} }],
			},
		});
		expect(out[0]?.id).toBe("single-fixture");
		expect(out[0]?.requestModelId).toBe("single-fixture-wire");
		expect(out[0]?.thinking).toBeUndefined();
	});
});

describe("stripThinkingVariantSuffix", () => {
	it("strips trailing and infix tokens case-insensitively", () => {
		expect(stripThinkingVariantSuffix("kimi-k2-thinking")).toBe("kimi-k2");
		expect(stripThinkingVariantSuffix("hf:moonshotai/Kimi-K2-Thinking")).toBe("hf:moonshotai/Kimi-K2");
		expect(stripThinkingVariantSuffix("xiaomi/mimo-v2-flash-thinking-original")).toBe(
			"xiaomi/mimo-v2-flash-original",
		);
		expect(stripThinkingVariantSuffix("sonar-reasoning-pro")).toBe("sonar-pro");
		expect(stripThinkingVariantSuffix("qwen3-235b-a22b-thinking-2507")).toBe("qwen3-235b-a22b-2507");
	});

	it("ignores ids without a token, colon suffixes, and negated tokens", () => {
		expect(stripThinkingVariantSuffix("kimi-k2")).toBeUndefined();
		expect(stripThinkingVariantSuffix("claude-3.7-sonnet:thinking")).toBeUndefined();
		expect(stripThinkingVariantSuffix("thinkingcap-1")).toBeUndefined();
		expect(stripThinkingVariantSuffix("deepseek-non-thinking-v3.2-exp")).toBeUndefined();
	});
});

describe("deriveThinkingPairFamilies", () => {
	it("routes off to the bare member and efforts to the thinking member", () => {
		const specs = [
			memberSpec("kimi-k2"),
			memberSpec("kimi-k2-thinking", { reasoning: true, thinking: PAIR_THINKING }),
		];
		const families = deriveThinkingPairFamilies(specs);
		expect(families).toHaveLength(1);
		expect(families[0]?.members).toEqual(["kimi-k2", "kimi-k2-thinking"]);
		expect(families[0]?.routing).toEqual({
			off: "kimi-k2",
			minimal: "kimi-k2-thinking",
			low: "kimi-k2-thinking",
			medium: "kimi-k2-thinking",
			high: "kimi-k2-thinking",
		});
		const out = collapseVariants(specs, { table: { families } });
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("kimi-k2");
		expect(out[0]?.requestModelId).toBeUndefined();
		expect(out[0]?.reasoning).toBe(true);
	});

	it("pairs infix thinking tokens", () => {
		const families = deriveThinkingPairFamilies([
			memberSpec("xiaomi/mimo-v2-flash-original"),
			memberSpec("xiaomi/mimo-v2-flash-thinking-original", { reasoning: true, thinking: PAIR_THINKING }),
		]);
		expect(families[0]?.id).toBe("xiaomi/mimo-v2-flash-original");
	});

	it("uses the bare member's surface and pricing when the twin lacks metadata", () => {
		const base = memberSpec("xiaomi/mimo-v2-flash", { reasoning: true, thinking: PAIR_THINKING });
		const twin = memberSpec("xiaomi/mimo-v2-flash-thinking", {
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const families = deriveThinkingPairFamilies([base, twin]);
		const out = collapseVariants([base, twin], { table: { families } });
		expect(out).toHaveLength(1);
		expect(out[0]?.cost).toEqual(base.cost);
		expect(out[0]?.thinking?.mode).toBe("budget");
		expect(out[0]?.thinking?.effortRouting?.high).toBe(twin.id);
	});

	it("derives a nonempty surface for zero-cost metadata-less twins", () => {
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const specs = [memberSpec("pair-fixture", { cost }), memberSpec("pair-fixture-thinking", { cost })];
		const families = deriveThinkingPairFamilies(specs);
		expect(families).toHaveLength(1);
		expect(families[0]?.thinking?.efforts.length).toBeGreaterThan(0);
		const out = collapseVariants(specs, { table: { families } });
		expect(out[0]?.reasoning).toBe(true);
		expect(out[0]?.thinking?.effortRouting?.off).toBe("pair-fixture");
	});

	it("never merges price-divergent twins, orphan thinking ids, or different APIs", () => {
		expect(
			deriveThinkingPairFamilies([
				memberSpec("kimi-k2"),
				memberSpec("kimi-k2-thinking", { cost: { input: 3, output: 6, cacheRead: 0.1, cacheWrite: 0 } }),
			]),
		).toEqual([]);
		expect(deriveThinkingPairFamilies([memberSpec("kimi-k2-thinking")])).toEqual([]);
		expect(
			deriveThinkingPairFamilies<ModelSpec>([
				memberSpec("kimi-k2"),
				{ ...memberSpec("kimi-k2-thinking"), api: "anthropic-messages" },
			]),
		).toEqual([]);
	});

	it("defers to explicitly claimed family ids", () => {
		const specs = [memberSpec("claimed-fixture"), memberSpec("claimed-fixture-thinking")];
		const claimed: VariantCollapseTable = {
			families: [{ id: "claimed-fixture", name: "Claimed", members: specs.map(spec => spec.id), routing: {} }],
		};
		expect(deriveThinkingPairFamilies(specs, claimed)).toEqual([]);
	});
});

describe("runtime collapsing", () => {
	it("keeps provider slices isolated and does not consume orphan thinking ids", () => {
		const out = collapseVariants([
			memberSpec("mixed-fixture"),
			memberSpec("mixed-fixture-thinking", { reasoning: true, thinking: PAIR_THINKING }),
			{ ...memberSpec("mixed-fixture-thinking"), provider: "local", api: "local-inference" } satisfies ModelSpec,
		]);
		expect(out.map(model => `${model.provider}/${model.id}`)).toEqual([
			"github-copilot/mixed-fixture",
			"local/mixed-fixture-thinking",
		]);
	});

	it("registers provider and bare aliases for dynamically derived pairs", () => {
		collapseVariants([
			memberSpec("alias-fixture"),
			memberSpec("alias-fixture-thinking", { thinking: PAIR_THINKING }),
		]);
		expect(resolveVariantSelector("github-copilot", "alias-fixture-thinking")).toBe("alias-fixture");
		expect(resolveVariantSelector("local", "alias-fixture-thinking")).toBeUndefined();
		expect(resolveBareVariantSelector("ALIAS-FIXTURE-THINKING")).toEqual({
			id: "alias-fixture",
			providers: ["github-copilot"],
		});
		expect(getVariantAliasSources("github-copilot", "alias-fixture")).toEqual(["alias-fixture-thinking"]);
	});

	it("does not mistake Copilot long-context request ids for collapsed variants", () => {
		const collapsed = collapseVariants(triplet(), { table })[0]!;
		expect(isCollapsedVariantSpec(collapsed)).toBe(true);
		expect(isCollapsedVariantSpec(memberSpec("collapse-fixture-minimal"))).toBe(false);
		expect(isCollapsedVariantSpec(memberSpec("claude-opus-4.6-1m", { requestModelId: "claude-opus-4.6" }))).toBe(
			false,
		);
	});

	it("preserves routing through buildModel and collapseBuiltVariants", () => {
		const models = [
			memberSpec("built-fixture"),
			memberSpec("built-fixture-thinking", { reasoning: true, thinking: PAIR_THINKING }),
		].map(spec => buildModel(spec));
		const out = collapseBuiltVariants(models);
		expect(out).toHaveLength(1);
		expect(resolveWireModelId(out[0]!, Effort.High)).toBe("built-fixture-thinking");
		expect(resolveWireModelId(out[0]!, undefined)).toBe("built-fixture");
		expect(collapseBuiltVariants(out)).toEqual(out);
		expect(resolveWireModelId(buildModel(memberSpec("unrouted-fixture")), Effort.High)).toBe("unrouted-fixture");
	});

	it("collapses bare/thinking pairs at the provider-model merge point", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "variant-collapse-"));
		try {
			const result = await resolveProviderModels(
				{
					providerId: "github-copilot",
					staticModels: [
						memberSpec("merge-fixture"),
						memberSpec("merge-fixture-thinking", { reasoning: true, thinking: PAIR_THINKING }),
					],
					cacheDbPath: path.join(dir, "models.db"),
				},
				"offline",
			);
			expect(result.models.map(model => model.id)).toEqual(["merge-fixture"]);
			expect(resolveWireModelId(result.models[0]!, Effort.High)).toBe("merge-fixture-thinking");
			expect(resolveWireModelId(result.models[0]!, undefined)).toBe("merge-fixture");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
