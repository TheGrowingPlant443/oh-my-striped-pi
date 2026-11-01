# Model and Provider Configuration (`models.yml` / `models.yaml`)

OMP retains Copilot, on-device workers and self-hosted inference integrations. Company-operated providers can be configured explicitly; built-in public model-provider integrations other than Copilot are removed.

## Model selection

Use `provider/model-id` selectors. Inspect the retained catalog with `omp models` and choose a session model with `/model`.

```yaml
modelRoles:
   default: github-copilot/gpt-5.5
   tiny: local/lfm2.5-230m
   memory: local/lfm2-1.2b
   judge: local/lfm2-1.2b
   speech: local/kokoro
   dictation: local/parakeet-tdt-0.6b-v3
retry:
   fallbackChains:
      tiny: []
      memory: []
      judge: []
      speech: []
      dictation: []
```

These are settings, not the contents of `models.yml`. Role compatibility still applies: a tiny text model is not a tool-capable coding model, and speech roles require TTS/STT models. Explicit empty fallback chains prevent fallback to another model for those roles.

Unknown explicit provider/model selectors are not silently redirected to Copilot. Update obsolete roles and saved selections deliberately. Explicit custom endpoint configuration remains supported; the separate `enabledProviders`/`disabledProviders` capability-directory switches control configuration discovery, not model transports.

## Config file location

The registry reads `models.yml` or `models.yaml` in the active agent directory (default `~/.omp/agent/`). Named profiles use their own agent directory. `PI_CODING_AGENT_DIR` can override the default-profile directory. A programmatic `ModelRegistry` path overrides the directory-derived location.

## Provider configuration

`providers` can configure the retained integrations or a company-specific provider ID. Supply an explicit endpoint for a generic HTTP protocol; use `auth: none` for a keyless service, or dedicated credentials/headers for an authenticated one.

Built-in chat/native protocols are `openai-completions`, `openai-responses`, `anthropic-messages`, `ollama-chat`, `apple-foundation-models` and `local-inference`. Configured modality protocols include `openai-images`, `openai-speech`, `openai-transcriptions`, `openai-embeddings`, `openrouter-rerank`, `typesafe` and `openai-decisions`. Protocol names do not enable the corresponding public vendor service.

Native self-hosted discovery supports Ollama, llama.cpp, LM Studio, LiteLLM and Apple availability; generic `openai-models-list` / `proxy` discovery remains available for explicit endpoints. `local` continues to mean the built-in on-device workers, not an HTTP alias.

For example, a display-name override for an existing Copilot model:

```yaml
providers:
   github-copilot:
      modelOverrides:
         gpt-5.5:
            name: Copilot GPT-5.5
```

For a keyless company server, use a distinct provider name rather than pretending it is Copilot:

```yaml
providers:
   company:
      api: openai-completions
      baseUrl: https://inference.company.example/v1
      auth: none
      models:
         - id: code-model
           contextWindow: 32768
           maxTokens: 8192
```

Select `company/code-model`, or assign it to `modelRoles.default`. Replace the example URL/model with your actual service. Generic HTTP clients do not supply a public OpenAI endpoint or borrow `OPENAI_API_KEY` when configuration is missing.

## Authentication and extensions

Authenticate Copilot with `omp login github-copilot` or `/login github-copilot`. On-device workers are keyless; self-hosted services follow their configured/declared optional-key policy. See [Providers](./providers.md).

Trusted extensions retain custom provider, API-handler and OAuth registration. Register a handler before executing a custom API name; declaring a name alone does not implement its transport.

See [Local models](./local-models.md) for local role configuration and [Settings](./settings.md) for settings merge precedence.
