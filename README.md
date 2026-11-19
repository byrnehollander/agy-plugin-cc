# agy-plugin-cc

A Claude Code plugin that sends questions, code reviews and coding tasks to Google's Gemini 4 Neon through the [Antigravity CLI](https://antigravity.google/docs/cli/reference) (`agy`). Runs are read-only unless you ask for more. On macOS, each run is confined by a kernel sandbox and a network allowlist. The plugin is named `agy`, so its commands are `/agy:rescue`, `/agy:review` and so on.

> **Google's terms: read this first.** This plugin wraps `agy`. Google's [Antigravity FAQ](https://antigravity.google/docs/faq) says "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service", that this "can result in suspension or termination of your account", and that "Wrapping `agy` inside third-party coding agents or applications … is not supported under consumer plans" (personal Google AI Pro or Ultra subscriptions). For third-party agents it recommends "a Gemini Enterprise or Google AI Studio API key". The plugin has been tested only with a consumer sign-in. Decide for yourself before you use it; nothing here is legal advice.

## Requirements

- macOS (verified on Apple silicon; Intel is untested). Elsewhere there is no kernel sandbox, so only read-only runs work, and only with `AGY_COMPANION_ALLOW_UNSANDBOXED=1`.
- Node.js 22 or later, git, and Claude Code with plugin support.
- The Antigravity CLI, signed in. `/agy:setup` can install it.

## Install

```text
/plugin marketplace add byrnehollander/agy-plugin-cc
/plugin install agy@agy-plugin-cc
/reload-plugins
/agy:setup
```

`/agy:setup` checks Node, the sandbox, `agy` and your sign-in. If `agy` is missing it offers Google's installer. To sign in, open the Antigravity app once or run `! agy` in Claude Code. To update, run `/plugin marketplace update agy-plugin-cc` and then `/reload-plugins`.

## Use

```text
/agy:rescue how does the retry backoff work? cite file:line
/agy:review
/agy:adversarial-review --base main focus on retry safety
/agy:rescue --shell --allow-command "npm test" fix the failing date test and make it pass
```

Neon can't see your Claude conversation, so write tasks that stand alone: the exact error, the paths, and what you have already ruled out. You can also ask Claude to "ask Neon" or "get a Gemini second opinion"; it delegates through the `agy-rescue` subagent, which stays read-only unless your request contains `--write` or `--shell`.

| Mode | Neon can | Use it for |
|---|---|---|
| read (default) | Read files and search the web | Questions, investigations, reviews |
| `--write` | Also edit files in the repo (no commands) | Small edits you will test yourself |
| `--shell` (experimental) | Also run commands in the repo | "Fix this and make the tests pass" |

`--write` and `--shell` need a git repository, so every change shows up in `git diff`. Web search works in every mode; it runs at Google. Commands in `--shell` reach only Google's model endpoints and localhost unless you add a host.

| Command | What it does |
|---|---|
| `/agy:rescue [flags] <task>` | Send a question or task; shows Neon's answer verbatim. |
| `/agy:review` / `/agy:adversarial-review [focus]` | Review uncommitted changes, or the branch against its base. Returns a verdict and findings. |
| `/agy:status`, `/agy:result [job]`, `/agy:cancel [job]` | Track, read and stop jobs. |
| `/agy:setup [--set-model <m>]` | Check the install and set the default model. |

| Flag | Meaning |
|---|---|
| `--write`, `--shell` | Allow edits, or edits and commands (see above). |
| `--allow-command "<prefix>"` | With `--shell`, repeatable: only these command prefixes may run. Scoping, not a security boundary. |
| `--allow-host <host>` | With `--shell`, repeatable: also let commands reach this host over HTTPS, e.g. `registry.npmjs.org` for installs. |
| `--web` | With `--shell`: let commands reach any web host. |
| `--model <m>`, `--effort <e>` | `neon` (default), `hydrogen`, `argon`, `flash`, or a slug from `agy models`; effort `low`/`medium`/`high`/`xhigh`. |
| `--background`, `--timeout <d>` | Run in the background; foreground runs stop at 7 minutes. |
| `--resume`, `--fresh` | Continue the last Neon conversation in this repo, or start a new one. |
| `--base <ref>`, `--scope auto\|working-tree\|branch` | What a review covers. |

**Choosing a model.** The default is `gemini-4-neon-high`; change it with `/agy:setup --set-model <model>`. In one small comparison, Hydrogen matched Neon on a code review and a code-tracing question in about half the time; see "Choosing a model" in [`plugins/agy/skills/agy-runtime/SKILL.md`](plugins/agy/skills/agy-runtime/SKILL.md).

## Safety in brief

- A Seatbelt kernel sandbox, built on the deny-by-default policy from OpenAI's Codex CLI, confines every run. In read and write modes nothing but `agy` can execute. Writes go only to the repo (in write modes) and temp folders; `.git`, `.vscode` and `.idea` at any depth, `.claude`, `.github/workflows`, `.husky`, `.envrc`, `.mcp.json` and similar paths stay read-only. Credential stores such as `~/.ssh`, `~/.aws` and `~/.config/gh` are unreadable.
- All remote traffic goes through a local proxy that allows only Google's model and sign-in hosts, plus what you add in `--shell`.
- Credential-looking environment variables (`*_TOKEN`, `*_SECRET`, `*_API_KEY`, `SSH_AUTH_SOCK`, …) never reach `agy`. Name one in `AGY_COMPANION_KEEP_ENV` if a command really needs it.
- After `--write` and `--shell` runs, the report lists every changed file and warns if a protected path changed. It reports; it doesn't revert.

These are limits, not a guarantee. **Google sees everything Neon reads**, and in `--shell` your login keychain is readable. Use `--shell` only on repositories you trust. [SECURITY.md](SECURITY.md) has the threat model and the full list of limitations.

## Where things are kept

Each run is a job under `~/.agy-plugin-cc/state/workspaces/<repo>-<hash>/jobs/<id>/`: `report.md`, the exact `prompt.txt` sent to `agy` (for reviews this includes the diff), `agy`'s raw output and logs, `egress.log` (hosts allowed and refused) and the `sandbox.sb` profile. The last 50 jobs per repository are kept. Delete everything with `rm -rf ~/.agy-plugin-cc`. `agy` keeps its own history under `~/.gemini/antigravity-cli/`.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `authentication required` | Open the Antigravity app or run `! agy` to sign in, then `/agy:setup`. |
| `model unavailable` | `/agy:setup` lists your models; pick one with `--model`. |
| `stopped by permission policy` | Neon tried something the mode forbids, which ends the run. Use a wider mode or make that change yourself. |
| `Network blocked by the egress policy: <host>` | In `--shell`, add `--allow-host <host>` if the task needs it. If it's your model endpoint (e.g. a Gemini Enterprise sign-in), add it to `AGY_COMPANION_MODEL_HOSTS`. |
| A command is missing an environment variable | It looked like a credential; name it in `AGY_COMPANION_KEEP_ENV`. |
| `timed out` | Use `--background` or a narrower task. |

## Verified versions

`agy` 1.5.12 on macOS (Apple silicon), 2026-11-19, offline and live test suites. `agy` changes quickly; `/agy:setup` warns when yours is newer than the last verified version.

## Credits

Command layout and review schema follow OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc). The Seatbelt base policies in `plugins/agy/sandbox-vendor/` come from [openai/codex](https://github.com/openai/codex) (Apache-2.0; see the LICENSE and NOTICE there). Prior art: [yuting0624/antigravity-for-claude-code](https://github.com/yuting0624/antigravity-for-claude-code) and [btli/antigravity-plugin-cc](https://github.com/btli/antigravity-plugin-cc).

MIT licensed, © agy-plugin-cc contributors. Not affiliated with Google, Anthropic or OpenAI. Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
