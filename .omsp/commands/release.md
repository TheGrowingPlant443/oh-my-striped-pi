# Managed deployment

This private fork does not publish public packages or releases. The upstream release, npm-trust, Homebrew, and installer entry points are disabled.

Build this checkout without installing it:

```sh
nix build --no-link .#omsp
```

Deploy through the company's authenticated Git/Nix release process. Do not publish packages, push tags, or replace an installed executable without an explicit request.

