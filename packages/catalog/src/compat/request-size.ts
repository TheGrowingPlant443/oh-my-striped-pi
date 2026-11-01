import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";
import { resolveCatalogAxes } from "./resolve";

const imageBudgetCache = new Map<string, number | null>();
const IMAGE_BUDGET_CACHE_MAX = 8192;

/**
 * Maximum encoded inline-image bytes retained per request, when the deployment declares a byte budget.
 */
export function resolveInlineImageByteBudget(model: Model): number | undefined {
	const key = `${model.provider} ${model.id} ${model.api}`;
	let budget = imageBudgetCache.get(key);
	if (budget === undefined) {
		const value = resolveCatalogAxes(toModelSpec(model)).inlineImageByteBudget;
		budget = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
		if (imageBudgetCache.size >= IMAGE_BUDGET_CACHE_MAX) imageBudgetCache.clear();
		imageBudgetCache.set(key, budget);
	}
	return budget ?? undefined;
}

/**
 * Largest request body the deployment accepts (`request-body-byte-limit`), or `undefined` when no rule names it.
 */
export function resolveRequestBodyByteLimit(model: Model): number | undefined {
	const value = resolveCatalogPolicy(model).requestBodyByteLimit;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Most images one request to this deployment may carry, or `undefined` when no rule names it.
 * A configured `model.imageCountBudget` overrides the deployment's declared policy.
 */
export function resolveImageCountBudget(model: Model): number | undefined {
	if (model.imageCountBudget !== undefined) return model.imageCountBudget;
	const policy = resolveCatalogPolicy(model);
	const value = policy.imageCountBudget;
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
