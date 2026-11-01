import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl } from "../types";

/** Config passed to a provider's runtime model-manager factory. */
export interface ModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	/** The supplied fetch already applies provider-specific authentication. */
	authenticated?: boolean;
}

/** Runtime model discovery for a retained provider. */
export interface ProviderDescriptor {
	providerId: string;
	createModelManagerOptions(config: ModelManagerConfig): ModelManagerOptions<Api>;
	defaultModel: string;
	allowUnauthenticated?: boolean;
	dynamicModelsAuthoritative?: boolean;
	skipCrossProviderReferenceFills?: boolean;
}
