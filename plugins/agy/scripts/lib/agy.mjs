// Everything that touches the agy binary: locating it, probing it, building
// argv, and running it under a wall-clock guard in its own process group.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageError } from "./args.mjs";

export const DEFAULT_MODEL = "gemini-4-neon-high";
export const MIN_TESTED_VERSION = "1.5.0";
export const LAST_VERIFIED_VERSION = "1.5.12";
export const ARGV_PROMPT_LIMIT = 60 * 1024; // above this, send the prompt on stdin
const EFFORTS = ["low", "medium", "high", "xhigh"];

const FAMILY_ALIASES = new Map([
  ["neon", "gemini-4-neon"],
  ["argon", "gemini-4-argon"],
  ["hydrogen", "gemini-4-hydrogen"],
  ["flash", "gemini-3.8-flash"]
]);
const FIXED_ALIASES = new Map([
  ["orchestrator", "gemini-pro-orchestrator-neon"],
  ["orchestrator-neon", "gemini-pro-orchestrator-neon"],
  ["orchestrator-argon", "gemini-pro-orchestrator-g1-pro"]
]);

/** Locate an executable `agy` binary via $AGY_BIN, ~/.local/bin/agy, or PATH. */
export function resolveAgyBinary(env = process.env) {
  const candidates = [];
  if (env.AGY_BIN) candidates.push(env.AGY_BIN);
  candidates.push(path.join(os.homedir(), ".local", "bin", "agy"));
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "agy"));
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

function runQuick(bin, args, { timeoutMs = 30_000, cwd } = {}) {
  const r = spawnSync(bin, args, {
    cwd: cwd ?? os.homedir(),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

/** Return the semantic version string (X.Y.Z) reported by `agy --version`, or null. */
export function agyVersion(bin) {
  const r = runQuick(bin, ["--version"], { timeoutMs: 15_000 });
  const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  return m ? m[1] : null;
}

/** Compare two dotted version strings (major.minor.patch); returns -1, 0, or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = String(b).split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `agy models` → [{id, name}]. Throws an Error with .agyStderr on failure. */
export function listModels(bin) {
  const r = runQuick(bin, ["models"], { timeoutMs: 45_000 });
  if (r.error || r.status !== 0) {
    const err = new Error(`agy models failed (${r.error?.message ?? `exit ${r.status}`})`);
    err.agyStderr = `${r.stderr}\n${r.stdout}`;
    throw err;
  }
  const models = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^([a-z0-9][a-z0-9.\-_]*)\t+(.+)$/i.exec(line.trim());
    if (m) models.push({ id: m[1], name: m[2].trim() });
  }
  return models;
}

/**
 * Resolve user-facing model/effort input to an agy model slug.
 *   (undefined, undefined)      -> default
 *   ("neon", "xhigh")           -> gemini-4-neon-xhigh
 *   (undefined, "xhigh")        -> default family with that effort
 *   ("gemini-4-neon-low", "high") -> gemini-4-neon-high
 *   ("orchestrator", *)          -> gemini-pro-orchestrator-neon (effort ignored)
 */
export function resolveModel(model, effort, defaultModel = DEFAULT_MODEL) {
  if (effort != null && !EFFORTS.includes(effort)) {
    throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")} (got ${effort})`);
  }
  const m = (model ?? "").trim().toLowerCase() || String(defaultModel ?? "").trim().toLowerCase() || DEFAULT_MODEL;
  if (FIXED_ALIASES.has(m)) return { slug: FIXED_ALIASES.get(m), effortIgnored: effort != null };
  if (FAMILY_ALIASES.has(m)) return { slug: `${FAMILY_ALIASES.get(m)}-${effort ?? "high"}`, effortIgnored: false };
  const suffix = /-(low|medium|high|xhigh)$/.exec(m);
  if (effort != null) {
    if (suffix) return { slug: m.slice(0, -suffix[0].length) + `-${effort}`, effortIgnored: false };
    return { slug: m, effortIgnored: true };
  }
  return { slug: m, effortIgnored: false };
}

/**
 * Build agy argv. The prompt is appended LAST as `-p <prompt>` when small;
 * otherwise the caller must feed it on stdin (no -p), which avoids argv limits.
 */
export function buildAgyArgs({ model, settings, printTimeoutMs, schemaPath, conversationId, promptOnArgv, prompt, agySandbox = false, logFile }) {
  const args = [
    "--output-format",
    "json",
    "--disable-slash-commands",
    ...(agySandbox ? ["--sandbox"] : []),
    "--model",
    model,
    "--settings",
    JSON.stringify(settings),
    "--print-timeout",
    `${Math.max(1, Math.round(printTimeoutMs / 1000))}s`
  ];
  if (logFile) args.push("--log-file", logFile);
  if (schemaPath) args.push("--json-schema", schemaPath);
  if (conversationId) args.push("--conversation", conversationId);
  if (promptOnArgv) args.push("-p", prompt);
  return args;
}

/** Wall-clock guard: print-timeout plus shutdown headroom (agy >= 1.5.5 can take ~30s to stop background tasks). */
export function guardTimeoutMs(printTimeoutMs, { foreground = false } = {}, env = process.env) {
  const override = Number(env.AGY_COMPANION_GUARD_PAD_MS);
  if (Number.isFinite(override) && override > 0) return printTimeoutMs + override;
  // Foreground runs must finish well inside Claude Code's 10-minute Bash limit.
  const cap = foreground ? 40_000 : 120_000;
  const pad = Math.min(cap, Math.max(35_000, Math.round(printTimeoutMs * 0.25)));
  return printTimeoutMs + pad;
}

/** Kill a whole process group: TERM, wait, then KILL. Safe if already gone. */
export async function killProcessGroup(pgid, { graceMs = 8000 } = {}) {
  if (!pgid || pgid <= 1) return false;
  const alive = () => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return false;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    // already gone
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!alive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
  return true;
}

const MAX_TIMEOUT_MS = 2_147_483_647; // Node.js setTimeout 32-bit signed max

/**
 * Run agy once. stdout/stderr go to FILES, never pipes: agy's MCP children can
 * inherit and hold a pipe open after agy exits, hanging the reader.
 *
 * @returns {Promise<{exitCode, signal, stdout, stderr, guardFired, durationMs}>}
 */
// Variables that look like credentials never reach agy or the commands it
// runs: in --shell, anything in the environment can end up in the model's
// context. agy's own sign-in comes from the keychain (or GEMINI_API_KEY /
// Google Cloud credentials, which are kept).
// Matched on underscore-separated name parts, so AWS_SECRET_ACCESS_KEY,
// GITHUB_TOKEN or STRIPE_KEY go while AWS_REGION or npm_config_registry stay.
const SECRET_NAME_RE = /(^|_)(TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASSPHRASE|CREDENTIALS?|CREDS|KEY|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|AUTH|COOKIE|DSN|WEBHOOK|DATABASE_URL|CONNECTION_STRING)(_|$)/i;
const SECRET_EXACT = new Set(["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "KUBECONFIG", "NETRC"]);
const KEEP_ENV = new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_GENAI_USE_VERTEXAI"]);

/**
 * Copy of `env` without credential-looking variables. AGY_* (agy and this
 * plugin's own settings) are kept; AGY_COMPANION_KEEP_ENV="A,B" keeps more.
 * @returns {Record<string,string>}
 */
export function scrubEnvironment(env = process.env) {
  const keep = new Set([...KEEP_ENV, ...String(env.AGY_COMPANION_KEEP_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    const secret = SECRET_EXACT.has(k) || SECRET_NAME_RE.test(k);
    if (!secret || keep.has(k) || k.startsWith("AGY_")) out[k] = v;
  }
  return out;
}

export function runAgy({ bin, args, cwd, stdinPath, stdoutPath, stderrPath, guardMs, onSpawn, env }) {
  return new Promise((resolve, reject) => {
    let outFd = null;
    let errFd = null;
    let inFd = "ignore";
    const closeFds = () => {
      if (outFd != null) {
        try {
          fs.closeSync(outFd);
        } catch {
          // ignore close errors
        }
        outFd = null;
      }
      if (errFd != null) {
        try {
          fs.closeSync(errFd);
        } catch {
          // ignore close errors
        }
        errFd = null;
      }
      if (typeof inFd === "number") {
        try {
          fs.closeSync(inFd);
        } catch {
          // ignore close errors
        }
        inFd = "ignore";
      }
    };

    const started = Date.now();
    let child;
    try {
      outFd = fs.openSync(stdoutPath, "w", 0o600);
      errFd = fs.openSync(stderrPath, "w", 0o600);
      if (stdinPath) inFd = fs.openSync(stdinPath, "r");
      child = spawn(bin, args, {
        cwd,
        detached: true, // own process group so we can kill agy + its MCP/tool children together
        stdio: [inFd, outFd, errFd],
        env: { ...scrubEnvironment(process.env), ...env, NO_COLOR: "1" }
      });
    } catch (e) {
      closeFds();
      reject(e);
      return;
    }
    closeFds();

    // Record the pid synchronously so a signal or cancel arriving right after
    // spawn can always find and kill the process group.
    if (child.pid) {
      try {
        onSpawn?.(child.pid);
      } catch {
        // bookkeeping failures must not kill the run
      }
    }

    let settled = false;
    let guardFired = false;
    const guard = setTimeout(() => {
      guardFired = true;
      killProcessGroup(child.pid).catch(() => {});
    }, Math.min(Math.max(1, guardMs), MAX_TIMEOUT_MS));

    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      reject(e);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      // Reap stragglers in the group (MCP servers, tool subprocesses).
      killProcessGroup(child.pid, { graceMs: 1000 })
        .catch(() => {})
        .finally(() => {
          resolve({
            exitCode: code,
            signal,
            stdout: safeRead(stdoutPath),
            stderr: safeRead(stderrPath),
            guardFired,
            durationMs: Date.now() - started
          });
        });
    });
  });
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
