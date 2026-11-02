# 03 — CI caches

Active fork CI runs on GitHub-hosted runners. There is no repository-provided vmon snapshot, node cache, or pre-warmed template. Cache availability is an optimization, not a prerequisite for a correct check.

## GitHub Actions caches and artifacts

- [`.github/actions/bun-install`](../../.github/actions/bun-install/action.yml) restores `~/.bun/install/cache` using `bun-<os>-<lockhash>`, with an OS-level restore prefix. It reuses Bun only when it satisfies the repository pin, runs `bun install --frozen-lockfile`, and retries a failed install with a fresh job-local store. Only `main` saves new shared store entries; other refs restore without saving. [The cache-warming workflow](../../.github/workflows/bun-cache-warm.yml) can also seed this store.
- The `native_addons` job restores the main-built linux-x64 addon cache using its native-inputs key. Main saves new entries and prunes superseded ones. Pull-request jobs consume the cached addons rather than building them with Bazel; see [ci.yml](../../.github/workflows/ci.yml) for cache-miss handling.
- Workflow artifacts `natives-linux-x64` and `native-addons` pass built addons to consuming jobs via [`.github/actions/native-artifacts`](../../.github/actions/native-artifacts/action.yml). Artifacts are separate from cross-run caches.
- Tool setup actions may manage their own caches where configured in the workflows. The license/source check explicitly runs `cargo fetch --locked` before `cargo deny --locked --offline check licenses sources`; no template-populated Cargo registry is assumed.

GitHub manages Actions cache storage and ref visibility. Inspect or remove entries through the repository's Actions cache interface. A cache hit does not change the checks or permissions configured by the workflow.

## Bazel

[`.github/actions/bazel-cache`](../../.github/actions/bazel-cache/action.yml) emits a bazelrc fragment. On the active hosted path (`VMON_CI` unset), it selects `--config=ci` only; it does not configure a shared remote cache or template repository cache. Bazel may still reuse local state within a job.

Optional externally provisioned runners setting `VMON_CI=1` get `--repository_cache=/opt/bazel-repo-cache` and `--repo_env=OMSP_XWIN_CACHE_DIR=/opt/bazel-repo-cache/xwin`. Their operator must provision those directories; the retired builder does not populate them. With `VMON_CACHE_URL` set, the action also selects `$VMON_CACHE_URL/bazel`, using `cache-ro` for `pull_request*` events and `cache-rw` otherwise. Without that URL it warns and omits the remote cache. These hooks do not provide a service, enforce server-side authorization, or establish a trust boundary by themselves.

The policies in [`.bazelrc`](../../.bazelrc) control uploads and allow local fallback with retries and a timeout. An external cache operator must enforce repository isolation and read/write authorization independently. Do not infer an active remote cache or a secured vmon deployment from these retained hooks.
