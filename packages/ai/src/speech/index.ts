import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { synthesizeOpenAiSpeech } from "./openai-speech";
import type { SpeechOptions, SpeechRequest, SpeechResult } from "./types";

export * from "./openai-speech";
export * from "./transport";
export * from "./types";

export const SPEECH_APIS = ["openai-speech"] as const;
export type SpeechApi = (typeof SPEECH_APIS)[number];

export function isSpeechApi(api: Api): api is SpeechApi {
	return api === "openai-speech";
}

/** Synthesize speech through an explicitly configured compatible endpoint. */
export function synthesizeSpeech(
	model: Model<Api>,
	request: SpeechRequest,
	options: SpeechOptions,
): Promise<SpeechResult> {
	if (model.api === "openai-speech") return synthesizeOpenAiSpeech(model, request, options);
	throw new AIError.ConfigurationError(`Unsupported speech API: ${model.api}`);
}
