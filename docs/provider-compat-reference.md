# Provider compatibility

OMP retains shared wire support only as required by `github-copilot` and literal `local` inference. The supported protocol IDs are `openai-completions`, `openai-responses`, `anthropic-messages`, and `local-inference`. Protocol names do not make the upstream vendors selectable providers.

## Catalog and request behavior

Catalog metadata describes model capabilities, context/output limits, reasoning controls, tool support, and request compatibility. Request builders apply those capabilities to the chosen Copilot wire API. Do not copy compatibility settings from a similarly named upstream model without checking the Copilot endpoint contract.

Tool schemas, tool-call/result pairing, thinking controls, and forced tool choice must match the actual retained model and transport. Local tiny text models do not support the coding agent's tool loop; TTS/STT models serve their speech roles rather than chat completion.

Generic `models.yml` model entries and overrides remain available only under `github-copilot` and `local`. They cannot enable a removed provider, custom OAuth flow, aggregator routing, or another local-server backend. Unsupported persisted provider selectors fail instead of silently switching to Copilot.

See [Model configuration](./models.md), [Endpoint constraints](./provider-endpoint-constraints.md), [Provider quirks](./provider-quirks.md), and [Streaming internals](./provider-streaming-internals.md).
