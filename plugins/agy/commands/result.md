---
description: Show the stored output of a finished Antigravity (Neon) job in this repository
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run exactly one Bash call (no other tools). The arguments go on stdin through a quoted heredoc, so nothing in them reaches the shell:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```

Present the output in full, following the `agy-result-handling` skill. Do not summarise or condense it; keep file paths, line numbers, findings and error details exactly as shown.
