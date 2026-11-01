import { seedModels } from "../compat/providers";
import type { ModelManagerOptions } from "../model-manager";
import { resolveModelCacheProviderId } from "./cache-provider-id";

export function localModelManagerOptions(): ModelManagerOptions<"local-inference"> {
	return {
		providerId: "local",
		cacheProviderId: resolveModelCacheProviderId("local"),
		staticModels: seedModels<"local-inference">("local"),
	};
}
