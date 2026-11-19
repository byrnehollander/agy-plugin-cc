// Permission policy passed to `agy --settings` for every run.
//
// Design notes (all verified against agy 1.5.12 on macOS, see SECURITY.md):
//
// * Headless `agy -p` with NO settings auto-approves file writes AND shell
//   commands. Never run agy without one of these policies.
// * `deny` rules let the model continue its turn ("blocked by a permission
//   check") and still answer. `ask` rules / unmatched requests are
//   soft-denied in headless mode, which ENDS the turn with an empty response.
//   So everything we forbid is expressed as `deny`.
// * `deny` outranks `allow`, including allow rules in the user's global
//   ~/.gemini/antigravity-cli/settings.json, so our denies always win.
// * Shell commands, MCP tool calls and browser navigation are ALWAYS denied.
//   (`unsandboxed(...)` rules are ignored on consumer accounts, which is why a
//   model could escape agy's own --sandbox with BypassSandbox=true.)
// * In write mode, writes are allowed only under the workspace root, and
//   sensitive subtrees are denied.
// * These rules are the SECOND layer. agy matches paths case-sensitively on
//   case-insensitive APFS and starts MCP servers despite `deny mcp(*)`, so the
//   kernel sandbox in sandbox.mjs is the primary enforcement on macOS.

export const PROTECTED_AT_ANY_DEPTH = [".git", ".vscode", ".idea"];

export const SENSITIVE_SUBPATHS = [
  ...PROTECTED_AT_ANY_DEPTH,
  ".claude",
  ".gemini",
  ".agents",
  ".codex",
  ".github/workflows",
  ".husky",
  ".envrc",
  ".mcp.json"
];

const ALWAYS_DENIED = ["command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)"];

export const MODES = ["read", "write", "shell"];
export const isWriteMode = (mode) => mode === "write" || mode === "shell";

/** Command prefixes accepted for --allow-command: plain words only, no shell syntax. */
export const ALLOW_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\/:=@+,-]{0,120}$/;

/** Hosts accepted for --allow-host: a DNS name with at least one dot (no IP literals), optionally prefixed by "*." (any subdomain). */
export const ALLOW_HOST_RE = /^(\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Turn an --allow-host value into an anchored, case-insensitive RegExp for the
 * egress proxy. "example.com" matches only example.com; "*.example.com"
 * matches any subdomain (not the apex).
 * @param {string} host
 * @returns {RegExp}
 */
export function hostPatternToRegExp(host) {
  if (!ALLOW_HOST_RE.test(host)) throw new Error(`Invalid --allow-host ${JSON.stringify(host)}`);
  const wildcard = host.startsWith("*.");
  const base = (wildcard ? host.slice(2) : host).toLowerCase().replace(/\./g, "\\.");
  return new RegExp(wildcard ? `^[a-z0-9.-]+\\.${base}$` : `^${base}$`, "i");
}

/**
 * @param {{mode: "read"|"write"|"shell", workspaceRoot: string, web?: boolean, allowCommands?: string[]}} opts
 * @returns {object} settings object for `agy --settings`
 */
export function buildPolicy({ mode, workspaceRoot, web = false, allowCommands = [] }) {
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown policy mode: ${mode}`);
  }
  if (!workspaceRoot || !workspaceRoot.startsWith("/")) {
    throw new Error(`workspaceRoot must be an absolute path, got: ${workspaceRoot}`);
  }
  const root = workspaceRoot.replace(/\/+$/, "");
  const allow = [];
  // In shell mode commands are allowed (the kernel sandbox contains them);
  // everything else stays denied.
  const deny = mode === "shell" ? ALWAYS_DENIED.filter((r) => r !== "command(*)") : [...ALWAYS_DENIED];

  if (mode === "read") {
    deny.push("write_file(*)");
  } else {
    allow.push(`write_file(${root})`);
    // Top-level prefixes only; the kernel sandbox also blocks nested .git,
    // .vscode and .idea at any depth, and is what actually enforces all of these.
    for (const sub of SENSITIVE_SUBPATHS) deny.push(`write_file(${root}/${sub})`);
  }
  if (mode === "shell") {
    for (const c of allowCommands) {
      if (!ALLOW_COMMAND_RE.test(c)) throw new Error(`Invalid --allow-command prefix: ${JSON.stringify(c)}`);
    }
    if (allowCommands.length) allow.push(...allowCommands.map((c) => `command(${c})`));
    else allow.push("command(*)");
  }

  // agy 1.5.12 has no URL-fetch tool in headless runs. Allow one only with
  // --shell --web, where the egress proxy lets any host through anyway.
  if (mode === "shell" && web) allow.push("read_url(*)");
  else deny.push("read_url(*)");

  return {
    // "" neutralises agy >= 1.5.7 defaulting headless runs to Auto mode.
    agentMode: "",
    toolPermission: "request-review",
    permissions: { allow, deny }
  };
}

/**
 * Human-readable one-liner for reports.
 * Web search is listed in every mode: agy's search_web tool runs at Google,
 * never touches the local network, and cannot be switched off by agy rules.
 */
export function describePolicy({ mode, web, sandboxed = true, allowHosts = [], allowCommands = [] }) {
  const parts = [mode === "shell" ? "shell (sandboxed, experimental)" : mode === "write" ? "write (workspace files only)" : "read-only"];
  if (mode === "shell") parts.push(allowCommands.length ? `commands: ${allowCommands.join(" | ")}` : "any command");
  else parts.push("no shell");
  parts.push("web search on");
  if (web) parts.push("network: any host");
  else if (allowHosts.length) parts.push(`network: model API + ${allowHosts.join(", ")}`);
  else parts.push("network: model API only");
  if (!sandboxed) parts.push("NO kernel sandbox");
  return parts.join(", ");
}

/**
 * Audit the user's persistent agy settings for rules that would weaken a run
 * if our per-run policy were ever bypassed or if agy changed precedence.
 * Returns a list of warning strings.
 */
export function auditUserSettings(settingsObjects) {
  const warnings = [];
  for (const { file, data } of settingsObjects) {
    if (!data || typeof data !== "object") continue;
    const perms = data.permissions ?? {};
    const allow = Array.isArray(perms.allow) ? perms.allow : [];
    for (const rule of allow) {
      const r = String(rule);
      if (/^(command|unsandboxed)\(/.test(r)) {
        warnings.push(`${file}: allow rule ${JSON.stringify(r)} grants shell access to interactive agy sessions (this plugin denies it per run).`);
      } else if (/^write_file\((\*|\/|~)\)?/.test(r) || r === "write_file(*)") {
        warnings.push(`${file}: allow rule ${JSON.stringify(r)} grants broad file writes.`);
      }
    }
    if (data.toolPermission === "always-proceed") {
      warnings.push(`${file}: toolPermission is "always-proceed" (auto-approves every tool in interactive sessions).`);
    }
    if (data.agentMode === "auto") {
      warnings.push(`${file}: agentMode is "auto" (overridden per run by this plugin).`);
    }
  }
  return warnings;
}
