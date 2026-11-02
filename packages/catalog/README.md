# @oh-my-striped-pi/pi-catalog

Model catalog for [omsp](https://github.com/TheGrowingPlant443/oh-my-striped-pi): bundled model data, model identity, classification, and compatibility for built-in on-device workers, self-hosted servers, and GitHub Copilot.

## What's inside

| Module                          | Purpose                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.json` + `models`        | Bundled model database (pricing, context windows, modalities, thinking support)                                                                                                                                                              |
| `provider-models`               | Provider discovery descriptors (`PROVIDER_DESCRIPTORS`) and per-provider model resolution rules |
| `discovery`                     | Generic configured-endpoint model discovery and account-scoped GitHub Copilot discovery |
| `compat/rules`                  | Checked-in KDL policy tree: taxonomy (classes/families/revisions), class/provider cascade rules, runtime behavior vocabulary; compiled by `bun run gen:compat` into the committed `rules.json`                                               |
| `compat`                        | The rule engine: `classifyModel` (taxonomy), `resolveModelPolicy` (cascade), behavior accessors (`api-routes`, `model-limits`, `exclude-models`, `pricing-peer`), collapse, and OpenAI/Anthropic wire builders that consume resolved records |
| `identity`                      | Mechanical id utilities: reference resolution against the bundled index, dialects, selection priority, tokenizer families                                                                                                                    |
| `model-thinking`                | Runtime thinking helpers (`getSupportedEfforts`, effort clamping/mapping, wire-id routing) over resolved model records                                                                                                                       |
| `model-manager` / `model-cache` | Runtime model registry with discovery refresh and on-disk caching                                                                                                                                                                            |
| `wire`                          | GitHub Copilot wire-level helpers |
| `effort`                        | Reasoning-effort level definitions                                                                                                                                                                                                           |

Import from subpaths (`@oh-my-striped-pi/pi-catalog/<module>`) or the root barrel.

## models.json and rules.json are generated

Never edit `src/models.json` or `src/compat/rules.json` by hand. `models.json` is a compact generated catalog; use `getBundledProviders()` and `getBundledModels()` instead of reading its internal format. Provider seeds in `src/compat/rules/providers/local.kdl` and `github-copilot.kdl` are the source of truth. `rules.json` is compiled from the KDL tree; `scripts/generate-models.ts` builds `models.json` offline from compiled seeds and policies. From `packages/catalog`, run:

```sh
bun run gen:compat   # src/compat/rules/**/*.kdl -> src/compat/rules.json
bun run gen:models   # compiled KDL seeds + rules -> src/models.json (offline)
```

Generation uses no authentication, network requests, live probes, external catalogs, or previous `models.json` snapshot. Every run regenerates all authored providers, even when `--provider` selects one. Dynamic self-hosted providers intentionally bundle no fabricated model rows.

Model- or provider-conditional policy (identity, effort ladders, wire quirks, modality/limit/pricing corrections, API routing, roster exclusions) lives in the KDL tree — see `src/compat/rules/README.md` for the grammar and axis vocabulary. Commit regenerated outputs alongside the `.kdl` edit.

`local` means built-in on-device tiny language models, TTS, and STT. Self-hosted providers are `ollama`, `lm-studio`, `vllm`, and `litellm`; `apple` represents Apple Foundation Models on supported Apple Silicon/macOS hosts. `llama.cpp` has wire/auth policy and discovery but deliberately no bundled catalog descriptor or seed model. Company DNS endpoints keep their declared backend's local-server compatibility semantics; arbitrary configured provider IDs can use supported generic protocols without impersonating Copilot.

`github-copilot` retains account-scoped discovery and its three transports: `openai-completions`, `openai-responses`, and `anthropic-messages`. Public hosted model-provider integrations other than Copilot are not registered. Model lineage classes remain taxonomy, not provider permissions.

### Self-hosted discovery

| Backend | Default endpoint | Discovery |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` | OpenAI model listing, native `/api/tags` fallback and `/api/show` capabilities |
| LM Studio | `http://127.0.0.1:1234/v1` (`LM_STUDIO_BASE_URL`) | OpenAI listing plus optional native VLM, loaded context, and decision-model metadata |
| vLLM | `http://127.0.0.1:8000/v1` | OpenAI listing with `max_model_len` and reviewed Qwen template policy |
| LiteLLM | `http://localhost:4000/v1` (`LITELLM_BASE_URL`) | Paginated management metadata, then the same deployment's OpenAI listing |
| Apple Foundation Models | In-process native bridge | Runtime availability; no HTTP endpoint or bundled model |

All HTTP managers accept `baseUrl`, optional `apiKey`, and an injected `fetch`. LiteLLM discovery never downloads metadata from a public catalog. Its upstream provider/model labels describe routing inside the configured proxy; they do not register hosted clients or redirect requests outside it. Explicit `mode: "decisions"` rows in LM Studio/LiteLLM use the generic `openai-decisions` judge protocol.

Configured in-house runner protocols are `openai-images` (image), `openai-speech` (TTS), `openai-transcriptions` (STT), `openai-embeddings`, `openrouter-rerank` (the existing generic rerank wire name), `typesafe` (System One/OpenJEV), and `openai-decisions`. These names do not imply hosted provider defaults.

## Workspace setup

This is a private source workspace, not a public npm package. Use it from an
authenticated monorepo or company workspace with managed dependencies prepared.
It runs TypeScript source directly (no build step); requires Bun ≥ 1.4.4.

## Cost calculation

The `models` subpath (also exported from the root) provides timestamp-aware pricing helpers:

| API                                                               | Result                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `calculateCost(model, usage, timestamp?)`                         | Updates and returns `usage.cost` using `model.cost`.                                                      |
| `calculateUsageCost(cost, usage, timestamp?)`                     | Updates and returns `usage.cost` using a `ModelCost`.                                                     |
| `calculateUncachedInputCost(cost, promptInputTokens, timestamp?)` | Returns the cost of a fully uncached prompt.                                                              |
| `getEffectiveTokenCost(cost, timestamp?)`                         | Returns the base card in force: the latest due effective rate, else the row's own legs.                   |
| `getTimeBasedPricingPeriod(cost, timestamp?)`                     | Returns `"peak"`, `"off-peak"`, or `undefined` without a recurring tariff.                                |
| `hasRecurringTariff(schedule)`                                    | Whether a `TimeBasedCost` carries a peak/off-peak tariff rather than only dated rate cards.               |
| `getNextTimeBasedPricingTransition(cost, timestamp?)`             | Returns the next actual peak/off-peak change strictly after the timestamp, or `undefined` if none exists. |

Timestamps are Unix milliseconds; omitted timestamps use the current time for scheduled pricing. Flat token prices are unaffected. Pricing selects the latest applicable effective rate card, then its long-context tier, then the peak/off-peak multiplier. A transition query concerns the recurring tariff, not dated rate-card changes.

`ModelCost.timeBased` is optional typed metadata (`TimeBasedCost`): `offPeakMultiplier`, `peakWindows` (UTC `weekdays`, Sunday = 0, and start-inclusive/end-exclusive `startMinute`/`endMinute`), and optional `effectiveRates`. Each effective rate is a complete `TokenCost` with an `effectiveFrom` Unix-millisecond timestamp and optional `longContext` tier, replacing the base card from that instant. A schedule with no peak windows at a 1x off-peak multiplier has no recurring tariff, only dated rate cards: `cost-patch`/`cost-fallback` `effective-rates` compile to one, so a row built before a scheduled price change still prices later requests at the new card.

Pass the request-start timestamp when estimating request usage, then preserve the resulting monetary amounts rather than repricing history at display time. OMSP does this using the assistant message timestamp; it is an estimation convention, not a claim about server billing across boundaries. Prefer monetary costs reported by a provider when available.

Schedules are materialized from the [`time-based-cost` KDL axis](src/compat/rules/README.md#time-based-pricing); this does not add a `timeBased` input field to the coding agent's `models.yml`.

## References

- [Monorepo README](https://github.com/TheGrowingPlant443/oh-my-striped-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
