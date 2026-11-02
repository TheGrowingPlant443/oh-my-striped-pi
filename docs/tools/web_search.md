# web_search

Run one query through configured private search backends and return the first usable sources. Built-in public search APIs, anonymous MCP search services, cookie adapters and public search-site scrapers are not included.

## Configuration and selection

Search engines are independent `web/*` descriptors, not model providers. The default chain is `web/searxng`, then `web/firecrawl`. A backend participates only when its endpoint is explicitly configured. There is no public endpoint default or public fallback.

- `modelRoles.web` selects the primary engine or role alias.
- `retry.fallbackChains.web` supplies explicit fallbacks. An empty array disables fallbacks after the primary.
- `omsp q --model web/searxng "query"` selects only that engine for one request.
- Duplicate candidates are removed, preserving explicit selection. Unavailable automatic candidates are skipped; unavailable explicit candidates produce a configuration error. Removed or unknown selectors are not silently substituted by another backend.

### SearXNG

Configure `searxng.endpoint` or `SEARXNG_ENDPOINT` with the base URL of your self-hosted instance. OMSP calls its `/search` JSON endpoint. The SearXNG server is external to OMSP; its operator controls upstream engines.

Optional authentication is `searxng.token` / `SEARXNG_TOKEN`, or `searxng.basicUsername` and `searxng.basicPassword` / `SEARXNG_BASIC_USERNAME` and `SEARXNG_BASIC_PASSWORD`. Configure both Basic fields together; empty fields are valid credentials. Existing authentication precedence and validation apply.

`searxng.categories`, `searxng.engines`, `searxng.language` and `searxng.safesearch` configure the instance request. Engine shortcuts resolve through that instance's `/config` endpoint; result parsing retains sources, answers, infoboxes and suggestions where supported. Query directives are mapped to supported engine syntax and native filters.

### Private Firecrawl

Set `FIRECRAWL_BASE_URL` (alias `FIRECRAWL_API_URL`) to an explicitly configured private/self-hosted deployment. HTTP and HTTPS are supported; URL-embedded credentials and non-HTTP schemes are rejected. The resolver preserves a path prefix and explicit `/v1` or `/v2`; otherwise it appends `/v2`. Search POSTs to `/search`; reader mode POSTs to `/scrape`.

`FIRECRAWL_API_KEY` or the configured `firecrawl` credential authenticates with a bearer token. Keyless private deployments omit Authorization. A configured search credential that cannot be resolved is an error, not a reason to switch to keyless access. Credentials alone never enable an unconfigured endpoint. OMSP does not ship the Firecrawl server.

Search maps Google-style operators into the query and recency/absolute dates into `tbs`. Results use Firecrawl v1 array or v2 web-result responses. The result count defaults to 10 and is clamped to 1–100.

## Inputs

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Text plus optional `site:`/`-site:`, `after:`/`before:`, `inurl:`, `intitle:`, `intext:`, `filetype:`, `lang:`, quoted phrases, exclusions and `OR`. |
| `recency` | `day` / `week` / `month` / `year` | No | Relative time window supported by the configured backend. |
| `limit` | `number` | No | Desired returned result count. |
| `num_search_results` | `number` | No | Backend result breadth, taking precedence over `limit`. |

Token/sampling controls are not exposed: neither retained search backend performs model inference through this tool. Known URLs and programmatic data should use `read` directly.

## Results and failures

The tool returns a text block with numbered sources, URLs and snippets, plus `details.response` and optional `details.error`. Optional answer/citation/related-query metadata is rendered when present. Cite the returned source URLs.

The shared query pipeline parses once, supplies structured directives to the selected adapter and applies lenient result filtering. A constraint that would eliminate every source is relaxed with a leading note; source snippets are truncated to 240 characters in tool text. Empty responses count as failed attempts. Fallback results name the backend that answered and earlier failures, so provenance remains visible.

`providers.webSearchTimeoutSeconds` controls each provider transport: default 60 seconds, maximum 300. It is not a whole-chain deadline. Ordinary backend failures advance through the configured private chain; user cancellation propagates immediately. With no configured endpoint the tool reports that no search model is configured, without attempting public services.

## Reader relationship

URL `read` retains native in-process conversion, trafilatura, lynx, binary/document handlers and ordinary direct URL/browser handling. `providers.fetch` accepts `auto`, `native`, `trafilatura`, `lynx` or `firecrawl`; a selected renderer is tried first, followed by remaining renderers. Firecrawl runs only with an explicit endpoint and can use keyless or custom-key private authentication. Reader requests have their existing bounded timeout/retry behavior and local fallbacks.

No URL is automatically forwarded to Parallel or Jina. This is not a network sandbox: directly selected websites, configured search servers, trusted shell commands, extensions and user-configured MCP servers retain their normal network behavior.

## Source and tests

- `packages/coding-agent/src/web/search/{index,provider,selection,query,types}.ts`
- `packages/coding-agent/src/web/search/providers/{base,searxng,firecrawl,utils}.ts`
- `packages/coding-agent/src/web/firecrawl.ts` and `src/tools/fetch.ts`
- `packages/tui/src/tools/web-search-types.ts` and `web-search.ts`
- `packages/coding-agent/test/web/search/` and `test/tools/web-search-{searxng,firecrawl}.test.ts`
