import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
	type ResolvedModelRoleValue,
	type RoleChainCandidate,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { cfgRetryFallbackChains } from "../../session/settings";
import { SEARCH_ENGINE_MODELS } from "./provider";

export const DEFAULT_SEARCH_CHAIN = ["web/searxng", "web/firecrawl"];

/** Reuse role aliases and thinking syntax without treating web engines as model providers. */
export function resolveSearchRoleValue(
	value: string | undefined,
	settings?: Settings,
	roleLookup: ModelRoleLookup | undefined = settings,
): ResolvedModelRoleValue {
	const lookup: ModelRoleLookup = {
		getModelRole: role =>
			roleLookup?.getModelRole(role) ?? (role === "web" ? DEFAULT_SEARCH_CHAIN.join(",") : undefined),
	};
	for (const [matchedPatternIndex, pattern] of resolveConfiguredModelPatterns(value, lookup).entries()) {
		const selector = pattern.replace(/^web\//i, "");
		if (selector.includes("/")) continue;
		const id = splitThinkingSuffix(selector, 0, MAX_THINKING_SUFFIX_OPTIONS).base.toLowerCase();
		const pool = /^web\//i.test(pattern)
			? SEARCH_ENGINE_MODELS.filter(model => model.id === id)
			: SEARCH_ENGINE_MODELS;
		const resolved = resolveModelRoleValue(selector, pool, { settings });
		if (resolved.model) return { ...resolved, matchedPatternIndex };
	}
	return { model: undefined, explicitThinkingLevel: false, warning: undefined };
}

/** Effective independent search attempts, preserving explicit-only engines and empty fallback chains. */
export function resolveSearchChain(settings: Settings): RoleChainCandidate[] {
	const fallback = cfgRetryFallbackChains.get(settings).web;
	const explicitFallback = Array.isArray(fallback);
	const selectors = [
		{ selector: settings.getModelRole("web") || "@web", explicit: Object.hasOwn(settings.getModelRoles(), "web") },
		...(explicitFallback ? fallback : DEFAULT_SEARCH_CHAIN).map(selector => ({
			selector,
			explicit: explicitFallback,
		})),
	];
	const candidates: RoleChainCandidate[] = [];
	for (const { selector, explicit } of selectors) {
		const resolved = resolveSearchRoleValue(selector, settings);
		const model = resolved.model;
		if (!model) continue;
		const existing = candidates.find(candidate => candidate.model.id === model.id);
		if (existing) {
			if (explicit) existing.explicit = true;
			continue;
		}
		candidates.push({ model, explicit, thinkingLevel: resolved.thinkingLevel });
	}
	return candidates;
}
