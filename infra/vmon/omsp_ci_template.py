#!/usr/bin/env python3
"""Retired vmon template builder for the private oh-my-striped-pi fork."""

import sys


if __name__ == "__main__":
    sys.exit(
        "Retired: the private oh-my-striped-pi fork uses GitHub-hosted CI, not "
        "a vmon template. No dependencies, network requests, remote builds, or "
        "file writes were started. Use the repository's Nix flake for local "
        "development (nix develop); see infra/docs/README.md."
    )
