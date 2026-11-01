# Provider integration boundaries

This distribution retains local/self-hosted integrations and Copilot while removing built-in public SaaS model-provider registrations. Explicit company endpoints and trusted extension providers remain supported.

## Configuration first

For an existing protocol, declare a distinct provider in `models.yml` with an explicit endpoint and appropriate authentication. Keyless servers use `auth: none`, not fake keys. Do not reuse Copilot's identity for an unrelated server. See [Model configuration](./models.md).

## Implementation ownership

- Provider and model-family policy belongs in `packages/catalog/src/compat/rules/`, not TypeScript model-name conditions.
- Reuse the existing protocol adapters, native workers, discovery factories, credential resolution and cancellation/error handling.
- Trusted extensions may use `registerProvider` with custom authentication and register a custom API handler when a new transport is genuinely required.
- Native Ollama/Apple paths and generic company endpoints must preserve their own identity and optional-key behavior.
- Generic HTTP clients require an explicit endpoint; do not add a public vendor URL or borrowed global API key as a fallback.
- Validate configuration before executing credential/header commands or sending requests. A custom API name requires an implementation.

Explicit endpoint configuration and trusted plugins are not an egress firewall. Review server ownership, upstream forwarding and credentials before enabling a service. See [Endpoint ownership](./provider-endpoint-constraints.md).
