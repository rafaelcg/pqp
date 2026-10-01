/**
 * RECONNECT-HERD HARNESS: what a rolling deploy does to the API that stays up.
 *
 * Reproduces the second half of `tools/api-host/pqp-deploy.sh` on one
 * machine, with the flags production sets (`CLUSTER_BUS=postgres`,
 * `VOICE_REGISTRY=postgres`, `PG_POOL_MAX=22`, CLAUDE.md pitfall 12):
 *
 *   1. two real APIs, A and B, on one scratch database;
 *   2. N sockets on B (distinct dev users, members of S servers, most of them
 *      seated in voice rooms across those servers, like a Saturday evening);
 *   3. A restarted, so it is the freshly booted container (fresh peaks);
 *   4. B gets SIGTERM and drains for real (`lib/drain.ts`), every socket
 *      reconnects to A after the web client's drain jitter (0.5 to 4 s), sends
 *      `auth`, then `join-channel` and, when seated, `join-voice-room` with its
 *      resume token, then GETs the channel's latest messages;
 *   5. when B has exited, its replacement B2 boots and runs `initDb`, exactly
 *      when the herd is landing on A.
 *
 * It reports, from A: the pool's peak busy and peak queue (the dashboard
 * card's two numbers), the per-checkout wait histogram (`lib/pool-wait.ts`),
 * the socket admission gate; from the clients: time from socket open to
 * `ready`, to `welcome` (voice resumed), and the messages GET; from the logs:
 * deadlocks, breaker flips, B2's boot time and whether it booted at all.
 *
 * `HERD_MODE=before` runs the same build with every new switch at its
 * rollback (BOOT_SCHEMA_MODE=always, WS_AUTH_ADMISSION=off,
 * DRAIN_RATE_PER_SECOND=0, VOICE_CATCHUP_CONCURRENCY=0), which is the code
 * production ran; `after` uses the defaults; `both` (default) runs one then
 * the other, each on a fresh database.
 *
 * Usage (server built with `pnpm --filter @pqp/server build`):
 *   HARNESS_PG_URL=postgres://pqp:pw@127.0.0.1:5432/postgres \
 *   pnpm --filter @pqp/server exec tsx ../tools/reconnect-herd-harness/run.mts
 *
 * Env: HARNESS_PG_URL (an admin URL to a LOCAL Postgres; the harness creates
 * and drops its own databases), HERD_SOCKETS (150), HERD_SERVERS (5),
 * HERD_VOICE_PER_SERVER (4), HERD_SEATED (0.7), HERD_MODE (both).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type PgModule from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SERVER_DIR = process.env.HARNESS_SERVER_DIR ?? join(REPO, "server");
const pg = createRequire(join(REPO, "server", "package.json"))("pg") as typeof PgModule;

const SOCKETS = Number(process.env.HERD_SOCKETS ?? 150);
const SERVERS = Number(process.env.HERD_SERVERS ?? 5);
const VOICE_PER_SERVER = Number(process.env.HERD_VOICE_PER_SERVER ?? 4);
const SEATED = Number(process.env.HERD_SEATED ?? 0.7);
const MODE = process.env.HERD_MODE ?? "both";
const ADMIN_URL = process.env.HARNESS_PG_URL;
if (!ADMIN_URL) {
  throw new Error("HARNESS_PG_URL is required (an admin URL to a LOCAL Postgres)");
}
const admin = new URL(ADMIN_URL);
if (!["127.0.0.1", "localhost", "::1"].includes(admin.hostname)) {
  throw new Error(`refusing a non-local Postgres: ${admin.hostname}`);
}

const PORT_A = 3971;
const PORT_B = 3972;
const PORT_B2 = 3973;
const ADMIN_TOKEN = "herd-harness-admin-token-0123456789abcdef";
const SEATS_PER_ROOM = 6;

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (message: string) => console.log(`[${stamp()}s] ${message}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const ROLLBACK_ENV: Record<string, string> = {
  BOOT_SCHEMA_MODE: "always",
  WS_AUTH_ADMISSION: "off",
  DRAIN_RATE_PER_SECOND: "0",
  VOICE_CATCHUP_CONCURRENCY: "0",
};

// ------------------------------------------------- latency between API and PG

/**
 * A TCP relay that holds every chunk for `delayMs` in each direction, in
 * order. Production's API talks to a managed Postgres about a millisecond
 * away (`/ready`'s `postgres.ms`, median 1 on 2026-09-30); a local socket is
 * a tenth of that, which makes every connection come back to the pool ten
 * times sooner and hides exactly the pile-up this harness is for.
 */
async function startLatencyProxy(
  target: URL,
  delayMs: number,
): Promise<{ port: number; close: () => void }> {
  const net = await import("node:net");
  // Read once: the caller rewrites its URL to point at this proxy afterwards.
  const targetPort = Number(target.port || 5432);
  const targetHost = target.hostname;
  const server = net.createServer((inbound) => {
    const outbound = net.connect(targetPort, targetHost);
    const relay = (from: import("node:net").Socket, to: import("node:net").Socket) => {
      from.on("data", (chunk) => {
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, delayMs);
      });
      from.on("close", () => setTimeout(() => to.destroy(), delayMs));
      from.on("error", () => to.destroy());
    };
    relay(inbound, outbound);
    relay(outbound, inbound);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address() as import("node:net").AddressInfo;
  return { port: address.port, close: () => server.close() };
}

const PG_LATENCY_MS = Number(process.env.HERD_PG_LATENCY_MS ?? 1);

// ------------------------------------------------------------------ helpers

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!);
      }
    }),
  );
}

interface Api {
  name: string;
  child: ChildProcess;
  port: number;
  startedAt: number;
  listeningAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  lines: string[];
}

function startApi(
  name: string,
  port: number,
  databaseUrl: string,
  extraEnv: Record<string, string>,
): Api {
  const child = spawn("node", ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      PORT: String(port),
      // The bypass signs anybody in: never on an interface the LAN can reach.
      LISTEN_HOST: "127.0.0.1",
      DATABASE_URL: databaseUrl,
      DEV_AUTH_BYPASS: "true",
      DEV_SEED: "false",
      VOICE_REGISTRY: "postgres",
      CLUSTER_BUS: "postgres",
      PG_POOL_MAX: "22",
      WORKER_MODE: "api",
      ADMIN_METRICS_TOKEN: ADMIN_TOKEN,
      CLERK_SECRET_KEY: "sk_test_dummy",
      // One address drives every client here; keep the address backstops
      // out of the measurement (docs/STAGING.md).
      RATE_LIMIT_SOCKET_CAPACITY: "1000000",
      RATE_LIMIT_SOCKET_REFILL: "1000000",
      RATE_LIMIT_ANON_CAPACITY: "1000000",
      RATE_LIMIT_ANON_REFILL: "1000000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const api: Api = {
    name,
    child,
    port,
    startedAt: Date.now(),
    listeningAt: null,
    exitedAt: null,
    exitCode: null,
    lines: [],
  };
  // A chunk can end mid-line: keep the tail until its newline arrives, per
  // stream, so a log line is never counted (or missed) in two halves.
  const pending = { out: "", err: "" };
  const onData = (which: "out" | "err") => (chunk: Buffer) => {
    const text = pending[which] + chunk.toString();
    const parts = text.split("\n");
    pending[which] = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      api.lines.push(`${Date.now()} ${line}`);
      if (line.includes("server listening")) api.listeningAt = Date.now();
      if (/deadlock|Failed to start|breaker\.stateChange|schemaRetry|schemaApplied|schemaSkipped|drainPlan|ws\.drained/.test(line)) {
        console.log(`[${stamp()}s]   ${name}| ${line.slice(0, 240)}`);
      }
    }
  };
  child.stdout!.on("data", onData("out"));
  child.stderr!.on("data", onData("err"));
  child.on("exit", (code) => {
    api.exitedAt = Date.now();
    api.exitCode = code;
  });
  return api;
}

function stopApi(api: Api, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  return new Promise((done) => {
    if (api.exitedAt !== null) return done();
    api.child.once("exit", () => done());
    api.child.kill(signal);
    setTimeout(() => api.child.kill("SIGKILL"), 70_000).unref();
  });
}

async function waitHealthy(api: Api, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (api.exitedAt !== null) {
      throw new Error(`${api.name} exited (${api.exitCode}) before it was healthy`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${api.port}/health`);
      if (response.ok) return;
    } catch {
      // not yet
    }
    await sleep(100);
  }
  throw new Error(`${api.name} never became healthy`);
}

async function http<T>(port: number, path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const tokenOf = (index: number) => `dev-local-token:herd${index}`;

// ------------------------------------------------------------------ clients

interface Client {
  index: number;
  token: string;
  textChannelId: string;
  voiceChannelId: string | null;
  ws: WebSocket | null;
  peerId: string | null;
  resumeToken: string | null;
  // herd measurements
  closedAt: number | null;
  closeCode: number | null;
  reopenedAt: number | null;
  readyAt: number | null;
  welcomeAt: number | null;
  resumed: boolean | null;
  messagesMs: number | null;
  errors: string[];
}

function connect(client: Client, port: number, onReady?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    client.ws = ws;
    let settled = false;
    // Bounded: a join refused without a `welcome` must not stall the run.
    const timer = setTimeout(() => finish(new Error("no ready/welcome within 20 s")), 20_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: client.token, caps: ["mesh-resume"] }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") {
        onReady?.();
        ws.send(JSON.stringify({ type: "join-channel", channelId: client.textChannelId }));
        if (client.voiceChannelId) {
          ws.send(
            JSON.stringify({
              type: "join-voice-room",
              voiceChannelId: client.voiceChannelId,
              transports: ["mesh", "livekit"],
              resume: true,
              ...(client.peerId && client.resumeToken
                ? { resumePeerId: client.peerId, resumeToken: client.resumeToken }
                : {}),
            }),
          );
        } else {
          finish();
        }
      } else if (message.type === "welcome") {
        const previous = client.peerId;
        client.resumed = previous !== null ? message.peerId === previous : null;
        client.peerId = message.peerId;
        client.resumeToken = message.resumeToken ?? client.resumeToken;
        if (client.reopenedAt !== null && client.welcomeAt === null) {
          client.welcomeAt = Date.now();
        }
        finish();
      } else if (message.type === "error" || message.type === "voice-error") {
        const reason = String(message.message ?? message.code ?? message.reason ?? "error");
        client.errors.push(reason);
        finish(new Error(`refused: ${reason}`));
      }
    };
    ws.onclose = (event) => {
      client.closedAt = Date.now();
      client.closeCode = event.code;
      finish(new Error(`closed ${event.code} before settling`));
    };
    ws.onerror = () => {
      // onclose follows
    };
  });
}

// -------------------------------------------------------------------- run

interface RunResult {
  mode: string;
  sockets: number;
  reconnected: number;
  resumedSeats: number;
  seated: number;
  timeToReadyMs: { p50: number; p95: number; max: number };
  timeToWelcomeMs: { p50: number; p95: number; max: number };
  messagesGetMs: { p50: number; p95: number; max: number };
  poolPeakBusy: number;
  poolPeakWaiting: number;
  poolMax: number;
  poolWait: unknown;
  wsAuth: unknown;
  deadlocksA: number;
  deadlocksB2: number;
  breakerFlipsA: number;
  b2BootMs: number | null;
  b2Booted: boolean;
  b2FailedStarts: number;
  clientErrors: number;
}

/**
 * `HERD_EXTRA_ENV="BOOT_SCHEMA_MODE=always,WS_AUTH_ADMISSION=off"` lays extra
 * variables over BOTH modes, for an ablation (which fix buys what).
 */
function extraEnvFromArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env.HERD_EXTRA_ENV ?? "").split(",")) {
    const [key, ...rest] = pair.split("=");
    if (key && key.trim() && rest.length > 0) out[key.trim()] = rest.join("=").trim();
  }
  return out;
}

async function runOnce(mode: "before" | "after"): Promise<RunResult> {
  const extraEnv = { ...(mode === "before" ? ROLLBACK_ENV : {}), ...extraEnvFromArgs() };
  const dbName = `pqp_herd_${mode}_${process.pid}`;
  const adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${dbName}`);
  await adminClient.end();
  const dbUrl = new URL(ADMIN_URL!);
  dbUrl.pathname = `/${dbName}`;
  const apis: Api[] = [];
  const clients: Client[] = [];
  // Set before cleanup kills B, so B's exit handler does not start a B2
  // nobody will stop.
  let stopping = false;
  let proxy: { port: number; close: () => void } | null = null;

  try {
    proxy = PG_LATENCY_MS > 0 ? await startLatencyProxy(dbUrl, PG_LATENCY_MS) : null;
    if (proxy) {
      dbUrl.hostname = "127.0.0.1";
      dbUrl.port = String(proxy.port);
    }
    const databaseUrl = dbUrl.toString();
    log(`== ${mode}: ${SOCKETS} sockets, ${SERVERS} servers x ${VOICE_PER_SERVER} voice rooms`);
    let apiA = startApi("A", PORT_A, databaseUrl, extraEnv);
    apis.push(apiA);
    await waitHealthy(apiA);
    const apiB = startApi("B", PORT_B, databaseUrl, extraEnv);
    apis.push(apiB);
    await waitHealthy(apiB);

    // ---- seed, through A's real HTTP API
    const ageCheck = (token: string) =>
      http(PORT_A, "/api/me/age-check", token, {
        method: "POST",
        body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
      }).catch(() => {});
    const textChannels: string[] = [];
    const voiceChannels: string[] = [];
    const invites: string[] = [];
    for (let s = 0; s < SERVERS; s += 1) {
      // One owner per server: server creation is rate limited per account.
      const owner = `dev-local-token:herdowner${s}`;
      await ageCheck(owner);
      const created = await http<{
        server: { id: string };
        channels: { id: string; type: string }[];
      }>(PORT_A, "/api/servers", owner, {
        method: "POST",
        body: JSON.stringify({ name: `Herd ${s}` }),
      });
      const serverId = created.server.id;
      textChannels.push(created.channels.find((c) => c.type === "text")!.id);
      const voices = created.channels.filter((c) => c.type === "voice").map((c) => c.id);
      for (let v = voices.length; v < VOICE_PER_SERVER; v += 1) {
        const made = await http<{ channel: { id: string } }>(
          PORT_A,
          `/api/servers/${serverId}/channels`,
          owner,
          { method: "POST", body: JSON.stringify({ name: `sala-${v}`, type: "voice" }) },
        );
        voices.push(made.channel.id);
      }
      voiceChannels.push(...voices.slice(0, VOICE_PER_SERVER));
      const invite = await http<{ invite: { code: string } }>(
        PORT_A,
        `/api/servers/${serverId}/invites`,
        owner,
        { method: "POST", body: JSON.stringify({}) },
      );
      invites.push(invite.invite.code);
    }
    const seatedCount = Math.min(
      Math.floor(SOCKETS * SEATED),
      voiceChannels.length * SEATS_PER_ROOM,
    );
    for (let i = 0; i < SOCKETS; i += 1) {
      clients.push({
        index: i,
        token: tokenOf(i),
        textChannelId: textChannels[i % textChannels.length]!,
        voiceChannelId: i < seatedCount ? voiceChannels[i % voiceChannels.length]! : null,
        ws: null,
        peerId: null,
        resumeToken: null,
        closedAt: null,
        closeCode: null,
        reopenedAt: null,
        readyAt: null,
        welcomeAt: null,
        resumed: null,
        messagesMs: null,
        errors: [],
      });
    }
    await pool(clients, 16, async (client) => {
      await ageCheck(client.token);
      for (const code of invites) {
        await http(PORT_A, `/api/invites/${code}/join`, client.token, {
          method: "POST",
          body: "{}",
        });
      }
    });
    log(`seeded: ${SOCKETS} members of ${SERVERS} servers, ${seatedCount} to be seated in ${voiceChannels.length} rooms`);

    // ---- everybody on B
    await pool(clients, 20, (client) =>
      connect(client, PORT_B).catch((error: Error) => {
        client.errors.push(`setup: ${error.message}`);
      }),
    );
    const seatedOk = clients.filter((c) => c.voiceChannelId && c.peerId).length;
    log(`connected to B: ${clients.length} sockets, ${seatedOk} seated`);
    await sleep(3_000);

    // ---- A is the freshly booted container
    await stopApi(apiA);
    apiA = startApi("A", PORT_A, databaseUrl, extraEnv);
    apis.push(apiA);
    await waitHealthy(apiA);
    await sleep(500);
    log("A restarted (fresh process, fresh peaks)");

    // ---- the deploy moment
    for (const client of clients) {
      const ws = client.ws!;
      ws.onclose = (event) => {
        client.closedAt = Date.now();
        client.closeCode = event.code;
        if (event.code !== 1001) return;
        // The web client's first attempt after a drain-shaped close.
        const jitter = 500 + Math.random() * 3_500;
        setTimeout(() => {
          client.reopenedAt = Date.now();
          connect(client, PORT_A, () => {
            client.readyAt = Date.now();
            // The selected channel's latest page, jittered 0 to 2 s, as
            // App.tsx does after a reconnect.
            setTimeout(() => {
              const started = Date.now();
              http(PORT_A, `/api/channels/${client.textChannelId}/messages?limit=50`, client.token)
                .then(() => {
                  client.messagesMs = Date.now() - started;
                })
                .catch((error: Error) => client.errors.push(`messages: ${error.message}`));
            }, Math.random() * 2_000);
          }).catch((error: Error) => client.errors.push(error.message));
        }, jitter);
      };
    }
    const sigtermAt = Date.now();
    log("SIGTERM B: drain begins");
    let apiB2: Api | null = null;
    apiB.child.once("exit", () => {
      if (stopping) return;
      // compose recreate: the replacement starts once the old one is gone.
      apiB2 = startApi("B2", PORT_B2, databaseUrl, extraEnv);
      apis.push(apiB2);
      log(`B exited after ${Date.now() - sigtermAt} ms; B2 booting (initDb)`);
    });
    apiB.child.kill("SIGTERM");

    // ---- wait for the herd to settle
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const pending = clients.filter(
        (c) => c.closeCode === 1001 && (c.readyAt === null || (c.voiceChannelId && c.welcomeAt === null)),
      ).length;
      const b2Done = apiB2 !== null && ((apiB2 as Api).listeningAt !== null || (apiB2 as Api).exitedAt !== null);
      if (pending === 0 && b2Done && clients.every((c) => c.messagesMs !== null || c.readyAt === null)) {
        break;
      }
      await sleep(250);
    }
    await sleep(1_000);

    const metrics = await http<{
      runtime: {
        peakPoolBusy: number;
        peakPoolWaiting: number;
        pool: { max: number };
        poolWait?: { lastHour: unknown };
        wsAuth?: unknown;
      };
    }>(PORT_A, "/api/admin/metrics", ADMIN_TOKEN);

    const reconnected = clients.filter((c) => c.readyAt !== null);
    const ready = reconnected.map((c) => c.readyAt! - c.reopenedAt!);
    const welcomed = clients.filter((c) => c.welcomeAt !== null);
    const welcome = welcomed.map((c) => c.welcomeAt! - c.reopenedAt!);
    const messages = clients.filter((c) => c.messagesMs !== null).map((c) => c.messagesMs!);
    const count = (api: Api | null, pattern: RegExp) =>
      api ? api.lines.filter((line) => pattern.test(line)).length : 0;
    const b2 = apiB2 as Api | null;
    const summary = (values: number[]) => ({
      p50: Math.round(percentile(values, 50)),
      p95: Math.round(percentile(values, 95)),
      max: Math.round(values.length ? Math.max(...values) : NaN),
    });
    return {
      mode,
      sockets: SOCKETS,
      reconnected: reconnected.length,
      seated: seatedOk,
      resumedSeats: welcomed.filter((c) => c.resumed === true).length,
      timeToReadyMs: summary(ready),
      timeToWelcomeMs: summary(welcome),
      messagesGetMs: summary(messages),
      poolPeakBusy: metrics.runtime.peakPoolBusy,
      poolPeakWaiting: metrics.runtime.peakPoolWaiting,
      poolMax: metrics.runtime.pool.max,
      poolWait: metrics.runtime.poolWait?.lastHour ?? null,
      wsAuth: metrics.runtime.wsAuth ?? null,
      deadlocksA: count(apiA, /deadlock detected/),
      deadlocksB2: count(b2, /deadlock detected/),
      breakerFlipsA: count(apiA, /breaker\.stateChange/),
      b2BootMs: b2 && b2.listeningAt ? b2.listeningAt - b2.startedAt : null,
      b2Booted: !!b2?.listeningAt,
      b2FailedStarts: count(b2, /Failed to start/),
      clientErrors: clients.reduce((sum, c) => sum + c.errors.length, 0),
    };
  } finally {
    stopping = true;
    for (const client of clients) {
      try {
        client.ws?.close();
      } catch {
        // gone
      }
    }
    await Promise.all(apis.map((api) => stopApi(api, "SIGKILL")));
    proxy?.close();
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await cleanup.end();
  }
}

const modes: ("before" | "after")[] =
  MODE === "before" ? ["before"] : MODE === "after" ? ["after"] : ["before", "after"];
const results: RunResult[] = [];
for (const mode of modes) {
  results.push(await runOnce(mode));
  console.log(JSON.stringify(results[results.length - 1], null, 2));
}
if (results.length > 1) {
  const row = (label: string, pick: (r: RunResult) => unknown) =>
    console.log(`${label.padEnd(34)} ${results.map((r) => String(pick(r)).padStart(16)).join(" ")}`);
  console.log(`\n${"".padEnd(34)} ${results.map((r) => r.mode.padStart(16)).join(" ")}`);
  row("pool peak busy / max", (r) => `${r.poolPeakBusy}/${r.poolMax}`);
  row("pool peak waiting", (r) => r.poolPeakWaiting);
  row("pool wait p95 / max ms", (r) => {
    const w = r.poolWait as { p95Ms?: number; maxMs?: number } | null;
    return w ? `${w.p95Ms}/${w.maxMs}` : "n/a";
  });
  row("checkouts waiting > 1 s", (r) => (r.poolWait as { waitedOver1s?: number } | null)?.waitedOver1s ?? "n/a");
  row("socket open -> ready p50/p95/max", (r) => `${r.timeToReadyMs.p50}/${r.timeToReadyMs.p95}/${r.timeToReadyMs.max}`);
  row("open -> voice welcome p50/p95", (r) => `${r.timeToWelcomeMs.p50}/${r.timeToWelcomeMs.p95}`);
  row("messages GET p50/p95 ms", (r) => `${r.messagesGetMs.p50}/${r.messagesGetMs.p95}`);
  row("reconnected / sockets", (r) => `${r.reconnected}/${r.sockets}`);
  row("seats resumed / seated", (r) => `${r.resumedSeats}/${r.seated}`);
  row("deadlocks (A + B2)", (r) => r.deadlocksA + r.deadlocksB2);
  row("breaker flips on A", (r) => r.breakerFlipsA);
  row("B2 boot ms (failed starts)", (r) => `${r.b2BootMs ?? "never"} (${r.b2FailedStarts})`);
  row("client errors", (r) => r.clientErrors);
}
process.exit(0);
