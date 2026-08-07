/**
 * Network primitives for the monitors. Node built-ins only — no dependency on
 * `pnpm install` having run, so the workflows can check out the repo and go.
 * That is not tidiness: an install step is one more thing that can fail at
 * 3am and turn a monitor into a false alarm about itself.
 *
 * Everything here takes an explicit timeout. A probe that hangs is worse than
 * one that fails: the workflow burns its 6h budget and never reports.
 */

import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";

/**
 * `MONITOR_RESOLVE="api.pqp.gg=66.241.125.111,pqp.gg=104.21.6.136"`.
 *
 * Pins a hostname to an address for every probe below. Two uses:
 *   * running these checks from a machine whose resolver lies about the
 *     domain (a corporate/sandboxed DNS that NXDOMAINs or hijacks unknown
 *     names), which is how they were first verified;
 *   * pointing a probe at one specific edge address during an investigation.
 * It is deliberately NOT set in CI — there the whole point is to exercise
 * public DNS as a user would.
 */
const OVERRIDES = new Map(
  (process.env.MONITOR_RESOLVE ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq < 1) {
        throw new Error(`MONITOR_RESOLVE entry must be host=ip, got: ${entry}`);
      }
      return [entry.slice(0, eq), entry.slice(eq + 1)];
    }),
);

/**
 * A `lookup` implementation for https.request / tls.connect, or undefined when
 * the host is not overridden (in which case Node's own resolver is used).
 */
export function lookupFor(hostname) {
  const address = OVERRIDES.get(hostname);
  if (!address) {
    return undefined;
  }
  const family = address.includes(":") ? 6 : 4;
  return (_host, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : (options ?? {});
    if (opts.all) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  };
}

class TimeoutError extends Error {}

/** Reject after `ms`, and make sure the underlying socket is torn down. */
function withDeadline(ms, label, run) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup?.();
      reject(new TimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
    let cleanup;
    const done = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    cleanup = run(done(resolve), done(reject));
  });
}

/** GET a URL. Resolves for any HTTP status — only transport failures reject. */
export function httpGet(url, { timeoutMs = 10_000, headers = {} } = {}) {
  const target = new URL(url);
  const started = Date.now();
  return withDeadline(timeoutMs, `GET ${url}`, (resolve, reject) => {
    const req = httpsRequest(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        lookup: lookupFor(target.hostname),
        headers: { "user-agent": "pqp-monitor/1", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            ms: Date.now() - started,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
    return () => req.destroy();
  });
}

/** Same, but for JSON bodies. Throws on non-2xx or unparseable JSON. */
export async function httpGetJson(url, options) {
  const res = await httpGet(url, options);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  try {
    return { ...res, json: JSON.parse(res.body) };
  } catch {
    throw new Error(`GET ${url} -> non-JSON body: ${res.body.slice(0, 200)}`);
  }
}

/** POST JSON, returning the parsed response regardless of status. */
export function httpPostJson(url, payload, { timeoutMs = 20_000, headers = {} } = {}) {
  const target = new URL(url);
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return withDeadline(timeoutMs, `POST ${url}`, (resolve, reject) => {
    const req = httpsRequest(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        lookup: lookupFor(target.hostname),
        headers: {
          "user-agent": "pqp-monitor/1",
          "content-type": "application/json",
          "content-length": body.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* left null; callers report `text` */
          }
          resolve({ status: res.statusCode, body: text, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
    return () => req.destroy();
  });
}

/**
 * The leaf certificate a host presents for `servername`.
 *
 * `rejectUnauthorized` stays ON. An expired or mis-issued certificate should
 * fail this probe the same way it fails a browser — reading `valid_to` off a
 * chain we refused to validate would report "28 days left" on a certificate
 * nobody can actually use.
 */
export function tlsCertificate(servername, { port = 443, timeoutMs = 10_000 } = {}) {
  return withDeadline(timeoutMs, `TLS ${servername}`, (resolve, reject) => {
    const socket = tlsConnect(
      {
        host: servername,
        port,
        servername,
        lookup: lookupFor(servername),
        rejectUnauthorized: true,
      },
      () => {
        const cert = socket.getPeerCertificate(false);
        socket.end();
        if (!cert || !cert.valid_to) {
          reject(new Error(`no peer certificate for ${servername}`));
          return;
        }
        const expiresAt = new Date(cert.valid_to);
        resolve({
          subject: cert.subject?.CN ?? servername,
          issuer: cert.issuer?.O ?? cert.issuer?.CN ?? "unknown",
          altNames: cert.subjectaltname ?? "",
          expiresAt,
          daysRemaining: Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000),
        });
      },
    );
    socket.on("error", reject);
    return () => socket.destroy();
  });
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeMaskedTextFrame(text) {
  const data = Buffer.from(text, "utf8");
  if (data.length > 125) {
    // Every frame this monitor sends is a short JSON control message. Keeping
    // the encoder single-byte-length keeps it auditable; a longer payload is a
    // bug in the caller, not a case to handle.
    throw new Error("monitor ws frames must be <= 125 bytes");
  }
  const mask = randomBytes(4);
  const header = Buffer.alloc(6);
  header[0] = 0x81; // FIN | opcode 0x1 (text)
  header[1] = 0x80 | data.length; // MASK | length
  mask.copy(header, 2);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    masked[i] = data[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, masked]);
}

/**
 * Pull whole frames off a growing buffer. Server-to-client frames are never
 * masked (RFC 6455 §5.1), so this only handles the unmasked shape.
 * Returns { frames, rest }.
 */
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      // 64-bit lengths cannot occur in the replies this monitor expects.
      throw new Error("unexpected 64-bit websocket frame");
    }
    if (buffer.length - offset < headerLength + length) break;
    frames.push({
      opcode,
      payload: buffer.subarray(offset + headerLength, offset + headerLength + length),
    });
    offset += headerLength + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * Open a WebSocket, send one text frame, and report the first frame back.
 *
 * This is the check a plain HTTP probe cannot make. `/health` answering 200
 * proves the HTTP server and the pg pool are alive; it says nothing about
 * whether the upgrade path works or the socket message loop is running, and
 * CLAUDE.md pitfall #9 was exactly that failure — HTTP fine, every WebSocket
 * dead. So this walks the whole path: TCP, TLS, HTTP/1.1 Upgrade, the
 * Sec-WebSocket-Accept handshake, a frame in, a frame out.
 *
 * Resolves { status, accepted, frame } where `frame` is `null` if the server
 * upgraded but never answered.
 */
export function wsProbe(url, { send, timeoutMs = 15_000 } = {}) {
  const target = new URL(url);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  const started = Date.now();

  return withDeadline(timeoutMs, `WS ${url}`, (resolve, reject) => {
    const req = httpsRequest({
      method: "GET",
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      servername: target.hostname,
      lookup: lookupFor(target.hostname),
      headers: {
        "user-agent": "pqp-monitor/1",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        Origin: `https://${target.hostname}`,
      },
    });

    let socket;

    // The server answered the upgrade request with an ordinary response, i.e.
    // it refused to upgrade. That is a real failure mode worth distinguishing
    // from "connection refused" — a misrouted /ws returns 404 or 200 here.
    req.on("response", (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        accepted: false,
        frame: null,
        ms: Date.now() - started,
      });
    });

    req.on("upgrade", (res, sock, head) => {
      socket = sock;
      if (res.headers["sec-websocket-accept"] !== expectedAccept) {
        sock.destroy();
        reject(new Error("Sec-WebSocket-Accept did not match the key we sent"));
        return;
      }
      let buffer = Buffer.from(head ?? []);
      const consume = () => {
        let decoded;
        try {
          decoded = decodeFrames(buffer);
        } catch (error) {
          sock.destroy();
          reject(error);
          return;
        }
        buffer = decoded.rest;
        const first = decoded.frames[0];
        if (!first) return;
        sock.destroy();
        resolve({
          status: res.statusCode,
          accepted: true,
          ms: Date.now() - started,
          frame:
            first.opcode === 0x8
              ? {
                  kind: "close",
                  code: first.payload.length >= 2 ? first.payload.readUInt16BE(0) : null,
                  reason: first.payload.subarray(2).toString("utf8"),
                }
              : { kind: "message", text: first.payload.toString("utf8") },
        });
      };
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        consume();
      });
      // A clean FIN with no frame at all is itself a finding: the server
      // upgraded and then hung up without speaking.
      sock.on("end", () =>
        resolve({ status: res.statusCode, accepted: true, frame: null, ms: Date.now() - started }),
      );
      sock.on("error", reject);
      if (send) sock.write(encodeMaskedTextFrame(send));
      consume();
    });

    req.on("error", reject);
    req.end();
    return () => {
      socket?.destroy();
      req.destroy();
    };
  });
}

/**
 * Raw WHOIS (RFC 3912): connect to port 43, send the query, read until close.
 * Written by hand because `.gg` has no RDAP service in the IANA bootstrap
 * (data.iana.org/rdap/dns.json lists no delegation for it), so the modern JSON
 * API this would otherwise use does not exist for this domain — and because
 * shelling out to a `whois` binary would add an apt-get to the workflow.
 */
export function whois(query, { host, port = 43, timeoutMs = 15_000 } = {}) {
  return withDeadline(timeoutMs, `WHOIS ${query}`, (resolve, reject) => {
    const chunks = [];
    const socket = createConnection({ host, port }, () => socket.write(`${query}\r\n`));
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
    return () => socket.destroy();
  });
}

/**
 * Run `fn` until it returns a truthy-ok result, with a pause between tries.
 *
 * THIS IS THE ANTI-FALSE-ALARM MECHANISM, and it is the reason these checks
 * can be trusted enough not to be muted. A single failed request is not an
 * outage: `fly.toml` uses a rolling deploy with `max_unavailable = 1` on a
 * single machine, so every legitimate release produces a few seconds where
 * this exact probe fails. Spreading three attempts across ~40s means a deploy,
 * a GC pause or one dropped packet cannot open an issue, while a genuine
 * outage still fails all three.
 *
 * `fn` receives the attempt number and must return `{ ok, ... }`.
 */
export async function untilOk(fn, { attempts = 3, delayMs = 20_000 } = {}) {
  const tries = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      result = await fn(attempt);
    } catch (error) {
      result = { ok: false, note: error.message };
    }
    tries.push(result);
    if (result.ok) {
      return { ...result, attempt, tries };
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { ...tries[tries.length - 1], attempt: attempts, tries };
}
