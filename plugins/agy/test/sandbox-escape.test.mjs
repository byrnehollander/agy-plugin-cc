// Model-free escape probes: run real programs under the GENERATED Seatbelt
// profiles (no agy, no model) and assert every escape route fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildSeatbeltProfile, sandboxSupported } from "../scripts/lib/sandbox.mjs";

const skip = !sandboxSupported();
let tmp;
let ws;
let fakeHome;
let profiles;

before(() => {
  if (skip) return;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-escape-")));
  ws = path.join(tmp, "ws");
  fakeHome = path.join(tmp, "home");
  fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, "other-repo"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".ssh", "id_test"), "SSH-SECRET");
  fs.writeFileSync(path.join(fakeHome, "other-repo", ".env"), "ENV-SECRET");
  fs.writeFileSync(path.join(fakeHome, ".claude.json"), "CLAUDE-SECRET");
  fs.writeFileSync(path.join(ws, "in-ws.txt"), "WS-OK");
  // Credential files inside toolchain folders that --shell may otherwise read.
  for (const [rel, body] of [
    [".cargo/credentials.toml", "CARGO-SECRET"],
    [".config/git/credentials", "GITCRED-SECRET"],
    [".local/share/fish/fish_history", "FISH-SECRET"],
    [".cargo/config.toml", "CARGO-CONFIG-OK"]
  ]) {
    fs.mkdirSync(path.dirname(path.join(fakeHome, rel)), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, rel), body);
  }
  profiles = {};
  for (const mode of ["read", "write", "shell"]) {
    const p = path.join(tmp, `${mode}.sb`);
    fs.writeFileSync(p, buildSeatbeltProfile({ mode, workspaceRoot: ws, agyBin: "/bin/sh", home: fakeHome }));
    profiles[mode] = p;
  }
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function sh(mode, script) {
  const r = spawnSync("/usr/bin/sandbox-exec", ["-f", profiles[mode], "/bin/sh", "-c", script], { cwd: ws, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("shell mode: secrets under $HOME are unreadable, the workspace is readable", { skip }, () => {
  for (const f of [".ssh/id_test", "other-repo/.env", ".claude.json"]) {
    const r = sh("shell", `cat "${path.join(fakeHome, f)}"`);
    assert.notEqual(r.code, 0, `${f} must be unreadable`);
    assert.ok(!r.out.includes("SECRET"), f);
  }
  assert.equal(sh("shell", "cat in-ws.txt").out.trim(), "WS-OK");
});

test("shell mode: credential files inside readable toolchain folders stay unreadable", { skip }, () => {
  // Positive control: an ordinary toolchain file in the same folder is readable.
  assert.equal(sh("shell", `cat "${path.join(fakeHome, ".cargo/config.toml")}"`).out.trim(), "CARGO-CONFIG-OK");
  for (const f of [".cargo/credentials.toml", ".config/git/credentials", ".local/share/fish/fish_history"]) {
    const r = sh("shell", `cat "${path.join(fakeHome, f)}"`);
    assert.notEqual(r.code, 0, `${f} must be unreadable`);
    assert.ok(!r.out.includes("SECRET"), f);
    assert.match(r.out, /operation not permitted|permission denied/i, f);
  }
});

test("shell mode: protected paths, home and other locations are not writable", { skip }, () => {
  assert.notEqual(sh("shell", "echo x > .git/hooks/pre-commit").code, 0);
  assert.notEqual(sh("shell", "mkdir -p .GIT/hooks && echo x > .GIT/hooks/pre-push").code, 0);
  assert.notEqual(sh("shell", `echo x > "${path.join(os.homedir(), `.agy-escape-${process.pid}`)}"`).code, 0);
  assert.ok(!fs.existsSync(path.join(os.homedir(), `.agy-escape-${process.pid}`)));
  assert.equal(sh("shell", "echo ok > made.txt && cat made.txt").out.trim(), "ok");
});

test("write and shell modes deny nested Git and editor paths regardless of case", { skip }, () => {
  // /bin/sh re-execs a shell variant (bash/zsh/dash), which write mode's exec
  // allowlist (agy only) would refuse; allow the variants for this test only so
  // the write-mode runs exercise the file rules rather than the exec rules.
  const writeWithShells = path.join(tmp, "write-shells.sb");
  fs.writeFileSync(writeWithShells, buildSeatbeltProfile({ mode: "write", workspaceRoot: ws, agyBin: "/bin/sh", home: fakeHome, extraExec: ["/bin/bash", "/bin/zsh", "/bin/dash"] }));
  const run = (mode, script) => {
    const profile = mode === "write" ? writeWithShells : profiles[mode];
    const r = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", script], { cwd: ws, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const parent = "project/sub";
  fs.mkdirSync(path.join(ws, parent), { recursive: true });
  for (const name of [".gIt", ".VsCoDe", ".iDeA"]) {
    fs.mkdirSync(path.join(ws, parent, name));
    for (const mode of ["write", "shell"]) {
      const rel = `${parent}/${name}/${mode}.txt`;
      const r = run(mode, `echo marker > ${rel}`);
      assert.ok(Number.isInteger(r.code) && r.code > 0, r.out);
      assert.match(r.out, /operation not permitted|permission denied/i);
      assert.ok(!fs.existsSync(path.join(ws, rel)), rel);
      assert.equal(run(mode, `echo ok > ${parent}/${mode}.txt`).code, 0);
    }
  }
  // Look-alikes are not protected.
  for (const rel of ["project/.idea-notes.txt", "project/my.gitignore"]) assert.equal(run("shell", `echo ok > ${rel}`).code, 0, rel);
});

test("shell mode: no way to start a process outside the sandbox", { skip }, () => {
  const label = `agy.escape.${process.pid}`;
  const r1 = sh("shell", `launchctl submit -l ${label} -- /usr/bin/true`);
  spawnSync("launchctl", ["remove", label]);
  assert.notEqual(r1.code, 0, "launchctl submit");
  assert.notEqual(sh("shell", "open -g -a TextEdit /etc/hosts").code, 0, "open / LaunchServices");
  const r3 = sh("shell", "osascript -e 'tell application \"System Events\" to get name of every process'");
  assert.ok(r3.code !== 0 || /error/i.test(r3.out), "Apple Events");
});

test("all modes: direct network is refused", { skip }, () => {
  const probe = fileURLToPath(new URL("./fixtures/direct-network.mjs", import.meta.url));
  for (const mode of ["read", "write", "shell"]) {
    // Use Node as the allowed executable in this profile, including in read/write mode.
    const profile = buildSeatbeltProfile({ mode, workspaceRoot: ws, agyBin: process.execPath, home: fakeHome });
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, probe], { encoding: "utf8", timeout: 15_000 });
    assert.ifError(r.error);
    assert.equal(r.signal, null);
    assert.equal(r.status, 1, `${mode}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout.trim(), /^probe started\nconnect (EPERM|EACCES)$/, mode);
  }
});

test("read/write modes: nothing but the allowed binary may execute", { skip }, () => {
  for (const mode of ["read", "write"]) {
    const r = sh(mode, "/usr/bin/true && echo RAN");
    assert.ok(!r.out.includes("RAN"), `${mode} must not exec other programs`);
  }
});
