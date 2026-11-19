---
description: Show running and recent Antigravity (Neon) jobs for this repository
argument-hint: "[job-id] [--all]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run exactly one Bash call (no other tools). The arguments go on stdin through a quoted heredoc, so nothing in them reaches the shell:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```

Show the output as-is (it is already a Markdown table). Do not add commentary beyond one line pointing to `/agy:result <job>` if a job just finished.
