# @oh-my-striped-pi/pi-wire

Shared TypeScript contracts for local transcripts, private/local collaboration, terminal recordings, tool intent metadata, and read-only skill registry access.

The package contains JSON-safe shapes and constants with no runtime dependencies. The coding agent and self-contained HTML export viewer consume these shared types.

## Exports

```ts
import type { SessionEntry, StreamRow } from "@oh-my-striped-pi/pi-wire";
import { INTENT_FIELD, STREAM_HISTORY_LIMIT } from "@oh-my-striped-pi/pi-wire";
```

Key groups:

- message and transcript entry shapes for local exports,
- encrypted collaboration frame shapes, protocol version, room capabilities, and relay control messages (no default relay or viewer URL),
- terminal row and local recording history limits,
- tool intent metadata and TSP rendering shapes,
- skill package metadata and read-only registry routes under `@oh-my-striped-pi/pi-wire/skillshare`.

Private/local collaboration uses an explicitly configured relay and browser deployment.
Public streaming, clip uploads, hosted session shares, QA, and skill publishing
are not available in this fork.
