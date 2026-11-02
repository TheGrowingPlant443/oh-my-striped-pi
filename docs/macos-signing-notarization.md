# macOS signing & notarization

This private fork is deployed from an authenticated checkout through Nix or
company-managed deployment, not a public installer, Homebrew tap, or GitHub
release channel. `nix build .#omsp` resolves pinned dependencies for the standalone
CLI. Source commands require a prepared, authenticated workspace with managed
dependencies.

Compiled macOS `omsp` binaries can optionally be signed with a
**Developer ID Application** certificate and submitted for **notarization** by
Apple. This guide documents retained manual tools; it does not establish that
any particular artifact has been signed, notarized, or approved by Gatekeeper.
The upstream `release_binary`, `release_smoke`, `release_github`, and
`release_brew` jobs are historical pipeline references, not active jobs in this
fork. No active publication workflow consumes the `APPLE_*` GitHub secrets.

## Manual signing workflow

1. Obtain a compiled Darwin binary through the managed build process. Bun's own
   signature is not shippable: arm64 gets a bare linker signature, and x86_64
   can retain the Bun runtime's Developer ID signature, which no longer matches
   the appended payload.
2. On Linux, `scripts/ci-macos-sign.sh` replaces that signature using
   [rcodesign](https://github.com/indygreg/apple-platform-rs), pinned and
   SHA-256-checked by the helper. With all five `APPLE_*` environment inputs below,
   it:
   - signs with the Developer ID certificate, the hardened runtime
     (`--code-signature-flags runtime`), a secure timestamp
     (`--for-notarization`), and `scripts/macos-entitlements.plist`, using
     the binary's filename as its signing identifier;
   - packages the binary in a ZIP and submits it with
     `rcodesign notary-submit --wait`, retrying a failed submission up to three
     times. Temporary credential files are removed on exit.
   With no credentials it signs ad hoc with the same entitlements; that does
   **not** provide Developer ID trust or notarization. A partial set is an error.
3. Before managed deployment, verify the final artifact on matching macOS
   hardware with `codesign --verify --strict`, then run `--version` and
   `--smoke-test` under that signature. Inspect the signing identity and confirm
   it is not ad hoc when Developer ID signing is required. These are manual
   checks, not guarantees supplied by a release job.

### Why the entitlements are mandatory

The binary is a Bun single-file executable that also launches Xcode's MCP
bridge, so the hardened runtime needs:

| Entitlement                                              | Reason                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-jit`                        | JavaScriptCore JITs at runtime.                                                                                                                                                                                                                                                                                               |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JSC executable memory pages.                                                                                                                                                                                                                                                                                                  |
| `com.apple.security.automation.apple-events`             | Allows macOS to prompt for Automation permission when `xcrun mcpbridge` connects to Xcode; without it, first-time Xcode MCP initialization hangs until timeout.                                                                                                                                                               |
| `com.apple.security.cs.disable-library-validation`       | omsp extracts its native addon (`pi_natives.<triple>.node`) and other optional dylibs to a runtime cache and `dlopen()`s them. They do not share the main binary's Team ID, so without this the hardened runtime aborts with _"mapping process and mapped file have different Team IDs"_ — breaking effectively every command. |

Without `disable-library-validation`, a signed+notarized binary can pass
notarization but **fail at first real use**. Run `--smoke-test` under the final
signature to detect runtime loading failures before managed deployment.

### Stapling limitation (important)

A bare Mach-O executable **cannot be stapled** (`stapler` only supports
`.app`/`.pkg`/`.dmg`). After a successful notarization submission, Apple's ticket
is keyed to the binary's cdhash and must be fetched online rather than read
from the executable. Preserve the actual submission result; signing alone is
not evidence of notarization.

On macOS, `spctl -a -t exec -vv <binary>` can help inspect Gatekeeper assessment.
An unstapled bare binary can produce a non-zero assessment when the online
ticket is unavailable; investigate the assessment and submission results rather
than treating either a signature or a failed lookup as conclusive.

Quarantine behavior depends on the managed delivery mechanism. A quarantined
binary (for example, a browser download) needs Apple's online ticket lookup.
For an offline-distributable artifact, package it in a supported stapleable
container such as a notarized **`.pkg` or `.dmg`** and staple that container's
ticket. The retained signing helper only submits a ZIP containing the bare
binary; it does not create or staple such a deployment container.

## Optional managed signing inputs

The helper consumes these environment variables directly. All five must be
present for Developer ID signing and notarization to engage. They are not
required for the source/Nix build, and storing them as GitHub secrets does not
activate any signing or publication workflow.

| Environment input            | What it is                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12`      | base64 of the exported Developer ID Application `.p12` (cert + private key). |
| `APPLE_CERTIFICATE_PASSWORD` | password you set when exporting the `.p12`.                                  |
| `APPLE_API_KEY_ID`           | App Store Connect API **Key ID**.                                            |
| `APPLE_API_ISSUER_ID`        | App Store Connect API **Issuer ID** (UUID).                                  |
| `APPLE_API_KEY`              | base64 of the App Store Connect `.p8` private key.                           |

### Producing the credential files

Drop these into a working directory (default `~/omsp-signing`):

| File                 | How                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.p12`              | **Keychain Access** → right-click your _Developer ID Application: …_ identity (the entry that expands to a cert **with** a private key) → **Export…** → save as `.p12` and set a password.                                              |
| `p12-password.txt`   | the password you just set on the `.p12`.                                                                                                                                                                                                |
| `AuthKey_<KEYID>.p8` | App Store Connect → **Users and Access → Integrations → App Store Connect API** → create a key (**Account Holder** role also allows API cert creation; **Developer** is enough for notarization) → **download once** (non-recoverable). |
| `issuer-id.txt`      | the **Issuer ID** (UUID) shown above the keys table.                                                                                                                                                                                    |
| `key-id.txt`         | _optional_ — the Key ID; otherwise read from the `.p8` filename.                                                                                                                                                                        |

The App Store Connect API key is the one credential that **cannot** be minted
from a CLI — it is the bootstrap credential for the API itself, and the `.p8`
downloads exactly once. Everything else is local.

### Optional manual credential upload helper

`scripts/ci-macos-upload-secrets.sh` requires exactly one `.p12` and one `.p8`,
imports the certificate into a temporary keychain to verify its password and
Developer ID identity, and checks that the `.p8` contains a PEM private-key
header. It pipes each uploaded value to `gh secret set` over stdin rather than
putting it in `gh` arguments or printing the credential payloads. Validation
does pass the certificate password to `security import -P`, so the password
can appear in that subprocess's arguments. The script prints the filenames
and Key ID.

This helper only stores GitHub Actions secrets; no active publication workflow
consumes them. Use it only if an explicitly authorized managed process needs
that storage. It does not sign, notarize, or release a binary.

```sh
scripts/ci-macos-upload-secrets.sh ~/omsp-signing --dry-run   # validate first
scripts/ci-macos-upload-secrets.sh ~/omsp-signing             # upload all five
gh secret list --repo TheGrowingPlant443/oh-my-striped-pi                       # confirm
```

For managed processes using that storage, re-run it when the certificate is renewed.
`OMSP_SIGNING_DIR` changes the default input directory;
`OMSP_REPO=owner/repo` changes the target repository
(default `TheGrowingPlant443/oh-my-striped-pi`). The validation path requires macOS `security`;
uploading also requires an authenticated `gh` CLI.

### Finding your signing identity / Team ID (sanity check)

```sh
security find-identity -v -p codesigning
# e.g. "Developer ID Application: Your Name (TEAMID1234)"
```

The `.p12` carries a single identity, which rcodesign signs with; you do not
need to store the identity string or Team ID as a secret.

## Manual invocation (not a dry run)

With an existing compiled Darwin binary on Linux, supply the five environment
variables through your approved secret-management mechanism, then invoke:

```sh
bash scripts/ci-macos-sign.sh /path/to/omsp-darwin-arm64
```

This modifies the binary in place and fetches the pinned rcodesign tool. With
credentials it contacts Apple's service and submits a real notarization
request; without them it signs ad hoc only. Do not put credential values in
shell history or logs. Complete the macOS checks above before managed deployment.
