# recall

Search long-term memory with `memory.backend: mnemopi`. The tool is absent with `off` or file-backed `local` memory.

Implementation: `packages/coding-agent/src/tools/memory-recall.ts`; scoped storage and formatting: `src/mnemopi/state.ts`.

## Input and output

`query` is a required natural-language string. Execution calls the calling session's `recallResultsScoped(query)` and formats matching rows with ids, scopes, and a UTC timestamp header. Empty results return `No relevant memories found.` with `useless: true`. Results have text content and empty details.

Read `memory://<memory-id>` before editing a clipped preview with `memory_edit`. Reads resolve only against the calling session's scoped banks.

## Availability and behavior

The tool has read approval, strict parameters, and discoverable load mode; device sessions may expose it as `xd://recall`. Restricted tool lists are not widened. Explicit recall uses only the supplied query, unlike automatic recall, which can include recent conversation context.

`mnemopi.recallLimit` controls result count (default 8, clamped to at least 1); recall previews default to 500 characters. Bank visibility follows `mnemopi.scoping`: global, per-project, or per-project-tagged. Storage is local SQLite; optional inference uses local embeddings and managed model callbacks, not an independent memory service.

Missing session state throws `Mnemopi backend is not initialised for this session.` Backend errors are logged and rethrown, not disguised as empty results. Cancellation is handled through `untilAborted`.
