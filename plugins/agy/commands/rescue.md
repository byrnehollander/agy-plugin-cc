---
description: Hand a question, investigation, or (with --write / --shell) an implementation task to Gemini 4 Neon via the Antigravity CLI
argument-hint: "[--write | --shell [--allow-command <prefix>]... [--allow-host <host>]... [--web]] [--background] [--resume|--fresh] [--model <m>] [--effort low|medium|high|xhigh] [--timeout <d>] <task>"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Delegate the user's request to Gemini (default `gemini-4-neon-high`) through the agy companion, then return its output.

Raw user request:
$ARGUMENTS

## 1. Parse routing flags (never put them in the task text)

- `--write`: allow the model to edit files inside this repository (no commands). Pass it ONLY if the user typed `--write`. Never infer it from wording; without it the run is read-only.
- `--shell`: allow the model to edit files AND run commands (tests, builds, scripts) inside the kernel sandbox, with no network except the model API (plus any `--allow-host` hosts). Pass it ONLY if the user typed `--shell`.
- `--allow-command "<prefix>"` (repeatable, only with `--shell`): restrict commands to these prefixes, e.g. `--allow-command "npm test" --allow-command "bun run typecheck"`. Pass through exactly as typed, each value double-quoted; refuse values containing quotes, `$`, backticks, `;`, `|`, `&`, `<`, `>` or newlines.
- `--allow-host <host>` (repeatable, only with `--shell`): let commands also reach this host over HTTPS, e.g. `registry.npmjs.org` for package installs. Pass only hosts the user typed; refuse values with a scheme, port, path or IP address.
- `--web` (only with `--shell`): let commands reach any web host. Pass only if the user typed it. Neon can search the web in every mode without it.
- `--model <m>`, `--effort <e>`, `--timeout <d>`: pass through unchanged. Don't add them yourself; the `agy-runtime` skill's "Choosing a model" table explains the options if the user asks.
- `--background`: run with the Bash tool's `run_in_background: true` and add `--long` to the companion call (see step 4).
- `--resume`: add `--resume-last`. `--fresh`: start a new conversation.
- If neither `--resume` nor `--fresh` was given, check for a resumable conversation:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task-resume-candidate --json
  ```
  If it reports `available: true`, use `AskUserQuestion` once: `Continue the previous Neon conversation` vs `Start a new Neon conversation`. Recommend continuing only if the request is clearly a follow-up ("keep going", "dig deeper", "now fix it"). Continuing costs more tokens than a fresh run.

If no task text remains, ask the user what Neon should do and stop.

## 2. Write the task text

- Forward the user's task text as written.
- The model cannot see this conversation. If the request depends on it ("this error", "the bug we found"), prepend a short `Context:` block with only the facts it needs: exact error messages, file paths, what was already ruled out. Do not add your own analysis or proposed answer.

## 3. Run it (foreground, default)

Use ONE Bash call with `timeout: 600000`. Pass the task on stdin with a QUOTED heredoc so nothing in it is shell-expanded, and put only the recognised routing flags above on the command line (never user text):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task [routing flags] <<'AGY_TASK_EOF_K9'
<task text>
AGY_TASK_EOF_K9
```

If the task text itself contains a line `AGY_TASK_EOF_K9`, pick a different delimiter suffix. Flag values (`--model`, `--effort`, `--timeout`) must be single plain tokens (letters, digits, `.`, `-`); if a value looks like anything else, ask the user instead of passing it.

## 4. Background

Same command with `--long` added, launched with `Bash(run_in_background: true)`. Tell the user: "Neon is working in the background; I'll report when it finishes (or check `/agy:status`)." When the notification arrives, read the output and present it as in step 5.

## 5. Present the result

Follow the `agy-result-handling` skill: return the companion's output verbatim, do not redo or extend the work yourself, and if the run failed, show the failure and its "Next step" line and stop.
