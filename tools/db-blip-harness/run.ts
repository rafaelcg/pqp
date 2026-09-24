/* eslint-disable no-console -- a CLI harness: its output is the report. */
/**
 * DB-BLIP HARNESS: does a watch party survive Postgres going away?
 *
 * Reproduces the 2026-09-23 incident locally (Vultr managed Postgres
 * unreachable from the API for 61 s, breaker open on both replicas) and
 * asserts the two things Saturday's party needs:
 *
 *  1. a viewer already watching a live HLS stream keeps playing, with no
 *     fatal hls.js error and no rebuild of the player, and
 *  2. a voice call already connected (two distinct dev users) is not hung
 *     up: both sockets stay open, nobody receives `peer-left` for the other,
 *     and after recovery both seats are still in `voice_peers` (with the
 *     registry on, the rows ARE what every roster is built from).
 *
 * Everything is local and free: the real API (`server/dist`), with
 * `VOICE_REGISTRY=postgres` and `CLUSTER_BUS=postgres` like production,
 * talking to Postgres THROUGH `blackhole-proxy.mjs`; ffmpeg writing a live
 * HLS rendition into a directory served by `fake-s3.mjs`; stock hls.js in
 * headless Chromium via Playwright. No LiveKit, no egress, no Docker beyond
 * the Postgres you already run.
 *
 * Usage (from the repo root, server built with `pnpm --filter @pqp/server build`):
 *   HARNESS_PG_URL=postgres://pqp:pw@127.0.0.1:5432/postgres \
 *   pnpm --filter @pqp/server exec tsx ../tools/db-blip-harness/run.ts
 *
 * Env: HARNESS_PG_URL (an admin URL; the harness creates and drops its own
 * database), BLIP_SECONDS (default 90), WARMUP_SECONDS (default 25),
 * AFTER_SECONDS (default 30).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type PgModule from "pg";
import type { Browser } from "playwright";
import { startBlackholeProxy } from "./blackhole-proxy.mjs";
import { startFakeS3 } from "./fake-s3.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
// Overridable, so the SAME harness can be pointed at another build (say, a
// checkout of main) to show the failure the fix removes.
const SERVER_DIR = process.env.HARNESS_SERVER_DIR ?? join(REPO, "server");
// Borrowed from the workspace packages that already depend on them.
const pg = createRequire(join(REPO, "server", "package.json"))("pg") as typeof PgModule;
const { chromium } = createRequire(join(REPO, "client", "package.json"))(
  "@playwright/test",
) as { chromium: { launch(options: { headless: boolean }): Promise<Browser> } };

const BLIP_SECONDS = Number(process.env.BLIP_SECONDS ?? 90);
const WARMUP_SECONDS = Number(process.env.WARMUP_SECONDS ?? 25);
const AFTER_SECONDS = Number(process.env.AFTER_SECONDS ?? 30);
const ADMIN_URL = process.env.HARNESS_PG_URL;
if (!ADMIN_URL) {
  throw new Error("HARNESS_PG_URL is required (an admin URL to a LOCAL Postgres)");
}
const admin = new URL(ADMIN_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(admin.hostname)) {
  throw new Error(`refusing a non-local Postgres: ${admin.hostname}`);
}

const API_PORT = 3960;
const API_B_PORT = 3963;
const PROXY_PORT = 55432;
const S3_PORT = 3961;
const PAGE_PORT = 3962;
const BUCKET = "pqp-live-harness";
const RUNG = "720p30";
const DB_NAME = `pqp_dbblip_${process.pid}`;
const API = `http://127.0.0.1:${API_PORT}`;
const API_B = `http://127.0.0.1:${API_B_PORT}`;

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (message: string) => console.log(`[${stamp()}s] ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const cleanups: (() => Promise<void> | void)[] = [];
async function cleanupAll() {
  for (const step of cleanups.reverse()) {
    try {
      await step();
    } catch (error) {
      console.error("cleanup step failed:", error);
    }
  }
}

function kill(child: ChildProcess) {
  return new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

// ---------------------------------------------------------------- database

async function createDatabase(): Promise<string> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  await client.query(`CREATE DATABASE ${DB_NAME}`);
  await client.end();
  cleanups.push(async () => {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await c.end();
  });
  const direct = new URL(ADMIN_URL!);
  direct.pathname = `/${DB_NAME}`;
  return direct.toString();
}

// ------------------------------------------------------------------ stream

function startFfmpeg(root: string, channelId: string, startedAt: number): ChildProcess {
  const dir = join(root, "live", channelId);
  mkdirSync(dir, { recursive: true });
  const base = `${startedAt}-${RUNG}`;
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-g",
      "120",
      "-keyint_min",
      "120",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-f",
      "hls",
      "-hls_time",
      "4",
      "-hls_list_size",
      "5",
      "-hls_flags",
      "delete_segments+program_date_time+temp_file",
      "-hls_segment_filename",
      join(dir, `${base}_%05d.ts`),
      join(dir, `${base}.m3u8`),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  return ffmpeg;
}

// --------------------------------------------------------------------- api

function startApi(databaseUrl: string, name: string, port: number): ChildProcess {
  const api = spawn("node", ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      DEV_AUTH_BYPASS: "true",
      DEV_SEED: "false",
      VOICE_REGISTRY: "postgres",
      CLUSTER_BUS: "postgres",
      LIVE_HLS_S3_BUCKET: BUCKET,
      LIVE_HLS_S3_ACCESS_KEY_ID: "harness",
      LIVE_HLS_S3_SECRET_ACCESS_KEY: "harness",
      LIVE_HLS_S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
      LIVE_HLS_S3_FORCE_PATH_STYLE: "true",
      LIVE_HLS_S3_REGION: "auto",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = /breaker|voice\.(join|leave|left|peer)|ws\.close|heartbeat|registry|sweep|reconcile|hlsPlaylist|error|Error/i;
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim() && keep.test(line)) {
        console.log(`[${stamp()}s]   ${name}| ${line.slice(0, 400)}`);
      }
    }
  };
  api.stdout!.on("data", forward);
  api.stderr!.on("data", forward);
  return api;
}

async function waitFor(what: string, check: () => Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ------------------------------------------------------------------- voice

interface VoiceClient {
  name: string;
  ws: WebSocket;
  peerId: string | null;
  closed: boolean;
  closeCode: number | null;
  peerLeft: string[];
  roster: Set<string>;
  errors: string[];
}

function connectVoice(
  name: string,
  token: string,
  channelId: string,
  wsUrl: string,
): Promise<VoiceClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const client: VoiceClient = {
      name,
      ws,
      peerId: null,
      closed: false,
      closeCode: null,
      peerLeft: [],
      roster: new Set(),
      errors: [],
    };
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 20_000);
    cleanups.push(() => {
      clearInterval(ping);
      ws.close();
    });
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      switch (message.type) {
        case "ready":
          ws.send(JSON.stringify({ type: "join-voice-room", voiceChannelId: channelId }));
          break;
        case "welcome":
          client.peerId = message.peerId;
          resolve(client);
          break;
        case "peer-left":
          client.peerLeft.push(message.peerId);
          client.roster.delete(message.peerId);
          log(`VOICE ${name} got peer-left ${message.peerId}`);
          break;
        case "voice-roster":
          if (message.voiceChannelId === channelId || message.channelId === channelId) {
            client.roster = new Set(
              (message.participants ?? []).map((p: { peerId: string }) => p.peerId),
            );
          }
          break;
        case "voice-roster-delta":
          for (const change of message.changes ?? message.deltas ?? []) {
            if (change.op === "left" || change.kind === "left") {
              client.roster.delete(change.peerId);
            } else if (change.peerId) {
              client.roster.add(change.peerId);
            }
          }
          break;
        case "error":
          client.errors.push(String(message.message ?? message.code ?? "error"));
          break;
        default:
          break;
      }
    };
    ws.onclose = (event) => {
      client.closed = true;
      client.closeCode = event.code;
      clearInterval(ping);
      log(`VOICE ${name} socket CLOSED code=${event.code}`);
      reject(new Error(`${name} closed before welcome`));
    };
  });
}

// ------------------------------------------------------------------ viewer

function startViewerPage(): Promise<() => Promise<void>> {
  const hlsJs = readFileSync(join(REPO, "client", "node_modules", "hls.js", "dist", "hls.min.js"));
  const page = readFileSync(join(HERE, "viewer.html"));
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/hls.min.js")) {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(hlsJs);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page);
  });
  return new Promise((resolve) =>
    server.listen(PAGE_PORT, "127.0.0.1", () =>
      resolve(() => new Promise((done) => server.close(() => done()))),
    ),
  );
}

interface ViewerSample {
  t: number;
  currentTime: number;
  buffered: number;
  paused: boolean;
  waiting: boolean;
}

interface ViewerReport {
  instances: number;
  manifestLoads: number;
  fatal: string[];
  nonFatal: Record<string, number>;
  levelLoaded: number;
  samples: ViewerSample[];
  waitingEvents: number;
}

// -------------------------------------------------------------------- main

async function main() {
  const databaseUrl = await createDatabase();
  log(`database ${DB_NAME} created`);

  const proxy = await startBlackholeProxy({
    listenPort: PROXY_PORT,
    targetHost: admin.hostname,
    targetPort: Number(admin.port || 5432),
  });
  cleanups.push(() => proxy.stop());
  const viaProxy = new URL(databaseUrl);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(PROXY_PORT);

  const root = mkdtempSync(join(tmpdir(), "pqp-dbblip-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const s3 = await startFakeS3({ port: S3_PORT, root, bucket: BUCKET });
  cleanups.push(() => s3.stop());
  const stopPage = await startViewerPage();
  cleanups.push(stopPage);

  // Two machines, like production: the cross-instance hazards (a reconcile
  // reading its twin's stale lease as death) need a twin.
  const apiA = startApi(viaProxy.toString(), "apiA", API_PORT);
  cleanups.push(() => kill(apiA));
  await waitFor("API A /health", async () => (await fetch(`${API}/health`)).ok, 60_000);
  const apiB = startApi(viaProxy.toString(), "apiB", API_B_PORT);
  cleanups.push(() => kill(apiB));
  await waitFor("API B /health", async () => (await fetch(`${API_B}/health`)).ok, 60_000);
  log(`two APIs up (Postgres via the black-hole proxy), server build ${SERVER_DIR}`);

  // Two DISTINCT accounts (CLAUDE.md: the suffix is what makes them two).
  const alice = "dev-local-token:alice";
  const bob = "dev-local-token:bob";
  // Both accounts are adults (the age gate refuses everything else).
  for (const token of [alice, bob]) {
    await api("/api/me/age-check", token, {
      method: "POST",
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  const created = await api<{
    id?: string;
    server?: { id: string };
    channels: { id: string; type: string }[];
  }>("/api/servers", alice, { method: "POST", body: JSON.stringify({ name: "Blip party" }) });
  const serverId = created.server?.id ?? created.id!;
  const voiceChannel = created.channels.find((c) => c.type === "voice")!.id;
  const invite = await api<{ code?: string; invite?: { code: string } }>(
    `/api/servers/${serverId}/invites`,
    alice,
    { method: "POST", body: JSON.stringify({}) },
  );
  const inviteCode = invite.code ?? invite.invite!.code;
  await api(`/api/invites/${inviteCode}/join`, bob, { method: "POST", body: "{}" });
  log(`server ${serverId}, voice channel ${voiceChannel}; bob joined via invite`);

  // The live session, the way the egress writer records it.
  const startedAt = Date.now();
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const aliceRow = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE clerk_id = 'dev_local_user_alice'`,
  );
  await db.query(
    `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, rung)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4)`,
    [voiceChannel, `live/${voiceChannel}/${startedAt}-${RUNG}`, startedAt, RUNG],
  );
  const ffmpeg = startFfmpeg(root, voiceChannel, startedAt);
  cleanups.push(() => kill(ffmpeg));

  // The viewer token the API would hand out from `/live`, minted with the
  // same key (dev bypass), for a viewer who passed the access check.
  process.env.DEV_AUTH_BYPASS = "true";
  const { mintHlsViewerToken } = await import("../../server/src/voice/hls-viewer-token.ts");
  const viewerToken = mintHlsViewerToken({
    userId: aliceRow.rows[0]!.id,
    channelId: voiceChannel,
    startedAt,
  });
  const masterUrl =
    `${API}/api/voice/hls-playlist/${voiceChannel}/${startedAt}?t=${encodeURIComponent(viewerToken)}`;
  await waitFor(
    "the first rendition playlist",
    async () =>
      (await fetch(`${API}/api/voice/hls-playlist/${voiceChannel}/${startedAt}/${RUNG}?t=${encodeURIComponent(viewerToken)}`)).ok,
    30_000,
  );
  log("stream is live through the proxy");

  // Two people in a call.
  // One on each machine, so their mesh leg crosses instances.
  const callA = await connectVoice("alice", alice, voiceChannel, `ws://127.0.0.1:${API_PORT}/ws`);
  const callB = await connectVoice("bob", bob, voiceChannel, `ws://127.0.0.1:${API_B_PORT}/ws`);
  callA.ws.onclose = (event) => {
    callA.closed = true;
    callA.closeCode = event.code;
    log(`VOICE alice socket CLOSED code=${event.code}`);
  };
  callB.ws.onclose = (event) => {
    callB.closed = true;
    callB.closeCode = event.code;
    log(`VOICE bob socket CLOSED code=${event.code}`);
  };
  log(`call up: alice=${callA.peerId} bob=${callB.peerId}`);

  // A viewer.
  const browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.text().startsWith("[viewer]")) log(message.text());
  });
  await page.goto(
    `http://127.0.0.1:${PAGE_PORT}/viewer.html#${encodeURIComponent(masterUrl)}`,
  );
  await page.waitForFunction(() => (window as unknown as { viewer?: { playing: boolean } }).viewer?.playing === true, null, {
    timeout: 45_000,
  });
  log("viewer is playing");

  await sleep(WARMUP_SECONDS * 1000);
  const readViewer = () =>
    page.evaluate(() => (window as unknown as { viewer: ViewerReport }).viewer) as Promise<ViewerReport>;
  const before = await readViewer();
  log(
    `WARMUP done: t=${before.samples.at(-1)?.currentTime.toFixed(1)} ` +
      `buffered=${before.samples.at(-1)?.buffered.toFixed(1)}s levelLoads=${before.levelLoaded}`,
  );

  // ---- THE BLIP ----
  const blipStart = Date.now();
  proxy.open();
  log(`>>> POSTGRES UNREACHABLE for ${BLIP_SECONDS}s`);
  let last = before.samples.at(-1)!.currentTime;
  let frozenSince: number | null = null;
  let longestFreezeMs = 0;
  while (Date.now() - blipStart < BLIP_SECONDS * 1000) {
    await sleep(5_000);
    const now = await readViewer();
    const sample = now.samples.at(-1)!;
    const advanced = sample.currentTime - last;
    if (advanced < 0.5) {
      frozenSince ??= Date.now() - 5_000;
      longestFreezeMs = Math.max(longestFreezeMs, Date.now() - frozenSince);
    } else {
      frozenSince = null;
    }
    last = sample.currentTime;
    const health = await fetch(`${API}/health`).then((r) => r.status).catch(() => "down");
    log(
      `    during: +${advanced.toFixed(1)}s played, buffered=${sample.buffered.toFixed(1)}s ` +
        `waiting=${sample.waiting} levelLoads=${now.levelLoaded} ` +
        `nonFatal=${JSON.stringify(now.nonFatal)} health=${health} ` +
        `ws alice=${callA.closed ? "CLOSED" : "open"} bob=${callB.closed ? "CLOSED" : "open"}`,
    );
  }
  proxy.close();
  log("<<< POSTGRES BACK");

  await sleep(AFTER_SECONDS * 1000);
  const after = await readViewer();
  const played = after.samples.at(-1)!.currentTime - before.samples.at(-1)!.currentTime;
  const wall = (Date.now() - blipStart) / 1000;

  // Voice: ask for a fresh roster the way a client does after a reconnect,
  // and read the registry directly.
  const rows = await db.query<{ peer_id: string }>(
    `SELECT peer_id FROM voice_peers WHERE channel_id = $1`,
    [voiceChannel],
  ).catch(async () => ({ rows: [] as { peer_id: string }[] }));
  await db.end();

  const failures: string[] = [];
  if (after.fatal.length > 0) failures.push(`viewer fatal errors: ${after.fatal.join(", ")}`);
  if (after.instances !== 1) failures.push(`viewer rebuilt the player: ${after.instances} instances`);
  if (after.manifestLoads !== 1) failures.push(`viewer reloaded the master ${after.manifestLoads} times`);
  if (played < wall - 12) {
    failures.push(`viewer played ${played.toFixed(1)}s of ${wall.toFixed(1)}s wall clock`);
  }
  if (longestFreezeMs > 8_000) failures.push(`playhead froze for ${longestFreezeMs}ms`);
  for (const call of [callA, callB]) {
    if (call.closed) failures.push(`${call.name}'s socket closed (code ${call.closeCode})`);
    if (call.peerLeft.length > 0) failures.push(`${call.name} was told ${call.peerLeft.join(",")} left`);
  }
  const seated = new Set(rows.rows.map((row) => row.peer_id));
  for (const call of [callA, callB]) {
    if (!seated.has(call.peerId!)) failures.push(`${call.name}'s voice_peers row is missing after recovery`);
  }

  log(
    `RESULT viewer: played ${played.toFixed(1)}s over ${wall.toFixed(1)}s wall, ` +
      `longest freeze ${(longestFreezeMs / 1000).toFixed(1)}s, fatal=${after.fatal.length}, ` +
      `instances=${after.instances}, masterLoads=${after.manifestLoads}, ` +
      `waitingEvents=${after.waitingEvents}, nonFatal=${JSON.stringify(after.nonFatal)}`,
  );
  log(
    `RESULT voice: alice ${callA.closed ? "CLOSED" : "open"} bob ${callB.closed ? "CLOSED" : "open"}, ` +
      `peer-left alice=${callA.peerLeft.length} bob=${callB.peerLeft.length}, ` +
      `voice_peers rows=${[...seated].join(",") || "none"}`,
  );
  if (failures.length > 0) {
    log(`FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    log("PASS");
  }
}

main()
  .catch((error) => {
    log(`HARNESS ERROR ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanupAll();
    process.exit();
  });
