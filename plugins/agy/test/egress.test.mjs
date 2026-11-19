import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";

import { startEgressProxy } from "../scripts/lib/egress.mjs";

function connectVia(port, target) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      resolve(String(d).split("\r\n")[0]);
      s.destroy();
    });
    s.on("error", () => resolve("error"));
    s.on("close", () => resolve("closed"));
  });
}

test("egress proxy denies non-allowlisted hosts and non-443 ports", async () => {
  const p = await startEgressProxy();
  try {
    assert.match(await connectVia(p.port, "api.example.org:443"), /403/);
    assert.match(await connectVia(p.port, "aicode.googleapis.com:80"), /403/);
    assert.match(await connectVia(p.port, "evilgoogleapis.com:443"), /403/);
    assert.match(await connectVia(p.port, "googleapis.com.evil.io:443"), /403/);
    assert.deepEqual(p.stats().allowed, []);
    assert.ok(p.stats().denied.includes("api.example.org:443"));
  } finally {
    await p.close();
  }
});

test("egress proxy honours extra allowed hosts on 443 only", async () => {
  const p = await startEgressProxy({ allowedHosts: [/^registry\.example\.invalid$/i] });
  try {
    // Allowed hosts get past the policy check; the upstream connect then fails
    // (.invalid never resolves) and the client gets a 502 instead of hanging.
    assert.match(await connectVia(p.port, "registry.example.invalid:443"), /502/);
    assert.match(await connectVia(p.port, "registry.example.invalid:80"), /403/);
    assert.match(await connectVia(p.port, "other.example.invalid:443"), /403/);
    assert.ok(p.stats().allowed.includes("registry.example.invalid:443"));
  } finally {
    await p.close();
  }
});

test("egress proxy refuses plain-HTTP proxying by default", async () => {
  const p = await startEgressProxy();
  try {
    const status = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: p.port, path: "http://example.com/", method: "GET" }, (res) => resolve(res.statusCode));
      req.on("error", () => resolve(0));
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await p.close();
  }
});

test("--web plain-HTTP proxying checks the port it actually connects to", async () => {
  const p = await startEgressProxy({ allowAll: true });
  try {
    for (const url of ["http://example.invalid:8080/x", "http://example.invalid:22/", "https://example.invalid/"]) {
      const status = await new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: p.port, method: "GET", path: url }, (r) => {
          r.resume();
          resolve(r.statusCode);
        });
        req.on("error", () => resolve("error"));
        req.end();
      });
      assert.equal(status, 403, url);
    }
    assert.deepEqual(p.stats().allowed, []);
    assert.ok(p.stats().denied.includes("example.invalid:8080"));
  } finally {
    await p.close();
  }
});

test("egress proxy env points every proxy variable at itself", async () => {
  const p = await startEgressProxy();
  try {
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy"]) assert.equal(p.env[k], `http://127.0.0.1:${p.port}`);
    // Only loopback bypasses the proxy; an inherited NO_PROXY can never route a remote host around it.
    assert.equal(p.env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(p.env.no_proxy, p.env.NO_PROXY);
  } finally {
    await p.close();
  }
});

test("egress proxy survives clients that reset denied or allowed connections", async () => {
  const p = await startEgressProxy();
  try {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => {
        const s = net.connect(p.port, "127.0.0.1", () => {
          s.write("CONNECT api.example.org:443 HTTP/1.1\r\n\r\n");
          s.resetAndDestroy();
          resolve();
        });
        s.on("error", () => resolve());
      });
      await new Promise((resolve) => {
        const s = net.connect(p.port, "127.0.0.1", () => {
          s.write("GARBAGE\r\n\r\n");
          s.resetAndDestroy();
          resolve();
        });
        s.on("error", () => resolve());
      });
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.match(await connectVia(p.port, "api.example.org:443"), /403/, "still serving after resets");
  } finally {
    await p.close();
  }
});
