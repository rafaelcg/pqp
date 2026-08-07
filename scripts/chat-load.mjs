#!/usr/bin/env node
/**
 * Chat throughput / fan-out load harness.
 *
 * Answers the one question a launch needs answered: how many concurrent
 * sockets does one container hold, at what message rate, with what delivery
 * latency. `voice-soak.mjs` is the connection-stability tool; this is the
 * throughput one.
 *
 * Spawns the built server, creates a server + invite, joins N clients as N
 * DISTINCT users, has a subset of them post at a fixed rate, and measures the
 * time from send to the message arriving at another client. Every posted
 * message carries its send timestamp in the body, so the latency measured is
 * true end-to-end fan-out — send → DB write → broadcast → receive — not a
 * round-trip ping.
 *
 * Usage (server must be built: `pnpm --filter @pqp/server build`):
 *   CLIENTS=200 SENDERS=20 RATE=2 SECONDS=60 pnpm load:chat
 *
 *   CLIENTS  total sockets to open              (default 100)
 *   SENDERS  how many of them post              (default 10)
 *   RATE     messages per second per sender     (default 1)
 *   CHANNELS spread clients over this many      (default 1)
 *   SECONDS  measurement window                 (default 30)
 *
 * NOTE ON RATE: the server allows 10 messages burst / 2 per second per user
 * (`messageLimiter` in ws/chat.ts). RATE above 2 will be throttled server-side
 * and shows up as a `rate-limited` count, not as throughput. To push real load,
 * raise SENDERS rather than RATE — which is also what a busy server looks like.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..", "server");
const PORT = Number(process.env.PORT ?? 3911);
const CLIENTS = Number(process.env.CLIENTS ?? 100);
const SENDERS = Number(process.env.SENDERS ?? 10);
const RATE = Number(process.env.RATE ?? 1);
const CHANNELS = Number(process.env.CHANNELS ?? 1);
// Pace the connect loop. Zero is a thundering-herd join, which is the launch
// case and the one that finds the shared address-bucket ceiling; a few ms
// apiece measures steady-state capacity instead.
const CONNECT_DELAY_MS = Number(process.env.CONNECT_DELAY_MS ?? 0);
const SECONDS = Number(process.env.SECONDS ?? 30);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://pqp@127.0.0.1:5432/pqp";
const OWNER_TOKEN = "dev-local-token";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const t0 = Date.now();
const log = (m) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

if (SENDERS > CLIENTS) {
  console.error("SENDERS cannot exceed CLIENTS");
  process.exit(1);
}

const server = spawn("node", ["dist/index.js"], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    DATABASE_URL,
    DEV_AUTH_BYPASS: "true",
    PORT: String(PORT),
    // Otherwise every simulated client shares one address bucket and the
    // connection limiter, not the server, decides how many get in.
    TRUST_PROXY: "true",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

async function api(path, { method = "GET", token = OWNER_TOKEN, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      // Distinct per caller so the pre-auth IP limiter does not collapse every
      // simulated client into one bucket. Only honoured because the harness
      // sets TRUST_PROXY for the child process.
      "X-Forwarded-For": `10.${Math.floor(Math.random() * 250)}.${Math.floor(
        Math.random() * 250,
      )}.${Math.floor(Math.random() * 250)}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Close codes seen on sockets that never finished connecting. */
const refusedCodes = new Map();

/** Latency samples, in ms, from send to arrival at a *different* client. */
const latencies = [];
let received = 0;
let sent = 0;
let errors = 0;
let rateLimited = 0;

function connect(index, token, channelId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const st = { index, ws, channelId, closed: false, closeCode: null };
    let settled = false;
    // Resolve with `null` rather than throwing: a client the server refused is
    // a data point about capacity, not a broken harness, and aborting the run
    // on the first one would throw away the number we came for.
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimer);
      resolve(value);
    };
    const failTimer = setTimeout(() => finish(null), 20_000);

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "ready") {
        ws.send(JSON.stringify({ type: "join-channel", channelId }));
        finish(st);
      } else if (m.type === "message-broadcast") {
        received++;
        // The sender timestamped the body; anything that round-trips back to
        // its own author is excluded so the number is fan-out, not echo.
        const stamp = Number(String(m.message?.body ?? "").split("|")[1]);
        // `st.userId` was never assigned, so this comparison was always true and
        // the sender's own echo landed in the latency samples alongside the
        // fan-out it was meant to measure. Senders are the first SENDERS
        // clients, so exclude by index instead of by an id we never learn.
        if (Number.isFinite(stamp) && index >= SENDERS) {
          latencies.push(Date.now() - stamp);
        }
      } else if (m.type === "error") {
        if (String(m.error ?? "").toLowerCase().includes("too many")) {
          rateLimited++;
        } else {
          errors++;
        }
      }
    };
    ws.onclose = (e) => {
      st.closed = true;
      st.closeCode = e.code;
      // Refused before it ever got going — 4429 means the shared address
      // bucket is empty, which is the number worth reporting.
      refusedCodes.set(e.code, (refusedCodes.get(e.code) ?? 0) + 1);
      finish(null);
    };
    ws.onerror = () => {};
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  if (!up) throw new Error("server never became healthy");

  const created = await api("/api/servers", {
    method: "POST",
    body: { name: `Load ${Date.now()}` },
  });
  const serverId = created.id ?? created.server?.id;
  const textChannels = (created.channels ?? []).filter((c) => c.type === "text");
  if (!serverId || textChannels.length === 0) {
    throw new Error(`unexpected create-server shape: ${JSON.stringify(created)}`);
  }

  while (textChannels.length < CHANNELS) {
    const extra = await api(`/api/servers/${serverId}/channels`, {
      method: "POST",
      body: { name: `load-${textChannels.length}`, type: "text" },
    });
    textChannels.push(extra.channel ?? extra);
  }

  const invite = await api(`/api/servers/${serverId}/invites`, {
    method: "POST",
    body: {},
  });
  const code = invite.invite?.code ?? invite.code;
  if (!code) throw new Error(`no invite code: ${JSON.stringify(invite)}`);

  log(`server ${serverId}, ${CHANNELS} channel(s); joining ${CLIENTS} users`);

  // Join over HTTP first — a distinct account per client, so the per-user
  // message limit applies per client the way it would in production.
  const tokens = [];
  for (let i = 0; i < CLIENTS; i++) {
    const token = `${OWNER_TOKEN}:c${i}`;
    await api(`/api/invites/${code}/join`, { method: "POST", token });
    tokens.push(token);
  }
  log(`${CLIENTS} users joined; opening sockets`);

  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const channel = textChannels[i % CHANNELS];
    const client = await connect(i, tokens[i], channel.id);
    if (client) clients.push(client);
    if (CONNECT_DELAY_MS) await sleep(CONNECT_DELAY_MS);
  }
  const refused = CLIENTS - clients.length;
  if (refused) {
    log(`WARNING ${refused}/${CLIENTS} sockets refused during connect — ` +
        `close codes ${[...refusedCodes].map(([c, n]) => `${c}:${n}`).join(" ")}`);
  }
  if (clients.length === 0) throw new Error("no client ever connected");
  await sleep(1000);
  log(`${clients.length} sockets open; ${SENDERS} senders at ${RATE}/s for ${SECONDS}s`);

  const started = Date.now();
  const timers = [];
  for (let i = 0; i < SENDERS; i++) {
    const client = clients[i];
    timers.push(
      setInterval(() => {
        if (client.ws.readyState !== 1) return;
        client.ws.send(
          JSON.stringify({
            type: "message-create",
            channelId: client.channelId,
            body: `load|${Date.now()}`,
          }),
        );
        sent++;
      }, Math.max(1, Math.round(1000 / RATE))),
    );
  }

  const deadline = started + SECONDS * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    log(
      `sent=${sent} received=${received} rateLimited=${rateLimited} ` +
        `open=${clients.filter((c) => !c.closed).length}/${clients.length}`,
    );
  }
  timers.forEach(clearInterval);
  // Let the last broadcasts land before measuring.
  await sleep(2000);

  const elapsed = (Date.now() - started) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const dropped = clients.filter((c) => c.closed);
  const expectedFanout = sent * (CLIENTS / CHANNELS);

  log("");
  log(`=== RESULT (${CLIENTS} sockets, ${SENDERS} senders, ${CHANNELS} channel(s)) ===`);
  log(`sockets held      ${clients.length - dropped.length}/${CLIENTS} requested` +
      (dropped.length
        ? ` — dropped mid-run: ${[...dropped.reduce((m, c) => m.set(c.closeCode, (m.get(c.closeCode) ?? 0) + 1), new Map())]
            .map(([code, n]) => `${code}×${n}`)
            .join(" ")}`
        : ""));
  log(`messages sent     ${sent} (${(sent / elapsed).toFixed(1)}/s)`);
  log(`fan-out delivered ${received} (${(received / elapsed).toFixed(0)}/s) ` +
      `of ~${Math.round(expectedFanout)} expected`);
  log(`rate-limited      ${rateLimited}${rateLimited ? "  ← raise SENDERS, not RATE" : ""}`);
  log(`errors            ${errors}`);
  log(`latency  p50 ${percentile(sorted, 50)}ms  p95 ${percentile(sorted, 95)}ms  ` +
      `p99 ${percentile(sorted, 99)}ms  max ${sorted[sorted.length - 1]}ms  (n=${sorted.length})`);

  process.exitCode = dropped.length === 0 && errors === 0 ? 0 : 1;
} catch (err) {
  log(`HARNESS ERROR ${err.message}`);
  process.exitCode = 1;
} finally {
  server.kill("SIGKILL");
}
