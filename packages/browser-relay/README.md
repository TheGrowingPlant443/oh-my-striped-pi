# @oh-my-striped-pi/browser-relay

Chrome extension that lets omsp's Eval `browser` API drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the omsp CLI (`omsp browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (omsp opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `omsp browser-relay install` — writes the bundled extension to `~/.omsp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → _Load unpacked_. Use a locally built CLI from the authenticated checkout; this fork does not provide public release downloads.
2. Opt in, one of two ways:
   - **Per call** — pass `app: { relay: true }` to `browser.open(...)` in Eval. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `omsp config set browser.relay true` makes the relay the default for **every session using this profile, in every project** (project-level settings, `OMSP_BROWSER_RELAY`, and an explicit `app` choice still take precedence). Any session's ordinary `browser.open(...)` call will then drive your real browser — including background sessions you aren't watching; without `app.target` such a call opens its own background tab in your logged-in profile.

That's it: the relay server auto-starts under omsp's profile-independent global daemon broker the first time Eval's browser API needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another; the server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `omsp browser-relay` manually only for `--token`, `--no-group`, or a non-default port — a relay already serving the port is adopted, never fought over.

The fork's default relay endpoint is `http://127.0.0.1:9225`, separate from the upstream relay on port 9224. The extension options and `browser.relayUrl` must match if you select another port.

`app.target` borrows a specific tab by URL/title substring; without it, omsp opens its own tab in the background, leaving your selected tab and focus alone, and closes it when the omsp tab is closed (an extension installed by an older omsp selects that tab instead; re-run `omsp browser-relay install` and reload it). Tabs omsp is **actively driving** are gathered into a per-window **"omsp" tab group** (cyan) — released when omsp lets go of the tab and dissolved on disconnect; the rest of your tabs, pinned tabs, tabs in your own groups, and tabs you drag out are left alone. Disable with `omsp browser-relay --no-group`.

After an omsp upgrade, the relay keeps the extension current on its own: when it meets an extension older than itself that Chrome loaded from `~/.omsp/browser-relay/extension`, and no omsp session is connected to the relay and none of the extension's tabs is attached, it rewrites the files there and asks the extension to reload. Chrome re-reads them under the same extension id, keeping its settings, permissions and the _Allow access to file URLs_ choice; the badge goes off and on. Otherwise run `omsp browser-relay install` (with your `--dir`) and click _Reload_ in `chrome://extensions`: after every upgrade for an extension loaded from another folder, once for one installed before omsp could update it. A Chrome restart is not enough, as Chrome keeps running the worker it loaded; a relay `browser.open` notes when the loaded extension came from an older omsp.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, creates a local ZIP, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**). The retained ZIP output is not a public GitHub release.
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating omsp's supervisor + tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `omsp browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
