// Egress control: a tiny in-process HTTP CONNECT proxy with a host allowlist.
//
// The Seatbelt profile denies all outbound network except 127.0.0.1:<port>, so
// every connection agy (and, in --shell mode, any command it runs) makes must
// go through this proxy. By default only Google's model/auth endpoints are
// reachable; with --web any host on 80/443 is allowed (and logged).
//
// Verified on agy 1.5.12: agy honours HTTPS_PROXY for all of its traffic, a
// command's `curl https://api.example.org` gets a 403 from the proxy, and a
// `curl --noproxy '*'` direct connection is refused by the kernel.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";

// Only the hosts agy's model and sign-in traffic uses (observed on 1.5.12).
// Deliberately NOT all of *.googleapis.com (e.g. storage.googleapis.com could
// carry data to a public bucket). www.googleapis.com is required for sign-in;
// play.googleapis.com (telemetry) is not.
export const DEFAULT_ALLOWED_HOSTS = [
  /^([a-z0-9-]+-)?cloudcode-pa\.googleapis\.com$/i,
  /^aicode\.googleapis\.com$/i,
  /^(www|oauth2)\.googleapis\.com$/i,
  /^accounts\.google\.com$/i
];

/**
 * Denials agy itself causes on every run (telemetry, avatar images, a
 * github.com check at startup seen in read-only runs on 1.5.12); logged in
 * egress.log but not worth a warning in the report.
 */
export const EXPECTED_DENIALS = [/^play\.googleapis\.com:443$/i, /^lh\d*\.googleusercontent\.com:443$/i, /^github\.com:443$/i];

/**
 * @param {{logPath?: string, allowAll?: boolean, allowedHosts?: RegExp[]}} opts
 * @returns {Promise<{port:number, close:()=>Promise<void>, env:Record<string,string>, stats:()=>{allowed:string[], denied:string[]}}>}
 */
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

/** Bounds so a looping command cannot grow memory or the log without limit. */
const MAX_TRACKED_DESTINATIONS = 200;
const MAX_LOG_BYTES = 1024 * 1024;
const CLOSE_DEADLINE_MS = 2000;

export function startEgressProxy({ logPath, allowAll = false, allowedHosts = DEFAULT_ALLOWED_HOSTS } = {}) {
  const allowed = new Set();
  const denied = new Set();
  const sockets = new Set();
  const track = (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  };
  const remember = (set, value) => {
    if (set.size < MAX_TRACKED_DESTINATIONS || set.has(value)) set.add(value);
  };
  let logBytes = 0;
  const log = (line) => {
    if (!logPath || logBytes > MAX_LOG_BYTES) return;
    const entry = logBytes + line.length > MAX_LOG_BYTES ? "(egress log truncated)" : line;
    logBytes += line.length + 32;
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${entry}\n`);
    } catch {
      // logging must never break a run
    }
  };
  const permitted = (host, port) => {
    if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) return false;
    if (allowAll) return port === 443 || port === 80;
    return port === 443 && allowedHosts.some((re) => re.test(host));
  };

  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    // Plain-HTTP proxying is never needed by agy; it is allowed only with
    // --web, only for http:// URLs, and only to port 80. The port that is
    // checked and logged is the port that is connected to.
    let target = null;
    try {
      target = new URL(req.url);
    } catch {
      // malformed
    }
    const host = target?.hostname ?? "";
    const port = target ? Number(target.port || 80) : 0;
    if (allowAll && target?.protocol === "http:" && permitted(host, port) && port === 80) {
      remember(allowed, `${host}:80`);
      log(`ALLOW http ${host}:80`);
      const up = http.request({ host, port: 80, method: req.method, path: target.pathname + target.search, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("socket", track);
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end();
      });
      req.pipe(up);
      return;
    }
    remember(denied, host ? `${host}:${port}` : "(invalid)");
    log(`DENY  http ${host ? `${host}:${port}` : req.url}`);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Blocked by agy plugin egress policy\n");
  });

  server.on("connect", (req, client, head) => {
    // A peer resetting the connection must never crash the companion.
    client.on("error", () => client.destroy());
    track(client);
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? "");
    const host = m?.[1] ?? "";
    const port = Number(m?.[2] ?? 0);
    if (!permitted(host, port)) {
      remember(denied, `${host}:${port}`);
      log(`DENY  ${host}:${port}`);
      client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by agy plugin egress policy\n");
      return;
    }
    remember(allowed, `${host}:${port}`);
    log(`ALLOW ${host}:${port}`);
    let established = false;
    const upstream = net.connect(port, host, () => {
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on("error", () => {
      // Before the tunnel is up the client is still waiting for a status
      // line; answer it instead of leaving it hanging.
      if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\nUpstream connection failed\n");
      else client.destroy();
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.on("clientError", (_e, sock) => sock.destroy());
  server.on("connection", (sock) => {
    sock.on("error", () => sock.destroy());
    track(sock);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}`;
      resolve({
        port,
        // Loopback stays direct (the profile allows it anyway), so local dev
        // servers and test fixtures work; this also replaces any inherited
        // NO_PROXY that could route a remote host around the proxy.
        env: { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url, https_proxy: url, http_proxy: url, all_proxy: url, NO_PROXY: LOOPBACK_NO_PROXY, no_proxy: LOOPBACK_NO_PROXY },
        stats: () => ({
          allowed: [...allowed].sort(),
          denied: [...denied].sort(),
          unexpectedDenied: [...denied].filter((d) => !EXPECTED_DENIALS.some((re) => re.test(d))).sort()
        }),
        close: () =>
          new Promise((done) => {
            const timer = setTimeout(done, CLOSE_DEADLINE_MS);
            timer.unref?.();
            server.close(() => {
              clearTimeout(timer);
              done();
            });
            server.closeAllConnections?.();
            for (const s of sockets) s.destroy();
          })
      });
    });
  });
}
