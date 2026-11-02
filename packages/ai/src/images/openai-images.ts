import type { Model } from "@oh-my-striped-pi/pi-catalog/types";
import * as AIError from "../error";
import {
	decodeImageResponse,
	imageBaseUrl,
	postJson,
	postMultipart,
	resolveOpenAIImageSize,
	toDataUrl,
	validateImageInput,
} from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

/** Generate or edit images using an explicitly configured OpenAI-compatible endpoint. */
export async function generateOpenAIImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const baseUrl = imageBaseUrl(model);
	const fetchImpl = options.fetch ?? fetch;
	const size = resolveOpenAIImageSize(request.aspectRatio, request.imageSize);
	const count = request.count ?? 1;
	const wireModelId = model.requestModelId ?? model.id;
	const isGptImage = model.identity?.family === "gpt-image";
	const body = {
		model: wireModelId,
		prompt: request.prompt,
		n: count,
		...(isGptImage ? {} : { response_format: "b64_json" }),
		...(size ? { size } : {}),
	};
	const inputImages = request.inputImages ?? [];
	for (const image of inputImages) validateImageInput(image);
	let response: unknown;
	if (inputImages.length === 0) {
		response = await postJson({ model, url: `${baseUrl}/images/generations`, body, ...options, fetch: fetchImpl });
	} else {
		const form = new FormData();
		form.set("model", wireModelId);
		form.set("prompt", request.prompt);
		form.set("n", String(count));
		if (!isGptImage) form.set("response_format", "b64_json");
		if (size) form.set("size", size);
		for (const image of inputImages) {
			form.append("image", new File([Buffer.from(image.data, "base64")], "image", { type: image.mimeType }));
		}
		try {
			response = await postMultipart({
				model,
				url: `${baseUrl}/images/edits`,
				body: form,
				...options,
				fetch: fetchImpl,
			});
		} catch (error) {
			if (!(error instanceof AIError.ProviderHttpError) || error.status !== 404) throw error;
			response = await postJson({
				model,
				url: `${baseUrl}/images/generations`,
				body: {
					...body,
					input_references: inputImages.map(image => ({ type: "image_url", url: toDataUrl(image) })),
				},
				...options,
				fetch: fetchImpl,
			});
		}
	}
	return decodeImageResponse(response, fetchImpl, options.signal);
}
