# Retained provider behavior

## GitHub Copilot

`github-copilot` remains the provider ID regardless of a model's upstream family. Its authentication, account entitlements, endpoint selection, and usage reporting are Copilot-specific. Use `omp login github-copilot`, `omp models`, and `omp usage` to authenticate and inspect the account.

Copilot serves models through retained Chat Completions, Responses, and Messages protocol adapters. Shared protocol code is not a direct login or inference route to the upstream model vendor. Model limits and compatibility follow the Copilot catalog entry rather than assumptions about an upstream product with the same name.

## Local workers

`local` is keyless on-device inference for tiny text, TTS, and STT models. Worker initialization, downloaded weights, and device/runtime support determine availability. It does not discover arbitrary model servers and is not a full coding-session provider. See [Local models](./local-models.md).

## Invalid old configuration

Removed provider IDs in persisted selectors or provider registration fail explicitly. They are not translated to Copilot or folded into `local`. Update obsolete configuration deliberately; do not relabel an old endpoint as a local worker.

Generic extensions, plugins, MCP, and independent web/search integrations remain separate from model-provider support.

See [Providers](./providers.md), [Compatibility](./provider-compat-reference.md), [Endpoint constraints](./provider-endpoint-constraints.md), and [Streaming internals](./provider-streaming-internals.md).
