import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelKind } from "@oh-my-pi/pi-catalog/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	parseRetryFallbackSelector,
	resolveRetryFallbackChainKey,
	validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function companyModel(
	provider: string,
	id: string,
	efforts: Effort[] = [Effort.Low, Effort.Medium, Effort.High],
): Model {
	return buildModel({
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://models.company.test/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
): RetryFallbackResolutionContext {
	const models = [
		companyModel("company-google", "gemini-3.5-flash"),
		companyModel("company-vertex", "gemini-3.5-flash"),
		companyModel("company-gateway", "google/gemini-3.5-flash"),
		companyModel("company-openai", "gpt-4o-mini"),
		companyModel("company-secondary", "grok-4.7", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "company-gateway/google/gemini-3.5-flash";
		const exactContext = createContext(
			{
				default: ["company-openai/gpt-4o-mini"],
				task: ["company-google/gemini-3.5-flash"],
				"company-gateway/*": ["company-openai/gpt-4o-mini"],
				"company-gateway/google/*": ["company-vertex/*"],
				[selector]: ["company-google/gemini-3.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["company-openai/gpt-4o-mini"],
				task: ["company-google/gemini-3.5-flash"],
				"company-gateway/*": ["company-openai/gpt-4o-mini"],
				"company-gateway/google/*": ["company-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe(
			"company-gateway/google/*",
		);

		const roleContext = createContext(
			{ default: ["company-openai/gpt-4o-mini"], task: ["company-google/gemini-3.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		const defaultContext = createContext({ default: ["company-openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBe("default");
	});

	it("does not let a later shared-assignment role steal the default chain", () => {
		const selector = "company-gateway/google/gemini-3.5-flash";
		const context = createContext(
			{
				vision: ["company-openai/gpt-4o-mini"],
				default: ["company-google/gemini-3.5-flash"],
			},
			{ default: selector, vision: selector },
		);
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "default")).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "vision")).toBe("vision");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["company-openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "company-openai/gpt-4o-mini",
				provider: "company-openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["company-google/gemini-3.5-flash", "company-openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "company-google/gemini-3.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "company-gateway/google/gemini-3.5-flash";
		const context = createContext({ "company-gateway/google/*": ["company-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "company-gateway/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "company-vertex/gemini-3.5-flash",
				provider: "company-vertex",
				id: "gemini-3.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("carries per-entry thinking levels while bare entries inherit", () => {
		const context = createContext({ default: ["company-openai/gpt-4o-mini:low", "company-google/gemini-3.5-flash"] });
		const candidates = findRetryFallbackCandidates(context, "default", "company-openai/gpt-4o-mini");
		expect(candidates.map(candidate => candidate.raw)).toEqual([
			"company-openai/gpt-4o-mini:low",
			"company-google/gemini-3.5-flash",
		]);
		expect(candidates[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// Bare entries carry no level so the failing turn's effort applies at switch time.
		expect(candidates[1]?.thinkingLevel).toBeUndefined();
	});

	it("keeps the auto sentinel on parsed selectors instead of collapsing it to no suffix", () => {
		const context = createContext({
			default: ["company-openai/gpt-4o-mini:auto", "company-google/gemini-3.5-flash"],
		});
		expect(parseRetryFallbackSelector("company-openai/gpt-4o-mini:auto", context.modelLookup)?.thinkingLevel).toBe(
			"auto",
		);
		expect(
			parseRetryFallbackSelector("company-openai/gpt-4o-mini", context.modelLookup)?.thinkingLevel,
		).toBeUndefined();
		expect(parseRetryFallbackSelector("company-openai/gpt-4o-mini:low", context.modelLookup)?.thinkingLevel).toBe(
			ThinkingLevel.Low,
		);
		const candidates = findRetryFallbackCandidates(context, "default", "company-secondary/grok-4.7:high");
		expect(candidates.map(candidate => candidate.thinkingLevel)).toEqual(["auto", undefined]);
	});

	it("matches an auto-keyed primary at any effort without demoting it behind a fixed effort", () => {
		const model = companyModel("company-messages", "claude-sonnet-4-5");
		const auto = "company-messages/claude-sonnet-4-5:auto";
		const low = "company-messages/claude-sonnet-4-5:low";
		const context = createContext({
			[auto]: ["company-openai/gpt-4o-mini"],
			[low]: ["company-google/gemini-3.5-flash"],
		});
		expect(resolveRetryFallbackChainKey(context, auto, model)).toBe(auto);
		expect(resolveRetryFallbackChainKey(context, low, model)).toBe(low);
		expect(resolveRetryFallbackChainKey(context, "company-messages/claude-sonnet-4-5:high", model)).toBe(auto);
	});

	it("inherits the default chain only for chat roles and preserves explicit empty kind chains", () => {
		const defaultChain = ["company-openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains(
			{ default: defaultChain, slow: ["company-google/gemini-3.5-flash"], judge: [] },
			["default", "task", "slow", "judge", "image", "web"],
		);
		expect(expanded.task).toBe(defaultChain);
		expect(expanded.slow).toEqual(["company-google/gemini-3.5-flash"]);
		expect(expanded.judge).toEqual([]);
		expect(expanded.image).toBeUndefined();
		expect(expanded.web).toBeUndefined();
	});

	it("prefers an exact model+effort key over a different-effort key regardless of object order", () => {
		const model = companyModel("company-google", "gemini-3.5-flash");
		const low = "company-google/gemini-3.5-flash:low";
		const max = "company-google/gemini-3.5-flash:max";

		const maxFirst = createContext({
			[max]: ["company-openai/gpt-4o-mini:max"],
			[low]: ["company-openai/gpt-4o-mini:low"],
		});
		expect(resolveRetryFallbackChainKey(maxFirst, low, model)).toBe(low);
		expect(findRetryFallbackCandidates(maxFirst, low, low, model).map(candidate => candidate.raw)).toEqual([
			"company-openai/gpt-4o-mini:low",
		]);

		const lowFirst = createContext({
			[low]: ["company-openai/gpt-4o-mini:low"],
			[max]: ["company-openai/gpt-4o-mini:max"],
		});
		expect(resolveRetryFallbackChainKey(lowFirst, low, model)).toBe(low);
	});

	it("lets a suffixless key match any effort but an exact effort key still wins", () => {
		const model = companyModel("company-google", "gemini-3.5-flash");
		const low = "company-google/gemini-3.5-flash:low";
		const suffixless = "company-google/gemini-3.5-flash";

		const baseOnly = createContext({ [suffixless]: ["company-openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(baseOnly, low, model)).toBe(suffixless);

		const suffixlessFirst = createContext({
			[suffixless]: ["company-openai/gpt-4o-mini"],
			[low]: ["company-openai/gpt-4o-mini:low"],
		});
		expect(resolveRetryFallbackChainKey(suffixlessFirst, low, model)).toBe(low);
	});

	it("never escalates to a different-effort chain when no matching effort is configured", () => {
		const model = companyModel("company-google", "gemini-3.5-flash");
		const low = "company-google/gemini-3.5-flash:low";
		const max = "company-google/gemini-3.5-flash:max";

		const maxOnly = createContext({ [max]: ["company-openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, low, model)).toBeUndefined();

		const maxWithDefault = createContext({
			[max]: ["company-openai/gpt-4o-mini:max"],
			default: ["company-openai/gpt-4o-mini"],
		});
		expect(resolveRetryFallbackChainKey(maxWithDefault, low, model)).toBe("default");

		const maxWithHint = createContext({
			[max]: ["company-openai/gpt-4o-mini:max"],
			smol: ["company-openai/gpt-4o-mini:medium"],
		});
		expect(resolveRetryFallbackChainKey(maxWithHint, low, model, "smol")).toBe("smol");
	});

	it("treats effort aliases as equivalent to their canonical form when matching keys", () => {
		const model = companyModel("company-google", "gemini-3.5-flash");
		const canonicalHigh = "company-google/gemini-3.5-flash:high";
		const aliasKey = "company-google/gemini-3.5-flash:hi";

		const context = createContext({ [aliasKey]: ["company-openai/gpt-4o-mini:high"] });
		expect(resolveRetryFallbackChainKey(context, canonicalHigh, model)).toBe(aliasKey);
		expect(
			findRetryFallbackCandidates(context, aliasKey, canonicalHigh, model).map(candidate => candidate.raw),
		).toEqual(["company-openai/gpt-4o-mini:high"]);
	});

	it("matches a requested effort key to the active model's clamped effort", () => {
		const model = companyModel("company-google", "gemini-3.5-flash");
		const high = "company-google/gemini-3.5-flash:high";
		const max = "company-google/gemini-3.5-flash:max";

		const maxOnly = createContext({ [max]: ["company-openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, high, model)).toBe(max);
		expect(findRetryFallbackCandidates(maxOnly, max, high, model).map(candidate => candidate.raw)).toEqual([
			"company-openai/gpt-4o-mini:max",
		]);

		const exactHigh = createContext({
			[max]: ["company-openai/gpt-4o-mini:max"],
			[high]: ["company-openai/gpt-4o-mini:high"],
		});
		expect(resolveRetryFallbackChainKey(exactHigh, high, model)).toBe(high);
	});

	it("uses the default chain when the live model matches no role primary (#12421)", () => {
		const live = "company-gateway/google/gemini-3.5-flash";
		const context = createContext(
			{
				default: ["company-openai/gpt-4o-mini", "company-google/gemini-3.5-flash"],
				slow: ["company-openai/gpt-4o-mini"],
			},
			{ default: "company-google/gemini-3.5-flash", slow: "company-openai/gpt-4o-mini" },
		);
		expect(resolveRetryFallbackChainKey(context, live)).toBe("default");
		// The effective chain leads with `default`'s primary, then the configured entries.
		expect(findRetryFallbackCandidates(context, "default", live).map(candidate => candidate.raw)).toEqual([
			"company-google/gemini-3.5-flash",
			"company-openai/gpt-4o-mini",
		]);
	});

	it("keeps a role's chain when the live effort differs from the role's explicit effort (#13789)", () => {
		const model = companyModel("company-secondary", "grok-4.7", [
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
		const high = "company-secondary/grok-4.7:high";
		const xhigh = "company-secondary/grok-4.7:xhigh";

		// A spawn `effort` or `/thinking` moved the session off the role's effort.
		const roleOnly = createContext({ task: ["company-openai/gpt-4o-mini"] }, { task: high });
		expect(resolveRetryFallbackChainKey(roleOnly, xhigh, model)).toBe("task");
		expect(findRetryFallbackCandidates(roleOnly, "task", xhigh, model).map(candidate => candidate.raw)).toEqual([
			"company-openai/gpt-4o-mini",
		]);

		// A role assigned the live effort still outranks one assigned another effort.
		const exactRole = createContext(
			{ task: ["company-openai/gpt-4o-mini"], slow: ["company-openai/gpt-4o-mini:high"] },
			{ task: high, slow: xhigh },
		);
		expect(resolveRetryFallbackChainKey(exactRole, xhigh, model)).toBe("slow");

		// Model-selector keys stay effort-exact.
		const modelKey = createContext({ [high]: ["company-openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(modelKey, xhigh, model)).toBeUndefined();
	});
});

describe("retry fallback kind-role validation", () => {
	const chatModel = companyModel("company-openai", "gpt-4o-mini");
	const judgeModel: Model = { ...chatModel, id: "test-judge", name: "Test Judge", kind: "judge" };
	const imageModel: Model = { ...chatModel, id: "test-image", name: "Test Image", kind: "image" };
	const models = [chatModel, judgeModel, imageModel];
	const registry = {
		getAll: (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? models : models.filter(model => (model.kind ?? "chat") === kind),
		getAvailable: (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? models : models.filter(model => (model.kind ?? "chat") === kind),
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
		hasProvider: (provider: string) => models.some(model => model.provider === provider),
		getProviderModels: (provider: string) => models.filter(model => model.provider === provider),
	};

	it("accepts aliases and fuzzy patterns that resolve to the role's model kind", () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${judgeModel.provider}/${judgeModel.id}` },
			"retry.fallbackChains": { judge: ["@judge", "test-judge"] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));

		expect(warnings).toEqual([]);
	});

	it("validates compatibility without requiring provider credentials or availability", () => {
		const settings = Settings.isolated({
			modelRoles: { image: `${imageModel.provider}/${imageModel.id}` },
			"retry.fallbackChains": { image: ["@image", "test-image"] },
		});
		const warnings: string[] = [];

		const unavailableRegistry = { ...registry, getAvailable: () => [] };
		validateRetryFallbackChains(settings, unavailableRegistry, warning => warnings.push(warning));

		expect(warnings).toEqual([]);
	});

	it("warns when kind-role entries resolve to the wrong kind or no model", () => {
		const wrongKindSelector = `${imageModel.provider}/${imageModel.id}`;
		const missingSelector = `${chatModel.provider}/missing-judge`;
		const settings = Settings.isolated({
			"retry.fallbackChains": { judge: [wrongKindSelector, missingSelector] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));

		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain(wrongKindSelector);
		expect(warnings[1]).toContain(missingSelector);
	});

	it("validates provider-qualified kind-role entries without composing the full catalog", () => {
		let fullCatalogReads = 0;
		const countingRegistry = {
			...registry,
			getAll: (kind: ModelKind | "all" = "chat") => {
				fullCatalogReads++;
				return registry.getAll(kind);
			},
		};
		const warnings: string[] = [];

		validateRetryFallbackChains(
			Settings.isolated({ "retry.fallbackChains": { judge: [`${judgeModel.provider}/${judgeModel.id}`] } }),
			countingRegistry,
			warning => warnings.push(warning),
		);
		expect(warnings).toEqual([]);
		expect(fullCatalogReads).toBe(0);

		// A provider-less pattern has no provider slice to check; it must still resolve.
		validateRetryFallbackChains(
			Settings.isolated({ "retry.fallbackChains": { judge: ["test-judge"] } }),
			countingRegistry,
			warning => warnings.push(warning),
		);
		expect(warnings).toEqual([]);
		expect(fullCatalogReads).toBe(1);
	});

	it("keeps pending-discovery suppression for unresolved kind-role entries", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": { judge: ["litellm/pending-judge"] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning), {
			isDiscoveryPending: provider => provider === "litellm",
		});

		expect(warnings).toEqual([]);
	});
});
