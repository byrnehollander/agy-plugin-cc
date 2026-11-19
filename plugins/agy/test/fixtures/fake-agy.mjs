#!/usr/bin/env node
// Fake `agy` for tests. Behaviour is chosen with FAKE_AGY_SCENARIO; every
// invocation appends {argv, stdinBytes, cwd, pid} to $FAKE_AGY_LOG (JSONL).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_AGY_SCENARIO ?? "ok";
const log = process.env.FAKE_AGY_LOG;

if (argv[0] === "--version") {
  console.log("agy version 1.5.12");
  process.exit(0);
}
if (argv[0] === "models") {
  console.log("Fetching available models...");
  for (const [id, name] of [
    ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
    ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
    ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
    ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"]
  ]) console.log(`${id}\t${name}`);
  process.exit(0);
}

let stdin = "";
const pIdx = argv.indexOf("-p");
if (pIdx === -1) {
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
}
const prompt = pIdx === -1 ? stdin : argv[pIdx + 1];
if (log) fs.appendFileSync(log, `${JSON.stringify({ argv, stdinBytes: Buffer.byteLength(stdin), promptBytes: Buffer.byteLength(prompt ?? ""), cwd: process.cwd(), pid: process.pid })}\n`);

const conv = "11111111-2222-3333-4444-555555555555";
const usage = { input_tokens: 1000, output_tokens: 50, thinking_tokens: 20, cache_read_tokens: 0, total_tokens: 1050 };
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ok = (extra = {}) => emit({ conversation_id: conv, status: "SUCCESS", response: scenario === "big" ? "x".repeat(400_000) : "fake answer", duration_seconds: 1.2, num_turns: 1, usage, ...extra });
const schemaIdx = argv.indexOf("--json-schema");

function spawnGrandchild() {
  const gc = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
  if (log) fs.appendFileSync(log, `${JSON.stringify({ grandchild: gc.pid })}\n`);
}

switch (scenario) {
  case "big":
  case "ok":
    if (schemaIdx !== -1) {
      const structured = {
        verdict: "needs-attention",
        summary: "One real bug.",
        findings: [
          { severity: "low", title: "Nit", body: "minor", file: "a.txt", line_start: 1, line_end: 1, confidence: 0.4, recommendation: "meh" },
          { severity: "high", title: "Off by one", body: "loop overruns", file: "a.txt", line_start: 2, line_end: 3, confidence: 0.9, recommendation: "use <" }
        ],
        next_steps: ["fix the loop"]
      };
      ok({ response: JSON.stringify(structured), structured_output: structured });
    } else ok();
    break;
  case "write-file":
    fs.writeFileSync(path.join(process.cwd(), "fake-written.txt"), "x");
    ok({ response: "wrote fake-written.txt" });
    break;
  case "denied":
    emit({ conversation_id: conv, status: "SUCCESS", response: "", usage, denied_actions: [{ action: "write_file", display_name: "Edit" }] });
    process.stderr.write("jetski: no output produced — a tool required the \"write_file\" permission that headless mode cannot prompt for, so it was auto-denied.\n");
    break;
  case "timeout":
    emit({ conversation_id: conv, status: "ERROR", response: "", error: "print timeout after 3s with the turn still in progress; the response is partial", usage, finished_reason: "print_timeout" });
    process.stderr.write('[agy] print timeout after 3s with turn in progress; returning partial output\nAGY_ERROR: {"reason":"print_timeout"}\n');
    process.exit(3);
    break;
  case "badmodel":
    emit({ conversation_id: "", status: "ERROR", response: "", error: "invalid model selection (--model \"x\"): model x is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 4 Neon (High)\n  Gemini 4 Argon (High)" });
    process.exit(1);
    break;
  case "quota":
    process.stderr.write("error: RESOURCE_EXHAUSTED: individual quota reached for this model\n");
    process.exit(1);
    break;
  case "auth":
    process.stderr.write("error: authentication required: please sign in\n");
    process.exit(1);
    break;
  case "status-error":
    emit({ conversation_id: conv, status: "ERROR", response: "", error: "boom" });
    process.exit(0);
    break;
  case "garbage":
    process.stdout.write("this is not json\n");
    process.exit(0);
    break;
  case "echo-stdin":
    ok({ response: `stdinBytes=${Buffer.byteLength(stdin)} hasP=${pIdx !== -1} promptBytes=${Buffer.byteLength(prompt ?? "")}` });
    break;
  case "hang-after-output":
    ok();
    spawnGrandchild();
    setInterval(() => {}, 1000);
    break;
  case "slow":
    spawnGrandchild();
    setTimeout(() => ok(), 600_000);
    break;
  case "sandbox-probe": {
    // Tries everything the kernel sandbox must stop, plus one legitimate write.
    const os = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const results = {};
    const tryIt = (name, fn) => {
      try {
        fn();
        results[name] = "ALLOWED";
      } catch (e) {
        results[name] = `blocked (${e.code ?? e.message})`;
      }
    };
    tryIt("exec_shell", () => {
      const r = spawnSync("/bin/sh", ["-c", "true"]);
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`status ${r.status} ${r.signal ?? ""}`);
    });
    tryIt("write_home", () => fs.writeFileSync(path.join(os.homedir(), `.agy-sbx-probe-${process.pid}`), "x"));
    tryIt("write_git_hook_upper", () => {
      fs.mkdirSync(path.join(process.cwd(), ".GIT", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), ".GIT", "hooks", "pre-push"), "x");
    });
    tryIt("write_claude_mixed", () => {
      fs.mkdirSync(path.join(process.cwd(), ".Claude"), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), ".Claude", "settings.json"), "{}");
    });
    tryIt("read_ssh", () => fs.readdirSync(path.join(os.homedir(), ".ssh")));
    tryIt("write_workspace", () => fs.writeFileSync(path.join(process.cwd(), "sbx-ok.txt"), "ok"));
    ok({ response: JSON.stringify(results) });
    break;
  }
  case "net-probe": {
    const net = await import("node:net");
    const results = {};
    const proxy = new URL(process.env.HTTPS_PROXY ?? "http://127.0.0.1:1");
    results.via_proxy_blocked = await new Promise((resolve) => {
      const s = net.connect(Number(proxy.port), proxy.hostname, () => s.write("CONNECT api.example.org:443 HTTP/1.1\r\nHost: api.example.org:443\r\n\r\n"));
      s.once("data", (d) => { resolve(String(d).split("\r\n")[0]); s.destroy(); });
      s.on("error", (e) => resolve(`error ${e.code}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    results.direct = await new Promise((resolve) => {
      const s = net.connect(443, "1.1.1.1", () => { resolve("connected"); s.destroy(); });
      s.on("error", (e) => resolve(`blocked ${e.code}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    ok({ response: JSON.stringify(results) });
    break;
  }
  case "filtered":
    ok({ response: "This request was blocked by Gemini's filters. They can occasionally trigger by mistake." });
    break;
  case "bad-schema":
    ok({ response: "{}", structured_output: { summary: "x" } });
    break;
  case "quota-exit3":
    emit({ conversation_id: conv, status: "ERROR", response: "", error: "RESOURCE_EXHAUSTED: individual quota reached" });
    process.exit(3);
    break;
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(99);
}
