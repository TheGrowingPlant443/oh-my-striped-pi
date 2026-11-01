# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Memory backends

Memory is selected with `memory.backend` (Settings → Memory, or the active configuration):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `mnemopi` — local SQLite/FastEmbed, managed inference or explicitly configured private HTTP embedding/LLM endpoints. Exposes `retain`, `recall`, `reflect` and memory editing.
- `sharpshooter` — project-local decision extraction, delta queues and consolidated knowledge files using the configured inference role.
- `hindsight` — your self-hosted Hindsight server, including retain/recall/reflect and mental models; defaults to loopback, not a hosted public service.

Private services control their own upstream behavior. No public OpenRouter/Gemini extraction defaults or borrowed public-provider credentials are supplied.

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
