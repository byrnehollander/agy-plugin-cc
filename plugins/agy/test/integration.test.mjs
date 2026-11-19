// End-to-end tests of agy-companion against a fake agy binary.
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobsDir } from "../scripts/lib/jobs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(HERE, "../scripts/agy-companion.mjs");
const FAKE = path.resolve(HERE, "fixtures/fake-agy.mjs");

let tmp;
let repo;
let plain;

function gitInit(dir) {
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  g("add", ".");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-test-"));
  repo = path.join(tmp, "repo");
  plain = path.join(tmp, "plain");
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  gitInit(repo);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function baseEnv(scenario, extra = {}) {
  const log = path.join(tmp, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  return {
    log,
    env: {
      ...process.env,
      AGY_BIN: FAKE,
      AGY_COMPANION_STATE_DIR: path.join(tmp, "state"),
      FAKE_AGY_SCENARIO: scenario,
      FAKE_AGY_LOG: log,
      AGY_COMPANION_MODEL: "",
      // The fake agy is a node script: let the sandbox exec its interpreter.
      AGY_COMPANION_SANDBOX_ALLOW_EXEC: `/usr/bin/env:${process.execPath}`,
      ...extra
    }
  };
}

function run(args, { scenario = "ok", cwd = repo, input, extraEnv } = {}) {
  const { env, log } = baseEnv(scenario, extraEnv);
  const r = spawnSync(process.execPath, [COMPANION, ...args], { cwd, env, input: input ?? "", encoding: "utf8", timeout: 60_000 });
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const settingsOf = (call) => JSON.parse(call.argv[call.argv.indexOf("--settings") + 1]);

test("write reports an incomplete protected audit even when nothing changed", { skip: process.getuid?.() === 0 }, (t) => {
  const file = path.join(repo, ".envrc");
  fs.writeFileSync(file, "", { mode: 0, flag: "wx" });
  t.after(() => fs.rmSync(file));
  const r = run(["task", "--write"], { input: "q" });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /protected-path audit was incomplete/);
});

test("task: read-only by default, prompt last, policy and preamble applied", () => {
  const r = run(["task"], { input: "What does a.txt contain?" });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /fake answer/);
  assert.match(r.stdout, /read-only, no shell, web search on, network: model API only/);
  const call = r.calls.find((c) => c.argv);
  assert.equal(call.argv.at(-2), "-p");
  assert.match(call.argv.at(-1), /<task>\nWhat does a.txt contain\?\n<\/task>/);
  assert.match(call.argv.at(-1), /a\.txt/); // workspace file list
  assert.equal(call.argv[call.argv.indexOf("--model") + 1], "gemini-4-neon-high");
  const s = settingsOf(call);
  assert.ok(s.permissions.deny.includes("write_file(*)"));
  assert.ok(s.permissions.deny.includes("command(*)"));
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(repo));
});

test("task: model + effort flags resolve to a slug", () => {
  const r = run(["task", "--model", "neon", "--effort", "xhigh"], { input: "q" });
  assert.equal(r.code, 0, r.stdout);
  const call = r.calls.find((c) => c.argv);
  assert.equal(call.argv[call.argv.indexOf("--model") + 1], "gemini-4-neon-xhigh");
});

test("task: unknown model is rejected before running agy", () => {
  const r = run(["task", "--model", "gemini-9-bogus"], { input: "q" });
  assert.equal(r.code, 14, r.stdout);
  assert.match(r.stdout, /not available on this account/);
  assert.match(r.stdout, /gemini-4-neon-high/);
  assert.equal(r.calls.filter((c) => c.argv).length, 0);
});

test("task: empty prompt is a usage error", () => {
  const r = run(["task"], { input: "" });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /No task given/);
});

test("task --write requires git", () => {
  const r = run(["task", "--write"], { cwd: plain, input: "edit" });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /needs a git repository/);
});

test("task --write: workspace-scoped policy and changed-file report", () => {
  const r = run(["task", "--write"], { scenario: "write-file", input: "make a file" });
  assert.equal(r.code, 0, r.stdout);
  const call = r.calls.find((c) => c.argv);
  const s = settingsOf(call);
  assert.deepEqual(s.permissions.allow, [`write_file(${fs.realpathSync(repo)})`]);
  assert.ok(s.permissions.deny.includes(`write_file(${fs.realpathSync(repo)}/.git)`));
  assert.match(r.stdout, /Files changed by this run/);
  assert.match(r.stdout, /fake-written\.txt/);
  fs.rmSync(path.join(repo, "fake-written.txt"));
});

test("failure outcomes map to exit codes with next steps", () => {
  const cases = [
    ["denied", 13, /permission/],
    ["timeout", 12, /timed out/],
    ["quota", 10, /quota/],
    ["auth", 11, /authentication required/],
    ["status-error", 1, /boom/],
    ["garbage", 16, /empty response/]
  ];
  for (const [scenario, code, re] of cases) {
    const r = run(["task"], { scenario, input: "q" });
    assert.equal(r.code, code, `${scenario}: ${r.stdout}`);
    assert.match(r.stdout, re, scenario);
    assert.match(r.stdout, /Next step/, scenario);
  }
});

test("agy-side model error (not caught by preflight) is classified", () => {
  const r = run(["task", "--model", "gemini-4-argon-high"], { scenario: "badmodel", input: "q" });
  assert.equal(r.code, 14, r.stdout);
  assert.match(r.stdout, /Gemini 4 Argon \(High\)/);
});

test("large reports reach a pipe intact before the process exits", () => {
  const big = "x".repeat(400_000);
  const r = run(["task"], { input: "q", scenario: "big" });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(big), `stdout was ${r.stdout.length} bytes`);
});

test("large prompts go over stdin without -p", () => {
  const big = path.join(tmp, "big prompt.txt");
  fs.writeFileSync(big, "x".repeat(70 * 1024));
  const r = run(["task", "--prompt-file", big], { scenario: "echo-stdin" });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /hasP=false/);
  const call = r.calls.find((c) => c.argv);
  assert.ok(call.stdinBytes > 70 * 1024);
});

test("wall-clock guard rescues a finished-but-hung agy and kills its process group", async () => {
  const r = run(["task", "--timeout", "2s"], { scenario: "hang-after-output", input: "q", extraEnv: { AGY_COMPANION_GUARD_PAD_MS: "1500" } });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /fake answer/);
  assert.match(r.stdout, /wall-clock guard/);
  const gc = r.calls.find((c) => c.grandchild)?.grandchild;
  assert.ok(gc, "grandchild recorded");
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(gc, 0), /ESRCH/);
});

test("review: structured findings sorted by severity", () => {
  fs.appendFileSync(path.join(repo, "a.txt"), "four\n");
  const r = run(["review"]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /needs attention/);
  assert.ok(r.stdout.indexOf("[HIGH] Off by one") < r.stdout.indexOf("[LOW] Nit"));
  assert.match(r.stdout, /a\.txt:2-3/);
  const call = r.calls.find((c) => c.argv);
  assert.ok(call.argv.includes("--json-schema"));
  assert.match(call.argv.at(-1), /\+four/);
  assert.ok(settingsOf(call).permissions.deny.includes("write_file(*)"));
  spawnSync("git", ["checkout", "a.txt"], { cwd: repo });
});

test("review rejects focus text; adversarial-review accepts it via one raw word", () => {
  fs.appendFileSync(path.join(repo, "a.txt"), "five\n");
  const bad = run(["review", "check retries"]);
  assert.equal(bad.code, 2);
  const r = run(["adversarial-review", "--long", "focus on retries and it's idempotency"]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Adversarial review/);
  assert.match(r.calls.find((c) => c.argv).argv.at(-1), /focus on retries and it's idempotency/);
  spawnSync("git", ["checkout", "a.txt"], { cwd: repo });
});

test("review with nothing to review", () => {
  const r = run(["review", "--scope", "working-tree"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Nothing to review/);
});

test("status, result and resume-last", () => {
  const first = run(["task", "--json"], { input: "remember me" });
  const j = JSON.parse(first.stdout);
  assert.equal(j.status, "completed");
  const status = run(["status"]);
  assert.match(status.stdout, new RegExp(j.jobId));
  const result = run(["result", j.jobId]);
  assert.match(result.stdout, /fake answer/);
  const cand = JSON.parse(run(["task-resume-candidate", "--json"]).stdout);
  assert.equal(cand.available, true);
  const resumed = run(["task", "--resume-last"], { input: "and now?" });
  const call = resumed.calls.find((c) => c.argv);
  assert.equal(call.argv[call.argv.indexOf("--conversation") + 1], "11111111-2222-3333-4444-555555555555");
});

test("background job can be cancelled, killing agy and its children", async () => {
  const { env, log } = baseEnv("slow");
  const start = spawnSync(process.execPath, [COMPANION, "task", "--background", "--json"], { cwd: repo, env, input: "slow job", encoding: "utf8" });
  const { jobId } = JSON.parse(start.stdout);
  let job;
  for (let i = 0; i < 50; i += 1) {
    const s = spawnSync(process.execPath, [COMPANION, "status", jobId, "--json"], { cwd: repo, env, encoding: "utf8" });
    job = JSON.parse(s.stdout);
    if (job.agyPid && fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("grandchild")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.status, "running");
  const gc = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.grandchild).grandchild;
  const c = spawnSync(process.execPath, [COMPANION, "cancel", jobId], { cwd: repo, env, encoding: "utf8" });
  assert.match(c.stdout, /Cancelled job/);
  await new Promise((r) => setTimeout(r, 1500));
  const after = JSON.parse(spawnSync(process.execPath, [COMPANION, "status", jobId, "--json"], { cwd: repo, env, encoding: "utf8" }).stdout);
  assert.equal(after.status, "cancelled");
  assert.throws(() => process.kill(job.agyPid, 0), /ESRCH/);
  assert.throws(() => process.kill(gc, 0), /ESRCH/);
  const res = spawnSync(process.execPath, [COMPANION, "result", jobId], { cwd: repo, env, encoding: "utf8" });
  assert.match(res.stdout, /cancel/i);
});

test("foreground run interrupted by SIGTERM records cancellation and kills agy", async () => {
  const { env, log } = baseEnv("slow");
  const child = spawn(process.execPath, [COMPANION, "task", "--json"], { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("interrupt me");
  let agyPid;
  for (let i = 0; i < 50 && !agyPid; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(log)) agyPid = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.pid)?.pid;
  }
  assert.ok(agyPid);
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 15);
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(agyPid, 0), /ESRCH/);
});

test("setup reports ready with the fake agy and can set a default model", () => {
  const r = run(["setup", "--json", "--set-model", "neon-low".replace("neon-low", "gemini-4-neon-low")]);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.ready, true, r.stdout);
  assert.equal(rep.defaultModel, "gemini-4-neon-low");
  const t = run(["task"], { input: "q" });
  const call = t.calls.find((c) => c.argv);
  assert.equal(call.argv[call.argv.indexOf("--model") + 1], "gemini-4-neon-low");
  run(["setup", "--json", "--set-model", "gemini-4-neon-high"]);
});

test("state never goes to another plugin's CLAUDE_PLUGIN_DATA", () => {
  const foreign = path.join(tmp, "foreign-plugin-data");
  fs.mkdirSync(foreign);
  const fakeHome = path.join(tmp, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const r = run(["task"], { input: "q", extraEnv: { CLAUDE_PLUGIN_DATA: foreign, AGY_COMPANION_STATE_DIR: "", HOME: fakeHome } });
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(fs.readdirSync(foreign), []);
  assert.ok(fs.existsSync(path.join(fakeHome, ".agy-plugin-cc", "state", "workspaces")));
});

test("kernel sandbox: read-only run cannot exec, write anywhere, plant hooks or read ~/.ssh", () => {
  const r = run(["task", "--json"], { scenario: "sandbox-probe", input: "probe" });
  assert.equal(r.code, 0, r.stdout);
  const res = JSON.parse(JSON.parse(r.stdout).response);
  for (const k of ["exec_shell", "write_home", "write_git_hook_upper", "write_claude_mixed", "read_ssh", "write_workspace"]) {
    assert.notEqual(res[k], "ALLOWED", `${k} must be blocked in read mode`);
  }
  assert.ok(!fs.existsSync(path.join(repo, "sbx-ok.txt")));
});

test("kernel sandbox: write mode allows the workspace but not hooks, agent config, shell or home", () => {
  const r = run(["task", "--write", "--json"], { scenario: "sandbox-probe", input: "probe" });
  assert.equal(r.code, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  const res = JSON.parse(out.response);
  assert.equal(res.write_workspace, "ALLOWED");
  for (const k of ["exec_shell", "write_home", "write_git_hook_upper", "write_claude_mixed", "read_ssh"]) {
    assert.notEqual(res[k], "ALLOWED", `${k} must be blocked in write mode`);
  }
  assert.ok(!fs.existsSync(path.join(repo, ".git", "hooks", "pre-push")));
  assert.ok(out.changedFiles.includes("sbx-ok.txt"));
  fs.rmSync(path.join(repo, "sbx-ok.txt"));
});

test("shell mode: commands run but home writes, hooks, ssh reads and direct network stay blocked", () => {
  const r = run(["task", "--shell", "--json"], { scenario: "sandbox-probe", input: "probe" });
  assert.equal(r.code, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  const res = JSON.parse(out.response);
  assert.equal(res.exec_shell, "ALLOWED", "shell mode allows exec");
  assert.equal(res.write_workspace, "ALLOWED");
  for (const k of ["write_home", "write_git_hook_upper", "write_claude_mixed", "read_ssh"]) assert.notEqual(res[k], "ALLOWED", k);
  const call = r.calls.find((c) => c.argv);
  const s = settingsOf(call);
  assert.ok(s.permissions.allow.includes("command(*)"));
  assert.ok(s.permissions.deny.includes("mcp(*)"));
  fs.rmSync(path.join(repo, "sbx-ok.txt"), { force: true });
});

test("shell mode: egress proxy blocks non-Google hosts; direct connections are refused", () => {
  const r = run(["task", "--shell", "--json"], { scenario: "net-probe", input: "probe" });
  assert.equal(r.code, 0, r.stdout);
  const res = JSON.parse(JSON.parse(r.stdout).response);
  assert.match(res.via_proxy_blocked, /403/);
  assert.notEqual(res.direct, "connected");
  assert.match(JSON.parse(r.stdout).report, /Network blocked by the egress policy: api\.example\.org:443/);
});

test("--allow-command validation and --fresh conflicts", () => {
  assert.equal(run(["task", "--shell", "--allow-command", "npm test; curl x"], { input: "q" }).code, 2);
  assert.equal(run(["task", "--allow-command", "npm test"], { input: "q" }).code, 2);
  assert.equal(run(["task", "--fresh", "--resume-last"], { input: "q" }).code, 2);
  // An empty prefix used to fall open to command(*).
  assert.equal(run(["task", "--shell", "--allow-command", ""], { input: "q" }).code, 2);
  assert.equal(run(["task", "--shell", "--allow-command", "   ", "--allow-command", "npm test"], { input: "q" }).code, 2);
  const ok = run(["task", "--shell", "--allow-command", "npm test"], { input: "q" });
  assert.equal(ok.code, 0, ok.stdout);
  const call = ok.calls.find((c) => c.argv);
  assert.deepEqual(settingsOf(call).permissions.allow.filter((x) => x.startsWith("command(")), ["command(npm test)"]);
});

test("--web and --allow-host are shell-only; hosts are validated and reach the policy and preamble", () => {
  for (const args of [["--web"], ["--write", "--web"], ["--allow-host", "registry.npmjs.org"]]) {
    const r = run(["task", ...args], { input: "q" });
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stdout + r.stderr, /only applies with --shell/);
  }
  assert.equal(run(["task", "--shell", "--allow-host", "10.0.0.1"], { input: "q" }).code, 2);
  assert.equal(run(["task", "--shell", "--allow-host", "https://x.org"], { input: "q" }).code, 2);
  assert.equal(run(["task", "--shell", "--web", "--allow-host", "x.org"], { input: "q" }).code, 2);
  const ok = run(["task", "--shell", "--allow-host", "registry.npmjs.org", "--allow-host", "*.pypi.org"], { input: "q" });
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /network: model API \+ registry\.npmjs\.org, \*\.pypi\.org/);
  const call = ok.calls.find((c) => c.argv);
  // No URL-fetch tool is allowed for named hosts; commands reach them through the proxy.
  assert.ok(settingsOf(call).permissions.deny.includes("read_url(*)"));
  assert.match(call.argv.at(-1), /ONLY these hosts, over HTTPS: `registry\.npmjs\.org`, `\*\.pypi\.org`/);
});

test("untracked symlinks are never followed into review context", () => {
  const secret = path.join(tmp, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET-TOKEN");
  fs.symlinkSync(secret, path.join(repo, "leak.txt"));
  const r = run(["review", "--scope", "working-tree"]);
  assert.equal(r.code, 0, r.stdout);
  const call = r.calls.find((c) => c.argv);
  assert.ok(!call.argv.at(-1).includes("TOP-SECRET-TOKEN"));
  fs.rmSync(path.join(repo, "leak.txt"));
});

test("slash-command text is data: no flag smuggling, no shell expansion", () => {
  fs.appendFileSync(path.join(repo, "a.txt"), "six\n");
  const payload = "--long focus on `touch PWNED1` and $(touch PWNED2) it's --write and --background";
  const r = run(["adversarial-review", "--args-stdin"], { input: payload });
  assert.equal(r.code, 0, r.stdout);
  const call = r.calls.find((c) => c.argv);
  assert.match(call.argv.at(-1), /focus on `touch PWNED1` and \$\(touch PWNED2\) it's --write and --background/);
  assert.ok(settingsOf(call).permissions.deny.includes("write_file(*)"), "review stays read-only");
  assert.ok(!fs.existsSync(path.join(repo, "PWNED1")) && !fs.existsSync(path.join(repo, "PWNED2")));
  spawnSync("git", ["checkout", "a.txt"], { cwd: repo });
});

test("--args / --args-stdin in prompt words are text, not raw-argument switches", () => {
  const r = run(["task", "explain", "--args-stdin", "please"], { input: "SHOULD-NOT-BE-READ" });
  assert.equal(r.code, 0, r.stdout);
  const prompt = r.calls.find((c) => c.argv).argv.at(-1);
  assert.match(prompt, /explain --args-stdin please/);
  assert.ok(!prompt.includes("SHOULD-NOT-BE-READ"));
});

test("contract details: --resume alias, empty review JSON, ignored effort is reported", () => {
  const first = run(["task"], { input: "q1" });
  assert.equal(first.code, 0, first.stdout);
  const resumed = run(["task", "--resume"], { input: "q2" });
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.ok(resumed.calls.find((c) => c.argv).argv.includes("--conversation"));
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "agy-clean-"));
  spawnSync("git", ["init", "-q"], { cwd: clean });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: clean });
  const empty = run(["review", "--json", "--scope", "working-tree"], { cwd: clean });
  assert.equal(empty.code, 0);
  assert.equal(JSON.parse(empty.stdout).status, "empty");
  const orch = run(["task", "--model", "orchestrator", "--effort", "low"], { input: "q" });
  assert.match(orch.stdout, /--effort was ignored/);
  fs.rmSync(clean, { recursive: true, force: true });
});

test("AGY_COMPANION_MODEL_HOSTS is validated before a job is created", () => {
  const bad = run(["task"], { input: "q", extraEnv: { AGY_COMPANION_MODEL_HOSTS: "https://x.example.com" } });
  assert.equal(bad.code, 2);
  assert.match(bad.stdout, /AGY_COMPANION_MODEL_HOSTS/);
  const ok = run(["task"], { input: "q", extraEnv: { AGY_COMPANION_MODEL_HOSTS: "models.example.com, *.api.example.com" } });
  assert.equal(ok.code, 0, ok.stdout);
});

test("prompt text containing --write never enables write mode", () => {
  const r = run(["task", "explain", "--write", "behaviour"]);
  assert.equal(r.code, 0, r.stdout);
  const call = r.calls.find((c) => c.argv);
  assert.ok(settingsOf(call).permissions.deny.includes("write_file(*)"));
  assert.match(call.argv.at(-1), /explain --write behaviour/);
});

test("--long wins over --background (Claude-side background keeps the result)", () => {
  const r = run(["task", "--long", "--background"], { input: "q" });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /fake answer/);
});

test("new failure outcomes: filter block, invalid review schema, exit-3 quota", () => {
  assert.equal(run(["task"], { scenario: "filtered", input: "q" }).code, 18);
  fs.appendFileSync(path.join(repo, "a.txt"), "seven\n");
  const bad = run(["review"], { scenario: "bad-schema" });
  assert.equal(bad.code, 17, bad.stdout);
  spawnSync("git", ["checkout", "a.txt"], { cwd: repo });
  assert.equal(run(["task"], { scenario: "quota-exit3", input: "q" }).code, 10);
});

test("invalid job ids are rejected before any lookup", () => {
  const r = run(["result", "--args", "x; rm -rf ~"]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Invalid job id/);
});

test("missing agy is reported as not installed", () => {
  const r = run(["task"], { input: "q", extraEnv: { AGY_BIN: "/nonexistent/agy", PATH: "/usr/bin:/bin", HOME: tmp } });
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.stdout, /not installed/);
});
