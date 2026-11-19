// Job records. Every run (foreground or background) is a job so that
// /agy:status, /agy:result and /agy:cancel work uniformly.
//
// Layout: <stateRoot>/workspaces/<wsKey>/jobs/<jobId>/
//   job.json      metadata + final outcome (atomic writes via rename)
//   prompt.txt    exact prompt sent to agy
//   stdout.json   agy's raw JSON envelope
//   stderr.log    agy diagnostics
//   report.md     rendered result shown to the user
//   final         exclusive-create marker: whoever creates it first (runner
//                 finishing vs. cancel) owns the final state

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP_JOBS_PER_WORKSPACE = 50;

// Deliberately NOT ${CLAUDE_PLUGIN_DATA}: Claude Code does not set it for Bash
// calls, and other plugins (e.g. the Codex plugin's SessionStart hook) export
// their OWN value into the session environment, so trusting it would write our
// jobs into another plugin's data directory.
/** Return the root directory for agy-companion state (config, caches, jobs). */
export function stateRoot(env = process.env) {
  if (env.AGY_COMPANION_STATE_DIR) return env.AGY_COMPANION_STATE_DIR;
  return path.join(os.homedir(), ".agy-plugin-cc", "state");
}

/** Return a stable, filesystem-safe key identifying a workspace root path. */
export function workspaceKey(workspaceRoot) {
  const base = path.basename(workspaceRoot).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "root";
  const hash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

/** Return the directory storing job subdirectories for `workspaceRoot`. */
export function jobsDir(workspaceRoot, env) {
  return path.join(stateRoot(env), "workspaces", workspaceKey(workspaceRoot), "jobs");
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** Generate a sortable job id containing date, time, and random hex suffix. */
export function newJobId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `agy-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

/** Atomically write `data` as pretty-printed JSON with mode 0o600 via temp-file rename. */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup error
    }
    throw e;
  }
}

/** Read and parse a JSON file, returning null on read or parse failure. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Create a new queued job directory and initial job.json, then prune old terminal jobs. */
export function createJob(workspaceRoot, fields, env) {
  const dir = jobsDir(workspaceRoot, env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let id;
  let jobDir;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    id = newJobId();
    jobDir = path.join(dir, id);
    try {
      fs.mkdirSync(jobDir, { mode: 0o700 });
      break;
    } catch (e) {
      if (e?.code !== "EEXIST" || attempt === 4) throw e;
    }
  }
  const job = {
    id,
    workspaceRoot,
    status: "queued",
    createdAt: new Date().toISOString(),
    ...fields
  };
  writeJsonAtomic(path.join(jobDir, "job.json"), job);
  pruneJobs(dir);
  return { job, jobDir };
}

/**
 * Patch job.json. Once a job is terminal, only the owner of the `final` claim
 * may write (pass {final: true}); every other update is ignored, so a runner
 * can never flip a cancelled job back to "running".
 */
export function updateJob(jobDir, patch, { final = false } = {}) {
  const file = path.join(jobDir, "job.json");
  const cur = readJson(file) ?? {};
  if (!final && TERMINAL_STATUSES.has(cur.status)) return cur;
  if (!final && isFinalClaimed(jobDir) && patch.status && !TERMINAL_STATUSES.has(patch.status)) return cur;
  const next = { ...cur, ...patch };
  writeJsonAtomic(file, next);
  return next;
}

/** Return true if a runner or cancel call has already claimed the job's final state. */
export function isFinalClaimed(jobDir) {
  return fs.existsSync(path.join(jobDir, "final"));
}

/** Claim the right to write the final state. Returns true for exactly one caller. */
export function claimFinal(jobDir, owner) {
  try {
    fs.writeFileSync(path.join(jobDir, "final"), `${owner}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Load job.json from `jobDir`, returning null if missing or corrupt. */
export function loadJob(jobDir) {
  return readJson(path.join(jobDir, "job.json"));
}

/** List all jobs for `workspaceRoot`, reconciled against live processes, newest first. */
export function listJobs(workspaceRoot, env) {
  const dir = jobsDir(workspaceRoot, env);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const jobs = [];
  for (const n of names) {
    const jobDir = path.join(dir, n);
    const job = loadJob(jobDir);
    if (job) jobs.push({ ...reconcileStatus(job), jobDir });
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Find a job by exact id or unique prefix/suffix match in `workspaceRoot`. */
export function findJob(workspaceRoot, jobId, env) {
  const jobs = listJobs(workspaceRoot, env);
  if (!jobId) return { job: jobs[0] ?? null, jobs };
  const exact = jobs.find((j) => j.id === jobId);
  if (exact) return { job: exact, jobs };
  const prefix = jobs.filter((j) => j.id.startsWith(jobId) || j.id.endsWith(jobId));
  if (prefix.length === 1) return { job: prefix[0], jobs };
  return { job: null, jobs, ambiguous: prefix.length > 1 };
}

/** True only for a live process we are allowed to signal (EPERM = someone else's). */
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Return the OS start timestamp string (`ps -o lstart=`) for `pid`, or null. */
export function processStartTime(pid) {
  if (!pid) return null;
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  if (r.error || r.status !== 0) return null;
  const s = (r.stdout ?? "").trim();
  return s || null;
}

/**
 * Is `pid` still the exact process we recorded? Fails CLOSED: without a
 * recorded start time we never treat the pid as ours (PID reuse safety).
 */
export function isSameProcess(pid, recordedStart) {
  if (!pid || !recordedStart) return false;
  if (!isPidAlive(pid)) return false;
  return processStartTime(pid) === recordedStart;
}

/** A non-terminal job whose runner is gone (sleep, kill -9, crash) is "lost". */
function reconcileStatus(job) {
  if (TERMINAL_STATUSES.has(job.status)) return job;
  if (isSameProcess(job.runnerPid, job.runnerStart)) return job;
  const ageMs = Date.now() - Date.parse(job.createdAt);
  if (job.status === "queued" && ageMs < 15_000) return job;
  const agyAlive = isSameProcess(job.agyPid, job.agyStart);
  return {
    ...job,
    status: "lost",
    agyStillRunning: agyAlive,
    error: job.error ?? `The runner process exited without recording a result.${agyAlive ? " agy is still running; /agy:cancel will stop it." : ""}`
  };
}

function pruneJobs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir).map((n) => ({ n, job: loadJob(path.join(dir, n)) }));
  } catch {
    return;
  }
  const excess = entries.length - KEEP_JOBS_PER_WORKSPACE;
  if (excess <= 0) return;
  entries.sort((a, b) => String(a.job?.createdAt ?? "").localeCompare(String(b.job?.createdAt ?? "")));
  for (const { n, job } of entries.slice(0, excess)) {
    const p = path.join(dir, n);
    if (job) {
      if (!TERMINAL_STATUSES.has(job.status)) continue;
    } else {
      // Avoid deleting a brand-new job directory whose job.json is still being written.
      try {
        if (Date.now() - fs.statSync(p).mtimeMs < 60_000) continue;
      } catch {
        continue;
      }
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore concurrent removal or transient fs error
    }
  }
}
