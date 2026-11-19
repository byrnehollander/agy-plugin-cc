#!/usr/bin/env node
// agy-companion: run Google's Antigravity CLI (agy) as a safe, scriptable
// sub-agent for Claude Code. See ../../../SECURITY.md for the safety model.
//
// Layers, outermost first:
//   1. macOS Seatbelt profile (sandbox.mjs): kernel-enforced exec/write/read limits.
//   2. agy per-run permission policy (policy.mjs): deny shell/MCP/web/writes.
//   3. Post-run audit (write mode): changed files + protected-path snapshot.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { UsageError, formatDuration, parseArgs, parseDuration, rawToArgv } from "./lib/args.mjs";
import {
  ARGV_PROMPT_LIMIT,
  DEFAULT_MODEL,
  LAST_VERIFIED_VERSION,
  MIN_TESTED_VERSION,
  agyVersion,
  buildAgyArgs,
  compareVersions,
  guardTimeoutMs,
  killProcessGroup,
  listModels,
  resolveAgyBinary,
  resolveModel,
  runAgy
} from "./lib/agy.mjs";
import { OUTCOMES, classifyRun, parseEnvelope } from "./lib/classify.mjs";
import {
  collectReviewContext,
  diffProtected,
  diffSnapshots,
  git,
  gitRoot,
  listWorkspaceFiles,
  recentlyModifiedFiles,
  resolveReviewTarget,
  resolveWorkspaceRoot,
  snapshotProtected,
  snapshotWorktree
} from "./lib/git.mjs";
import {
  TERMINAL_STATUSES,
  claimFinal,
  createJob,
  findJob,
  isFinalClaimed,
  isSameProcess,
  listJobs,
  loadJob,
  processStartTime,
  readJson,
  stateRoot,
  updateJob,
  writeJsonAtomic
} from "./lib/jobs.mjs";
import { ALLOW_COMMAND_RE, ALLOW_HOST_RE, PROTECTED_AT_ANY_DEPTH, SENSITIVE_SUBPATHS, auditUserSettings, buildPolicy, describePolicy, hostPatternToRegExp, isWriteMode } from "./lib/policy.mjs";
import { DEFAULT_ALLOWED_HOSTS, startEgressProxy } from "./lib/egress.mjs";
import { renderFailure, renderReview, renderStatus, renderTask } from "./lib/render.mjs";
import { buildSeatbeltProfile, extraExecFromEnv, guardAgentapiShim, isUnsafeWorkspaceRoot, sandboxSupported, wrapCommand } from "./lib/sandbox.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const FOREGROUND_TIMEOUT_MS = 7 * 60_000; // + 40s guard + overhead stays well under Claude Code's 10-minute Bash limit
const BACKGROUND_TIMEOUT_MS = 30 * 60_000;
const MODELS_CACHE_TTL_MS = 6 * 3_600_000;
const INSTALLER_URL = "https://antigravity.google/cli/install.sh";
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CONVERSATION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const WORKSPACE_FILE_LIST_MAX_BYTES = 40 * 1024;
const CANCEL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// ---------------------------------------------------------------- utilities

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function loadTemplate(name) {
  return fs.readFileSync(path.join(ROOT_DIR, "prompts", name), "utf8");
}

function fill(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => vars[k] ?? "");
}

function configPath() {
  return path.join(stateRoot(), "config.json");
}

function loadConfig() {
  return readJson(configPath()) ?? {};
}

function saveConfig(patch) {
  fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  writeJsonAtomic(configPath(), { ...loadConfig(), ...patch });
}

function defaultModel() {
  return process.env.AGY_COMPANION_MODEL || loadConfig().defaultModel || DEFAULT_MODEL;
}

function requireAgy() {
  const bin = resolveAgyBinary();
  if (!bin) {
    const e = new Error("The Antigravity CLI (agy) is not installed. Run /agy:setup.");
    e.outcome = "not_installed";
    throw e;
  }
  return bin;
}

/** Kernel sandbox is mandatory unless explicitly overridden (non-macOS, read-only only). */
function sandboxDecision(mode) {
  const flag = mode === "shell" ? "--shell" : "--write";
  if (process.env.AGY_COMPANION_SANDBOX === "off") {
    if (isWriteMode(mode)) throw new UsageError(`${flag} requires the kernel sandbox; unset AGY_COMPANION_SANDBOX=off.`);
    return false;
  }
  if (sandboxSupported()) return true;
  if (isWriteMode(mode)) {
    throw new UsageError(`${flag} is only supported on macOS, where the kernel sandbox (sandbox-exec) can enforce it.`);
  }
  if (process.env.AGY_COMPANION_ALLOW_UNSANDBOXED === "1") return false;
  throw new UsageError(
    "No kernel sandbox is available on this platform. Read-only runs would rely on agy's own rules, which do not stop MCP servers from starting. Set AGY_COMPANION_ALLOW_UNSANDBOXED=1 to accept that."
  );
}

/** Cached `agy models` (6h, keyed by agy binary identity). Returns null if unavailable. */
function cachedModels(bin, { refresh = false } = {}) {
  const cacheFile = path.join(stateRoot(), "models-cache.json");
  let stat;
  try {
    stat = fs.statSync(bin);
  } catch {
    return null;
  }
  const key = `${bin}:${stat.size}:${stat.mtimeMs}`;
  const cache = readJson(cacheFile);
  if (!refresh && cache && cache.key === key && Array.isArray(cache.models) && Date.now() - cache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return cache.models;
  }
  try {
    const models = listModels(bin);
    if (models.length) {
      fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
      writeJsonAtomic(cacheFile, { key, fetchedAt: Date.now(), models });
    }
    return models;
  } catch {
    return null;
  }
}

function validateModel(bin, slug) {
  let models = cachedModels(bin);
  if (!models?.length) return { ok: true, name: null }; // can't check; let agy decide
  let hit = models.find((m) => m.id === slug);
  if (!hit) {
    models = cachedModels(bin, { refresh: true }) ?? models;
    if (!models?.length) return { ok: true, name: null };
    hit = models.find((m) => m.id === slug);
  }
  if (hit) return { ok: true, name: hit.name };
  return { ok: false, available: models };
}

function workspaceFileBlock(root) {
  const { files, total } = listWorkspaceFiles(root, { maxFiles: 1500 });
  const kept = [];
  let bytes = 0;
  let truncated = false;
  for (const f of files) {
    const add = Buffer.byteLength(f) + (kept.length ? 1 : 0);
    if (bytes + add > WORKSPACE_FILE_LIST_MAX_BYTES) {
      truncated = true;
      break;
    }
    kept.push(f);
    bytes += add;
  }
  const list = truncated ? (kept.length ? `${kept.join("\n")}\n… (truncated)` : "… (truncated)") : kept.join("\n");
  return { list, total, shown: kept.length };
}

/** The shell preamble's network sentence, matching what the egress proxy will allow. */
function networkRule({ web, allowHosts = [] }) {
  if (web) return "Network: commands may reach any web host on ports 80/443 in this session. Use it only for what the task needs, and never send repository content, credentials or secrets anywhere.";
  if (allowHosts.length) {
    return `Network: besides the model API, commands may reach ONLY these hosts, over HTTPS: ${allowHosts.map((h) => `\`${h}\``).join(", ")}. Everything else is refused. Never send repository content, credentials or secrets to them.`;
  }
  return "There is NO network access except to the model API. Package installs (npm/bun/pip install) and downloads will fail; use the dependencies already present, and report clearly if a task needs a new one.";
}

function buildPreamble({ mode, root, web = false, allowHosts = [], allowCommands = [] }) {
  const { list, total, shown } = workspaceFileBlock(root);
  const template = mode === "shell" ? "preamble-shell.md" : mode === "write" ? "preamble-write.md" : "preamble-read.md";
  return fill(loadTemplate(template), {
    WORKSPACE_ROOT: root,
    NETWORK_RULE: networkRule({ web, allowHosts }),
    COMMAND_NOTE: allowCommands.length ? ` (ONLY commands starting with: ${allowCommands.map((c) => `\`${c}\``).join(", ")}; any other command ends your turn immediately, so do not try one)` : "",
    FILE_LIST: list || "(no files found)",
    FILE_TOTAL: String(total),
    FILE_SHOWN: String(shown)
  });
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function hooksPathOutsideDefault(root) {
  const r = git(root, ["config", "--get", "core.hooksPath"], { allowFail: true });
  if (!r.ok || !r.stdout.trim()) return [];
  return [path.resolve(root, r.stdout.trim())];
}

// ---------------------------------------------------------------- run engine

function finalize(jobDir, { status, outcome, report, extra = {} }) {
  if (claimFinal(jobDir, "runner")) {
    fs.writeFileSync(path.join(jobDir, "report.md"), report, { mode: 0o600 });
    updateJob(jobDir, { status, outcome, finishedAt: new Date().toISOString(), ...extra }, { final: true });
    return true;
  }
  // Someone else (cancel / signal) owns the final state; keep our output as a
  // clearly-labelled side file and never contradict their status.
  fs.writeFileSync(path.join(jobDir, "report.after-cancel.md"), report, { mode: 0o600 });
  return false;
}

/** Build the agy argv (and Seatbelt profile + wrapper when sandboxed) for a job. */
function prepareAgyCommand(jobDir, job, req, bin) {
  const promptPath = path.join(jobDir, "prompt.txt");
  const prompt = fs.readFileSync(promptPath, "utf8");
  const onArgv = Buffer.byteLength(prompt) <= ARGV_PROMPT_LIMIT;
  const settings = buildPolicy({ mode: job.mode, workspaceRoot: job.workspaceRoot, web: job.web, allowCommands: job.allowCommands ?? [] });
  const logPath = path.join(jobDir, "agy.log");
  const agyArgs = buildAgyArgs({
    model: job.model,
    settings,
    printTimeoutMs: job.timeoutMs,
    schemaPath: req.schema ? REVIEW_SCHEMA : null,
    conversationId: req.conversationId ?? null,
    promptOnArgv: onArgv,
    prompt,
    agySandbox: !job.sandboxed,
    logFile: logPath
  });
  if (!job.sandboxed) return { command: { bin, args: agyArgs }, onArgv, promptPath };
  const profilePath = path.join(jobDir, "sandbox.sb");
  fs.writeFileSync(
    profilePath,
    buildSeatbeltProfile({
      mode: job.mode,
      workspaceRoot: job.workspaceRoot,
      agyBin: bin,
      extraProtected: isWriteMode(job.mode) ? hooksPathOutsideDefault(job.workspaceRoot) : [],
      extraExec: extraExecFromEnv(),
      extraWritable: [logPath]
    }),
    { mode: 0o600 }
  );
  return { command: wrapCommand({ profilePath, bin, args: agyArgs }), onArgv, promptPath };
}

/**
 * Extra model-endpoint hosts for every mode, for sign-in routes the default
 * allowlist doesn't cover (e.g. a Gemini Enterprise or API-key setup).
 * AGY_COMPANION_MODEL_HOSTS="host1,host2"; same syntax as --allow-host.
 * In read and write modes only agy itself can open connections.
 */
function modelHostsFromEnv() {
  const hosts = String(process.env.AGY_COMPANION_MODEL_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of hosts) {
    if (!ALLOW_HOST_RE.test(h)) throw new UsageError(`Invalid host in AGY_COMPANION_MODEL_HOSTS: ${JSON.stringify(h)}`);
  }
  return hosts;
}

/**
 * Package-manager and build caches normally live under ~ (~/.npm,
 * ~/Library/Caches/...), which shell mode cannot write. Point them at a
 * per-job temp directory (writable, removed after the run) so installs via
 * --allow-host and ordinary builds work. Module stores that hold already
 * downloaded dependencies (GOMODCACHE, CARGO_HOME) are left alone so offline
 * builds keep using them.
 */
function createJobCaches() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-job-cache-"));
  const sub = (name) => path.join(dir, name);
  return {
    env: {
      npm_config_cache: sub("npm"),
      YARN_CACHE_FOLDER: sub("yarn"),
      BUN_INSTALL_CACHE_DIR: sub("bun"),
      PIP_CACHE_DIR: sub("pip"),
      UV_CACHE_DIR: sub("uv"),
      POETRY_CACHE_DIR: sub("poetry"),
      GOCACHE: sub("go-build"),
      XDG_CACHE_HOME: sub("xdg")
    },
    remove: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

/** How long a signalled runner waits for the normal cleanup path (shim restore, audit, proxy close) before forcing an exit. */
const SIGNAL_CLEANUP_DEADLINE_MS = 15_000;

/**
 * Register idempotent SIGINT/SIGTERM/SIGHUP handlers that cancel the job and
 * kill agy. The handler does not exit: once agy's process group is gone,
 * runAgy resolves and executeJob's normal cleanup runs (shim restore, egress
 * proxy close, write audit). If that stalls, `emergencyCleanup` restores what
 * it can synchronously and the process exits anyway.
 */
function installCancelSignals(jobDir, getAgyPid, onInterrupted, emergencyCleanup = () => {}) {
  let handling = false;
  const onSignal = (sig) => {
    if (handling) return;
    handling = true;
    onInterrupted();
    if (claimFinal(jobDir, `signal:${sig}`)) {
      updateJob(jobDir, { status: "cancelled", outcome: "cancelled", finishedAt: new Date().toISOString(), error: `Interrupted (${sig}).` }, { final: true });
    }
    setTimeout(() => {
      try {
        emergencyCleanup();
      } finally {
        process.exit(OUTCOMES.cancelled.exit);
      }
    }, SIGNAL_CLEANUP_DEADLINE_MS);
    killProcessGroup(getAgyPid(), { graceMs: 1500 }).catch(() => {});
  };
  for (const s of CANCEL_SIGNALS) process.on(s, onSignal);
  return () => {
    for (const s of CANCEL_SIGNALS) process.off(s, onSignal);
  };
}

/** Post-run write-mode audit: merge git diff, recent mtimes, and protected-path diffs. */
function collectWriteChanges(workspaceRoot, before, protectedBefore, startedMs, mode) {
  const after = snapshotWorktree(workspaceRoot);
  const tracked = diffSnapshots(before ?? new Map(), after);
  const recent = recentlyModifiedFiles(workspaceRoot, startedMs);
  const byFile = new Map(tracked.map((c) => [c.file, c]));
  for (const f of recent.files) if (!byFile.has(f)) byFile.set(f, { file: f, change: "modified (ignored or unchanged in git)" });
  const { changed: protectedChanged, incomplete: protectedIncomplete } = diffProtected(protectedBefore, snapshotProtected(workspaceRoot, SENSITIVE_SUBPATHS));
  const protectedSet = new Set(protectedChanged);
  for (const f of protectedChanged) if (!byFile.has(f)) byFile.set(f, { file: f, change: "protected path changed" });
  const files = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  const isSensitive = (f) => {
    const lf = f.toLowerCase();
    return lf.split("/").some((s) => PROTECTED_AT_ANY_DEPTH.includes(s)) || SENSITIVE_SUBPATHS.some((s) => lf === s || lf.startsWith(`${s}/`)) || protectedSet.has(f);
  };
  return { files, sensitive: files.map((c) => c.file).filter(isSensitive), incomplete: recent.incomplete, protectedIncomplete, shell: mode === "shell" };
}

/** Render the final Markdown report for a completed or failed run. */
function renderJobReport({ job, req, classified, run, changes }) {
  if (classified.outcome !== "success") {
    return renderFailure({ job, classified, stderr: run.stderr, durationMs: run.durationMs, changes });
  }
  return req.kind === "task"
    ? renderTask({ job, classified, durationMs: run.durationMs, changes })
    : renderReview({ job, classified, durationMs: run.durationMs, target: req.target, context: req.contextMeta });
}

/**
 * Execute a prepared job (foreground or inside the background worker).
 * Returns { report, exitCode, job, classified }.
 */
async function executeJob(jobDir) {
  const job = loadJob(jobDir);
  const req = readJson(path.join(jobDir, "request.json"));
  if (!job || !req) throw new Error(`Incomplete or unreadable job metadata in ${jobDir}.`);
  const cancelledReport = () => {
    const cur = loadJob(jobDir) ?? job;
    return { report: `## agy job ${job.id} was cancelled before it finished.`, exitCode: OUTCOMES.cancelled.exit, job: cur, classified: { response: "", structured: null } };
  };
  if (isFinalClaimed(jobDir)) return cancelledReport();

  const bin = requireAgy();
  const writes = isWriteMode(job.mode);
  const before = writes ? snapshotWorktree(job.workspaceRoot) : null;
  const protectedBefore = writes ? snapshotProtected(job.workspaceRoot, SENSITIVE_SUBPATHS) : null;
  const { command, onArgv, promptPath } = prepareAgyCommand(jobDir, job, req, bin);
  const startedAt = new Date().toISOString();
  updateJob(jobDir, { status: "running", startedAt, runnerPid: process.pid, runnerStart: processStartTime(process.pid) });
  if (isFinalClaimed(jobDir)) return cancelledReport(); // cancelled while preparing

  let agyPid = null;
  let interrupted = false;
  const restoreShim = job.sandboxed && job.mode === "shell" ? guardAgentapiShim(os.homedir(), bin) : null;
  const removeSignals = installCancelSignals(
    jobDir,
    () => agyPid,
    () => {
      interrupted = true;
    },
    () => restoreShim?.()
  );

  // Every remote connection from inside the sandbox goes through this proxy
  // (the profile only allows localhost); --allow-host adds named hosts and
  // --web widens it to any host (both are shell-only).
  let proxy = null;
  let run;
  const caches = job.sandboxed && job.mode === "shell" ? createJobCaches() : null;
  try {
    if (job.sandboxed) {
      proxy = await startEgressProxy({
        logPath: path.join(jobDir, "egress.log"),
        allowAll: !!job.web,
        allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...modelHostsFromEnv().map(hostPatternToRegExp), ...(job.allowHosts ?? []).map(hostPatternToRegExp)]
      });
    }
    run = await runAgy({
      bin: command.bin,
      args: command.args,
      env: { ...proxy?.env, ...caches?.env },
      cwd: job.workspaceRoot,
      stdinPath: onArgv ? null : promptPath,
      stdoutPath: path.join(jobDir, "stdout.json"),
      stderrPath: path.join(jobDir, "stderr.log"),
      // Only a run Claude waits on in the foreground needs the short shutdown pad.
      guardMs: guardTimeoutMs(job.timeoutMs, { foreground: !job.long && !job.background }),
      onSpawn: (pid) => {
        agyPid = pid;
        updateJob(jobDir, { agyPid: pid, agyStart: processStartTime(pid) });
        // Cancel won the race between our pre-spawn check and the spawn.
        if (isFinalClaimed(jobDir)) killProcessGroup(pid).catch(() => {});
      }
    });
  } catch (e) {
    run = { exitCode: null, signal: null, stdout: "", stderr: String(e?.message ?? e), guardFired: false, durationMs: 0 };
  } finally {
    removeSignals();
    await proxy?.close().catch(() => {});
    caches?.remove();
  }
  const shim = restoreShim?.() ?? null;
  const egress = proxy?.stats() ?? null;

  const current = loadJob(jobDir);
  const wasCancelled = interrupted || current?.status === "cancelled";
  const classified = classifyRun({ ...run, cancelled: wasCancelled, schemaRequested: !!req.schema });
  if (shim?.tampered) classified.warnings.push(`agy's agentapi shim (~/.gemini/antigravity-cli/bin/agentapi) was modified during the run and has been ${shim.restored ? "restored" : "COULD NOT be restored; inspect it"}.`);
  if (egress?.unexpectedDenied.length) {
    const hint = classified.outcome === "success" ? "" : " If one of these is your model endpoint (for example with a Gemini Enterprise or API-key sign-in), add it to AGY_COMPANION_MODEL_HOSTS.";
    classified.warnings.push(`Network blocked by the egress policy: ${egress.unexpectedDenied.join(", ")}.${hint}`);
  }
  if (req.effortIgnored) classified.warnings.push(`--effort was ignored: ${job.model} has a fixed thinking level.`);
  const changes = writes ? collectWriteChanges(job.workspaceRoot, before, protectedBefore, Date.parse(startedAt), job.mode) : null;
  if (changes?.protectedIncomplete) classified.warnings.push("The protected-path audit was incomplete (too many or unreadable files under .git, .claude and similar paths), so a change there might not be listed. Check them yourself before running anything in this repo.");
  const report = renderJobReport({ job, req, classified, run, changes });

  const owned = finalize(jobDir, {
    status: classified.outcome === "success" ? "completed" : classified.outcome === "cancelled" ? "cancelled" : "failed",
    outcome: classified.outcome,
    report,
    extra: {
      exitCode: run.exitCode,
      conversationId: classified.envelope?.conversation_id || null,
      usage: classified.envelope?.usage ?? null,
      error: classified.outcome === "success" ? null : classified.error,
      changedFiles: changes?.files.map((c) => c.file) ?? undefined,
      egressDenied: egress?.unexpectedDenied.length ? egress.unexpectedDenied : undefined,
      protectedChanged: changes?.sensitive?.length ? changes.sensitive : undefined
    }
  });
  const final = loadJob(jobDir) ?? job;
  if (!owned || final.status === "cancelled") {
    return {
      report: `## agy job ${final.id} was cancelled\n\n${changes?.files.length ? `Files changed before it stopped: ${changes.files.map((c) => `\`${c.file}\``).join(", ")}. Review with \`git diff\`.` : "No output is kept for a cancelled job."}`,
      exitCode: OUTCOMES.cancelled.exit,
      job: final,
      classified
    };
  }
  return { report, exitCode: OUTCOMES[classified.outcome]?.exit ?? 1, job: final, classified };
}

/** Create the job, then run it in the foreground or hand it to a detached worker. */
async function launch({ kind, mode, web, allowHosts = [], allowCommands = [], model, modelLabel, timeoutMs, background, long, prompt, summary, root, extra = {}, json }) {
  const sandboxed = sandboxDecision(mode);
  modelHostsFromEnv(); // validate before creating the job
  const policyLabel = describePolicy({ mode, web, sandboxed, allowHosts, allowCommands });
  const { job, jobDir } = createJob(root, {
    kind,
    mode,
    web,
    allowHosts,
    allowCommands,
    model,
    modelLabel,
    timeoutMs,
    background,
    long,
    sandboxed,
    summary,
    policyLabel
  });
  fs.writeFileSync(path.join(jobDir, "prompt.txt"), prompt, { mode: 0o600 });
  writeJsonAtomic(path.join(jobDir, "request.json"), { kind, ...extra });

  if (background) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "_worker", jobDir], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
    const msg = {
      jobId: job.id,
      status: "started",
      message: `Started ${kind} job \`${job.id}\` in a detached worker (${model}, ${policyLabel}, timeout ${formatDuration(timeoutMs)}). Check \`/agy:status\`; fetch output with \`/agy:result ${job.id}\`.`
    };
    out(json ? JSON.stringify(msg) : msg.message);
    return 0;
  }

  const { report, exitCode, job: final, classified } = await executeJob(jobDir);
  if (json) {
    out(
      JSON.stringify({
        jobId: final.id,
        status: final.status,
        outcome: final.outcome,
        model: final.model,
        conversationId: final.conversationId ?? null,
        response: classified.response,
        structured: classified.structured,
        error: final.error ?? null,
        changedFiles: final.changedFiles ?? null,
        protectedChanged: final.protectedChanged ?? null,
        egressDenied: final.egressDenied ?? null,
        warnings: classified.warnings ?? [],
        usage: final.usage ?? null,
        report
      })
    );
  } else {
    out(report);
  }
  return exitCode;
}

// ---------------------------------------------------------------- commands

const COMMON_VALUES = ["model", "effort", "timeout"];

function resolveRunOptions(flags, bin, { background, long }) {
  const { slug, effortIgnored } = resolveModel(flags.model, flags.effort, defaultModel());
  const v = validateModel(bin, slug);
  if (!v.ok) {
    const list = v.available.map((m) => `- \`${m.id}\` (${m.name})`).join("\n");
    const e = new UsageError(`Model \`${slug}\` is not available on this account.\n\nAvailable models:\n${list}`);
    e.outcome = "model_unavailable";
    throw e;
  }
  const unbounded = background || long;
  const timeoutMs = flags.timeout ? parseDuration(flags.timeout) : unbounded ? BACKGROUND_TIMEOUT_MS : FOREGROUND_TIMEOUT_MS;
  if (!unbounded && timeoutMs > FOREGROUND_TIMEOUT_MS) {
    throw new UsageError(
      `Foreground runs are capped at ${formatDuration(FOREGROUND_TIMEOUT_MS)} (Claude Code's Bash limit is 10 minutes). Use --background, or --long inside a run_in_background Bash call.`
    );
  }
  return { slug, modelLabel: v.name ?? slug, timeoutMs, effortIgnored };
}

/** --long (Claude-side background) wins over --background (detached worker). */
function executionMode(flags) {
  if (flags.long) return { background: false, long: true };
  return { background: !!flags.background, long: false };
}

function workspaceFromFlags(flags) {
  const cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();
  try {
    return resolveWorkspaceRoot(cwd);
  } catch (e) {
    throw new UsageError(`Invalid workspace directory ${cwd}: ${e.message}`);
  }
}

function requireJob(root, id) {
  const { job, ambiguous } = findJob(root, id);
  if (!job) throw new UsageError(ambiguous ? `Job id ${id} is ambiguous.` : `No job ${id} in this workspace.`);
  return job;
}

function isCancellable(job) {
  return job.status === "running" || job.status === "queued" || (job.status === "lost" && job.agyStillRunning);
}

async function cmdTask(argv) {
  const { flags, positionals } = parseArgs(argv, {
    booleans: new Set(["write", "shell", "web", "background", "long", "json", "resume-last", "fresh"]),
    aliases: new Map([["resume", "resume-last"]]),
    values: new Set([...COMMON_VALUES, "conversation", "prompt-file", "cwd", "allow-command", "allow-host"]),
    multi: new Set(["allow-command", "allow-host"])
  });
  if (flags.fresh && (flags["resume-last"] || flags.conversation)) throw new UsageError("--fresh cannot be combined with --resume-last or --conversation.");
  const allowCommands = (flags["allow-command"] ?? []).map((c) => c.trim());
  // An empty prefix must never silently become "any command".
  if (allowCommands.some((c) => !c)) throw new UsageError("--allow-command needs a non-empty command prefix, e.g. \"npm test\".");
  for (const c of allowCommands) {
    if (!ALLOW_COMMAND_RE.test(c)) throw new UsageError(`Invalid --allow-command prefix ${JSON.stringify(c)}: use plain words (e.g. "npm test", "bun run typecheck").`);
  }
  if (allowCommands.length && !flags.shell) throw new UsageError("--allow-command only applies with --shell.");
  const allowHosts = [...new Set((flags["allow-host"] ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))];
  for (const h of allowHosts) {
    if (!ALLOW_HOST_RE.test(h)) throw new UsageError(`Invalid --allow-host ${JSON.stringify(h)}: use a host name such as registry.npmjs.org or *.pypi.org (no scheme, port, path or IP address).`);
  }
  if ((flags.web || allowHosts.length) && !flags.shell) {
    throw new UsageError(
      `${flags.web ? "--web" : "--allow-host"} only applies with --shell. Neon can already search the web in every mode (agy's search tool runs at Google); reaching other hosts needs commands such as curl, which only --shell allows.`
    );
  }
  if (flags.web && allowHosts.length) throw new UsageError("--web already allows any host; drop --allow-host, or drop --web to limit access to the listed hosts.");
  const root = workspaceFromFlags(flags);
  let prompt = positionals.join(" ").trim();
  if (flags["prompt-file"]) {
    try {
      prompt = fs.readFileSync(path.resolve(flags["prompt-file"]), "utf8").trim();
    } catch (e) {
      throw new UsageError(`Could not read --prompt-file: ${e.message}`);
    }
  }
  if (!prompt) prompt = readStdin().trim();
  if (!prompt) throw new UsageError("No task given. Pass the prompt on stdin (quoted heredoc), with --prompt-file, or as trailing words.");

  const mode = flags.shell ? "shell" : flags.write ? "write" : "read";
  if (isWriteMode(mode) && isUnsafeWorkspaceRoot(root)) {
    throw new UsageError(`--${mode} requires a workspace below or outside your home directory. Refusing ${root}, which contains your home directory.`);
  }
  if (isWriteMode(mode) && !gitRoot(root)) {
    throw new UsageError(`--${mode} needs a git repository so every change can be reviewed with \`git diff\` and reverted.`);
  }
  const bin = requireAgy();
  const { background, long } = executionMode(flags);
  const { slug, modelLabel, timeoutMs, effortIgnored } = resolveRunOptions(flags, bin, { background, long });

  let conversationId = flags.conversation ?? null;
  if (conversationId && !CONVERSATION_ID_RE.test(conversationId)) throw new UsageError("Invalid --conversation id.");
  if (flags["resume-last"] && !conversationId) {
    const cand = resumeCandidate(root);
    if (!cand) throw new UsageError("No previous completed agy task with a conversation to resume in this workspace.");
    conversationId = cand.conversationId;
  }

  const fullPrompt = `${buildPreamble({ mode, root, web: !!flags.web, allowHosts, allowCommands })}\n<task>\n${prompt}\n</task>\n`;
  return launch({
    kind: "task",
    mode,
    web: !!flags.web,
    allowHosts,
    allowCommands,
    model: slug,
    modelLabel,
    timeoutMs,
    background,
    long,
    prompt: fullPrompt,
    summary: prompt.split("\n")[0].slice(0, 200),
    root,
    extra: { conversationId, effortIgnored },
    json: !!flags.json
  });
}

const REVIEW_VALUES = new Set([...COMMON_VALUES, "base", "scope", "cwd"]);

function formatReviewContext(ctx) {
  const parts = [];
  if (ctx.log) parts.push(`<commits>\n${ctx.log.trim()}\n</commits>`);
  parts.push(`<diffstat>\n${ctx.stat.trim()}\n</diffstat>`);
  parts.push(`<diff>\n${ctx.diff}\n</diff>`);
  if (ctx.untracked.length) {
    const blocks = ctx.untracked.map((u) =>
      u.content == null ? `<untracked_file path="${u.file}" content="omitted (binary or large; read it if relevant)"/>` : `<untracked_file path="${u.file}">\n${u.content}\n</untracked_file>`
    );
    parts.push(`<untracked_files>\n${blocks.join("\n")}\n</untracked_files>`);
  }
  return parts.join("\n\n");
}

async function cmdReview(argv, kind) {
  const { flags, positionals } = parseArgs(argv, {
    booleans: new Set(["background", "long", "json", "wait"]),
    values: REVIEW_VALUES
  });
  const root = workspaceFromFlags(flags);
  const focus = positionals.join(" ").trim();
  if (focus && kind === "review") {
    throw new UsageError("/agy:review takes no focus text; use /agy:adversarial-review for a focused challenge review.");
  }
  const target = resolveReviewTarget(root, { scope: flags.scope ?? "auto", base: flags.base });
  const ctx = collectReviewContext(root, target);
  if (ctx.empty) {
    out(flags.json ? JSON.stringify({ status: "empty", target: target.label }) : `Nothing to review: ${target.label} is empty.`);
    return 0;
  }
  const bin = requireAgy();
  const { background, long } = executionMode(flags);
  const { slug, modelLabel, timeoutMs, effortIgnored } = resolveRunOptions(flags, bin, { background, long });

  const template = loadTemplate(kind === "adversarial-review" ? "adversarial-review.md" : "review.md");
  const body = fill(template, {
    TARGET_LABEL: target.label,
    USER_FOCUS_BLOCK: focus ? `User focus (weight this heavily):\n<focus>\n${focus}\n</focus>` : "",
    TRUNCATION_NOTE: ctx.truncated ? "- The diff below was TRUNCATED for size. Use the diffstat to find the remaining changed files and read them directly." : "",
    CONTEXT: formatReviewContext(ctx)
  });
  const fullPrompt = `${buildPreamble({ mode: "read", root, web: false })}\n${body}`;
  return launch({
    kind,
    mode: "read",
    web: false,
    model: slug,
    modelLabel,
    timeoutMs,
    background,
    long,
    prompt: fullPrompt,
    summary: `${kind === "adversarial-review" ? "adversarial review" : "review"} of ${target.label}${focus ? `: ${focus}` : ""}`.slice(0, 200),
    root,
    extra: { schema: true, target, contextMeta: { truncated: ctx.truncated }, effortIgnored },
    json: !!flags.json
  });
}

function resumeCandidate(root) {
  return listJobs(root).find((j) => j.kind === "task" && j.status === "completed" && j.conversationId) ?? null;
}

function cmdResumeCandidate(argv) {
  const { flags } = parseArgs(argv, { booleans: new Set(["json"]), values: new Set(["cwd"]) });
  const root = workspaceFromFlags(flags);
  const c = resumeCandidate(root);
  const res = c ? { available: true, jobId: c.id, conversationId: c.conversationId, summary: c.summary, finishedAt: c.finishedAt } : { available: false };
  out(flags.json ? JSON.stringify(res) : c ? `Resumable: ${c.id} — ${c.summary}` : "No resumable agy task in this workspace.");
  return 0;
}

function jobIdArg(positionals) {
  const id = positionals[0];
  if (id && !JOB_ID_RE.test(id)) throw new UsageError(`Invalid job id: ${JSON.stringify(id).slice(0, 80)}`);
  return id;
}

function cmdStatus(argv) {
  const { flags, positionals } = parseArgs(argv, { booleans: new Set(["all", "json"]), values: new Set(["cwd"]), stopAtFirstPositional: false });
  const root = workspaceFromFlags(flags);
  const id = jobIdArg(positionals);
  if (id) {
    const job = requireJob(root, id);
    out(flags.json ? JSON.stringify(job) : renderStatus([job], { all: true }));
    return 0;
  }
  const jobs = listJobs(root);
  out(flags.json ? JSON.stringify(jobs) : renderStatus(jobs, { all: !!flags.all }));
  return 0;
}

function cmdResult(argv) {
  const { flags, positionals } = parseArgs(argv, { booleans: new Set(["json"]), values: new Set(["cwd"]), stopAtFirstPositional: false });
  const root = workspaceFromFlags(flags);
  const id = jobIdArg(positionals);
  let job;
  if (id) {
    job = requireJob(root, id);
  } else {
    job = listJobs(root).find((j) => TERMINAL_STATUSES.has(j.status) || j.status === "lost");
    if (!job) {
      out(flags.json ? JSON.stringify({ jobId: null, status: "none" }) : "No finished agy jobs in this workspace yet.");
      return 0;
    }
  }
  if (job.status === "running" || job.status === "queued") {
    const elapsed = formatDuration(Date.now() - Date.parse(job.startedAt ?? job.createdAt));
    out(flags.json ? JSON.stringify({ ...job, report: null, elapsed }) : `Job \`${job.id}\` is still ${job.status} (${elapsed} so far). Check again with \`/agy:status\`.`);
    return 0;
  }
  let report;
  if (job.status === "cancelled") {
    // A runner that finished after the cancel keeps its report (including the
    // changed-files audit) in a side file; show it so edits are never hidden.
    let afterCancel = null;
    try {
      afterCancel = fs.readFileSync(path.join(job.jobDir, "report.after-cancel.md"), "utf8");
    } catch {
      // none recorded
    }
    report = `## agy job ${job.id} was cancelled\n\n${job.error ?? ""}${job.changedFiles?.length ? `\n\nFiles changed before it stopped: ${job.changedFiles.map((f) => `\`${f}\``).join(", ")}.` : ""}${afterCancel ? `\n\n### Output recorded after the cancel\n\n${afterCancel}` : ""}`;
  } else if (job.status === "lost") {
    report = `## agy job ${job.id} was lost\n\n${job.error}`;
  } else {
    try {
      report = fs.readFileSync(path.join(job.jobDir, "report.md"), "utf8");
    } catch {
      report = `## Job ${job.id}: ${job.status}\n\n${job.error ?? "No report was recorded."}`;
    }
  }
  out(flags.json ? JSON.stringify({ ...job, report }) : report);
  return 0;
}

async function cmdCancel(argv) {
  const { flags, positionals } = parseArgs(argv, { booleans: new Set(["json"]), values: new Set(["cwd"]), stopAtFirstPositional: false });
  const root = workspaceFromFlags(flags);
  const id = jobIdArg(positionals);
  let job;
  if (id) {
    job = requireJob(root, id);
  } else {
    const live = listJobs(root).filter(isCancellable);
    if (live.length === 0) {
      out(flags.json ? JSON.stringify({ cancelled: false, reason: "no running jobs" }) : "No running agy jobs in this workspace.");
      return 0;
    }
    if (live.length > 1) throw new UsageError(`Several jobs are running; pass one id: ${live.map((j) => j.id).join(", ")}`);
    job = live[0];
  }
  if (!isCancellable(job)) {
    out(flags.json ? JSON.stringify({ jobId: job.id, cancelled: false, status: job.status }) : `Job \`${job.id}\` is already ${job.status}.`);
    return 0;
  }
  const claimed = claimFinal(job.jobDir, "cancel");
  if (claimed) {
    updateJob(job.jobDir, { status: "cancelled", outcome: "cancelled", finishedAt: new Date().toISOString(), error: "Cancelled by user." }, { final: true });
  }
  // Signal only processes provably still ours (fails closed on PID reuse).
  let killed = false;
  if (isSameProcess(job.agyPid, job.agyStart)) {
    killed = await killProcessGroup(job.agyPid);
  }
  if (job.background && isSameProcess(job.runnerPid, job.runnerStart)) {
    try {
      process.kill(job.runnerPid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (flags.json) out(JSON.stringify({ jobId: job.id, cancelled: claimed, agyStopped: killed }));
  else if (claimed) out(`Cancelled job \`${job.id}\`${killed ? " (agy stopped)" : ""}.`);
  else out(`Job \`${job.id}\` finished before it could be cancelled; see \`/agy:result ${job.id}\`.`);
  return 0;
}

function readSettingsFiles() {
  const home = os.homedir();
  const files = [path.join(home, ".gemini", "antigravity-cli", "settings.json"), path.join(home, ".gemini", "config", "config.json")];
  return files.filter((f) => fs.existsSync(f)).map((f) => ({ file: f.replace(home, "~"), data: readJson(f) }));
}

/** `agy -p /permissions` resolves all scopes at zero token cost. */
function resolvedPermissionRules(bin) {
  const r = spawnSync(bin, ["-p", "/permissions", "--output-format", "json"], { cwd: os.homedir(), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  const env = parseEnvelope(r.stdout);
  return env?.command?.data?.permissions ?? null;
}

async function cmdSetup(argv) {
  const { flags } = parseArgs(argv, { booleans: new Set(["json", "install"]), values: new Set(["set-model"]), stopAtFirstPositional: false });
  const report = { ready: false, checks: [], warnings: [], nextSteps: [] };
  const add = (name, ok, detail) => report.checks.push({ name, ok, detail });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("Node.js >= 22", nodeMajor >= 22, process.versions.node);
  const sb = sandboxSupported();
  add("kernel sandbox (macOS sandbox-exec)", sb, sb ? "available; every run is confined" : "unavailable; --write and --shell are disabled, read-only runs need AGY_COMPANION_ALLOW_UNSANDBOXED=1");

  if (flags.install) {
    const existing = resolveAgyBinary();
    if (existing) {
      add("install agy", true, `already installed at ${existing}; skipped`);
    } else {
      const res = installAgy();
      add("install agy", res.ok, res.detail);
    }
  }

  const bin = resolveAgyBinary();
  add("agy installed", !!bin, bin ?? "not found (looked at $AGY_BIN, ~/.local/bin/agy, PATH)");
  if (!bin) {
    report.nextSteps.push("Install the Antigravity CLI: run `/agy:setup` again and choose install (Google's official checksum-verified installer).");
  } else {
    const version = agyVersion(bin);
    const okVersion = version && compareVersions(version, MIN_TESTED_VERSION) >= 0;
    add("agy version", !!okVersion, version ? `${version} (safety suite last verified on ${LAST_VERIFIED_VERSION})` : "unknown");
    if (version && compareVersions(version, LAST_VERIFIED_VERSION) > 0) {
      report.warnings.push(`agy ${version} is newer than the last version the live safety suite ran against (${LAST_VERIFIED_VERSION}). New agy releases can change behaviour the sandbox relies on; see "Verified versions" in the README.`);
    }
    const models = cachedModels(bin, { refresh: true });
    add("signed in (agy models)", !!models && models.length > 0, models ? `${models.length} models available` : "could not list models: sign in first");
    if (!models?.length) report.nextSteps.push("Sign in once: open the Antigravity app, or run `! agy` here and complete the Google login.");
    if (flags["set-model"]) {
      const { slug } = resolveModel(flags["set-model"], undefined, DEFAULT_MODEL);
      if (!models?.length) {
        add(`set default model ${slug}`, false, "not saved: sign in first so the model can be checked against your account");
      } else if (!models.some((m) => m.id === slug)) {
        add(`set default model ${slug}`, false, "not available on this account");
      } else {
        saveConfig({ defaultModel: slug });
        add("set default model", true, slug);
      }
    }
    // Aliases ("neon", "hydrogen") resolve the same way task/review resolve them.
    const def = resolveModel(defaultModel(), undefined, DEFAULT_MODEL).slug;
    const defOk = !!models?.length && models.some((m) => m.id === def);
    add("default model available", defOk, models?.length ? def : `${def} (unknown until signed in)`);
    if (models?.length && !defOk) report.nextSteps.push("Pick an available default: `/agy:setup --set-model <slug>`.");
    if (process.env.AGY_COMPANION_MODEL && flags["set-model"]) {
      report.warnings.push(`AGY_COMPANION_MODEL=${process.env.AGY_COMPANION_MODEL} is set and overrides the saved default.`);
    }
    report.models = models ?? [];
    report.defaultModel = def;
    const scopes = resolvedPermissionRules(bin);
    if (scopes) {
      for (const sc of scopes) {
        const allow = Array.isArray(sc.allow) ? sc.allow : [];
        const risky = allow.filter((r) => /^(command|unsandboxed|mcp)\(|^write_file\((\*|\/|~)/.test(String(r)));
        if (risky.length) report.warnings.push(`agy ${sc.scope} scope allows ${risky.join(", ")} (this plugin denies these per run and the kernel sandbox contains them).`);
      }
    }
  }

  report.warnings.push(...auditUserSettings(readSettingsFiles()));
  report.stateDir = stateRoot();
  // Without the kernel sandbox, nothing runs unless the user opted in to unsandboxed read-only runs.
  const sandboxOk = sb || process.env.AGY_COMPANION_ALLOW_UNSANDBOXED === "1";
  report.ready = sandboxOk && report.checks.filter((c) => c.name !== "kernel sandbox (macOS sandbox-exec)").every((c) => c.ok);

  if (flags.json) {
    out(JSON.stringify(report));
  } else {
    const lines = [`## agy setup: ${report.ready ? "✅ ready" : "❌ not ready"}`, ""];
    for (const c of report.checks) lines.push(`- ${c.ok ? "✅" : "❌"} **${c.name}**: ${c.detail}`);
    if (report.warnings.length) lines.push("", "### Warnings", ...report.warnings.map((w) => `- ⚠️ ${w}`));
    if (report.nextSteps.length) lines.push("", "### Next steps", ...report.nextSteps.map((s) => `- ${s}`));
    if (report.models?.length) {
      const neon = report.models.filter((m) => m.id.includes("neon")).map((m) => `\`${m.id}\``);
      lines.push("", `Neon models: ${neon.join(", ") || "none"} · default: \`${report.defaultModel}\``);
    }
    lines.push("", "Runs are read-only by default and confined by a macOS kernel sandbox. `--write` allows edits inside the repo; `--shell` also allows commands, still inside the sandbox.");
    out(lines.join("\n"));
  }
  return report.ready ? 0 : 3;
}

function installAgy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-"));
  const script = path.join(dir, "install.sh");
  try {
    const dl = spawnSync("curl", ["-fsSL", "--proto", "=https", "--tlsv1.2", "-o", script, INSTALLER_URL], { encoding: "utf8", timeout: 60_000 });
    if (dl.error || dl.status !== 0) return { ok: false, detail: `download failed: ${(dl.stderr || dl.error?.message || "").trim()}` };
    const text = fs.readFileSync(script, "utf8");
    if (!/sha512|checksum/i.test(text)) return { ok: false, detail: "installer no longer verifies a checksum; refusing to run it. Install manually." };
    const run = spawnSync("bash", [script], { cwd: dir, encoding: "utf8", timeout: 300_000, env: { ...process.env, NO_COLOR: "1" } });
    const bin = resolveAgyBinary();
    const ok = !run.error && run.status === 0 && !!bin;
    let detail;
    if (ok) {
      detail = `installed at ${bin}`;
    } else if (!run.error && run.status === 0) {
      detail = "installer exited 0, but agy was not found on PATH or in ~/.local/bin/agy";
    } else {
      const tail = (run.stderr || run.stdout || run.error?.message || "").trim().split("\n").slice(-3).join(" ");
      detail = `installer exited ${run.status ?? "error"}: ${tail}`;
    }
    return { ok, detail };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function cmdWorker(argv) {
  const jobDir = argv[0];
  if (!jobDir || !fs.existsSync(path.join(jobDir, "job.json"))) return 2;
  try {
    await executeJob(jobDir);
  } catch (e) {
    const outcome = e?.outcome && OUTCOMES[e.outcome] ? e.outcome : "error";
    finalize(jobDir, { status: "failed", outcome, report: `## agy run failed\n\n${String(e?.message ?? e)}\n`, extra: { error: String(e?.message ?? e) } });
  }
  return 0;
}

// ---------------------------------------------------------------- entrypoint

const VALUE_FLAGS_FOR_RAW = new Set([...REVIEW_VALUES, "set-model", "conversation", "prompt-file", "allow-command", "allow-host"]);

const SUBCOMMANDS = {
  task: cmdTask,
  review: (a) => cmdReview(a, "review"),
  "adversarial-review": (a) => cmdReview(a, "adversarial-review"),
  status: cmdStatus,
  result: cmdResult,
  cancel: cmdCancel,
  setup: cmdSetup,
  "task-resume-candidate": cmdResumeCandidate,
  _worker: cmdWorker
};

const USAGE = `Usage: agy-companion <command> [options]

Commands:
  setup [--install] [--set-model <model>] [--json]
  task  [--write | --shell [--allow-command <prefix>]... [--allow-host <host>]... [--web]] [--model <m>] [--effort <e>] [--timeout <d>] [--background | --long]
        [--resume-last | --conversation <id>] [--prompt-file <f>] [--json] [prompt... | <stdin]
  review [--base <ref>] [--scope auto|working-tree|branch] [--model] [--effort] [--timeout] [--background | --long] [--json]
  adversarial-review [same as review] [focus text...]
  status [job-id] [--all] [--json]
  result [job-id] [--json]
  cancel [job-id] [--json]
  task-resume-candidate [--json]

Slash-command text is passed as DATA, never on a shell command line:
  --args-stdin   read raw arguments (flags, then free text) from stdin
  --args <raw>   same, from one argument (single-quoted by the caller)
Flags are recognised only before the first free-text word.

--background  detach a worker that survives the session (poll /agy:status)
--long        lift the 7-minute foreground cap (use inside Claude's run_in_background Bash)

Models: --model neon|argon|hydrogen|flash|orchestrator|<slug>  --effort low|medium|high|xhigh
Default model: ${DEFAULT_MODEL} (override: /agy:setup --set-model, or AGY_COMPANION_MODEL)`;

// Commands whose raw arguments are only flags and ids (no free text): split
// on whitespace and let flags appear anywhere ("/agy:status <id> --all").
const TOKEN_ONLY_COMMANDS = new Set(["status", "result", "cancel", "setup", "task-resume-candidate"]);

/** Expand --args-stdin / --args <raw> into argv (flags first, free text verbatim after "--"). */
function expandRawArgs(argv, sub) {
  const toArgv = (raw) => (TOKEN_ONLY_COMMANDS.has(sub) ? String(raw ?? "").split(/\s+/).filter(Boolean) : rawToArgv(raw, VALUE_FLAGS_FOR_RAW));
  const outArgs = [];
  const extra = [];
  // --args / --args-stdin are recognised only among the leading flags: never
  // after "--" or once free text starts, so prompt words can't trigger them.
  let flagsDone = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!flagsDone && a === "--args-stdin") {
      extra.push(...toArgv(readStdin()));
    } else if (!flagsDone && a === "--args") {
      extra.push(...toArgv(argv[i + 1] ?? ""));
      i += 1;
    } else {
      outArgs.push(a);
      if (a === "--" || !a.startsWith("--")) flagsDone = true;
      else if (!a.includes("=") && VALUE_FLAGS_FOR_RAW.has(a.slice(2)) && i + 1 < argv.length) outArgs.push(argv[++i]);
    }
  }
  // Fixed flags from the command template first, then the user's flags/text.
  // Keep anything after extra's "--" after "--" so free text can never become flags.
  const dd = outArgs.indexOf("--");
  if (dd === -1) return [...outArgs, ...extra];
  const extraDd = extra.indexOf("--");
  const extraFlags = extraDd === -1 ? extra : extra.slice(0, extraDd);
  const extraRest = extraDd === -1 ? [] : extra.slice(extraDd + 1);
  return [...outArgs.slice(0, dd), ...extraFlags, "--", ...extraRest, ...outArgs.slice(dd + 1)];
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    out(USAGE);
    return sub ? 0 : 2;
  }
  const fn = SUBCOMMANDS[sub];
  if (!fn) {
    out(`Unknown command: ${sub}\n\n${USAGE}`);
    return 2;
  }
  return fn(sub === "_worker" ? rest : expandRawArgs(rest, sub));
}

/**
 * Exit only after stdout has flushed. On macOS, writes to a pipe are
 * asynchronous, so exiting right after a large write can truncate a report.
 */
function exitWhenFlushed(code) {
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}

main()
  .then((code) => exitWhenFlushed(code ?? 0))
  .catch((e) => {
    if (e instanceof UsageError || e?.outcome) {
      out(e.outcome && e.outcome !== "model_unavailable" ? `## agy: ${OUTCOMES[e.outcome]?.label ?? "error"}\n\n${e.message}` : e.message);
      exitWhenFlushed(e.outcome ? (OUTCOMES[e.outcome]?.exit ?? 2) : 2);
      return;
    }
    out(`agy-companion error: ${e?.stack ?? e}`);
    exitWhenFlushed(1);
  });
