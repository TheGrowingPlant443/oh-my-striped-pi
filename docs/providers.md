# Providers

Built-in integrations are `github-copilot`, `local`, `apple`, `ollama`, `lm-studio`, `vllm` and `litellm`, plus the discoverable `llama.cpp` wire integration. Public hosted model-provider registrations other than Copilot are removed.

Selectors use `provider/model-id`. Model families served through Copilot or a configured company server are not separate public provider integrations.

## GitHub Copilot

Run `omsp login github-copilot` or `/login github-copilot`, complete authorization, then select an available model with `/model`. `COPILOT_GITHUB_TOKEN` remains the dedicated environment credential. Existing Copilot identity selection and compatibility retries are unchanged.

Copilot receives prompts, code and tool results included in its model context. Account entitlement and quotas remain controlled by GitHub and your organization.

## Local and self-hosted inference

| ID | Execution |
| --- | --- |
| `local` | Built-in on-device tiny text, TTS and STT workers |
| `apple` | Apple Foundation Models on supported Apple Silicon/macOS systems |
| `ollama` | Native/local Ollama discovery and inference, not Ollama Cloud |
| `llama.cpp` | Discoverable llama-server inference |
| `lm-studio` | LM Studio discovery and loaded-runtime metadata |
| `vllm` | Configured vLLM-compatible server |
| `litellm` | Your LiteLLM proxy |

Ollama defaults to loopback port 11434 and supports `OLLAMA_BASE_URL` / `OLLAMA_HOST`. llama.cpp probes loopback ports 8080 then 9931 unless configured otherwise. LM Studio and LiteLLM support their configured endpoints. Keys are optional where the service permits; use a dedicated service key when required.

`local` is a distinct worker identity, not an alias for HTTP servers. Its tiny models are intended for auxiliary workloads; use an appropriate self-hosted server model for a tool-capable coding session. See [Local models](./local-models.md).

## Company endpoints and extensions

`models.yml` can declare company-operated providers with explicit `baseUrl`, protocol, model metadata and authentication. `auth: none` supports a genuinely keyless server without a dummy credential. Trusted extensions can register providers, custom transports and OAuth flows.

An unknown explicit selector is not silently redirected to Copilot. Review old roles, saved selectors and custom configuration: deleted public integrations are not restored by their former catalog names.

Explicit configuration is not a hostname allowlist or proof that a server is private. Copilot, approved GitHub workflows, configured services and ordinary trusted tools remain network-capable. See [Model configuration](./models.md), [Secrets and credentials](./secrets.md) and [Endpoint ownership](./provider-endpoint-constraints.md).
