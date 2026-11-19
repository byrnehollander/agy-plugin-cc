---
description: Cancel a running Antigravity (Neon) job in this repository
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run exactly one Bash call (no other tools). The arguments go on stdin through a quoted heredoc, so nothing in them reaches the shell:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel --args-stdin <<'AGY_ARGS_EOF_7Q2'
$ARGUMENTS
AGY_ARGS_EOF_7Q2
```

Report the output to the user as-is.
