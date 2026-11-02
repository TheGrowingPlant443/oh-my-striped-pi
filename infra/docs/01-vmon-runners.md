# 01 — Hosted runners; retired vmon infrastructure

The fork's active CI jobs run on GitHub-hosted `ubuntu-22.04` runners, including pull-request and trusted branch jobs. See [the workflows](../../.github/workflows) for their event conditions and permissions. No fork jobs currently select a `vmon` runner label.

The former upstream vmon deployment, its GitHub App, webhook relay, cluster nodes, team limits, JIT runner service, and template snapshots are not infrastructure supplied by this private fork. There are no supported vmon setup, deployment, debug-sandbox, or rollback procedures here.

## Remaining action hooks

Some repository actions still recognize the external runner environment variables `VMON_CI=1` and `VMON_CACHE_URL`. These are third-party infrastructure inputs, not application `OMSP_*` settings. An external operator would need to provision and secure the runner, toolchains, cache directories, cache service, credentials, and trust boundaries independently. Setting those variables alone does not create any of them.

The normal hosted path does not set these variables. It uses GitHub Actions caches where configured and local Bazel execution without the optional vmon remote cache; see [03-caching.md](03-caching.md).

The old template builder is deliberately disabled: see [02-omsp-ci-template.md](02-omsp-ci-template.md). For local development rather than runner provisioning, use `nix develop` from an authenticated checkout.
