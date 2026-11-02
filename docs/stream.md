# Local Terminal Recordings

`/record` captures the interactive session's rendered screen to a local file. Live streaming and clip uploads are not available in this fork.

### Redaction

Redaction is irreversible and intentionally over-matches. Any match replaces the run with `••••••`; a row with a match is recorded unstyled. Sources:

- Values of environment variables whose names look secret (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, …) and every value loaded from a `.env` file for the directory, regardless of name (8+ chars).
- `.omsp/secrets.yml` and `~/.omsp/agent/secrets.yml` entries.
- Credential shapes (GitHub/GitLab/OpenAI/Anthropic/AWS/Slack/Stripe/npm/HF tokens, JWTs, PEM blocks, `Bearer …`). Vendor prefixes are matched **without** a length gate so a token is masked while it is still being typed or streamed character by character.
- `NAME=value`, `NAME: value`, `"NAME": "value"` where `NAME` looks secret — the value is masked (covers `read .env` and config files on screen).
- Passwords in connection URLs (`scheme://user:password@host`).
- `stream.redactPatterns`.

Known plain values are also matched by prefix (6+ characters) so a partially typed secret is masked before it is complete.

Redaction cannot know about secrets it has never seen: a token pasted from elsewhere that matches no shape and no configured value is shown. Use `stream.redactPatterns` or `secrets.yml` for anything unusual. The redactor is loaded when a recording starts.

## Recording

`/record` captures normalized, redacted rows, viewport patches, and scrollback commits into a local file. No account is needed. The footer shows `● REC` while recording; `/record` again stops it and prints the path.

Recordings are written to `<tmpdir>/omsp-recordings/<utc-time>-<session>.ompcast`, a JSON Lines file similar to asciicast: a header line `{"ompcast":1,"cols":…,"rows":…,"title":…,"createdAt":…}`, then one `[ms, frame]` line per screen frame (`reset`, `history`, `resize`, `viewport`, `patch`).

```
omsp play                      # newest recording
omsp play <file> -s 2 -i 1     # 2× speed, pauses capped at 1s
```

Playback requires an interactive terminal and runs on the normal screen: the recorded viewport occupies the bottom of the terminal and recorded scrollback scrolls into your terminal's scrollback, so the output stays after playback ends. Space pauses/resumes; `q`, Esc, or Ctrl-C quits.

