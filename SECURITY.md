# Security

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository. Include the `agy` version, macOS version and chip, and steps to reproduce. Don't open a public issue for a sandbox escape or a credential leak.

## Threat model

The main adversary is **content in the repository**: a README, code comment, test fixture or dependency that tries to steer the model ("prompt injection") into reading secrets, sending them somewhere, or planting something that runs later. The model itself is treated as untrusted. The user, Claude Code and the plugin's own code are trusted.

The goal is that, whatever the model is talked into, it can only:

- read what the mode allows,
- write inside the repository (in `--write` and `--shell`), outside protected paths,
- reach Google's model endpoints, plus hosts you add in `--shell`.

## How it is enforced

1. **Kernel sandbox (macOS Seatbelt).** Every run executes under a generated `sandbox-exec` profile (`plugins/agy/scripts/lib/sandbox.mjs`), built on OpenAI Codex's deny-by-default base policy. The kernel applies it to `agy` and everything it starts.
   - **Execution:** in read and write modes, only `agy` and the keychain helper can execute. In `--shell` anything can run, but it inherits every limit below. LaunchServices (`open`), Apple Events (`osascript`) and `launchctl` are unavailable, so nothing can start a process outside the sandbox.
   - **Writes:** temp folders and `agy`'s state folder, plus the repository in write modes. These stay read-only:
     - `.git`, `.vscode` and `.idea` at any depth (matched case-insensitively);
     - the repository's `.claude`, `.gemini`, `.agents`, `.codex`, `.github/workflows`, `.husky`, `.envrc` and `.mcp.json`;
     - your `core.hooksPath`;
     - `agy`'s `settings.json` and `bin/`.
   - **Reads:** common credential stores are denied in every mode (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`). In `--shell`, file contents under your home folder are denied except the repository, `agy`'s state and toolchain folders. Credential and history files inside those toolchain folders are denied too, for example `~/.cargo/credentials.toml`, `~/.config/git/credentials` and shell histories.
   - **Network:** loopback only.
2. **Egress proxy.** All remote traffic goes through an in-process CONNECT proxy (`egress.mjs`). By default it allows only `*cloudcode-pa.googleapis.com`, `aicode.googleapis.com`, `www.googleapis.com`, `oauth2.googleapis.com` and `accounts.google.com` on port 443. `--allow-host` adds named hosts and `--web` allows any host, both only in `--shell`. Every decision is logged to the job's `egress.log`.
3. **Environment scrubbing.** Variables whose names look like credentials never reach `agy` or its commands. That covers underscore-separated name parts such as `TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `API_KEY`, `AUTH` and `WEBHOOK`, plus `SSH_AUTH_SOCK`. `agy`'s own sign-in variables (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`) are kept.
4. **`agy`'s own permission rules,** passed per run, deny shell commands, MCP tool calls, browser navigation and file writes wherever the mode doesn't allow them. These are a second layer only. On `agy` 1.5.12 they match paths case-sensitively on a case-insensitive disk, and they don't stop a repository-supplied MCP server from starting. The kernel sandbox is what actually stops both.
5. **Your text is data.** Task and review text reaches the plugin on stdin, never on a shell command line, and words inside it can't switch on `--write` or `--shell`. The flags themselves are put on the command line by Claude, which is instructed to pass only plain tokens the user typed; the companion validates every value it receives.
6. **Post-run report.** After `--write` and `--shell` runs, the report lists every changed file, including git-ignored ones. It flags changes to protected paths and restores `agy`'s `agentapi` launcher if a run modified it. Otherwise it reports; it doesn't revert.

## How it is tested

- `npm test` runs offline: unit tests, integration tests against a fake `agy`, and model-free escape probes. The probes run real programs under the generated profiles and check that writes, reads, network and process-launch attempts are actually refused.
- `npm run test:live` runs a handful of end-to-end checks against the real `agy`. It verifies the final state, such as nothing written outside the repository and no MCP server started, rather than depending on the model to attempt anything.

## Known limitations

- **Google sees everything Neon reads,** including git-ignored files in the repository, review diffs, and search queries. Don't use the plugin on content you aren't willing to send to Google.
- **The login keychain is readable in `--shell`.** `agy` reads its sign-in through `/usr/bin/security`, and the kernel can't tell `agy` apart from its commands. A command can therefore read keychain items that don't prompt for a password, such as a token stored by `gh`. Read and write modes aren't affected.
- **`agy`'s own state is readable in `--shell`,** including its sign-in material under `~/.gemini`.
- **Reads outside the repository aren't restricted in read and write modes,** apart from the credential stores. Only `agy`'s file tool can read in those modes, but what it reads goes to Google.
- **Localhost is reachable in `--shell`.** Stop sensitive local services, such as a database with no password, first.
- **Allowed hosts can carry data out.** `www.googleapis.com` is required by `agy`. A command holding someone else's Google token, for example one planted in the repository, could upload data to that account. Any `--allow-host` host, and every host under `--web`, is a channel too.
- **Some `agy` tools can't be switched off.** Headless `agy` offers `schedule`, `swarm` and subagent tools that permission rules don't cover. On 1.5.12 they ran inside the same sandboxed process and nothing persisted after the run. The prompts tell Neon not to use them.
- **A process that daemonizes,** leaving `agy`'s process group, can outlive the run inside the sandbox. It isn't killed on cancel and isn't covered by the report.
- **Neon can write any code in the repository,** including things that run later outside the sandbox: `package.json` scripts, Makefiles, tests. Review `git diff` before you run anything it wrote.
- **Not reported:** deleted git-ignored files, changes inside a git-ignored `node_modules`, and edits to a file that a git hook symlinks to.
- **Two variables weaken the sandbox on purpose.** `AGY_COMPANION_SANDBOX=off` (for debugging) runs read-only jobs without the kernel sandbox and proxy; `--write` and `--shell` refuse to run with it. `AGY_COMPANION_SANDBOX_ALLOW_EXEC` (a test hook) lets extra programs execute in read and write modes. Don't set either in normal use.
- **Verified only on `agy` 1.5.12, macOS arm64.** A new `agy` release can change behaviour this design relies on, such as honouring the proxy variables. Outside macOS there is no kernel sandbox.
