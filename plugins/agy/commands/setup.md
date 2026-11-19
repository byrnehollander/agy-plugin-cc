---
description: Check (and optionally install) the Antigravity CLI for the agy plugin, or set the default model
argument-hint: "[--set-model <model>]"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run (Bash `timeout: 120000`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```

Then:

1. If the `agy installed` check failed, use `AskUserQuestion` once:
   - `Install the Antigravity CLI (Recommended)`: runs Google's official installer from antigravity.google, which verifies a SHA-512 checksum and installs to `~/.local/bin/agy`.
   - `Skip for now`
   If the user chooses install, run (Bash `timeout: 400000`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --install --json
   ```
2. If the sign-in check failed, tell the user to sign in once by opening the Antigravity app, or by typing `! agy` in this session and completing the Google login, then rerun `/agy:setup`. Do not try to automate the login.
3. Present the final result to the user as a short checklist (one line per check), followed by any warnings and next steps from the JSON, and the default model. Keep it compact.
4. If this is the first successful setup, add one line: Google's Antigravity FAQ says wrapping `agy` in third-party agents is unsupported on consumer plans; use is at the account owner's discretion.
