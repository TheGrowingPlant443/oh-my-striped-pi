# tts

> Generate a speech audio file from text using the speech model role and write it to `output_path`.

## Source

- Entry: `packages/coding-agent/src/tools/tts.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/tts.md`
- Speech role selection: `packages/coding-agent/src/config/model-resolver.ts`, role default chains in `packages/catalog/src/compat/rules/runtime/behavior.kdl` (`roleDefaultModels()`)
- Local voice catalog: `packages/coding-agent/src/tts/models.ts`
- Local worker client: `packages/coding-agent/src/tts/tts-client.ts`
- Session injection: `packages/coding-agent/src/sdk.ts` (`speechgen.enabled`)

The SDK registers this write-approved custom tool when `speechgen.enabled=true` (default `false`), unless tool registration is restricted or a same-named tool is already registered. Live setting changes add or remove the SDK-owned entry. The tool has `strict=false`.

## Inputs

| Field         | Type             | Required | Description                                                                                                                                          |
| ------------- | ---------------- | -------: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`        | `string`         |      Yes | Text to synthesize. Must be `1..15000` JavaScript string characters.                                                                                 |
| `output_path` | `string` | Yes | Destination resolved relative to session cwd. Non-WAV paths are rewritten to a sibling `.wav` path. |

## Outputs

- Success returns one text block and `details = { bytes, voiceId, codec, backend }`.
   - Local: names the actual WAV path, `<model>/<voice>`, sample rate, and any container substitution.
   - `backend` is `"local-inference"` and `codec` is `"wav"`.
- No matching speech model or a `null` local-worker response returns `isError: true` with one text block and no `details`.
- Other exceptions, caller cancellation, and transport timeouts propagate.

## Flow

1. Resolve cwd and destination.
2. Resolve the on-device `tts` model from `modelRoles.speech` and `retry.fallbackChains.speech`, defaulting to `local/kokoro`.
3. Call the local worker with the selected model id, `tts.localVoice`, `tts.localSpeed`, and the caller's cancellation signal.
4. Encode PCM16 WAV and write the actual WAV destination. A `null` worker response returns an error; thrown errors propagate.

## Modes / Variants

- Local: Kokoro-82M on-device inference; always WAV/PCM16. Model weights may need downloading before local inference can run.

## Side Effects

- Filesystem: writes the destination, or a sibling `.wav` for a non-WAV destination.
- Network: local model loading may download/cache weights; synthesis stays on-device.
- Session state: reads cwd, model registry, speech-role settings, `tts.localVoice`, and `tts.localSpeed`.
- Cancellation: local synthesis receives the caller signal.
- Streaming: single-shot; no `onUpdate` progress.

## Limits & Caps

- Text limit: `1..15_000` JavaScript string characters.
- Default local model: `local/kokoro` (`onnx-community/Kokoro-82M-v1.0-ONNX`, q8).
- Default local voice: `af_heart`; the settings catalog also includes `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, and `bm_fable`.

## Errors

- Empty candidate chain: `No available speech model matches the speech role.`
- A local worker `null` response reports the model id and possible worker/model-download issue.
- Caller cancellation, filesystem write errors, and thrown local-worker failures propagate.

## Notes

- No local MP3 encoder is bundled. A local request for `speech.mp3` writes `speech.wav` and reports the substitution.
- There is no per-call model selector. Configure the speech role and fallback chain; local voice selection remains a setting.
