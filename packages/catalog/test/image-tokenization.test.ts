import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import {
	type ImageTokenization,
	imageTokens,
	resolveImageMaxEdge,
	resolveImageTokenization,
} from "@oh-my-striped-pi/pi-catalog/compat/image-tokenization";
import { isRecord } from "@oh-my-striped-pi/pi-utils/type-guards";
import rules from "../src/compat/rules.json";

const HIRES: ImageTokenization = { regime: "anthropic-patch", verified: true, maxEdge: 2576, maxTokens: 4784 };
/** The Anthropic-wire fallback: the high-res numbers, unmeasured for the readers it prices. */
const HIRES_FALLBACK: ImageTokenization = { regime: "anthropic-patch", maxEdge: 2576, maxTokens: 4784 };
const STANDARD: ImageTokenization = { regime: "anthropic-patch", maxEdge: 1568, maxTokens: 1568 };
/** GPT-5.5's sizing; `auto` sizes like `original`. */
const GPT_PATCH: ImageTokenization = {
	regime: "openai-patch",
	multiplier: 1.2,
	auto: "original",
	low: { maxEdge: 512 },
	high: { maxEdge: 2048, patchBudget: 2500 },
	original: { maxEdge: 6000, patchBudget: 10_000 },
};

/** DeepSeek V4.1 Flash's vision config: 14px patches merged 3×3, 1,024-token cap, 544² floor. */
const DEEPSEEK_PATCH: ImageTokenization = {
	regime: "deepseek-patch",
	verified: true,
	patchSize: 14,
	downsample: 3,
	maxTokens: 1024,
	minPixels: 295_936,
};

function ruleFor(provider: string, id: string): ImageTokenization {
	const rule = resolveImageTokenization({ provider, id });
	if (!rule) throw new Error(`no image rule for ${provider}/${id}`);
	return rule;
}

describe("resolveImageTokenization", () => {
	it("splits Claude at 4.7: Opus 4.6 and older on the standard tier, 4.7+ and Fable/Mythos high-res", () => {
		for (const id of ["claude-opus-4-6", "claude-haiku-4-5", "claude-3-5-sonnet-20241022", "claude-sonnet-45"]) {
			expect(resolveImageTokenization({ provider: "custom", id })).toEqual(STANDARD);
		}
		for (const id of ["claude-sonnet-4-6", "claude-sonnet-46"]) {
			expect(resolveImageTokenization({ provider: "custom", id })).toEqual({ ...STANDARD, verified: true });
		}
		for (const id of [
			"claude-opus-4-7",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"claude-fable-5-1",
			"claude-fable-latest",
			"claude-mythos-preview",
		]) {
			expect(resolveImageTokenization({ provider: "custom", id })).toEqual(HIRES);
		}
		// Separator-collapsed revisions parse as two digits: `claude-opus-45` is
		// Opus 4.5 (standard), `claude-opus-47` is Opus 4.7 (high-res).
		expect(resolveImageTokenization({ provider: "custom", id: "claude-opus-45" })).toEqual(STANDARD);
		expect(resolveImageTokenization({ provider: "custom", id: "claude-opus-47" })).toEqual(HIRES);
	});

	it("prices unversioned Claude aliases at the high-res tier", () => {
		expect(resolveImageTokenization({ provider: "custom", id: "claude-opus-latest" })).toEqual(HIRES);
		expect(resolveImageTokenization({ provider: "custom", id: "claude-sonnet-latest" })).toEqual(HIRES);
		for (const id of ["~anthropic/claude-opus-latest", "anthropic/claude-sonnet-latest"]) {
			expect(resolveImageTokenization({ provider: "github-copilot", id })).toEqual(HIRES);
		}
	});

	it("follows the Claude lineage through gateways and cloud hosts", () => {
		expect(
			resolveImageTokenization({
				provider: "custom",
				api: "openai-completions",
				id: "anthropic/claude-opus-4.7",
			}),
		).toEqual(HIRES);
		expect(
			resolveImageTokenization({
				provider: "custom",
				api: "openai-completions",
				id: "anthropic/claude-sonnet-4.6",
			}),
		).toEqual({ ...STANDARD, verified: true });
		expect(
			resolveImageTokenization({
				provider: "custom",
				api: "anthropic-messages",
				id: "us.anthropic.claude-opus-4-7-v1:0",
			}),
		).toEqual(HIRES);
		expect(
			resolveImageTokenization({ provider: "custom", api: "anthropic-messages", id: "claude-fable-5@20250929" }),
		).toEqual(HIRES);
	});

	it("prices GPT and Codex family models with 32px patches × 1.2", () => {
		for (const id of [
			"gpt-6-astra",
			"gpt-6.1-sol",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-daybreak-blue-latest",
			"gpt-5.3-codex",
		]) {
			const rule = ruleFor("github-copilot", id);
			expect(rule).toMatchObject({ regime: "openai-patch", multiplier: 1.2 });
			expect(imageTokens(rule, { width: 1568, height: 1562 }, "original")).toBe(2882);
		}
	});

	it("marks the GPT rules measured against Codex billing as verified", () => {
		for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-daybreak-blue-latest"]) {
			expect(ruleFor("github-copilot", id).verified).toBe(true);
		}
		// gpt-5.4 and older follow the guide without a billing probe.
		expect(ruleFor("github-copilot", "gpt-5.4").verified).toBeUndefined();
		expect(ruleFor("github-copilot", "gpt-5.3-codex").verified).toBeUndefined();
		// Lines after 6.1 size like gpt-5.6 but are not measured yet.
		for (const id of ["gpt-6.2-sol", "gpt-7-luna"]) {
			const rule = ruleFor("github-copilot", id);
			expect(rule.verified).toBeUndefined();
			expect(imageTokens(rule, { width: 1568, height: 1562 }, "original")).toBe(2882);
		}
	});

	it("sizes each detail level the way the guide lists for that model", () => {
		const astra = ruleFor("github-copilot", "gpt-6-astra");
		// Guide example: astra `high` keeps a 4096×512 image (65,535px limit).
		expect(imageTokens(astra, { width: 4096, height: 512 }, "high")).toBe(2458);
		// Astra `original` has no resizing budget; gpt-5.5 caps at 10,000 patches.
		expect(imageTokens(astra, { width: 4096, height: 4096 }, "original")).toBe(19_661);
		expect(imageTokens(ruleFor("github-copilot", "gpt-5.5"), { width: 4096, height: 4096 }, "original")).toBe(12_000);
		// gpt-5.6 `high` fits 2048px first.
		expect(imageTokens(ruleFor("github-copilot", "gpt-5.6-sol"), { width: 4096, height: 512 }, "high")).toBe(615);
		// gpt-5.4 sizes `auto` like `high` (2,500 patches).
		const gpt54 = ruleFor("github-copilot", "gpt-5.4-mini");
		expect(imageTokens(gpt54, { width: 1932, height: 1920 })).toBe(2940);
		expect(imageTokens(gpt54, { width: 1932, height: 1920 }, "original")).toBe(4392);
	});

	it("bills Gemini 3 a fixed budget and leaves unruled lines without a wire to the caller", () => {
		expect(resolveImageTokenization({ provider: "custom", id: "gemini-3.5-flash" })).toEqual({
			regime: "fixed",
			tokens: 1120,
		});
		expect(resolveImageTokenization({ provider: "custom", id: "gemini-2.5-pro" })).toBeUndefined();
		expect(resolveImageTokenization({ provider: "custom", id: "moonshotai/kimi-k2.6" })).toBeUndefined();
		for (const id of ["gpt-5.1-codex-max", "gpt-5.1", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o3"]) {
			expect(resolveImageTokenization({ provider: "openai", id })).toBeUndefined();
		}
	});

	it("falls back to the wire API's rule when the lineage has none", () => {
		for (const api of ["openai-completions", "openai-responses"]) {
			expect(resolveImageTokenization({ api })).toEqual(GPT_PATCH);
			expect(resolveImageTokenization({ provider: "custom", api, id: "moonshotai/kimi-k2.6" })).toEqual(GPT_PATCH);
		}
		for (const api of ["anthropic-messages"]) {
			expect(resolveImageTokenization({ api, id: "qwen/qwen3-vl" })).toEqual(HIRES_FALLBACK);
		}
		// The lineage rule wins over the wire carrying it.
		expect(
			resolveImageTokenization({
				provider: "custom",
				api: "openai-completions",
				id: "anthropic/claude-opus-4.6",
			}),
		).toEqual(STANDARD);
		expect(resolveImageTokenization({ api: "anthropic-messages", id: "gemini-3.5-flash" })).toEqual({
			regime: "fixed",
			tokens: 1120,
		});
		// An unregistered API carries no rule.
		expect(resolveImageTokenization({ api: "some-future-api", id: "qwen/qwen3-vl" })).toBeUndefined();
	});

	it("keeps separator-collapsed GPT revisions off the gpt-5.6+ sizing", () => {
		for (const id of ["openai-gpt-52-codex", "openai-gpt-53-codex", "openai-gpt-54", "openai-gpt-55"]) {
			expect(resolveImageTokenization({ provider: "custom", api: "openai-completions", id })).toEqual(GPT_PATCH);
		}
	});

	it("uses a built model's identity", () => {
		const model = buildModel({
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		expect(resolveImageTokenization(model)).toEqual(STANDARD);
		expect(resolveImageTokenization({ ...model, identity: { ...model.identity, revision: "4.7.0" } })).toEqual(HIRES);
	});

	it("prices DeepSeek V4.1 Flash by its own vision config on every host, and V4.0 by the wire", () => {
		for (const id of [
			"deepseek/deepseek-v4.1-flash-1017",
			"deepseek/deepseek-v4.1-flash",
			"deepseek-ai/DeepSeek-V4.1-Flash",
		]) {
			expect(resolveImageTokenization({ provider: "custom", api: "openai-completions", id })).toEqual(
				DEEPSEEK_PATCH,
			);
		}
		expect(
			resolveImageTokenization({ provider: "custom", api: "openai-completions", id: "deepseek-v4.2-flash" }),
		).toEqual(GPT_PATCH);
	});
});

describe("imageTokens", () => {
	it("matches the per-frame input-token deltas measured on live requests", () => {
		expect(imageTokens(GPT_PATCH, { width: 1568, height: 1562 }, "original")).toBe(2882);
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "original")).toBe(4392);
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "auto")).toBe(4392);
		// `high` resizes to a 2,500-patch budget; `low` fits 512px.
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "high")).toBe(2940);
		expect(imageTokens(GPT_PATCH, { width: 1932, height: 1920 }, "low")).toBe(308);
		expect(imageTokens(HIRES, { width: 1932, height: 1920 })).toBe(4761);
		// The standard tier shrinks to the largest size under its 1,568-token cap.
		expect(imageTokens(STANDARD, { width: 1932, height: 1920 })).toBe(40 * 39);
		expect(imageTokens(STANDARD, { width: 1568, height: 1568 })).toBe(39 * 39);
	});

	it("follows OpenAI's documented patch examples", () => {
		expect(imageTokens(GPT_PATCH, { width: 1024, height: 1024 }, "high")).toBe(1229);
		expect(imageTokens(GPT_PATCH, { width: 2048, height: 2048 }, "high")).toBe(3000);
		expect(imageTokens(GPT_PATCH, { width: 4096, height: 512 }, "original")).toBe(2458);
	});

	it("resizes Anthropic images like the reference implementation", () => {
		expect(imageTokens(HIRES, { width: 200, height: 100 })).toBe(8 * 4);
		expect(imageTokens(HIRES, { width: 4000, height: 4000 })).toBe(69 * 69);
		// Guide examples on the standard tier: A4 scan 1075×1520 → 924×1307,
		// 1920×1080 screenshot → 1456×819.
		expect(imageTokens(STANDARD, { width: 1075, height: 1520 })).toBe(33 * 47);
		expect(imageTokens(STANDARD, { width: 1920, height: 1080 })).toBe(52 * 30);
		// Near-square: the short edge follows the original aspect, so 3000×2999
		// lands at 1092×1092 (39²), not 40·39.
		expect(imageTokens(STANDARD, { width: 3000, height: 2999 })).toBe(39 * 39);
		expect(imageTokens(STANDARD, { width: 2999, height: 3000 })).toBe(39 * 39);
		expect(imageTokens({ regime: "fixed", tokens: 1120 }, { width: 2048, height: 2048 })).toBe(1120);
	});

	it("matches DeepSeek V4.1 Flash billing measured through OpenRouter", () => {
		// Input-token delta over a text-only request, identical on Fireworks and
		// DeepInfra: upscaled to the 544² floor, then 42px cells up to the cap.
		const measured: [width: number, height: number, tokens: number][] = [
			[256, 256, 184],
			[512, 512, 184],
			[784, 784, 382],
			[1024, 1024, 652],
			[1280, 1280, 994],
			[1568, 1562, 994],
			[1568, 784, 743],
			[784, 1568, 762],
			[2576, 1716, 977],
			[3000, 1000, 992],
			[4000, 4000, 994],
		];
		for (const [width, height, tokens] of measured) {
			expect(imageTokens(DEEPSEEK_PATCH, { width, height })).toBe(tokens);
		}
	});

	it("resizes DeepSeek images like the reference processor at extreme aspect ratios", () => {
		// Values from `plan_image_grid` in DeepSeek's `inference/image_processor.py`.
		expect(imageTokens(DEEPSEEK_PATCH, { width: 1, height: 8192 })).toBe(1024);
		expect(imageTokens(DEEPSEEK_PATCH, { width: 8192, height: 1 })).toBe(1024);
		expect(imageTokens(DEEPSEEK_PATCH, { width: 64, height: 8192 })).toBe(590);
		expect(imageTokens(DEEPSEEK_PATCH, { width: 8192, height: 64 })).toBe(396);
		expect(imageTokens(DEEPSEEK_PATCH, { width: 100, height: 2000 })).toBe(234);
		expect(imageTokens(DEEPSEEK_PATCH, { width: 2000, height: 100 })).toBe(179);
	});
});

function isPositiveNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Why a compiled `image-tokenization` payload cannot be priced, or [] when it can. */
function payloadProblems(payload: unknown): string[] {
	if (!isRecord(payload)) return ["not an object"];
	const problems: string[] = [];
	const requirePositive = (record: Record<string, unknown>, field: string, path: string) => {
		if (!isPositiveNumber(record[field])) problems.push(`${path}${field} is not a positive number`);
	};
	switch (payload.regime) {
		case "fixed":
			requirePositive(payload, "tokens", "");
			break;
		case "anthropic-patch":
			requirePositive(payload, "maxEdge", "");
			requirePositive(payload, "maxTokens", "");
			break;
		case "deepseek-patch":
			for (const field of ["patchSize", "downsample", "maxTokens", "minPixels"]) requirePositive(payload, field, "");
			break;
		case "openai-patch":
			requirePositive(payload, "multiplier", "");
			if (payload.auto !== "high" && payload.auto !== "original") problems.push("auto is not high or original");
			for (const level of ["low", "high", "original"]) {
				const sizing = payload[level];
				if (!isRecord(sizing)) {
					problems.push(`${level} is not an object`);
					continue;
				}
				requirePositive(sizing, "maxEdge", `${level}.`);
				if (sizing.patchBudget !== undefined) requirePositive(sizing, "patchBudget", `${level}.`);
			}
			break;
		default:
			problems.push(`unknown regime ${String(payload.regime)}`);
	}
	return problems;
}

describe("compiled image-tokenization payloads", () => {
	it("carry every field their regime prices with", () => {
		const offenders: string[] = [];
		let checked = 0;
		for (const rule of rules.cascade.rules) {
			const catalog: Record<string, unknown> | undefined = rule.catalog;
			if (catalog?.imageTokenization === undefined) continue;
			checked++;
			for (const problem of payloadProblems(catalog.imageTokenization)) offenders.push(`${rule.source}: ${problem}`);
		}
		expect(checked).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});

describe("resolveImageMaxEdge", () => {
	it("leaves retained Copilot image readers without a provider resize cap", () => {
		for (const id of ["claude-opus-5.5", "gpt-6.1-sol"]) {
			expect(resolveImageMaxEdge({ provider: "github-copilot", api: "openai-responses", id })).toBeUndefined();
		}
	});
});
