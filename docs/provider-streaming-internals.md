# Provider streaming internals

The model-provider boundary permits only `github-copilot` and `local`. Copilot uses retained protocol adapters; local tiny text and speech workers use on-device inference. Unsupported provider IDs fail before dispatch, including persisted selectors; they never silently dispatch to Copilot.

## Event flow

1. `streamSimple()` in `packages/ai/src/stream.ts` resolves the model and credentials and dispatches through the retained API adapter.
2. Protocol adapters normalize responses into `AssistantMessageEvent` values.
3. `AssistantMessageEventStream` supports async iteration for incremental updates and `result()` for the final assistant message.
4. The agent loop forwards updates to the session, which persists messages and drives extension hooks and session behavior.

## Unified events

The shared event contract includes `start`; text, thinking, and tool-call block lifecycle events (`*_start`, `*_delta`, `*_end`); complete image blocks where supported; and terminal `done` or `error` events. A successful terminal reason is `stop`, `length`, or `toolUse`; error termination distinguishes `aborted` from `error`.

Callers should consume the normalized event contract instead of depending on Copilot wire payloads. Tool support and reasoning remain model/transport capabilities, not universal event-stream guarantees. Local tiny text inference does not provide the coding-session tool loop; TTS and STT use their dedicated speech paths.

Generic extension hooks remain supported, but API registration does not authorize additional model-provider IDs or custom OAuth flows. Independent web/search integrations do not pass through this model-provider restriction.

See [Providers](./providers.md), [Compatibility](./provider-compat-reference.md), and [Endpoint constraints](./provider-endpoint-constraints.md).
