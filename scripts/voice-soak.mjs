#!/usr/bin/env node
/**
 * Voice connection soak / reproduction harness.
 *
 * Spawns the built server, creates a server + voice channel, connects N
 * WebSocket clients, has them join the voice room, and soaks the connections
 * (heartbeats only) for a while — watching for spurious disconnects. Prints the
 * server's diagnostic log lines (ws.connect / ws.auth / voice.join / ws.close /
 * ws.heartbeatTerminate) so a drop can be traced to its cause.
 *
 * Usage (server must be built: `pnpm --filter @pqp/server build`):
 *   DATABASE_URL=postgres://pqp@127.0.0.1:5432/pqp \
 *   CLIENTS=3 SOAK_SECONDS=120 node scripts/voice-soak.mjs
 *
 * Requires DEV_AUTH_BYPASS (set automatically). NOTE: all simulated clients
 * authenticate as the single dev user, so this exercises the WS/heartbeat/
 * voice-transport path (which is user-agnostic) rather than multi-account
 * behavior — it is a connection-stability tool, not an auth test.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..", "server");
const PORT = Number(process.env.PORT ?? 3910);
const CLIENTS = Number(process.env.CLIENTS ?? 2);
const SOAK_SECONDS = Number(process.env.SOAK_SECONDS ?? 70);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://pqp@127.0.0.1:5432/pqp";
const TOKEN = "dev-local-token";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const server = spawn("node", ["dist/index.js"], {
  cwd: SERVER_DIR,
  env: { ...process.env, DATABASE_URL, DEV_AUTH_BYPASS: "true", PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});

function makeClient(name, voiceId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const st = { name, ws, closed: false, closeCode: null, pongs: 0, timers: [] };
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "ready") {
        ws.send(JSON.stringify({ type: "join-voice-room", voiceChannelId: voiceId }));
        // Mirror the real client's app-level heartbeat.
        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 20_000);
        st.timers.push(ping);
        resolve(st);
      } else if (m.type === "pong") {
        st.pongs++;
      }
    };
    ws.onclose = (e) => {
      st.closed = true;
      st.closeCode = e.code;
      st.timers.forEach(clearInterval);
      log(`${name} CLOSED code=${e.code}`);
    };
    ws.onerror = () => log(`${name} ERROR`);
  });
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {}
    await sleep(200);
  }
  if (!up) throw new Error("server never became healthy");

  const res = await fetch(`${BASE}/api/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name: "Soak" }),
  });
  if (!res.ok) {
    throw new Error(`create server failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const voice = Array.isArray(body.channels)
    ? body.channels.find((c) => c.type === "voice")
    : undefined;
  if (!voice) {
    throw new Error(
      `no voice channel in create-server response: ${JSON.stringify(body)}`,
    );
  }
  log(`voice channel ${voice.id}; connecting ${CLIENTS} clients`);

  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    clients.push(await makeClient(`C${i + 1}`, voice.id));
  }
  await sleep(800);
  log(`all joined; soaking ${SOAK_SECONDS}s…`);

  const deadline = Date.now() + SOAK_SECONDS * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (clients.every((c) => c.closed)) break;
  }

  const dropped = clients.filter((c) => c.closed);
  log(
    `RESULT dropped=${dropped.length}/${clients.length} ` +
      clients.map((c) => `${c.name}:${c.closed ? `closed(${c.closeCode})` : "ok"}/pongs=${c.pongs}`).join(" "),
  );
  process.exitCode = dropped.length === 0 ? 0 : 1;
} catch (err) {
  log(`HARNESS ERROR ${err.message}`);
  process.exitCode = 1;
} finally {
  server.kill("SIGKILL");
}
