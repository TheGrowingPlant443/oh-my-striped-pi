import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	clampThinkingLevelForModel,
	defaultSupportedEffort,
	getSupportedEfforts,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	requireSupportedEffort,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, Model, ModelSpec, Provider } from "@oh-my-pi/pi-catalog/types";

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	name?: string;
	reasoning?: boolean;
	baseUrl?: string;
	compat?: ModelSpec<TApi>["compat"];
	thinking?: ModelSpec<TApi>["thinking"];
}): Model<TApi> {
	return buildModel({
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: overrides.baseUrl ?? "",
		reasoning: overrides.reasoning ?? true,
		compat: overrides.compat,
		thinking: overrides.thinking,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

describe("model thinking derivation", () => {
	it("stores supported efforts for Codex mini in model metadata", () => {
		const model = createModel({
			id: "gpt-5.1-codex-mini",
			api: "openai-responses",
			provider: "github-copilot",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Medium, Effort.High],
		});
		expect(() => requireSupportedEffort(model, Effort.Low)).toThrow(/Supported efforts: medium, high/);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(/Supported efforts: medium, high/);
	});

	it("stores MiniMax M2 and GPT-OSS OpenAI-compatible effort limits in model metadata", () => {
		const minimax = createModel({
			id: "minimax-m2.7",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
		});
		const gptOss = createModel({
			id: "gpt-oss-120b",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
		});

		expect(minimax.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			// MiniMax M2 is a reasoning-first architecture — thinking-off clamps.
			requiresEffort: true,
		});
		expect(gptOss.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(minimax.thinking?.effortMap).toBeUndefined();
		expect(gptOss.thinking?.effortMap).toBeUndefined();
	});

	it("preserves stale explicit MiniMax M2 / GPT-OSS effort metadata from caches", () => {
		const staleMinimax = createModel({
			id: "minimax-m2.7",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: { minimal: "none", xhigh: "max" },
			},
		});
		const staleGptOss = createModel({
			id: "gpt-oss-120b",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
		});

		expect(staleMinimax.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "none", xhigh: "max" },
			requiresEffort: true,
		});
		expect(staleGptOss.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});

	it("derives Anthropic adaptive thinking for SAP hai-proxy version-first Claude ids", () => {
		const opus48 = createModel({
			id: "anthropic--claude-4.8-opus",
			api: "anthropic-messages",
			provider: "custom",
		});
		const opus46 = createModel({
			id: "anthropic--claude-4.6-opus",
			api: "anthropic-messages",
			provider: "custom",
		});

		expect(opus48.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			supportsDisplay: true,
		});
		expect(getSupportedEfforts(opus48)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
		expect(opus46.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});

	it("maps minimal to LOW when a collapsed family aliases it onto the low wire id", () => {
		const model = createModel({
			id: "gemini-3.7-flash",
			api: "openai-completions",
			provider: "custom",
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				requiresEffort: true,
				effortRouting: {
					[Effort.Minimal]: "gemini-3.7-flash-low",
					[Effort.Low]: "gemini-3.7-flash-low",
					[Effort.Medium]: "gemini-3.7-flash-medium",
					[Effort.High]: "gemini-3.7-flash-high",
				},
			},
		});
		expect(mapEffortToGoogleThinkingLevel(Effort.Minimal, model)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(Effort.Low, model)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(Effort.Minimal)).toBe("MINIMAL");
	});

	it("encodes adaptive Claude and MiniMax thinking without provider implementations", () => {
		const opus46 = createModel({ id: "claude-opus-4.6", api: "anthropic-messages", provider: "github-copilot" });
		const opus47 = createModel({ id: "claude-opus-4.7", api: "anthropic-messages", provider: "github-copilot" });
		const sonnet46 = createModel({ id: "claude-sonnet-4.6", api: "anthropic-messages", provider: "github-copilot" });
		expect(opus46.thinking?.mode).toBe("anthropic-adaptive");
		expect(getSupportedEfforts(opus46)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
		expect(getSupportedEfforts(opus47)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus47.thinking?.effortMap).toBeUndefined();
		expect(getSupportedEfforts(sonnet46)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		for (const id of ["MiniMax-M2.7", "MiniMax-M3"]) {
			const model = createModel({ id, api: "anthropic-messages", provider: "custom" });
			expect(model.thinking?.mode).toBe("anthropic-adaptive");
			expect(mapEffortToAnthropicAdaptiveEffort(model, Effort.High)).toBe("high");
		}
	});

	it("clamps a custom adaptive ladder's minimal tier to low (issue #10994)", () => {
		// Built-in Claude ladders exclude minimal, but a custom anthropic-messages
		// provider can declare it. The Anthropic adaptive wire has no minimal tier,
		// so the mapper must clamp rather than forward it verbatim (400).
		const custom = createModel({
			id: "claude-opus-5",
			api: "anthropic-messages",
			provider: "ccs",
			baseUrl: "https://ccs.example/anthropic",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
		});
		expect(getSupportedEfforts(custom)).toContain(Effort.Minimal);
		expect(mapEffortToAnthropicAdaptiveEffort(custom, Effort.Minimal)).toBe("low");
		expect(mapEffortToAnthropicAdaptiveEffort(custom, Effort.High)).toBe("high");
	});

	it("backfills family display and prefix-binding facts", () => {
		for (const id of ["claude-opus-4-7", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
			expect(
				createModel({ id, api: "anthropic-messages", provider: "github-copilot" }).thinking?.supportsDisplay,
			).toBe(true);
		}
		expect(
			createModel({ id: "claude-opus-4-6", api: "anthropic-messages", provider: "github-copilot" }).thinking
				?.supportsDisplay,
		).toBeUndefined();
		expect(
			createModel({ id: "claude-fable-5-1", api: "anthropic-messages", provider: "github-copilot" }).thinking
				?.prefixBinding,
		).toBe(true);
		expect(
			createModel({ id: "claude-fable-5", api: "anthropic-messages", provider: "github-copilot" }).thinking
				?.prefixBinding,
		).toBeUndefined();
	});
	it("backfills wire facts onto explicit thinking, explicit values winning", () => {
		// Authored partial ladders are authoritative; rules only fill fields
		// the spec omitted.
		const filled = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "github-copilot",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.High] },
		});
		expect(filled.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.High],
			supportsDisplay: true,
		});

		// Explicit wire facts are authoritative — including `false` — when the
		// authored ladder matches the wire truth.
		const pinned = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "github-copilot",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortMap: { max: "ultra" },
				supportsDisplay: false,
			},
		});
		expect(pinned.thinking?.effortMap).toEqual({ max: "ultra" });
		expect(pinned.thinking?.supportsDisplay).toBe(false);
	});

	it("infers thinking when explicit metadata omits efforts", () => {
		const model = buildModel(
			JSON.parse(`{
				"id": "gpt-5",
				"name": "gpt-5",
				"api": "openai-completions",
				"provider": "custom",
				"baseUrl": "",
				"reasoning": true,
				"thinking": { "mode": "effort" },
				"input": ["text"],
				"cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
				"contextWindow": 200000,
				"maxTokens": 32000
			}`),
		);

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
	});

	it("bakes sampling-param rejection into anthropic compat", () => {
		const sonnet45 = createModel({ id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "github-copilot" });
		const opus47 = createModel({ id: "claude-opus-4.7", api: "anthropic-messages", provider: "github-copilot" });
		const sonnet5 = createModel({ id: "claude-sonnet-5", api: "anthropic-messages", provider: "github-copilot" });
		const fable = createModel({ id: "claude-fable-5", api: "anthropic-messages", provider: "github-copilot" });

		expect(sonnet45.compat.supportsSamplingParams).toBe(true);
		expect(opus47.compat.supportsSamplingParams).toBe(false);
		expect(sonnet5.compat.supportsSamplingParams).toBe(false);
		expect(fable.compat.supportsSamplingParams).toBe(false);
	});

	it("bakes sampling-param rejection into OpenAI reasoning compat (#5606)", () => {
		// GitHub Copilot Responses gpt-5.6 — the reported failing model.
		const luna = createModel({
			id: "gpt-5.6-luna",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
		});
		const gpt5 = createModel({ id: "gpt-5", api: "openai-responses", provider: "custom" });
		const gpt5Mini = createModel({ id: "gpt-5-mini", api: "openai-completions", provider: "custom" });
		const gpt5Chat = createModel({ id: "gpt-5-chat-latest", api: "openai-responses", provider: "custom" });
		const oThree = createModel({ id: "o3-mini", api: "openai-responses", provider: "custom" });
		// Non-restricted OpenAI + non-OpenAI models keep sampling support.
		const gpt4o = createModel({ id: "gpt-4o", api: "openai-responses", provider: "custom", reasoning: false });
		const kimi = createModel({ id: "kimi-k2.6", api: "openai-completions", provider: "custom" });

		expect(luna.compat.supportsSamplingParams).toBe(false);
		expect(gpt5.compat.supportsSamplingParams).toBe(false);
		expect(gpt5Mini.compat.supportsSamplingParams).toBe(false);
		expect(gpt5Chat.compat.supportsSamplingParams).toBe(false);
		expect(oThree.compat.supportsSamplingParams).toBe(false);
		expect(gpt4o.compat.supportsSamplingParams).toBe(true);
		expect(kimi.compat.supportsSamplingParams).toBe(true);
	});

	it("encodes effort-dial-less reasoners as thinking: undefined", () => {
		const model = createModel({
			id: "grok-build",
			api: "openai-responses",
			provider: "custom",
			compat: { supportsReasoningEffort: false },
		});

		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeUndefined();
		expect(getSupportedEfforts(model)).toEqual([]);
		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("bakes the wire-exact five-tier low..max ladder on GPT-5.6 wire-effort APIs", () => {
		const codex = createModel({
			id: "gpt-5.6-sol",
			api: "openai-responses",
			provider: "github-copilot",
		});

		expect(codex.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});

		// Stale baked metadata (caches/discovery) — including shifted-era maps —
		// remains authoritative when explicitly authored.
		const staleOpenRouter = createModel({
			id: "openai/gpt-5.6-terra",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: {
					minimal: "low",
					low: "medium",
					medium: "high",
					high: "xhigh",
					xhigh: "max",
				},
			},
		});

		expect(staleOpenRouter.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: {
				minimal: "low",
				low: "medium",
				medium: "high",
				high: "xhigh",
				xhigh: "max",
			},
		});
	});
});

describe("model thinking runtime helpers", () => {
	it("clamps from explicit metadata instead of inferring from model id", () => {
		const model = createModel({
			id: "custom-reasoner",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		});

		// Explicit metadata owns the ladder; the `-reasoner` pair token still
		// backfills the mandatory-thinking floor (variant orphans cannot
		// disable reasoning).
		expect(model.thinking).toEqual({ mode: "effort", efforts: [Effort.Medium, Effort.High], requiresEffort: true });
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.Medium);
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
	});

	it('forces "off" for non-reasoning models', () => {
		const model = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "custom",
			reasoning: false,
		});

		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("derives binary-thinking fallback from resolved compat when catalog compat is partial", () => {
		const model = createModel({
			id: "qwen/qwen3-32b",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			compat: { supportsToolChoice: true },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("exposes wire-exact adaptive ladders for Copilot-hosted Anthropic models", () => {
		const fable = createModel({
			id: "anthropic/claude-fable-5",
			api: "openai-completions",
			provider: "github-copilot",
		});
		const opus46 = createModel({
			id: "anthropic/claude-opus-4.6",
			api: "openai-completions",
			provider: "github-copilot",
		});
		const sonnet46 = createModel({
			id: "anthropic/claude-sonnet-4.6",
			api: "openai-completions",
			provider: "github-copilot",
		});
		const sonnet5 = createModel({
			id: "anthropic/claude-sonnet-5",
			api: "openai-completions",
			provider: "github-copilot",
		});
		expect(fable.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus46.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(sonnet46.thinking?.efforts.at(-1)).toBe(Effort.High);
		expect(sonnet5.thinking?.efforts.at(-1)).toBe(Effort.Max);
		expect(() => requireSupportedEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
	});

	it("rejects effort requests against un-built reasoning specs", () => {
		const spec = {
			id: "broken-reasoner",
			name: "Broken Reasoner",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as ModelSpec<"openai-responses">;

		expect(() => requireSupportedEffort(spec, Effort.High)).toThrow(/not supported/);
	});

	it("drops authored thinking on non-reasoning models and re-derives empty efforts", () => {
		const nonReasoning = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: false,
			thinking: { mode: "effort", efforts: [Effort.High] },
		});
		expect(nonReasoning.thinking).toBeUndefined();

		// Empty explicit efforts are treated as absent metadata: infer instead.
		const emptyEfforts = createModel({
			id: "gpt-5.2-codex",
			api: "openai-responses",
			provider: "github-copilot",
			thinking: { mode: "effort", efforts: [] },
		});
		expect(emptyEfforts.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});
});

describe("generic chat-template thinking dialect", () => {
	it("preserves an explicit model effort ladder and derives the thinking-off wire mode", () => {
		const model = createModel({
			id: "deepseek-flash-v4",
			name: "DeepSeek Flash V4",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			compat: {
				supportsReasoningEffort: true,
				thinkingFormat: "chat-template",
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortMap: {
					[Effort.Minimal]: "low",
					[Effort.Low]: "low",
					[Effort.Medium]: "high",
					[Effort.High]: "high",
					[Effort.XHigh]: "max",
					[Effort.Max]: "max",
				},
			},
		});

		expect(model.compat.thinkingFormat).toBe("chat-template");
		expect(model.compat.reasoningDisableMode).toBe("chat-template-thinking-false");
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortMap: {
				[Effort.Minimal]: "low",
				[Effort.Low]: "low",
				[Effort.Medium]: "high",
				[Effort.High]: "high",
				[Effort.XHigh]: "max",
				[Effort.Max]: "max",
			},
		});
	});
});

describe("default reasoning effort", () => {
	it("defaults an effort-less clamp to the tier routing to requestModelId, else the floor (issue #9478)", () => {
		// A collapsed row whose default wire id is a non-floor tier clamps to the
		// effort that routes there, not the numeric minimum.
		const grok = buildModel({
			id: "cursor-grok-4.6",
			name: "Grok 4.6",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			requestModelId: "cursor-grok-4.6-medium",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				requiresEffort: true,
				effortRouting: {
					[Effort.Low]: "cursor-grok-4.6-low",
					[Effort.Medium]: "cursor-grok-4.6-medium",
					[Effort.High]: "cursor-grok-4.6-high",
					[Effort.XHigh]: "cursor-grok-4.6-xhigh",
				},
			},
		});
		expect(defaultSupportedEffort(grok)).toBe(Effort.Medium);
		expect(minimumSupportedEffort(grok)).toBe(Effort.Low);

		// Families whose default already is the floor are unchanged.
		const floorDefault = createModel({
			id: "custom-reasoner",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		});
		expect(defaultSupportedEffort(floorDefault)).toBe(minimumSupportedEffort(floorDefault));
	});
});
