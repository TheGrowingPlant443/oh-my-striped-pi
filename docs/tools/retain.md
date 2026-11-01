# retain

Store durable facts in local Mnemopi SQLite memory. Available only with `memory.backend: mnemopi`; absent with `off` and file-backed `local` memory. For local lessons use `learn` with autolearn enabled.

Implementation: `packages/coding-agent/src/tools/memory-retain.ts`; scoped storage: `src/mnemopi/state.ts`.

## Input

`items` is a nonempty array of objects containing required string `content` and optional string `context`. When a shared bank is available, the schema also offers `scope: "project" | "global"`, defaulting to project. Global scope is available with global or per-project-tagged scoping, not isolated per-project scoping.

## Execution and output

The tool resolves any requested global target before writing the batch, then calls `rememberScoped` for each item. Writes use source `coding-agent-retain`, importance 0.75, fact/entity extraction, tool veracity, and session/cwd/context metadata. The storage boundary applies memory redaction.

Success returns `<count> memory stored.` or `<count> memories stored.` and `details: { count }`. Rows are stored synchronously; extraction or embedding work may continue afterward using local inference or managed model callbacks.

A failed write stops the batch and reports its cause, ids already stored and kept, and whether later items were untried. Earlier writes are not rolled back. Retry only failed or untried items. Unsupported global scope rejects before any item is stored. Missing state throws `Mnemopi backend is not initialised for this session.`

## Availability and approval

Strict parameters and discoverable load mode; device sessions may expose `xd://retain`. Restricted tool lists are not widened. Approval is write when any item requests global scope, otherwise read. The tool has no progress callback or cancellation parameter. Bank visibility follows `mnemopi.scoping`; no independent remote memory transport is used.
