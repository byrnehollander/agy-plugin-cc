---
name: agy-runtime
description: Internal contract for calling the agy companion (Antigravity CLI / Gemini 4 Neon) from Claude Code. Used by the agy-rescue subagent.
user-invocable: false
---

# agy runtime contract

## Task call (the only call the rescue subagent makes)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task [flags] <<'AGY_TASK_EOF_K9'
<self-contained task text>
AGY_TASK_EOF_K9
```

Never put task text on the command line; only the flags below go there, and their values must be plain tokens.

The path above is filled in when this skill loads. If it ever appears unexpanded (literally `${CLAUDE_PLUGIN_ROOT}`), use the PATH shim instead: `agy-companion task [flags] <<'AGY_TASK_EOF_K9' …`.

Always use Bash `timeout: 600000` (foreground runs are capped at 7 minutes inside the companion so they finish under Claude Code's 10-minute Bash limit).

Flags. Pass each one only when the request asks for it; the safety-relevant ones only when their literal token appears in the request:
- `--write`: allow edits to files inside the repository root. Only when the literal token `--write` was given. Commands are still never allowed; .git, .claude and similar config paths stay protected by the kernel sandbox.
- `--shell`: allow edits AND commands (tests, builds) inside the kernel sandbox: repo and temp writes only, protected paths blocked, no network except the model API. Only when the literal token `--shell` was given.
- `--allow-command "<prefix>"` (repeatable, with `--shell`): only these command prefixes may run; any other command ends the run.
- `--allow-host <host>` (repeatable, with `--shell`): also let commands reach this host over HTTPS, e.g. `registry.npmjs.org` or `*.pypi.org` for package installs. Only when the literal token `--allow-host` was given, with the hosts the user listed.
- `--web` (with `--shell`): let commands reach any web host. Only when the literal token `--web` was given. Web *search* needs no flag: Neon can search in every mode.
- `--model <m>` and `--effort low|medium|high|xhigh`: see "Choosing a model" below.
- `--timeout <d>`: e.g. `5m`. Max `7m` in the foreground.
- `--resume` (alias `--resume-last`): continue the most recent completed Neon task conversation in this repo (costs more tokens; use only for genuine follow-ups). `--fresh` forces a new conversation.

The rescue subagent always runs in the foreground with one Bash call. Background work is the caller's job: the main agent launches the subagent (or the Bash call) in the background. The companion's own `--background` (a detached worker, results via `/agy:result`) and `--long` (lifts the 7-minute cap for a Bash call that is itself running in the background) are for the slash commands.

## Choosing a model

Default: omit `--model` and `--effort`. The user's configured default (normally `gemini-4-neon-high`) applies. Override only when the user names a model or effort, or a row below clearly fits and the user asked for speed or lower cost.

| Alias | Resolves to | Use when | Notes |
|---|---|---|---|
| `neon` | `gemini-4-neon-<effort>` | Default. Hard questions, design review, implementation. | `--effort xhigh` for the hardest problems; slowest and most quota. |
| `hydrogen` | `gemini-4-hydrogen-<effort>` | Fast second opinions: code review, tracing how code works. | In one comparison (2026-11-19, agy 1.5.12) it matched Neon on a seeded-bug review and a code-tracing question in about half the time. One run per task, so treat this as a hint, not a ranking. |
| `argon` | `gemini-4-argon-<effort>` | An alternative Gemini opinion when Neon and Hydrogen disagree. | Same comparison: equal accuracy, slower than Hydrogen. |
| `flash` | `gemini-3.8-flash-<effort>` | Cheap, simple lookups. | Same comparison: correct but slowest, and missed a detail the others caught. |

Effort applies to every alias above (`low`, `medium`, `high` default, `xhigh`). Pass a full slug from `agy models` to pick anything else.

## Writing the task text

Neon cannot see the Claude conversation. A good task text:
1. States the goal in one or two sentences.
2. Includes the concrete facts it needs (exact error text, file paths, what was ruled out).
3. Says what output is wanted (for example "five bullets with path:line citations", "a patch plan", "yes/no and why").
It already gets the workspace root and file list automatically, and it can read any file in the repo.

## Exit codes

0 success · 2 usage error · 3 not installed / not ready · 10 quota · 11 auth · 12 timeout · 13 stopped by permission policy · 14 model unavailable · 15 cancelled · 16 empty response · 17 invalid structured output · 18 blocked by Gemini safety filter · 1 other error. Output is Markdown either way; return it verbatim.
