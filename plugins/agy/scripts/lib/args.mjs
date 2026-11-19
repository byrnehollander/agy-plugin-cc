// Argument parsing for agy-companion.
//
// Slash commands pass "$ARGUMENTS" as data on stdin (--args-stdin), which
// rawToArgv() splits into leading flags plus verbatim free text. Direct
// callers (the rescue subagent, tests) pass normal argv. Both end up in
// parseArgs().

/** Error thrown for invalid CLI flags, arguments, or preconditions (exits 2). */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Parse argv against a spec.
 * spec = { booleans: Set<string>, values: Set<string>, aliases: Map<string,string> }
 * Returns { flags: {name: value|true}, positionals: string[] }.
 * Everything after a bare "--" is positional.
 * Unknown flags are an error (prevents silently forwarding typos into prompts)
 * unless spec.allowUnknownAsPositional is true.
 */
export function parseArgs(argv, spec = {}) {
  const flags = {};
  const positionals = [];
  const booleans = spec.booleans ?? new Set();
  const values = spec.values ?? new Set();
  const aliases = spec.aliases ?? new Map();
  let i = 0;
  let rest = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (rest) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    if (tok === "--") {
      rest = true;
      i += 1;
      continue;
    }
    if (tok.startsWith("--") && tok.length > 2) {
      let name = tok.slice(2);
      let inline;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      name = aliases.get(name) ?? name;
      if (booleans.has(name)) {
        if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
        flags[name] = true;
        i += 1;
        continue;
      }
      if (values.has(name)) {
        let v = inline;
        if (v === undefined) {
          if (i + 1 >= argv.length) throw new UsageError(`--${name} requires a value`);
          v = argv[i + 1];
          i += 2;
        } else {
          i += 1;
        }
        if (spec.multi?.has(name)) (flags[name] ??= []).push(v);
        else flags[name] = v;
        continue;
      }
      if (spec.allowUnknownAsPositional) {
        positionals.push(tok);
        i += 1;
        continue;
      }
      throw new UsageError(`Unknown flag: --${name}`);
    }
    positionals.push(tok);
    i += 1;
    // Flags are only recognised BEFORE the first free-text word, so prompt or
    // focus text such as "explain --write" can never toggle a flag.
    if (spec.stopAtFirstPositional !== false) rest = true;
  }
  return { flags, positionals };
}

/** Parse durations like "90s", "8m", "1h", "1500ms", or a bare number of seconds. */
export function parseDuration(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(value ?? ""));
  if (!m) throw new UsageError(`Invalid duration: ${value} (use e.g. 90s, 8m, 1h)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  const ms = Math.round(n * mult);
  if (!Number.isFinite(ms) || ms <= 0) throw new UsageError(`Duration must be positive: ${value}`);
  return ms;
}

/** Format a millisecond duration compactly (e.g. "45s", "3m12s", "1h5m"). */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/**
 * Read one flag value from the start of `text`: a single- or double-quoted
 * string (quotes removed; \" and \\ unescaped inside double quotes) or a bare
 * word. Returns the value and the remaining text, or null at end of input.
 */
function readFlagValue(text) {
  const q = text[0];
  if (q === '"' || q === "'") {
    let value = "";
    let i = 1;
    while (i < text.length && text[i] !== q) {
      if (q === '"' && text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) i += 1;
      value += text[i];
      i += 1;
    }
    if (i >= text.length) throw new UsageError(`Unterminated ${q === '"' ? "double" : "single"} quote in a flag value`);
    return { value, rest: text.slice(i + 1).replace(/^\s+/, "") };
  }
  const m = /^(\S+)(\s+|$)/.exec(text);
  return m ? { value: m[1], rest: text.slice(m[0].length) } : null;
}

/**
 * Turn raw slash-command text (delivered as DATA via stdin or a single
 * argument, never interpolated into a shell command line) into argv:
 * leading `--flag [value]` tokens are split on whitespace; everything from the
 * first non-flag word on is kept VERBATIM as one free-text argument after "--".
 * valueFlags: names (without --) that consume the next token as their value.
 */
export function rawToArgv(raw, valueFlags) {
  const text = String(raw ?? "").replace(/^\s+/, "");
  const out = [];
  let rest = text;
  while (rest.length) {
    const m = /^(\S+)(\s+|$)/.exec(rest);
    if (!m) break;
    const tok = m[1];
    if (!tok.startsWith("--") || tok === "--") {
      break;
    }
    const eq = tok.indexOf("=");
    const name = tok.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1 && valueFlags.has(name) && /^--[^=]+=["']/.test(tok)) {
      // --flag="quoted value", possibly containing spaces
      const v = readFlagValue(rest.slice(eq + 1));
      if (!v) break;
      out.push(`--${name}=${v.value}`);
      rest = v.rest;
      continue;
    }
    out.push(tok);
    rest = rest.slice(m[0].length);
    if (eq === -1 && valueFlags.has(name)) {
      const v = readFlagValue(rest);
      if (!v) break;
      out.push(v.value);
      rest = v.rest;
    }
  }
  if (/^--(?:\s|$)/.test(rest)) rest = rest.slice(2);
  const free = rest.trim();
  if (free) out.push("--", free);
  return out;
}
