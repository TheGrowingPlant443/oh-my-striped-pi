/** Read live model request settings for main, advisor, and auxiliary streams. */
import { fitOutputTokensToContextWindow, type StreamFn, Tokenizer } from "@oh-my-striped-pi/pi-agent-core";
import { type SimpleStreamOptions, streamSimple } from "@oh-my-striped-pi/pi-ai";
import { openAIResponsesReplaysNativeHistory } from "@oh-my-striped-pi/pi-ai/providers/openai-responses-state";
import type { Settings } from "../config/settings";

import {
	cfgModelLoopGuardCheckAssistantContent,
	cfgModelLoopGuardEnabled,
	cfgOmitThinking,
	cfgProvidersCacheRetention,
	cfgProvidersMaxInFlightRequests,
	cfgProvidersStreamFirstEventTimeoutSeconds,
	cfgProvidersStreamIdleTimeoutSeconds,
	cfgRetryMaxDelayMs,
	cfgTextVerbosity,
	validateProviderMaxInFlightRequests,
} from "./settings";

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/**
 * Build a {@link StreamFn} that reads provider routing/guard settings from
 * `settings` per call and forwards to `base` (defaults to `streamSimple`).
 *
 * Caller-supplied `streamOptions` always win — the helper only fills holes.
 * The one exception is the output cap, which is lowered when prompt plus cap
 * would exceed the model's context window (see
 * {@link fitOutputTokensToContextWindow}); every request this session drives,
 * including side turns like `/btw`, goes through here.
 */
export function createSettingsAwareStreamFn(settings: Settings, base: StreamFn = streamSimple): StreamFn {
	// One tokenizer per reading model and native-history replay state, so
	// per-message counts are reused across requests: its prices (images,
	// replayed thinking and reasoning) belong to that model and request state.
	const tokenizers = new Map<string, Tokenizer>();
	return (model, context, streamOptions) => {
		const textVerbosity = model.api === "openai-responses" ? cfgTextVerbosity.get(settings) : undefined;
		// "auto" leaves the option unset so provider defaults and the
		// OMSP_CACHE_RETENTION env override keep working; anything else is an
		// explicit per-request retention (long restores 1h Anthropic TTLs and
		// implicitly disables the short-entry keep-alive refresh loop).
		const cacheRetentionSetting = cfgProvidersCacheRetention.get(settings);
		const cacheRetention = cacheRetentionSetting === "auto" ? undefined : cacheRetentionSetting;
		const streamFirstEventTimeoutMs = timeoutSecondsToMs(cfgProvidersStreamFirstEventTimeoutSeconds.get(settings));
		const streamIdleTimeoutMs = timeoutSecondsToMs(cfgProvidersStreamIdleTimeoutSeconds.get(settings));
		const maxInFlightRequests = validateProviderMaxInFlightRequests(
			streamOptions?.maxInFlightRequests ?? cfgProvidersMaxInFlightRequests.get(settings),
		);
		// A cold Responses session rebuilds turns without their encrypted reasoning.
		// A request that may wait for a provider slot is built when it gets one,
		// after a concurrent response may have warmed the session, so it is
		// fitted as replaying.
		const nativeHistoryReplay =
			Object.hasOwn(maxInFlightRequests, model.provider) ||
			openAIResponsesReplaysNativeHistory(model, streamOptions?.providerSessionState);
		const tokenizerKey = `${model.provider}\0${model.api}\0${model.id}\0${nativeHistoryReplay}`;
		let tokenizer = tokenizers.get(tokenizerKey);
		if (!tokenizer) {
			tokenizer = new Tokenizer(model, { nativeHistoryReplay });
			tokenizers.set(tokenizerKey, tokenizer);
		}
		const maxTokens = fitOutputTokensToContextWindow(model, context, streamOptions?.maxTokens, tokenizer);
		const merged: SimpleStreamOptions = {
			...streamOptions,
			maxTokens,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			cacheRetention: streamOptions?.cacheRetention ?? cacheRetention,
			streamFirstEventTimeoutMs: streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
			streamIdleTimeoutMs: streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
			maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? cfgRetryMaxDelayMs.get(settings),
			maxInFlightRequests,
			loopGuard: {
				enabled: cfgModelLoopGuardEnabled.get(settings),
				checkAssistantContent: cfgModelLoopGuardCheckAssistantContent.get(settings),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? cfgOmitThinking.get(settings),
		};
		return base(model, context, merged);
	};
}
