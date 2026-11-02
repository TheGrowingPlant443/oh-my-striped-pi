// Ported from NousResearch/hermes-agent (MIT) — tools/tts_tool.py L167-171, L896-959.
// On-device and configured-endpoint speech models share the speech role chain.

import { type } from "@oh-my-striped-pi/omptype";
import type { AgentToolResult } from "@oh-my-striped-pi/pi-agent-core";
import type { Model } from "@oh-my-striped-pi/pi-ai";
import { ConfigurationError, MissingApiKeyError, ProviderHttpError } from "@oh-my-striped-pi/pi-ai/error";
import { synthesizeSpeech } from "@oh-my-striped-pi/pi-ai/speech";
import { prompt } from "@oh-my-striped-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain, type RoleChainCandidate } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { settings, type Settings } from "../config/settings";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import ttsDescription from "../prompts/tools/tts.md" with { type: "text" };
import { DEFAULT_TTS_VOICE, KOKORO_VOICES } from "../tts/models";
import { ttsClient } from "../tts/tts-client";
import { encodeWav } from "../tts/wav";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";

import { cfgTtsLocalSpeed, cfgTtsLocalVoice } from "../tts/settings";

const ttsSchema = type({
	text: "1 <= string <= 15000",
	"voice_id?": "string",
	output_path: "string",
});

type TtsSchemaType = typeof ttsSchema.infer;

interface TtsToolDetails {
	bytes: number;
	voiceId: string;
	codec: "wav" | "mp3";
	backend: "local-inference" | "openai-speech";
}

/** Resolve speech candidates in their configured role order. */
export function resolveSpeechCandidates(
	settingsInstance: Settings,
	modelRegistry: ModelRegistry,
): RoleChainCandidate[] {
	const pool = roleCandidatePool("speech", settingsInstance, modelRegistry);
	const candidates = resolveRoleChain("speech", settingsInstance, pool);
	return candidates;
}

/**
 * Resolve the on-disk path for local synthesis. Local output is always WAV (no
 * MP3 encoder is bundled), so an `.mp3` (or any non-`.wav`) request is rewritten
 * to a sibling `.wav` and flagged so the tool result can note the substitution.
 */
export function resolveLocalWavPath(outputPath: string): { wavPath: string; substituted: boolean } {
	const lower = outputPath.toLowerCase();
	if (lower.endsWith(".wav")) return { wavPath: outputPath, substituted: false };
	const slash = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
	const dot = outputPath.lastIndexOf(".");
	const base = dot > slash ? outputPath.slice(0, dot) : outputPath;
	return { wavPath: `${base}.wav`, substituted: true };
}

function readLocalVoice(settingsInstance: Settings): string {
	try {
		const value = cfgTtsLocalVoice.get(settingsInstance);
		return typeof value === "string" && value ? value : DEFAULT_TTS_VOICE;
	} catch {
		return DEFAULT_TTS_VOICE;
	}
}

async function synthesizeLocal(
	model: Model,
	params: TtsSchemaType,
	settingsInstance: Settings,
	cwd: string,
	outputPath: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const voice = readLocalVoice(settingsInstance);
	const speed = cfgTtsLocalSpeed.get(settingsInstance);
	const audio = await ttsClient.synthesize(model.id, params.text, { voice, speed, signal });
	if (!audio) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `Local TTS synthesis failed (model=${model.id}). The on-device worker may be unavailable or the model download was interrupted.`,
				},
			],
		};
	}

	const { wavPath, substituted } = resolveLocalWavPath(outputPath);
	const wav = encodeWav(audio.pcm, audio.sampleRate);
	await Bun.write(wavPath, wav);
	const displayPath = formatPathRelativeToCwd(wavPath, cwd);
	const note = substituted ? ` Local output is WAV (PCM16), so the requested path was changed to .wav.` : "";
	return {
		content: [
			{
				type: "text",
				text: `Saved ${wav.length} bytes to ${displayPath} (voice=${model.id}/${voice}, codec=wav, backend=local, ${audio.sampleRate} Hz).${note}`,
			},
		],
		details: { bytes: wav.length, voiceId: `${model.id}/${voice}`, codec: "wav", backend: "local-inference" },
	};
}

export const ttsTool: CustomTool<typeof ttsSchema, TtsToolDetails> = {
	name: "tts",
	label: "Speech Generation",
	strict: false,
	approval: "write",
	description: prompt.render(ttsDescription, {
		localVoices: KOKORO_VOICES.map(v => (v.id === DEFAULT_TTS_VOICE ? `${v.id} (default)` : v.id)).join(", "),
	}),
	parameters: ttsSchema,
	async execute(
		_toolCallId: string,
		params: TtsSchemaType,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
		const cwd = ctx.sessionManager.getCwd();
		const outputPath = resolveToCwd(params.output_path, cwd);

		const settingsInstance = ctx.settings ?? settings;
		const candidates = resolveSpeechCandidates(settingsInstance, ctx.modelRegistry);
		if (candidates.length === 0) {
			return {
				isError: true,
				content: [{ type: "text", text: "No available speech model matches the speech role." }],
			};
		}

		const failures: string[] = [];
		for (const { model } of candidates) {
			try {
				if (model.api === "local-inference") {
					return await synthesizeLocal(model, params, settingsInstance, cwd, outputPath, signal);
				}
				if (model.api !== "openai-speech") throw new ConfigurationError(`Unsupported speech API: ${model.api}`);
				if (!model.baseUrl?.trim()) throw new ConfigurationError("Speech model requires an explicit base URL");
				const codec = outputPath.toLowerCase().endsWith(".wav") ? "wav" : "mp3";
				const result = await synthesizeSpeech(
					{
						...model,
						resolveHeaders: headerSignal => ctx.modelRegistry.resolveModelHeaders(model, headerSignal),
					},
					{
						text: params.text,
						format: codec,
						...(params.voice_id !== undefined ? { voice: params.voice_id } : {}),
					},
					{
						apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
						fetch: ctx.fetch,
						signal,
					},
				);
				await Bun.write(outputPath, result.audio);
				const voiceId = params.voice_id ?? "default";
				return {
					content: [
						{
							type: "text",
							text: `Saved ${result.audio.length} bytes to ${formatPathRelativeToCwd(outputPath, cwd)} (model=${model.provider}/${model.id}, voice=${voiceId}, codec=${codec}).`,
						},
					],
					details: { bytes: result.audio.length, voiceId, codec, backend: "openai-speech" },
				};
			} catch (error) {
				if (signal?.aborted) throw error;
				if (!(error instanceof MissingApiKeyError || error instanceof ProviderHttpError)) throw error;
				failures.push(`${model.provider}/${model.id}: ${error.message}`);
			}
		}
		return {
			isError: true,
			content: [{ type: "text", text: `Speech synthesis failed for every candidate: ${failures.join("; ")}` }],
		};
	},
};
