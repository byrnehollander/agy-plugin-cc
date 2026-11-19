---
description: Run a Gemini 4 Neon review that challenges the approach, assumptions and failure modes of local changes
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--effort <e>] [focus ...]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a read-only adversarial Neon review: it tries to find the strongest reasons the change should not ship, including whether the approach itself is wrong. Return its output verbatim.

Raw arguments: `$ARGUMENTS`

Rules:
- Review only. Do not fix anything or offer to make changes in this turn.
- Free text after the flags is the user's focus; pass it through unchanged (do not soften or rewrite it).

Choose foreground or background exactly as `/agy:review` does:
- `--wait` → foreground; `--background` → background; otherwise estimate size with `git status --short --untracked-files=all` and `git diff --shortstat` (plus `--cached`, or `<ref>...HEAD` with `--base`), then `AskUserQuestion` once: `Wait for results` / `Run in background`, recommending wait only for a clearly tiny change.
- Do not decide on your own that there is nothing to review: when the working tree is clean, the companion reviews the branch against its base, and it reports "Nothing to review" itself if both are empty. If the size commands show no working-tree changes, recommend waiting.

Foreground (Bash `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```

Background (Bash `run_in_background: true`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review --long --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```
Then tell the user it started and that you will show it when it finishes (or `/agy:status`).

Present the output verbatim, following the `agy-result-handling` skill, then ask which findings (if any) to address.
