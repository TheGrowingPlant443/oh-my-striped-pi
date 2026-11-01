/** Runtime discovery factories for the retained model providers. */
import type { KnownProvider } from "../compat/provider-ids";
import { providerEntries, providerEntry } from "../compat/providers";
import type { Api } from "../types";
import type { ModelManagerOptions } from "../model-manager";
import type { ModelManagerConfig, ProviderDescriptor } from "./descriptor-types";
import { githubCopilotModelManagerOptions } from "./openai-compat";
import { localModelManagerOptions } from "./special";
import {
	litellmModelManagerOptions,
	lmStudioModelManagerOptions,
	ollamaModelManagerOptions,
	vllmModelManagerOptions,
} from "./self-hosted";

export type { KnownProvider } from "../compat/provider-ids";

type ModelManagerFactory = (config: ModelManagerConfig) => ModelManagerOptions<Api>;

const MODEL_MANAGER_FACTORIES: Readonly<Record<KnownProvider, ModelManagerFactory>> = {
	"github-copilot": config => githubCopilotModelManagerOptions(config),
	local: () => localModelManagerOptions(),
	apple: () => ({ providerId: "apple" }),
	ollama: config => ollamaModelManagerOptions(config),
	"lm-studio": config => lmStudioModelManagerOptions(config),
	vllm: config => vllmModelManagerOptions(config),
	litellm: config => litellmModelManagerOptions(config),
};

function isKnownProvider(id: string): id is KnownProvider {
	return providerEntry(id) !== undefined;
}

/**
 * Runtime model-discovery descriptors: every catalog provider with a
 * model-manager factory, paired with its compiled KDL entry.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = Object.values(providerEntries()).flatMap(entry => {
	const createModelManagerOptions = isKnownProvider(entry.id) ? MODEL_MANAGER_FACTORIES[entry.id] : undefined;
	if (!createModelManagerOptions) return [];
	return [
		{
			providerId: entry.id,
			defaultModel: entry.defaultModel,
			createModelManagerOptions,
			allowUnauthenticated: entry.allowUnauthenticated,
			dynamicModelsAuthoritative: entry.dynamicModelsAuthoritative,
			skipCrossProviderReferenceFills: entry.skipCrossProviderReferenceFills,
		},
	];
});

/** Default model IDs for all known providers, from their KDL entries. */
export const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<KnownProvider, string>> = Object.fromEntries(
	Object.values(providerEntries()).map(entry => [entry.id, entry.defaultModel] as const),
) as Record<KnownProvider, string>;
