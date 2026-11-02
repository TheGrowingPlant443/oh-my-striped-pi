# @oh-my-striped-pi/collab-web

Private/local live collaboration browser client and shared React renderers for
self-contained omsp HTML session exports. No public relay or viewer is selected
implicitly, and the browser entry has no hosted analytics or remote asset loader.

## Private/local collaboration

Run the existing local relay and browser app from this package in separate terminals:

```sh
bun scripts/local-relay.ts --port 7466
bun --hot index.html
```

In an omsp session, run `/collab ws://localhost:7466`. For browser links, configure
`collab.webUrl` to the browser server's printed localhost URL before starting the
room. Alternatively, configure `collab.relayUrl` to an operator-managed `wss://`
relay and `collab.webUrl` to its private HTTPS browser deployment. If the browser
is served at the relay's origin, `collab.webUrl` may remain empty: the browser URL
is derived only from that explicitly selected relay.

`/collab view` creates read-only access; control links permit prompting,
interrupting, agent commands, and answering host dialogs. `/join <link>` and
`omsp join <link>` join from another terminal; `/leave` leaves; `/collab stop`
withdraws the hosted room. `omsp collab list` exposes local metadata only;
`omsp collab link <instanceId|pid> [--view]` explicitly retrieves a capability link.
Do not log or publish room links: anyone holding one can decrypt the session.
Bare room/key links are rejected because they do not identify a relay.

Hosting is manual by default (`collab.autoStart: off`). The existing opt-in
`view` and `control` auto-start modes require an explicitly configured relay;
there is no public fallback. Discovery records and authenticated IPC endpoints
are local to the machine, not publication to an external directory.

The restored relay is the original functional development/local server, not a
mock host: it assigns peers, routes encrypted binary frames, enforces one host,
and closes rooms on host disconnect. It now binds to localhost only. It has no
deployment authentication, persistence, or operator-level room/guest quotas;
do not expose this local helper as a hardened multi-tenant service. Company
deployments must supply their own relay with the same contract and deployment
controls. Plain WebSockets/HTTP are allowed only for localhost; remote endpoints
require WSS/HTTPS. Browsers need a secure context for WebCrypto.

Session frames retain AES-256-GCM sealing and random room keys/write tokens.
The relay sees peer routing metadata, not plaintext. Read-only enforcement is
host-side; reconnect, snapshot chunking, bounded host replication, queue
backpressure, session ownership and authenticated local discovery are retained.


## Generate the viewer

```sh
bun run gen:export-viewer
```

`scripts/build-export-viewer.ts` bundles the viewer used by
`packages/coding-agent/src/export/html`. Exported HTML embeds the viewer and its
Markdown, highlighting, styles, and session data rather than loading remote scripts.

## Retained source graph

- `src/export-standalone.ts` registers the viewer's browser components.
- `src/tool-render/` provides tool cards and the `<omsp-tool-view>` custom element.
- `src/trace-render/` provides `<omsp-session-trace>` using the local stats viewer.
- `src/components/transcript/Markdown.tsx`, `math.ts`, and `src/lib/format.ts`
  provide shared Markdown, math, and formatting support.

These renderers depend on React, React DOM, KaTeX, the shared Markdown utilities,
local stats components, and the shared tool intent-field contract from `pi-wire`.
Tests cover private endpoint links, authenticated encryption, relay routing,
guest state/permissions, reconnects, local discovery, Markdown, tool cards, and
standalone viewer generation. HTML export and recording/playback remain local;
hosted shares, QA, public streams/clips, and skill publication are not restored.
