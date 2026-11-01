import { type Api, IMAGE_GENERATION_APIS, type ImageGenerationApi, type Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { generateOpenAIImage } from "./openai-images";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

export * from "./openai-images";
export * from "./types";
export type { ImageGenerationApi } from "@oh-my-pi/pi-catalog/types";

export function isImageGenerationApi(api: Api): api is ImageGenerationApi {
	return (IMAGE_GENERATION_APIS as readonly Api[]).includes(api);
}

/** Generate or edit images through an explicitly configured compatible endpoint. */
export function generateImage(
	model: Model<Api>,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	if (model.api === "openai-images") return generateOpenAIImage(model, request, options);
	throw new AIError.ValidationError(`Image generation does not support model API ${model.api}`);
}
