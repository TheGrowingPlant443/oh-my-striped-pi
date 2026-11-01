# Compatibility taxonomy and cascade

This tree is the checked-in source of model identity and compatibility policy for on-device workers, self-hosted backends, configured company endpoints, and GitHub Copilot. Bundled model inventory is not an execution allowlist.

- `local` serves built-in on-device tiny language models, TTS, and STT workers.
- Self-hosted catalog entries are `ollama`, `lm-studio`, `vllm`, and `litellm`; `apple` is the on-device Foundation Models bridge. `llama.cpp` has wire/auth rules without a catalog descriptor or fabricated seed.
- `github-copilot` retains account-scoped runtime discovery and three wire transports: `openai-completions`, `openai-responses`, and `anthropic-messages`.
- Classes and families describe model lineage, not provider approvals. Generic configured-endpoint protocols remain available; public hosted provider clients other than Copilot are not registered.

## Source ownership

- `taxonomy/*.kdl` defines class membership, product families, revision extraction, reviewed identity corrections, and suffix collapse.
- `classes/*.kdl` defines model-lineage truths, optionally scoped to retained providers or request adapters.
- `providers/*.kdl` defines catalog entries, authored seeds, and deployment policy. A provider with no `default-model` can declare wire policy alone.
- `runtime/behavior.kdl` defines behavior outside exact model lookup.
- `auth/` defines retained runtime authentication metadata. Catalog generation never reads credentials or performs login.

Do not move common deployment behavior into a class file or lineage truths into a provider file. Absence is not evidence that a capability is stripped. Preserve comments recording reviewed exceptions and why exact model residue remains.

Per-model pricing belongs in KDL, not generator lookup tables. Copilot request rates use the numeric catalog axis `premium-multiplier`; `0` explicitly marks a model with no premium-request charge.

The grammars use KDL v2. Unknown directives and malformed value shapes are errors. Declaration and file order never break cascade ties.

## Regeneration

From `packages/catalog`:

```sh
bun run gen:compat   # KDL sources -> src/compat/rules.json
bun run gen:models   # compiled seeds and policy -> src/models.json (offline)
```

Provider KDL seeds are the bundled catalog source of truth. Generation uses no authentication, network requests, live probes, external catalogs, or previous `models.json` snapshot. Every invocation regenerates all authored providers, even when `--provider` selects one. Runtime-only self-hosted entries legitimately have no seed rows; their discovery is separate from generation.

Never hand-edit generated files. Commit regenerated outputs together with the KDL change.

## Taxonomy grammar

A **class** is a vendor lineage such as `gemini` or `anthropic`; a **family** is a product line such as `flash`, `pro`, `sonnet`, or `opus`; a **revision** is a `major.minor.patch` triple extracted from a model name. Missing minor and patch components compare as zero. These generic classes and families remain available for retained provider models.

Taxonomy roots accept `class`, `collapse`, and optional compiler discovery vocabulary. Class names and override IDs must be unique across all sources. Exactly one non-empty `collapse` definition is required.

```kdl
class "anthropic" {
    namespace "anthropic" bounded=#true
    bounded "claude"
    family "sonnet" glob="*sonnet*"
    family "opus" glob="*opus*"
    revision prefix="claude-" anywhere=#true
}
```

### Class membership

Classification trims and lowercases the full identifier. The **bare name** is the segment after its final `/`. Matcher tokens are lowercased while parsing.

| Matcher | Rank | Meaning |
| --- | ---: | --- |
| `exact "token"` | 4 | Bare name equals token. |
| `bounded "token"` | 3 | Bare name equals token or begins with it followed by `-`, `_`, `.`, `:`, or an ASCII digit. |
| `namespace "token"` | 2 | A non-empty `/`-separated segment equals token. |
| `namespace "token" bounded=#true` | 2 | Split on `/`, `.`, and `:`; a segment satisfies the bounded rule. |
| `prefix "token"` | 1 | Bare name starts with token. |
| `glob "pattern"` | 0 | Anchored `*` wildcard over the bare name. |

The greatest `(matcher-kind rank, token byte length)` wins. Equal tuples from different classes are ambiguity errors. No match returns class `unknown` without family or revision.

### Families and revisions

`family "name" glob="pattern" priority=N` requires a glob; signed integer priority defaults to zero. Matching is anchored and ASCII-case-insensitive. Rank is `(priority, non-wildcard byte count)`. Equal-ranked ties are retried after removing a matching leading class namespace (`class.` or `class:`); remaining ties are errors. Repeated rules for a family are allowed; no match yields no family.

`revision prefix="gemini-"` extracts after a prefix at the start of the bare name. `anywhere=#true` allows its first occurrence anywhere. Prefixes are tried in declaration order. `revision skip-bare "o1" "o3" "o4"` suppresses extraction for those bare names. Extraction starts at the first ASCII digit and reads at most three unsigned 8-bit components separated by `.` or by `-` followed by a digit. Thus `claude-opus-4-6` yields `4.6.0`.

### Reviewed identity overrides

An `override` has properties only: required globally unique `id`, `rationale`, `provenance`, and exactly one selector (`model` or anchored wildcard `glob`). Selectors compare bare identifiers case-insensitively. Optional properties are `provider`, `logical`, `class`, `family`, `revision`, `effort`, `thinking-variant`, and `expires-at-ms`.

The `(provider, selector-kind, selector)` tuple must be unique. Active exact overrides beat globs; within each kind, provider-scoped overrides beat provider-agnostic ones. Matching globs rank by non-wildcard byte count; equal ranks are errors. Expiring overrides are inactive at or after their expiration when an observation time is supplied.

### Suffix collapse

The collapse vocabulary separates identity from wire routing. `thinking-suffix` declares one suffix. `pair-token` identifies a thinking sibling without collapsing identity; negated `no-` and `non-` forms do not match. `effort-suffix` requires a `tier` and may exclude a bare-name prefix.

Compiler vocabulary for provider-scoped variants does not enroll providers or make deleted transports available. Retained declarations in `taxonomy/` are authoritative; do not infer a live provider implementation from a taxonomy token.

## Cascade grammar

Cascade documents start with `class`, `provider`, or `on-api`. Each selector adds a conjunct. `on` selects a deployment provider; `on-api` selects a request adapter; `on-upstream` selects an upstream without changing deployment identity or importing direct-host rules.

```kdl
class "anthropic" {
    on "github-copilot" {
        family "sonnet" {
            revision ">=4" {
                thinking-efforts "low" "medium" "high"
            }
        }
    }
}
```

| Selector | Meaning |
| --- | --- |
| `class "id"` | Exact classified class. |
| `provider "id"` | Root-only exact deployment provider. |
| `on "a" "b"` | Provider alternatives under a root class. |
| `on-api "a" "b"` | Request-adapter alternatives. |
| `family "id"` | Exact family; missing family never matches. |
| `revision ">=2.5 <4"` | Conjunction of revision comparisons; missing revision never matches. |
| `models "id" "vendor/*"` | Exact case-sensitive IDs or anchored ASCII-case-insensitive wildcards; alternatives are OR. |
| `on-upstream "a" "b"` | Exact selected-upstream alternatives; absent upstream never matches. |

Structured class, provider, API, upstream, and family comparisons are case-sensitive. Revision operators are `>=`, `>`, `<=`, `<`, and `=` with one to three unsigned 8-bit components. A `models` selector may also use `token="name"` for ASCII-case-insensitive non-alphanumeric-bounded token matching. Prefer taxonomy ranks to model lists; explain unavoidable lists with a `// residue:` comment.

A row whose own ID classifies as `unknown` but whose `requestModelId` does not resolves classification and model selectors under its wire ID. `resolveModelPolicy(spec, { upstream })` resolves policy without mutating model identity; request-shaping fields and shared compatibility fields use the same cascade and upstream-aware cache key.

### Axes and value shapes

The closed vocabulary is in `src/compat/axes.ts`: directive, resolved field, namespace, value shape, applicability, and accepted enum values. Consult that table and retained KDL assignments rather than assuming every compiler-supported axis has a live transport consumer.

- **Scalar:** one boolean, integer, float, or string; no children; `#null` is rejected.
- **Array:** scalar arguments and no children; empty arrays are accepted only for axes explicitly marked `emptyArray`.
- **Object:** no arguments and a child block. Kebab-case child names map to resolved axis keys or camelCase. `extra-body` keys are literal wire JSON keys instead. Each child is a scalar or nested object, not an array.

A block cannot assign the same resolved axis twice. Wire axes apply to matching targets; thinking axes require reasoning capability except for the compiler's explicit reviewed capability-gating rules.

### Precedence and ambiguity

Each axis resolves independently by the lexicographically greatest tuple:

```text
(model-selector exactness, constrained-dimension count, priority)
```

Exactness is 2 for an exact model selector, 1 for a wildcard or token, and 0 without a model selector. Dimensions are class, provider, API, upstream, family, revision, and model. Signed integer `priority` defaults to zero. Two matching assignments tied on all components are errors even when their values agree. Use priority only for intentional overlaps, never declaration order.

### Time-based pricing

The generic `time-based-cost` object materializes `ModelCost.timeBased`. Named `peak-windows` children contain a comma-separated `weekdays` string (`0` Sunday through `6` Saturday), integer `start-minute`, and `end-minute`, with `0 <= start < end <= 1440`. Windows are start-inclusive and end-exclusive; split overnight windows. Outside them, the nonnegative `off-peak-multiplier` applies.

Optional named `effective-rates` children require distinct ISO UTC `effective-from` timestamps and all four nonnegative per-million rates (`input`, `output`, `cache-read`, `cache-write`). The latest due card replaces the base card. A card may include its own absolute `long-context` tier; it does not inherit the base tier. Pricing order is effective card, context tier, tariff multiplier.

This is catalog policy metadata, not schedule syntax for the coding agent's `models.yml`. See [the catalog API](../../../README.md#cost-calculation) for timestamp semantics.

## Runtime behavior grammar

`runtime/behavior.kdl` has one root `behavior` node. Its retained declarations govern model limits, routing, role defaults, and other behavior outside exact lookup. Runtime accessors live in `src/compat/behavior.ts`; compiler vocabulary does not imply support for removed providers.

`role-defaults "<role>"` holds ordered `model "<selector>"` children, most preferred first. Selectors are copied verbatim; duplicate selectors or repeated roles are errors. `roleDefaultModels()` returns the chains keyed by role.

## Provider catalog grammar

A root `provider "<id>"` carries a catalog entry alongside cascade policy. `default-model` marks a catalog entry in the generated `KnownProvider` union; wire-only providers need no default or seed. Compiled entries live under `providers` in `rules.json`; accessors live in `src/compat/providers.ts`.

### Seed rows

Seeds author bundled rows; cascade policy patches them. Runtime managers obtain seeds through `seedModels(provider)`. The offline generator rebuilds every authored provider from seeds, without discovery enrollment, snapshot merges, or cross-provider reference fills.

`seed` properties `api` and `base-url` provide defaults that individual models may override. Retained seeds use `bundle="always"`. Each `model` takes an ID positionally, requires `name=`, and declares `reasoning`, `input` (`"text"` and/or `"image"`), all four `cost` rates, and `limits` (`context=` / `max-tokens=`; omitted limits become `null`). `supports-tools` is optional; `request-model-id` sets a distinct wire ID.

Optional numeric model-header properties `int` and `tps` preserve intelligence and throughput metrics in the offline bundle.

Thinking directives become explicit thinking policy (requiring both mode and efforts); wire directives become explicit compatibility policy and must apply to the API. Catalog axes remain cascade-owned rather than seed-body directives. Explicit thinking and compatibility values win over the cascade.

Local seeds use `api="local-inference"` and `base-url="local://inference"`; cascade kind policy distinguishes language, TTS, and STT rows. Copilot rows declare one of its three retained wire APIs. Multiple vendor lineages in those rows do not introduce direct vendor providers.

## Vendoring provenance

The generic compiler taxonomy originated in the o2 catalog census (`census 2026-08`). Classes, families, and compiler vocabulary remain useful independently of deployment providers. Only authored rows are bundled; self-hosted discovery does not publish a machine's live model roster.
