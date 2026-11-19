---
description: Run a Gemini 4 Neon code review of local git changes via the Antigravity CLI
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <m>] [--effort <e>]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a read-only Neon review of the current changes and return its output verbatim.

Raw arguments: `$ARGUMENTS`

Rules:
- Review only. Do not fix anything, apply patches, or offer to make changes in this turn.
- `/agy:review` takes no focus text. If the user wants a focused or design-level challenge, point them to `/agy:adversarial-review`.

Choose foreground or background:
- `--wait` → foreground. `--background` → background. Do not ask in either case.
- Otherwise estimate the size first:
  - working tree / auto: `git status --short --untracked-files=all`, `git diff --shortstat`, `git diff --shortstat --cached`
  - with `--base <ref>`: `git diff --shortstat <ref>...HEAD`
  - Recommend waiting only for a clearly tiny change (about 1-2 files). Otherwise recommend background.
  - Use `AskUserQuestion` once: `Wait for results` / `Run in background`, recommended option first with `(Recommended)`.
- Do not decide on your own that there is nothing to review: when the working tree is clean, the companion reviews the branch against its base, and it reports "Nothing to review" itself if both are empty. If the size commands show no working-tree changes, recommend waiting.

Foreground (Bash `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```

Background (Bash `run_in_background: true`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review --long --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```
Then tell the user: "Neon review started in the background; I'll show it when it finishes (or check `/agy:status`)."

Present the output verbatim, following the `agy-result-handling` skill. After the findings, stop and ask which (if any) the user wants fixed.
