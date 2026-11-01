import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { type Api, type Model, modelKind, type ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Select a bundled chat model by behavior so tests survive catalog roster changes. */
export function getTestModel(provider: GeneratedProvider, matches?: (model: Model) => boolean): Model {
	const model = getBundledModels(provider).find(
		candidate => modelKind(candidate) === "chat" && (matches === undefined || matches(candidate)),
	);
	if (!model) throw new Error(`No bundled chat model matches the ${provider} test fixture`);
	return model;
}

/** Registry fixtures require numeric limits, unlike discovered models. */
export function toProviderModelConfig(model: ModelSpec<Api>): ProviderModelConfig {
	if (typeof model.contextWindow !== "number" || typeof model.maxTokens !== "number") {
		throw new Error(`Provider fixture requires numeric limits: ${model.id}`);
	}
	return model as ProviderModelConfig;
}
