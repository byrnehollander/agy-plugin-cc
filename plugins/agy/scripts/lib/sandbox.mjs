// Kernel-enforced confinement for agy on macOS (Seatbelt / sandbox-exec), the
// same mechanism the Codex CLI uses. agy's own permission rules are a second
// layer only, because live tests on agy 1.5.12 showed they can be bypassed:
//
//   * path rules are matched case-sensitively on a case-insensitive APFS
//     volume: a write to `.GIT/hooks/pre-push` landed in `.git/hooks/`
//     despite `deny write_file(<repo>/.git)`;
//   * `deny mcp(*)` blocks MCP tool CALLS but not server STARTUP: a repo's
//     `.agents/mcp_config.json` launched an arbitrary command during a
//     read-only run;
//   * `unsandboxed(...)` rules are ignored on consumer accounts, so a model can
//     escape agy's own `--sandbox` with BypassSandbox=true whenever commands
//     are allowed.
//
// The profile below closes all three at the kernel level: the process tree may
// exec only agy itself and the keychain helper, may write only to agy's own
// state and temp dirs (plus the workspace minus protected paths in write
// mode), and may not read common credential stores.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROTECTED_AT_ANY_DEPTH, SENSITIVE_SUBPATHS } from "./policy.mjs";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// Helpers agy legitimately execs. /usr/bin/security reads the sign-in token
// from the login keychain (without it agy falls back to an interactive login).
const ALLOWED_HELPERS = ["/usr/bin/security"];

// Shell mode: file CONTENTS under $HOME are unreadable except these (relative
// to $HOME). Toolchains live here, so commands like node/bun/cargo keep working;
// dotfiles with tokens (.npmrc, .netrc, ~/.config/gh, ~/.claude.json, shell
// history, other repos) stay unreadable. Metadata (stat) stays allowed.
export const SHELL_HOME_READ_ALLOW = [
  ".gemini",
  ".local",
  ".nvm",
  ".bun",
  ".cargo",
  ".rustup",
  ".pyenv",
  ".rbenv",
  ".volta",
  ".asdf",
  ".deno",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cache",
  ".gradle",
  ".m2",
  ".sdkman",
  "go",
  ".config/git",
  ".config/mise",
  ".gitconfig",
  ".zshenv",
  "Library/Caches",
  "Library/pnpm",
  "Library/Keychains"
];

const SECRET_READ_DENY = [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".kube", ".netrc", ".npmrc", ".pypirc", ".git-credentials"];

// Shell mode's toolchain read exceptions must not expose credential stores or
// command histories kept inside those folders.
const SHELL_SECRET_READ_DENY = [
  ".bash_history", ".bash_sessions", ".zsh_history", ".zsh_sessions",
  ".cargo/credentials", ".cargo/credentials.toml", ".config/git/credentials",
  ".gem/credentials", ".local/share/gem/credentials", ".gradle/gradle.properties",
  ".gradle/enterprise/keys.properties", ".gradle/develocity/keys.properties",
  ".gemini/oauth_creds.json", ".gemini/.env", ".local/share/keyrings",
  ".local/share/atuin", ".local/share/powershell/PSReadLine", ".local/share/uv/credentials",
  ".cache/huggingface/token", ".cache/huggingface/stored_tokens",
  ".m2/settings.xml", ".m2/settings-security.xml", ".local/share/fish/fish_history"
];

/** True on macOS when /usr/bin/sandbox-exec is available and executable. */
export function sandboxSupported() {
  if (process.platform !== "darwin") return false;
  try {
    fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** SBPL string literal. Paths come from the filesystem, so escape defensively. */
function lit(p) {
  return `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Anchor a Seatbelt regex below a literal directory, including its trailing slash. */
function relativeRegex(dir, pattern) {
  return `(regex (string-append "^" (regex-quote ${lit(path.join(dir, "/"))}) ${lit(pattern)}))`;
}

/** The path patterns below use ASCII letters only as literal characters. */
function caseFoldPattern(pattern) {
  return pattern.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
}

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * A writable workspace must never contain the user's home directory (a git
 * repo at ~ would make ~/Library/LaunchAgents writable). Compared
 * case-insensitively, as APFS is by default.
 */
export function isUnsafeWorkspaceRoot(root, home = os.homedir()) {
  const r = realOrSelf(path.resolve(root)).toLowerCase();
  const h = realOrSelf(path.resolve(home)).toLowerCase();
  return h === r || h.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Credential locations under `home` that are never readable (more of them in shell mode). */
function deniedReadPaths(home, shell) {
  return [...SECRET_READ_DENY, ...(shell ? SHELL_SECRET_READ_DENY : [])].map((rel) => path.join(home, rel));
}

const VENDOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "sandbox-vendor");
let vendorCache = null;
/** Codex's deny-by-default Seatbelt base (Apache-2.0, see sandbox-vendor/NOTICE.md). */
function vendorPolicies() {
  if (!vendorCache) {
    const read = (f) => fs.readFileSync(path.join(VENDOR_DIR, f), "utf8");
    vendorCache = {
      base: read("codex_seatbelt_base_policy.sbpl"),
      prefs: read("codex_seatbelt_preferences_policy.sbpl"),
      network: read("codex_seatbelt_network_policy.sbpl")
    };
  }
  return vendorCache;
}

/**
 * Compose the Seatbelt profile for one run.
 *
 * Base: Codex's deny-by-default policy (process/sysctl/IPC/platform services),
 * plus full file reads, preferences and TLS/DNS platform services. On top:
 *   - read/write modes: only agy + the keychain helper may exec;
 *     shell mode: any program may exec (it inherits every limit below).
 *   - network: localhost only (agy's own server and the egress proxy);
 *     every remote host is reached through the allowlisting proxy.
 *   - writes: temp dirs, the workspace (write/shell) minus protected paths,
 *     agy's state minus its settings/binaries.
 *   - reads: credential stores denied.
 * Because the base denies by default, LaunchServices (`open`), Apple Events
 * (`osascript` to other apps) and launchd job submission are unavailable, so
 * nothing can start a process outside the sandbox.
 *
 * @param {{mode:"read"|"write"|"shell", workspaceRoot:string, agyBin:string, home?:string,
 *          extraProtected?:string[], extraExec?:string[], extraWritable?:string[]}} o
 */
export function buildSeatbeltProfile(o) {
  const home = realOrSelf(o.home ?? os.homedir());
  const agyReal = realOrSelf(o.agyBin);
  const root = realOrSelf(o.workspaceRoot);
  const agyState = path.join(home, ".gemini", "antigravity-cli");
  const tmpDirs = ["/private/tmp", "/private/var/folders"];
  const execAllow = [agyReal, ...ALLOWED_HELPERS, ...(o.extraExec ?? []).map(realOrSelf)];
  const denied = deniedReadPaths(home, o.mode === "shell");
  const v = vendorPolicies();

  const lines = [
    ";; ---- Codex base policy (deny by default) ----",
    v.base.trim(),
    "",
    ";; ---- agy plugin additions ----",
    "(allow file-read*)",
    v.prefs.trim(),
    v.network.trim(),
    "",
    ";; Network: localhost only (agy's local server + the egress proxy).",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    ""
  ];
  if (o.mode !== "shell") {
    lines.push(
      ";; Read/write modes: only agy itself and the keychain helper may be executed",
      ";; (no shell, no MCP servers, no tool subprocesses).",
      "(deny process-exec)",
      `(allow process-exec ${execAllow.map((p) => `(literal ${lit(p)})`).join(" ")})`,
      ""
    );
  }
  lines.push(
    ";; Writes. SBPL applies the LAST matching rule, so order matters.",
    `(allow file-write* ${tmpDirs.map((d) => `(subpath ${lit(d)})`).join(" ")} (subpath "/dev"))`
  );
  if (o.mode === "write" || o.mode === "shell") {
    lines.push(`(allow file-write* (subpath ${lit(root)}))`);
  } else {
    lines.push(";; Read-only: the workspace is never writable, even if it lives under a temp dir.");
    lines.push(`(deny file-write* (subpath ${lit(root)}))`);
  }
  lines.push(
    ";; agy's own state stays writable, except its settings and binaries.",
    `(allow file-write* (subpath ${lit(agyState)}))`,
    `(deny file-write* (literal ${lit(path.join(agyState, "settings.json"))}) (subpath ${lit(path.join(agyState, "bin"))}))`,
    // Shell mode: agy rewrites its 59-byte `agentapi` PATH shim before every
    // command. The companion restores the pre-run content after the run, so a
    // command cannot leave a tampered shim for unsandboxed sessions.
    ...(o.mode === "shell" ? [`(allow file-write* (literal ${lit(agentapiShimPath(home))}))`] : []),
    ...(o.extraWritable?.length ? [`(allow file-write* ${o.extraWritable.map((p) => `(literal ${lit(p)})`).join(" ")})`] : []),
    "",
    ...(o.mode === "shell"
      ? [
          ";; Shell mode: file contents under $HOME are unreadable except toolchains,",
          ";; agy's state and the workspace (other repos, ~/.claude.json, history, tokens).",
          `(deny file-read-data (subpath ${lit(home)}))`,
          `(allow file-read-data (literal ${lit(home)}) ${SHELL_HOME_READ_ALLOW.map((r) => `(subpath ${lit(path.join(home, r))})`).join(" ")})`,
          `(allow file-read-data (subpath ${lit(root)}) (subpath ${lit(path.dirname(agyReal))}))`,
          ""
        ]
      : []),
    ";; Credential stores are unreadable."
  );
  // Name file-read-data explicitly: Seatbelt lets a rule for the specific
  // operation (the shell-mode `allow file-read-data` grants for toolchain
  // folders) beat a later `file-read*` rule, so a wildcard-only deny would not
  // protect credential files inside an allowed folder.
  lines.push(`(deny file-read* file-read-data ${denied.map((p) => `(subpath ${lit(p)})`).join(" ")})`);
  if (o.mode === "write" || o.mode === "shell") {
    // Place these after every write grant, including state and log files.
    const protectedPaths = [...SENSITIVE_SUBPATHS.map((s) => path.join(root, s)), ...(o.extraProtected ?? []).map(realOrSelf)];
    lines.push(`(deny file-write* ${protectedPaths.map((p) => `(subpath ${lit(p)})`).join(" ")})`);
    const names = PROTECTED_AT_ANY_DEPTH.map((s) => caseFoldPattern(s.replaceAll(".", "[.]")));
    lines.push(`(deny file-write* ${relativeRegex(root, `([^/]+/)*(${names.join("|")})(/|$)`)})`);
  }
  return `${lines.join("\n")}\n`;
}

export function agentapiShimPath(home = os.homedir()) {
  return path.join(realOrSelf(home), ".gemini", "antigravity-cli", "bin", "agentapi");
}

/**
 * Snapshot agy's agentapi shim before a shell-mode run; the returned function
 * restores it afterwards and reports whether it had been altered.
 */
export function guardAgentapiShim(home = os.homedir(), agyBin = null) {
  const p = agentapiShimPath(home);
  const inspect = () => {
    try {
      const st = fs.lstatSync(p);
      if (st.isFile()) return { kind: "file", content: fs.readFileSync(p), mode: st.mode & 0o7777 };
      if (st.isSymbolicLink()) return { kind: "symlink", target: fs.readlinkSync(p) };
      return { kind: "other" };
    } catch {
      return { kind: "missing" };
    }
  };
  const before = inspect();
  return () => {
    const now = inspect();
    const unchanged =
      before.kind === "file"
        ? now.kind === "file" && now.mode === before.mode && Buffer.compare(now.content, before.content) === 0
        : before.kind === "symlink"
          ? now.kind === "symlink" && now.target === before.target
          : before.kind === "other"
            ? now.kind === "other"
            : now.kind === "missing" || (now.kind === "file" && isLegitShim(now.content, agyBin) && (now.mode & 0o022) === 0);
    if (unchanged) return { restored: false };
    try {
      if (now.kind === "file" || now.kind === "symlink") fs.rmSync(p, { force: true });
      else if (now.kind === "other") return { restored: false, tampered: true };
      if (before.kind === "file") fs.writeFileSync(p, before.content, { mode: before.mode });
    } catch {
      return { restored: false, tampered: true };
    }
    return { restored: true, tampered: true };
  };
}

/**
 * The shim agy writes is exactly `#!/bin/sh\nexec "<agy>" agentapi "$@"\n`.
 * With a known agy binary, only that binary (or its real path) is accepted.
 */
function isLegitShim(buf, agyBin) {
  const text = String(buf);
  if (!agyBin) return /^#!\/bin\/sh\nexec "[^"\n]+" agentapi "\$@"\n?$/.test(text);
  const bins = new Set([agyBin]);
  try {
    bins.add(fs.realpathSync(agyBin));
  } catch {
    // keep the given path
  }
  return [...bins].some((b) => text === `#!/bin/sh\nexec "${b}" agentapi "$@"\n` || text === `#!/bin/sh\nexec "${b}" agentapi "$@"`);
}

/** Wrap an agy invocation in sandbox-exec. */
export function wrapCommand({ profilePath, bin, args }) {
  return { bin: SANDBOX_EXEC, args: ["-f", profilePath, bin, ...args] };
}

/** Optional extra exec allowances (test hook; colon-separated absolute paths). */
export function extraExecFromEnv(env = process.env) {
  return String(env.AGY_COMPANION_SANDBOX_ALLOW_EXEC ?? "")
    .split(":")
    .filter((p) => p.startsWith("/"));
}
