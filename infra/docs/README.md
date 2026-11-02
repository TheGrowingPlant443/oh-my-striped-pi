# CI infrastructure

The private oh-my-striped-pi fork uses GitHub-hosted runners. Its active CI jobs select `ubuntu-22.04`; no vmon cluster, GitHub App, private template, or node cache is provided by this repository.

Workflows in [`.github/workflows`](../../.github/workflows) are the source of truth for job selection, checks, permissions, and runner requirements. Repository actions install the required toolchains and manage applicable GitHub Actions caches and workflow artifacts. A hosted job is not guaranteed to start with warm dependencies or a remote Bazel cache.

For local development, use the repository's Nix flake with `nix develop`. This does not provision a CI runner or a VM service. Access to the private checkout must already be configured; the repository does not delegate GitHub credentials to remote builders.

## Infrastructure notes

- [Runner selection and retired vmon integration](01-vmon-runners.md)
- [Retired template builder](02-omsp-ci-template.md)
- [Current cache behavior](03-caching.md)

The optional `VMON_CI` / `VMON_CACHE_URL` action hooks remain for externally provisioned runners only. They are not active fork infrastructure and do not imply that a template or cache service exists.
