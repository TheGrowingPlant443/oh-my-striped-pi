# Provider endpoint constraints

Provider identity, wire protocol and endpoint ownership are distinct. Copilot can speak several chat protocols; local servers and explicitly configured company providers can reuse those protocols without enabling a public vendor integration.

## Ownership

- Catalog rules own model-family capabilities and built-in provider behavior.
- Copilot owns its account endpoints, credentials, entitlement and compatibility behavior.
- Local workers and Apple Foundation Models execute on-device; self-hosted adapters use their configured server.
- Generic HTTP clients require an explicit base URL before credential/header/network callbacks. They do not fall back to public OpenAI URLs or `OPENAI_API_KEY`.
- Request builders own protocol shaping and tool/result encoding. Configuration and custom-handler registration own custom provider/API validation.
- Explicit unknown selectors are not permission to silently use Copilot.

This is not a hostname allowlist. An operator can deliberately configure an external endpoint, and a company proxy can itself forward data externally. Ordinary trusted shell/eval, extensions, MCP and approved GitHub workflows remain network-capable. Review endpoint ownership and upstream policy; removing built-in SaaS clients is not an absolute code-egress guarantee.

See [Providers](./providers.md), [Model configuration](./models.md), [Provider compatibility](./provider-compat-reference.md) and [Streaming internals](./provider-streaming-internals.md).
