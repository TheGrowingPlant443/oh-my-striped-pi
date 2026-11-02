# 02 — Retired `omsp-ci` template builder

[`infra/vmon/omsp_ci_template.py`](../vmon/omsp_ci_template.py) is a retired entrypoint, not a supported template builder. The private fork uses GitHub-hosted CI and provides no vmon deployment. The former builder assumed unauthenticated access to repository source, which cannot support this private checkout; it has been removed rather than adding credential delegation or a new remote service.

Running the entrypoint only prints a retirement explanation to stderr and exits with status 1:

```bash
python3 -I -B infra/vmon/omsp_ci_template.py
```

It uses only Python's standard library, has no PEP 723 dependencies, and refuses before any dependency installation, network request, remote build, or file write. Old build arguments do not enable it. There are no supported template build, publish, warm-up, or rollback commands.

Use the repository's existing GitHub Actions workflows for CI. For local development, enter the Nix environment with `nix develop` from a checkout whose private-repository access is already configured. Neither path requires this retired builder; Nix may fetch its own declared inputs normally.
