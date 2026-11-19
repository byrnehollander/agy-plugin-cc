// Git helpers. Every git call disables pagers, external diff drivers, textconv
// filters and colour so repository config can't run commands or change output.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { UsageError } from "./args.mjs";

const SAFE_GIT_ENV = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C"
};

/** Run git with pagers, colour, and fsmonitor disabled. Throws unless `allowFail` is true. */
export function git(cwd, args, { maxBuffer = 64 * 1024 * 1024, allowFail = false } = {}) {
  const r = spawnSync("git", ["--no-pager", "-c", "color.ui=false", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...SAFE_GIT_ENV },
    maxBuffer,
    timeout: 60_000
  });
  if (r.error) {
    if (allowFail) return { ok: false, stdout: "", stderr: String(r.error.message) };
    throw new Error(`git ${args[0]} failed: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  }
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Return the git repository toplevel for `cwd`, or null if not in a git repo. */
export function gitRoot(cwd) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

/** Workspace root: git toplevel if inside a repo, else the resolved cwd. */
export function resolveWorkspaceRoot(cwd) {
  const root = gitRoot(cwd);
  return fs.realpathSync(root ?? cwd);
}

function hasHead(root) {
  return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true }).ok;
}

/** Tracked + untracked (not ignored) files, capped. */
export function listWorkspaceFiles(root, { maxFiles = 2000 } = {}) {
  if (gitRoot(root)) {
    const r = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { allowFail: true });
    if (r.ok) {
      const files = r.stdout.split("\0").filter(Boolean);
      return { files: files.slice(0, maxFiles), total: files.length };
    }
  }
  // Not a git repo: shallow walk, skipping heavy/hidden dirs.
  const files = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__"]);
  const walk = (dir, rel, depth) => {
    if (files.length >= maxFiles || depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath, depth + 1);
      else if (e.isFile()) files.push(relPath);
    }
  };
  walk(root, "", 0);
  return { files, total: files.length };
}

/** Snapshot of working-tree state used to report what a write-mode run changed. */
export function snapshotWorktree(root) {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFail: true });
  const snap = new Map();
  if (!status.ok) return snap;
  const entries = status.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const code = e.slice(0, 2);
    const file = e.slice(3);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i += 1; // skip rename/copy source
    let sig = "missing";
    try {
      sig = hashFile(path.join(root, file));
    } catch {
      // Deleted or unreadable working-tree entry.
    }
    snap.set(file, `${code}:${sig}`);
  }
  return snap;
}

const MAX_HASH_BYTES = 50 * 1024 * 1024;

function hashFile(p, st = fs.lstatSync(p)) {
  if (!st.isFile()) return st.isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : "nonfile";
  if (st.size > MAX_HASH_BYTES) return `size:${st.size}:${st.mtimeMs}`;
  return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
}

/**
 * Files under root modified at/after sinceMs (catches writes to git-ignored
 * files such as .env, which `git status` would not show). Bounded walk.
 */
export function recentlyModifiedFiles(root, sinceMs, { maxEntries = 300_000, timeBudgetMs = 5000 } = {}) {
  const found = [];
  const started = Date.now();
  let seen = 0;
  let incomplete = false;
  const stack = [""];
  while (stack.length && !incomplete) {
    if (seen > maxEntries || Date.now() - started > timeBudgetMs) {
      incomplete = true;
      break;
    }
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen += 1;
      if (seen > maxEntries || (seen % 256 === 0 && Date.now() - started > timeBudgetMs)) {
        incomplete = true;
        break;
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (relPath === ".git" || e.name === "node_modules") continue;
        stack.push(relPath);
      } else {
        try {
          const st = fs.lstatSync(path.join(root, relPath));
          if (st.mtimeMs > sinceMs) found.push(relPath);
        } catch {
          // vanished
        }
      }
    }
  }
  return { files: found.sort(), incomplete };
}

/** Compare two worktree snapshots and return sorted file-level change records. */
export function diffSnapshots(before, after) {
  const changed = [];
  for (const [file, sig] of after) {
    if (before.get(file) !== sig) changed.push({ file, change: before.has(file) ? "modified" : "new change" });
  }
  for (const [file] of before) {
    if (!after.has(file)) changed.push({ file, change: "reverted/cleaned" });
  }
  return changed.sort((a, b) => a.file.localeCompare(b.file));
}

function defaultBaseRef(root) {
  const originHead = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFail: true });
  if (originHead.ok && originHead.stdout.trim()) return originHead.stdout.trim();
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", cand], { allowFail: true }).ok) return cand;
  }
  return null;
}

function isWorkingTreeDirty(root) {
  const r = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], { allowFail: true });
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * Decide what to review.
 * scope: auto | working-tree | branch ; base: optional ref (implies branch).
 */
export function resolveReviewTarget(root, { scope = "auto", base } = {}) {
  if (!gitRoot(root)) throw new UsageError("Reviews need a git repository (run inside one).");
  if (!["auto", "working-tree", "branch"].includes(scope)) {
    throw new UsageError(`--scope must be auto, working-tree or branch (got ${scope})`);
  }
  if (base) scope = "branch";
  if (scope === "auto") scope = isWorkingTreeDirty(root) ? "working-tree" : "branch";
  if (scope === "working-tree") {
    return { kind: "working-tree", label: "uncommitted changes (staged, unstaged and untracked)" };
  }
  const baseRef = base ?? defaultBaseRef(root);
  if (!baseRef) throw new UsageError("Could not determine a base branch; pass --base <ref>.");
  if (baseRef.startsWith("-") || /[\s\0]/.test(baseRef)) throw new UsageError(`Invalid base ref: ${baseRef}`);
  if (!git(root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { allowFail: true }).ok) {
    throw new UsageError(`Base ref not found: ${baseRef}`);
  }
  const mb = git(root, ["merge-base", baseRef, "HEAD"], { allowFail: true });
  if (!mb.ok) throw new UsageError(`No merge base between ${baseRef} and HEAD.`);
  return { kind: "branch", base: baseRef, mergeBase: mb.stdout.trim(), label: `HEAD compared with ${baseRef}` };
}

const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "-M", "--unified=5"];
const STAT_FLAGS = ["--no-ext-diff", "--no-textconv"];

function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return { text: str, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Content of an untracked workspace file for review context, or null. The
 * companion is not sandboxed, so never follow a link out of the repo (a link
 * to ~/.ssh/id_rsa must not become "context") and skip hard-linked files.
 */
function readUntrackedFile(realRoot, rel, limit) {
  const file = path.join(realRoot, rel);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > limit) return null;
    if (!fs.realpathSync(file).startsWith(`${realRoot}${path.sep}`)) return null;
    const buf = fs.readFileSync(file);
    return buf.length <= limit && !buf.includes(0) ? buf : null;
  } catch {
    return null; // unreadable: list it without content
  }
}

/**
 * Collect review context. Large diffs are truncated with an explicit note; the
 * reviewer can still read any file itself (reads are allowed).
 */
export function collectReviewContext(root, target, { maxDiffBytes = 350 * 1024, maxUntrackedBytes = 120 * 1024 } = {}) {
  let diff = "";
  let stat = "";
  let log = "";
  const untracked = [];
  if (target.kind === "working-tree") {
    if (hasHead(root)) {
      diff = git(root, ["diff", ...DIFF_FLAGS, "HEAD"]).stdout;
      stat = git(root, ["diff", "--stat", ...STAT_FLAGS, "HEAD"]).stdout;
    } else {
      diff = git(root, ["diff", ...DIFF_FLAGS, "--cached"]).stdout;
      stat = git(root, ["diff", "--stat", ...STAT_FLAGS, "--cached"]).stdout;
    }
    const others = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).stdout.split("\0").filter(Boolean);
    const realRoot = fs.realpathSync(root);
    let budget = maxUntrackedBytes;
    for (const f of others) {
      const buf = readUntrackedFile(realRoot, f, Math.min(budget, 40 * 1024));
      if (buf) budget -= buf.length;
      untracked.push({ file: f, content: buf?.toString("utf8") ?? null });
    }
  } else {
    const range = `${target.mergeBase}..HEAD`;
    diff = git(root, ["diff", ...DIFF_FLAGS, range]).stdout;
    stat = git(root, ["diff", "--stat", ...STAT_FLAGS, range]).stdout;
    log = git(root, ["log", "--no-decorate", "--format=%h %s", "-n", "50", range]).stdout;
  }
  const empty = !diff.trim() && untracked.length === 0;
  const trimmed = truncateUtf8(diff, maxDiffBytes);
  return { diff: trimmed.text, stat, log, untracked, truncated: trimmed.truncated, empty };
}

/**
 * Snapshot protected workspace paths, including ignored and nested repos.
 * The discovery walk never descends through directory symlinks. Each protected
 * target has its own budget so a large target cannot starve its siblings.
 */
/**
 * Snapshot protected paths at the top of the workspace (matched
 * case-insensitively), inside .git only what can run code or redirect git
 * (hooks, config, info), and the configured core.hooksPath. A backstop for the
 * kernel sandbox, which already blocks writes to all of these and to nested
 * .git/.vscode/.idea at any depth: changes are reported, not reverted.
 * `incomplete` is set when a target exceeded its file budget or was unreadable.
 */
export function snapshotProtected(root, protectedSubpaths, { maxFiles = 5000 } = {}) {
  const entries = new Map();
  let incomplete = false;
  const targets = new Set();
  let top = [];
  try {
    top = fs.readdirSync(root);
  } catch {
    incomplete = true;
  }
  for (const name of top) {
    for (const want of protectedSubpaths) {
      const [first, ...rest] = want.toLowerCase().split("/");
      if (name.toLowerCase() !== first) continue;
      if (first === ".git") for (const sub of ["hooks", "config", "info"]) targets.add(path.join(name, sub));
      else targets.add(path.join(name, ...rest));
    }
  }
  const hooks = git(root, ["config", "--get", "core.hooksPath"], { allowFail: true });
  if (hooks.ok && hooks.stdout.trim()) {
    const rel = path.relative(root, path.resolve(root, hooks.stdout.trim()));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) targets.add(rel);
  }
  for (const target of targets) {
    const stack = [target];
    let seen = 0;
    while (stack.length) {
      if (seen++ >= maxFiles) {
        incomplete = true;
        break;
      }
      const rel = stack.pop();
      const file = path.join(root, rel);
      let st;
      try {
        st = fs.lstatSync(file);
      } catch (e) {
        if (e.code !== "ENOENT") incomplete = true;
        continue;
      }
      const mode = st.mode & 0o7777;
      try {
        if (st.isDirectory()) {
          entries.set(`${rel}/`, `dir:${mode}`);
          // Claude Code agent worktrees are full checkouts, not configuration.
          const skip = path.basename(rel).toLowerCase() === ".claude" ? new Set(["worktrees"]) : null;
          for (const name of fs.readdirSync(file)) if (!skip?.has(name.toLowerCase())) stack.push(path.join(rel, name));
        } else {
          entries.set(rel, `${mode}:${hashFile(file, st)}`);
        }
      } catch {
        incomplete = true;
      }
    }
  }
  return { entries, incomplete };
}

/** Report changed protected entries and any gaps in either snapshot. */
export function diffProtected(before, after) {
  const changed = new Set();
  for (const [k, v] of after.entries) if (before.entries.get(k) !== v) changed.add(k.replace(/\/$/, ""));
  for (const [k] of before.entries) if (!after.entries.has(k)) changed.add(k.replace(/\/$/, ""));
  return { changed: [...changed].sort(), incomplete: before.incomplete || after.incomplete };
}
