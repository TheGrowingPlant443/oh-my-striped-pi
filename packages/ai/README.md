# @oh-my-striped-pi/pi-ai

Streaming, tool calling, reasoning controls, credential rotation, and usage accounting for GitHub Copilot, local models, and configured self-hosted services.

## Supported model backends

- **`github-copilot`**: GitHub Copilot model discovery, device login, token refresh, account endpoints, and usage reporting. Copilot models use Anthropic Messages, OpenAI Responses, or Chat Completions wire formats; those format names do not enable direct Anthropic or OpenAI providers.
- **`local`**: built-in on-device tiny text, speech synthesis, and transcription workers. The coding-agent host registers the `local-inference` text transport. Importing this package alone does not install that worker transport.

- **Self-hosted servers**: Ollama (native `ollama-chat` or compatible OpenAI wires), llama.cpp, LM Studio, vLLM, and LiteLLM retain their own provider identities and configurable endpoints.
- **`apple`**: on-device Apple Foundation Models through the native bridge, when supported by the host.
- **Company providers**: configure an explicit endpoint for reusable OpenAI-compatible or Anthropic-compatible protocols, or register an extension-owned custom API handler. No Copilot alias is needed.

Built-in public model SaaS integrations other than Copilot remain removed. Generic HTTP transports require an explicit base URL; they do not fall back to public OpenAI URLs or borrow `OPENAI_API_KEY`. Optional-key backends and `auth: none` endpoints send no synthetic bearer token. Existing stored credentials and sessions are preserved.

Configured self-hosted embeddings, reranking, images, speech, transcription, and native judgment protocols are available through their dedicated modules. This is not a network sandbox: ordinary trusted extensions, MCP, shell, and tools remain operational, and company endpoints need not be loopback addresses. Copilot account/enterprise endpoint, identity, header, auth, and fallback behavior is unchanged.

## Quick start

Select a Copilot model from the catalog and supply a resolved Copilot credential (or `COPILOT_GITHUB_TOKEN`):

```typescript
import { getBundledModels } from "@oh-my-striped-pi/pi-catalog/models";
import { completeSimple, streamSimple, type Context } from "@oh-my-striped-pi/pi-ai";

const model = getBundledModels("github-copilot").find(model => model.kind === "chat");
if (!model) throw new Error("No Copilot chat model is available");
const context: Context = {
	messages: [{ role: "user", content: "Explain this function." }],
};

const response = await completeSimple(model, context, { apiKey: copilotCredential });
context.messages.push(response);

const events = streamSimple(model, context, { apiKey: copilotCredential });
for await (const event of events) {
	if (event.type === "text_delta") process.stdout.write(event.delta);
}
const finalMessage = await events.result();
```

`stream` / `complete` accept wire-specific options. `streamSimple` / `completeSimple` map shared reasoning and tool-choice options to the selected backend. Failed requests produce an assistant message with `stopReason: "error"`; synchronous configuration failures can throw. Pass an `AbortSignal` through `signal` to cancel requests.

## Tools

```typescript
import { type, type Tool } from "@oh-my-striped-pi/pi-ai";

const tool: Tool = {
	name: "get_time",
	description: "Get the current time in a time zone",
	parameters: type({ timezone: "string" }),
};
```

Put tool definitions in `context.tools`. Consume `toolcall_start`, `toolcall_delta`, and `toolcall_end` events when displaying incremental arguments. Execute completed `toolCall` blocks in the host, then append a `toolResult` message containing the original `toolCallId`, tool name, content, error state, and timestamp before continuing the conversation. Tool execution is not performed by the model wire client.

## Images and history

Vision-capable Copilot models accept image content with base64 `data` and a MIME type; existing caller-served image URLs remain supported where the wire accepts them. Provider-native upload references and upload clients have been removed. Model history consists of serializable user, developer, assistant, and tool-result messages. Preserve structured reasoning and tool metadata rather than flattening it into plain text.

## Reasoning and usage

Use `reasoning` with a supported model effort, and `thinkingBudgets` for token-budget controls. `disableReasoning` / `forceReasoningOff` request supported thinking-off behavior. Copilot family-specific reasoning, tool schemas, cache behavior, and premium-request accounting remain available even when the served model has an Anthropic, OpenAI, Gemini, Kimi, or xAI family identity.

Assistant messages expose input/output/cache token counts and cost data in `usage`. `getPremiumServiceTierRequests` and Copilot usage reporting retain their existing semantics. Generic chat/text judgment helpers use the configured model backend; self-hosted native judgment protocols are also supported.

## Authentication and exports

Use `AuthStorage` and the provider registry for interactive login, refresh, and account-aware key resolution. Self-hosted optional-key prompts do not imply an OAuth account; company extensions may register their own OAuth implementation. Stored credentials are preserved without enabling deleted public SaaS clients.

Public entrypoints include the package root, `error`, `judgment`, `oauth`, `registry`, `auth-broker`, `auth-gateway`, dedicated modality modules, reusable provider wires, and shared utilities. Unknown protocols fail explicitly rather than silently falling back to another provider.

## License

MIT
