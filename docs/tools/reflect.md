# reflect

Present relevant long-term memories as context for an answer. Available only with `memory.backend: mnemopi`; absent with `off` and file-backed `local` memory.

Implementation: `packages/coding-agent/src/tools/memory-reflect.ts`; scoped retrieval and formatting: `src/mnemopi/state.ts`.

## Input and output

- `query`: required question string.
- `context`: optional string. Nonblank context is trimmed and appended to the query under `Additional context:`.

Execution calls the calling session's `recallResultsScoped` and `formatContextScoped`. Matching memories return `Based on recalled memories:` followed by the formatted context; this tool does not invoke a separate synthesis service. Empty results return `No relevant information found to reflect on.` Text results have empty details.

## Availability and behavior

Read approval, strict parameters, discoverable load mode; device sessions may expose `xd://reflect`. Restricted tool lists are not widened. Recall limits and bank visibility follow Mnemopi settings, including `mnemopi.recallLimit` (default 8, runtime minimum 1) and `mnemopi.scoping`. Optional inference uses local embeddings and managed model callbacks.

The explicit tool path does not refresh automatic prompt recall or mutate memory. Missing session state throws `Mnemopi backend is not initialised for this session.` Retrieval failures are logged and rethrown. Cancellation is handled through `untilAborted`.
