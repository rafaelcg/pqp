/**
 * Fan-out load generator for the realtime layer.
 *
 * Opens N fake clients against a local server running with DEV_AUTH_BYPASS,
 * each a distinct dev user (`dev-local-token:<suffix>`), joins them all to one
 * text channel and one voice room, then generates the traffic a big room
 * produces: messages, typing, mute toggles, voice join/leave churn. While the
 * traffic runs it samples the server's CPU (by pid, through `ps`) and counts
 * every byte and frame the clients receive.
 *
 * It measures the API's signalling cost only. Media is on LiveKit or the mesh
 * and never touches this process, which is exactly why the numbers here are
 * the ones that matter for a 1 vCPU machine hosting a 100-person room.
 *
 *   pnpm --filter @pqp/server exec tsx scripts/load-fanout.ts \
 *     --url http://localhost:3111 --pid <server pid> --n 200 --seconds 30
 *
 * Or let it spawn the server itself (needs a database it may write to):
 *
 *   DATABASE_URL=postgresql://rafael@localhost:5432/pqp_load \
 *     pnpm --filter @pqp/server exec tsx scripts/load-fanout.ts --spawn --n 200
 *
 * Two phases, and the first one is the one 2026-09-05 needed:
 *
 *   --voice <k>  hold every socket out of the room during connect, then send
 *                all k joins at once. That STAMPEDE phase reports time to
 *                join, how many were never welcomed, and what the fan-out
 *                cost per arrival. The remaining sockets are the sidebar
 *                audience: members who see every roster without being in the
 *                call, which is the audience that made the roster expensive.
 *   (steady)     the original phase, unchanged: messages, typing, mute
 *                toggles and voice churn at fixed rates.
 *
 *   pnpm --filter @pqp/server exec tsx scripts/load-fanout.ts --spawn \
 *     --n 200 --voice 150 --seconds 30 --json /tmp/after.json
 *
 * `--caps 0` makes every socket look like a client built before roster deltas
 * existed, so a before/after comparison runs on one binary.
 *
 * `--db <url>` (default `$DATABASE_URL`) reports exact statement counts from
 * `pg_stat_statements` when that extension is installed.
 *
 * `--mode join` is the third phase, and it asks the question the other two
 * cannot: not "what does a room of size N cost" and not "what does one burst
 * of k joins cost", but WHERE IS THE EDGE. It ramps arrivals per second, with
 * every welcomed socket staying in the room, until joins start failing, and it
 * reports the answer as an OCCUPANCY: how many people can already be in a room
 * before the next person's join stops fitting inside their own client's
 * `JOIN_TIMEOUT_MS` (12 s, client/src/hooks/use-voice.ts). Per arrival it
 * records the time to socket open, to `ready` and to `welcome`, plus a
 * terminal outcome bucketed by cause; alongside it samples the connection pool
 * from `GET /api/admin/metrics`, the machine's CPU from `/proc/stat`, and
 * every byte received split by frame type, which is what turns "it got slow"
 * into a frame somebody can go and fix.
 *
 *   set -a; . ~/.config/pqp/staging-load-test.env; set +a
 *   pnpm --filter @pqp/server exec tsx scripts/load-fanout.ts \
 *     --mode join --url https://pqp-api-staging.fly.dev \
 *     --fly-app pqp-api-staging --arrivals 6 --ramp 3 --ramp-every 15
 *
 * `LOAD_TEST_TOKEN` is what makes a HOSTED target possible at all: the dev
 * bypass constant is in this repository, so it can never be switched on for a
 * public hostname. See server/src/auth/load-test.ts.
 *
 * Never point this at a shared database: it creates users and a server. Never
 * point it at production, and never at any deployment whose database cluster
 * is shared with production, because exhausting a shared `max_connections`
 * starves the neighbour. The safety rules and the staging runbook are in
 * `docs/STAGING.md`.
 */
/* eslint-disable no-console -- a CLI report is its stdout */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";

type Mode = "steady" | "join";

interface Options {
  /**
   * `steady` keeps the two phases above (connect, optional stampede, then
   * fixed-rate traffic). `join` replaces them with the arrival ramp.
   */
  mode: Mode;
  url: string;
  n: number;
  seconds: number;
  messagesPerSecond: number;
  typingPerSecond: number;
  togglesPerSecond: number;
  churnPerSecond: number;
  viewsPerSecond: number;
  pid: number | null;
  spawn: boolean;
  port: number;
  prefix: string;
  /** How many of the clients actually join the voice room. The rest are the
   *  sidebar audience: members who can see the channel and are therefore in
   *  every roster fan-out without being in the call. -1 means all of them. */
  voice: number;
  /** A join that has not been welcomed in this long counts as failed. */
  joinTimeoutMs: number;
  /** Negotiate `voice-roster-delta` at auth. 0 measures a client that cannot. */
  caps: boolean;
  /** Write the run's numbers here as JSON, for before/after comparison. */
  json: string;
  /** Postgres URL; enables exact per-statement counts via pg_stat_statements. */
  db: string;
  /**
   * The bearer secret every simulated identity is built from. Locally this is
   * the dev bypass constant; against staging it is `LOAD_TEST_TOKEN`, which is
   * a real secret and therefore comes from the environment, never from a flag
   * that would land in shell history. See server/src/auth/load-test.ts.
   */
  secret: string;
  /** `ADMIN_METRICS_TOKEN` on the target, for the once-a-second pool sample. */
  metricsToken: string;
  /** Fly app to stream `/proc/stat` from, when the target is not local. */
  flyApp: string;
  // --- `--mode join` only ---
  /** Arrivals per second the ramp starts at. */
  arrivals: number;
  /** Added to that rate every `rampEvery` seconds. */
  ramp: number;
  rampEvery: number;
  /** Hard stop, so a healthy server cannot run the ramp forever. */
  maxClients: number;
  /** Share of a 40-arrival window that may fail before the ramp stops. */
  abortFailRate: number;
  /** Seconds to hold after the ramp, so the tail is measured against a full room. */
  holdSeconds: number;
  /** Do the cold-browser HTTP before each arrival. Off isolates the socket. */
  bootstrap: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    mode: "steady",
    url: "",
    n: 200,
    seconds: 30,
    messagesPerSecond: 5,
    typingPerSecond: 40,
    togglesPerSecond: 20,
    churnPerSecond: 4,
    viewsPerSecond: 4,
    pid: null,
    spawn: false,
    port: 3111,
    prefix: `load${Date.now().toString(36).slice(-4)}`,
    voice: -1,
    joinTimeoutMs: 45_000,
    caps: true,
    json: "",
    db: process.env.DATABASE_URL ?? "",
    secret: process.env.LOAD_TEST_TOKEN || DEV_TOKEN,
    metricsToken: process.env.ADMIN_METRICS_TOKEN ?? "",
    flyApp: "",
    arrivals: 6,
    ramp: 3,
    rampEvery: 15,
    maxClients: 1500,
    abortFailRate: 0.3,
    holdSeconds: 20,
    bootstrap: true,
  };
  let joinTimeoutGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? "";
    switch (arg) {
      case "--url":
        opts.url = next();
        break;
      case "--n":
        opts.n = Number(next());
        break;
      case "--seconds":
        opts.seconds = Number(next());
        break;
      case "--msgs":
        opts.messagesPerSecond = Number(next());
        break;
      case "--typing":
        opts.typingPerSecond = Number(next());
        break;
      case "--toggles":
        opts.togglesPerSecond = Number(next());
        break;
      case "--churn":
        opts.churnPerSecond = Number(next());
        break;
      case "--views":
        opts.viewsPerSecond = Number(next());
        break;
      case "--pid":
        opts.pid = Number(next());
        break;
      case "--spawn":
        opts.spawn = true;
        break;
      case "--port":
        opts.port = Number(next());
        break;
      case "--prefix":
        opts.prefix = next();
        break;
      case "--voice":
        opts.voice = Number(next());
        break;
      case "--join-timeout":
        opts.joinTimeoutMs = Number(next());
        joinTimeoutGiven = true;
        break;
      case "--mode": {
        const mode = next();
        if (mode !== "steady" && mode !== "join") {
          throw new Error(`--mode must be steady or join, got ${mode}`);
        }
        opts.mode = mode;
        break;
      }
      case "--fly-app":
        opts.flyApp = next();
        break;
      case "--arrivals":
        opts.arrivals = Number(next());
        break;
      case "--ramp":
        opts.ramp = Number(next());
        break;
      case "--ramp-every":
        opts.rampEvery = Number(next());
        break;
      case "--max-clients":
        opts.maxClients = Number(next());
        break;
      case "--abort-fail-rate":
        opts.abortFailRate = Number(next());
        break;
      case "--hold":
        opts.holdSeconds = Number(next());
        break;
      case "--no-bootstrap":
        opts.bootstrap = false;
        break;
      case "--caps":
        opts.caps = next() !== "0";
        break;
      case "--json":
        opts.json = next();
        break;
      case "--db":
        opts.db = next();
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!opts.url) {
    opts.url = `http://localhost:${opts.port}`;
  }
  // THE TWO PHASES MEAN DIFFERENT THINGS BY "join timeout" and the default has
  // to follow. The stampede's 45 s is `SFU_JOIN_TIMEOUT_MS`: welcome plus media
  // on an SFU room. The ramp measures signalling alone and is scored against
  // `JOIN_TIMEOUT_MS`, the 12 s the browser gives the handshake, because that
  // is the budget whose expiry is what the person actually experiences. An
  // explicit `--join-timeout` still wins in both.
  if (opts.mode === "join" && !joinTimeoutGiven) {
    opts.joinTimeoutMs = CLIENT_JOIN_TIMEOUT_MS;
  }
  return opts;
}

const DEV_TOKEN = "dev-local-token";

/**
 * `JOIN_TIMEOUT_MS` in client/src/hooks/use-voice.ts: the browser's own budget
 * for WebSocket handshake through `welcome`.
 *
 * THE CEILING `--mode join` REPORTS IS DEFINED BY THIS NUMBER. A join that
 * takes longer has already failed for the person doing it, however healthy the
 * server still looks from outside. Keep the two in step.
 */
const CLIENT_JOIN_TIMEOUT_MS = 12_000;

/**
 * The secret every simulated identity is built from, set once by `main`.
 *
 * Module-level rather than threaded through every helper because it is a
 * property of the run, not of any one client. Locally it is the dev bypass
 * constant and nothing changes; against staging it is `LOAD_TEST_TOKEN`.
 */
let authSecret = DEV_TOKEN;

/** `<secret>:<suffix>`: one throwaway account per suffix, on either path. */
function identityToken(suffix: string): string {
  return `${authSecret}:${suffix}`;
}

/**
 * A stable, distinct client address per simulated user.
 *
 * The pre-auth limiter in `lib/rate-limit.ts` is keyed on the client address,
 * and every socket here comes from 127.0.0.1, so without this the harness
 * measures that one bucket instead of the server. Only honoured when the
 * target sets `TRUST_PROXY` (the spawned server does); against anything that
 * does not, the header is ignored and the pacing below is what keeps the run
 * inside the limit.
 */
function forgedAddress(token: string): string {
  let hash = 0;
  for (const char of token) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `10.${(hash >> 16) & 0xff}.${(hash >> 8) & 0xff}.${(hash & 0xff) || 1}`;
}

async function api<T>(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Forwarded-For": forgedAddress(token),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function passGates(base: string, token: string): Promise<void> {
  const me = await api<{ ageGate?: string }>(base, token, "GET", "/api/me");
  if (me.ageGate !== "passed") {
    await fetch(`${base}/api/me/age-check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Forwarded-For": forgedAddress(token),
      },
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
}

interface Setup {
  /** Needed by the cold bootstrap, which fetches the server's own endpoints. */
  serverId: string;
  textChannelId: string;
  voiceChannelId: string;
  inviteCode: string;
}

async function setupServer(base: string, prefix: string): Promise<Setup> {
  const owner = identityToken(`${prefix}-owner`);
  await passGates(base, owner);
  const created = await api<{
    server: { id: string };
    channels: Array<{ id: string; type: string }>;
  }>(base, owner, "POST", "/api/servers", { name: `Load ${prefix}` });
  const serverId = created.server.id;
  let channels = created.channels ?? [];
  if (channels.length === 0) {
    channels = (
      await api<{ channels: Array<{ id: string; type: string }> }>(
        base,
        owner,
        "GET",
        `/api/servers/${serverId}/channels`,
      )
    ).channels;
  }
  const text = channels.find((c) => c.type === "text");
  const voice = channels.find((c) => c.type === "voice");
  if (!text || !voice) {
    throw new Error("server has no text + voice channel to load");
  }
  // The transport policy keeps a small server on the mesh, which caps the room
  // at MESH_VOICE_LIMIT peers. Pin the channel to LiveKit so the whole load
  // can sit in one room, which is the shape that hurt in production.
  await api(base, owner, "PATCH", `/api/channels/${voice.id}`, {
    voiceTransport: "livekit",
  });
  const invite = await api<{ invite: { code: string } }>(
    base,
    owner,
    "POST",
    `/api/servers/${serverId}/invites`,
    {},
  );
  return {
    serverId,
    textChannelId: text.id,
    voiceChannelId: voice.id,
    inviteCode: invite.invite.code,
  };
}

interface Client {
  index: number;
  token: string;
  socket: WebSocket;
  bytes: number;
  frames: number;
  byType: Map<string, number>;
  bytesByType: Map<string, number>;
  inVoice: boolean;
  muted: boolean;
  /** When `join-voice-room` was sent, for the time-to-join measurement. */
  joinSentAt: number;
  /** ms from that frame to `welcome`, or null while still waiting. */
  joinMs: number | null;
  /** Set when the server refused the join outright rather than timing out. */
  joinRefused: string | null;
  /** peerId -> participant, as this socket believes the room to be. */
  belief: Map<string, { peerId: string }>;
  /** Last roster sequence applied, so a gap is detectable. */
  rosterSeq: number;
  /** How many times this socket saw a gap or a size mismatch. */
  desynced: number;
}

// `Set<number>` on purpose: `readyState` is typed `0 | 1 | 2 | 3` and an
// inferred `Set<2 | 3>` refuses to be asked about the other two.
const TERMINAL_STATES = new Set<number>([
  WebSocket.CLOSING,
  WebSocket.CLOSED,
]);

function sendFrame(client: Client, frame: unknown): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(frame));
  }
}

/**
 * The frames a real arrival sends before it can be in a call, in the order the
 * SPA sends them. Not decoration: the 2026-09-05 plateau was arrivals, and an
 * arrival is a cold browser doing its bootstrap against the same pool the join
 * needs. Measuring only the WebSocket join measures something much cheaper
 * than a person clicking a voice channel from a link.
 */
async function spaBootstrap(base: string, token: string): Promise<void> {
  await Promise.all([
    api(base, token, "GET", "/api/me"),
    api(base, token, "GET", "/api/servers"),
    api(base, token, "GET", "/api/friends"),
    api(base, token, "GET", "/api/dms"),
  ]);
}

async function connectClient(
  base: string,
  wsUrl: string,
  index: number,
  prefix: string,
  setup: Setup,
  caps: boolean,
  joinVoice: boolean,
): Promise<Client> {
  const token = identityToken(`${prefix}-${index}`);
  await passGates(base, token);
  await api(base, token, "POST", `/api/invites/${setup.inviteCode}/join`);
  await spaBootstrap(base, token);

  const socket = new WebSocket(wsUrl);
  const client: Client = {
    index,
    token,
    socket,
    bytes: 0,
    frames: 0,
    byType: new Map(),
    bytesByType: new Map(),
    inVoice: false,
    muted: false,
    joinSentAt: 0,
    joinMs: null,
    joinRefused: null,
    belief: new Map(),
    rosterSeq: 0,
    desynced: 0,
  };

  const ready = new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("ready timeout")), 15_000);
    socket.on("message", (data) => {
      const text = String(data);
      client.bytes += text.length;
      client.frames += 1;
      const type = /"type":"([^"]+)"/.exec(text)?.[1] ?? "?";
      client.byType.set(type, (client.byType.get(type) ?? 0) + 1);
      client.bytesByType.set(
        type,
        (client.bytesByType.get(type) ?? 0) + text.length,
      );
      if (type === "ready") {
        clearTimeout(timer);
        resolveReady();
        return;
      }
      if (type === "welcome") {
        client.inVoice = true;
        if (client.joinSentAt && client.joinMs === null) {
          client.joinMs = Date.now() - client.joinSentAt;
        }
        return;
      }
      if (type === "voice-room-full" || type === "voice-transport-unsupported") {
        client.joinRefused = type;
        return;
      }
      if (type !== "voice-roster" && type !== "voice-roster-delta") {
        return;
      }
      // The roster half. Applied exactly the way the real client applies it,
      // including the gap rule, so "every socket converged" cannot pass
      // vacuously: a harness that ignored `seq` would agree with a server that
      // had silently stopped sending anything.
      let frame: {
        type: string;
        voiceChannelId?: string;
        participants?: { peerId: string }[];
        joined?: { peerId: string }[];
        updated?: { peerId: string }[];
        left?: string[];
        seq?: number;
        size?: number;
      };
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame.voiceChannelId !== setup.voiceChannelId) {
        return;
      }
      if (frame.type === "voice-roster") {
        client.belief = new Map(
          (frame.participants ?? []).map((p) => [p.peerId, p]),
        );
        client.rosterSeq = frame.seq ?? 0;
        return;
      }
      if (frame.seq !== client.rosterSeq + 1) {
        client.desynced += 1;
        return;
      }
      for (const peer of frame.joined ?? []) client.belief.set(peer.peerId, peer);
      for (const peer of frame.updated ?? []) client.belief.set(peer.peerId, peer);
      for (const peerId of frame.left ?? []) client.belief.delete(peerId);
      client.rosterSeq = frame.seq;
      if (typeof frame.size === "number" && frame.size !== client.belief.size) {
        client.desynced += 1;
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      client.inVoice = false;
    });
  });

  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "auth",
      token,
      // Per-socket capability negotiation, exactly as the SPA does it. With
      // `--caps 0` this socket is an old build and keeps receiving whole
      // rosters, which is what makes a before/after run possible on one binary.
      ...(caps ? { caps: ["voice-roster-delta"] } : {}),
    }),
  );
  await ready;
  sendFrame(client, { type: "join-channel", channelId: setup.textChannelId });
  if (joinVoice) {
    joinRoom(client, setup);
  }
  return client;
}

function joinRoom(client: Client, setup: Setup): void {
  client.joinSentAt = Date.now();
  client.joinMs = null;
  sendFrame(client, {
    type: "join-voice-room",
    voiceChannelId: setup.voiceChannelId,
    transports: ["mesh", "livekit"],
    resume: true,
  });
}

/**
 * The pid and every descendant. `pnpm exec tsx` is a wrapper around a wrapper
 * around the node process that does the work, so sampling one pid reads 0.
 */
function processTree(pid: number): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  });
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined) {
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i += 1) {
    tree.push(...(children.get(tree[i]!) ?? []));
  }
  return tree;
}

function parseCpuTime(raw: string): number {
  // "MM:SS.ss" or "HH:MM:SS"
  let seconds = 0;
  for (const part of raw.trim().split(":").map(Number)) {
    seconds = seconds * 60 + part;
  }
  return seconds;
}

/** Cumulative CPU seconds of a process tree, as macOS and Linux `ps` report it. */
function cpuSeconds(pid: number): number {
  const pids = processTree(pid);
  const out = execFileSync("ps", ["-o", "cputime=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((line) => line.trim())
    .reduce((sum, line) => sum + parseCpuTime(line), 0);
}

function rssMb(pid: number): number {
  const pids = processTree(pid);
  const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  const largest = Math.max(
    ...out
      .split("\n")
      .filter((line) => line.trim())
      .map(Number),
  );
  return largest / 1024;
}

function spawnServer(port: number): ChildProcess {
  const serverDir = resolve(import.meta.dirname, "..");
  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DEV_AUTH_BYPASS: "true",
      DEV_SEED: "false",
      NODE_ENV: "development",
      // So the forged per-user X-Forwarded-For above is honoured and the
      // address-keyed limiter does not become the thing being measured.
      TRUST_PROXY: "true",
      // A LiveKit room is what a 100-person call runs on; the mesh caps at a
      // handful of peers. Joining never contacts LiveKit (only token minting
      // and eviction do), so placeholder values are enough for signalling.
      LIVEKIT_URL: process.env.LIVEKIT_URL ?? "wss://livekit.invalid",
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? "load",
      LIVEKIT_API_SECRET:
        process.env.LIVEKIT_API_SECRET ?? "load-secret-load-secret-load-secret",
      // The per-user write budget is sized for a human, not for a script
      // joining 200 accounts in a few seconds.
      RATE_LIMIT_API_CAPACITY: "100000",
      RATE_LIMIT_API_REFILL: "10000",
      RATE_LIMIT_WRITE_CAPACITY: "100000",
      RATE_LIMIT_WRITE_REFILL: "10000",
      // The two ADDRESS-keyed backstops. `forgedAddress` spreads the harness
      // across buckets where the target honours X-Forwarded-For, but a hosted
      // target behind fly-proxy overwrites it, so the ramp needs these too or
      // it measures the limiter. Defaults live in the server; see the notes on
      // `anonLimiter` (api/index.ts) and `socketLimiter` (ws/index.ts).
      RATE_LIMIT_ANON_CAPACITY: "100000",
      RATE_LIMIT_ANON_REFILL: "10000",
      RATE_LIMIT_SOCKET_CAPACITY: "100000",
      RATE_LIMIT_SOCKET_REFILL: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    if (/listening|error|Error/i.test(line)) {
      process.stdout.write(`[server] ${line}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`);
  });
  return child;
}

/**
 * Statements Postgres has executed on this database, from
 * `pg_stat_statements`. Exact, unlike counting committed transactions, which
 * folds in every pooled connection's own chatter. NaN when the extension is
 * not installed, which is the ordinary case and only costs the report a line:
 *
 *   ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
 *   -- restart Postgres, then, in the load database:
 *   CREATE EXTENSION pg_stat_statements;
 */
function statementsExecuted(dbUrl: string): number {
  if (!dbUrl) {
    return Number.NaN;
  }
  try {
    return Number(
      execFileSync(
        "psql",
        [dbUrl, "-tAc", "SELECT COALESCE(sum(calls), 0) FROM pg_stat_statements"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim(),
    );
  } catch {
    return Number.NaN;
  }
}

interface StampedeReport {
  joiners: number;
  welcomed: number;
  refused: number;
  timedOut: number;
  elapsedSeconds: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  frames: number;
  bytes: number;
  framesPerJoin: number;
  bytesPerJoin: number;
  cpuSeconds: number;
  statementsPerJoin: number;
  byType: { type: string; frames: number; bytes: number }[];
  convergence: {
    expectedRoomSize: number;
    socketsHoldingIt: number;
    sockets: number;
    socketsThatSawAGap: number;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * THE STAMPEDE. Everyone taps the voice channel at once, which is what a
 * streamer saying "entra aí" produces and what 2026-09-05 actually was: 552
 * unique participants in 41 minutes for a room that held about 90, because
 * arrivals that missed the client's own give-up timer retried and became more
 * arrivals. Time-to-join is therefore the number that matters, not throughput.
 */
async function runStampede(
  joiners: Client[],
  everySocket: Client[],
  setup: Setup,
  opts: Options,
  pid: number | null,
): Promise<StampedeReport> {
  for (const client of everySocket) {
    client.bytes = 0;
    client.frames = 0;
    client.byType.clear();
    client.bytesByType.clear();
  }
  const cpuStart = pid ? cpuSeconds(pid) : 0;
  const statementsStart = statementsExecuted(opts.db);
  const started = Date.now();

  console.log(`stampede: ${joiners.length} joins at once`);
  for (const client of joiners) {
    joinRoom(client, setup);
  }

  const deadline = started + opts.joinTimeoutMs;
  const settled = () =>
    joiners.filter((c) => c.joinMs !== null || c.joinRefused).length;
  while (settled() < joiners.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const elapsedSeconds = (Date.now() - started) / 1000;
  // Let the last coalesced roster land before the fan-out is counted.
  await new Promise((r) => setTimeout(r, 3_000));

  const cpuUsed = pid ? cpuSeconds(pid) - cpuStart : Number.NaN;
  const statements = statementsExecuted(opts.db) - statementsStart;
  const welcomed = joiners.filter((c) => c.joinMs !== null).length;
  const refused = joiners.filter((c) => c.joinRefused).length;
  const timedOut = joiners.length - welcomed - refused;

  let frames = 0;
  let bytes = 0;
  const byType = new Map<string, { frames: number; bytes: number }>();
  for (const client of everySocket) {
    frames += client.frames;
    bytes += client.bytes;
    for (const [type, count] of client.byType) {
      const row = byType.get(type) ?? { frames: 0, bytes: 0 };
      row.frames += count;
      row.bytes += client.bytesByType.get(type) ?? 0;
      byType.set(type, row);
    }
  }

  const sorted = joiners
    .map((c) => c.joinMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  const holding = everySocket.filter((c) => c.belief.size === welcomed).length;

  return {
    joiners: joiners.length,
    welcomed,
    refused,
    timedOut,
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    frames,
    bytes,
    framesPerJoin: welcomed ? Math.round(frames / welcomed) : 0,
    bytesPerJoin: welcomed ? Math.round(bytes / welcomed) : 0,
    cpuSeconds: Number(cpuUsed.toFixed(2)),
    statementsPerJoin: welcomed
      ? Number((statements / welcomed).toFixed(1))
      : Number.NaN,
    byType: [...byType]
      .map(([type, row]) => ({ type, ...row }))
      .sort((a, b) => b.bytes - a.bytes),
    convergence: {
      expectedRoomSize: welcomed,
      socketsHoldingIt: holding,
      sockets: everySocket.length,
      socketsThatSawAGap: everySocket.filter((c) => c.desynced > 0).length,
    },
  };
}

async function waitForServer(base: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${authSecret}` },
      });
      if (res.status < 500) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${base} did not come up`);
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

// ------------------------------------------------ join storm (--mode join)
//
// The arrival test. Everything below exists to answer one question with a
// number: how many people can already be in a room before the next person's
// join takes longer than their own client is willing to wait.

/**
 * Every byte and frame the whole run received, counted across all sockets.
 *
 * WHY THIS IS PART OF THE INSTRUMENT AND NOT A CURIOSITY. Voice signalling is
 * fan-out: one person joining a room of N causes N `peer-joined` frames, so
 * arrivals cost O(N) each and a filling room costs O(N^2) in total. Spread
 * over N households that is nothing; concentrated on the one link the harness
 * runs over it is the first thing to run out, and it presents as slow
 * handshakes with an idle server, which is indistinguishable from a server
 * problem unless the bytes are counted. Compare the peak rate here against the
 * DOWNLINK of the machine running the harness before believing any latency.
 */
const wire = { bytes: 0, frames: 0 };

/**
 * The same totals split by frame type, which is what turns "the link filled
 * up" into a thing somebody can fix. A signalling frame should be a few
 * hundred bytes; a type averaging tens of kilobytes is a whole-collection
 * re-send, and the bytes column names it.
 */
const wireByType = new Map<string, { bytes: number; frames: number }>();

function noteFrame(type: string, bytes: number): void {
  wire.bytes += bytes;
  wire.frames += 1;
  const row = wireByType.get(type) ?? { bytes: 0, frames: 0 };
  row.bytes += bytes;
  row.frames += 1;
  wireByType.set(type, row);
}


/**
 * What ended one simulated person's attempt to get into the room.
 *
 * Bucketed by CAUSE rather than by success/failure, because the causes want
 * completely different fixes and a run that reports "37 failed" tells you
 * nothing about which one you have. `timeout` is deliberately the residual
 * bucket, and it is also the one the server can produce silently: a cold join
 * that `handleVoiceMessage` refuses (no channel access, a timeout sanction, a
 * character account) sends NOTHING back unless the client asked to resume, so
 * from out here a refusal and an overloaded server look identical. On a rig
 * whose accounts are all freshly invited members that ambiguity does not
 * arise, which is why the harness invites them rather than reusing accounts.
 */
type Outcome =
  | "welcome"
  | "transport-refused"
  | "join-refused"
  | "room-full"
  | "timeout"
  | `closed:${number}`
  | `http:${number}`
  | "error";

/**
 * A usable one-line reason from whatever was thrown.
 *
 * `String(error)` on a Node connect failure is the word "AggregateError" and
 * nothing else. The actual `ECONNRESET` / `EMFILE` / `ETIMEDOUT` is one level
 * down in `.errors`, and without it a run that failed on the harness's own
 * file-descriptor limit is indistinguishable from one that failed because the
 * server stopped accepting connections. Those want opposite responses.
 */
function describeError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error).slice(0, 120);
  }
  const shaped = error as {
    errors?: unknown[];
    code?: string;
    message?: string;
  };
  if (Array.isArray(shaped.errors) && shaped.errors.length > 0) {
    const codes = new Set(
      shaped.errors.map((inner) => {
        const e = inner as { code?: string; message?: string };
        return e.code ?? e.message ?? String(inner);
      }),
    );
    return `${shaped.message ?? "AggregateError"} [${[...codes].join(", ")}]`.slice(
      0,
      160,
    );
  }
  return `${shaped.code ? `${shaped.code} ` : ""}${shaped.message ?? String(error)}`.slice(
    0,
    160,
  );
}

interface Arrival {
  index: number;
  /** Room occupancy the instant this person started arriving. */
  occupancyAtStart: number;
  /**
   * The cold-browser HTTP, measured from the start of the attempt. Its own
   * clock because it happens BEFORE the browser arms any join timer.
   */
  bootstrapMs: number | null;
  /**
   * Milliseconds from the moment the WebSocket is created. Null never happened.
   *
   * THE ZERO MATTERS. `JOIN_TIMEOUT_MS` starts when the client opens the
   * socket, not when the tab started loading, so timing these from the top of
   * the attempt would charge the join budget for the page load and report a
   * ceiling far below the real one.
   */
  openMs: number | null;
  readyMs: number | null;
  welcomeMs: number | null;
  /** `POST /api/voice/token`, the SFU mint a real client does after welcome. */
  tokenMs: number | null;
  outcome: Outcome;
  detail: string;
  socket: WebSocket | null;
}

/**
 * The HTTP a REAL cold browser does before and around a voice join, in the
 * order client/src/App.tsx does it.
 *
 * THIS IS WHERE THE POOL PRESSURE LIVES, and leaving it out is what makes a
 * WebSocket-only harness cheerful and wrong: the socket costs one checkout,
 * while this sequence costs roughly a hundred, so a run that skips it measures
 * a machine that no browser has ever talked to. Traced from `App.tsx`'s
 * bootstrap effect (~2004), `loadChannels` (~2759), `openChannel` (~1811) and
 * `handleJoinVoice` (~3071).
 *
 * Failures are swallowed on purpose except for the status, which is returned:
 * a 429 or a 503 here is a result, not a reason to stop.
 */
async function coldBootstrap(
  base: string,
  token: string,
  setup: Setup,
): Promise<number | null> {
  let firstBadStatus: number | null = null;
  const get = async (path: string, method = "GET"): Promise<void> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Forwarded-For": forgedAddress(token),
        },
        body: method === "POST" ? "{}" : undefined,
      });
      if (!res.ok && firstBadStatus === null) {
        firstBadStatus = res.status;
      }
      // Drain: an unread body keeps the socket busy and skews the next timing.
      await res.arrayBuffer();
    } catch {
      firstBadStatus ??= 0;
    }
  };
  const all = (...paths: string[]) => Promise.all(paths.map((p) => get(p)));

  // App mount. `/api/me` gates everything after it, so it is awaited alone.
  await get("/api/me");
  await all("/api/ice-servers", "/api/voice/backend");
  await all("/api/servers", "/api/community-home/config");
  await all(
    "/api/dms",
    "/api/blocks",
    "/api/attachments/config",
    "/api/communities/config",
    "/api/friends",
    "/api/me/depoimentos/pending",
  );
  // Server selected.
  await all(
    `/api/servers/${setup.serverId}/channels`,
    `/api/servers/${setup.serverId}/unread`,
  );
  await all(
    `/api/servers/${setup.serverId}/members`,
    `/api/servers/${setup.serverId}/roles`,
    `/api/servers/${setup.serverId}/permissions`,
  );
  // The voice channel is opened like any other channel before the join.
  await all(`/api/channels/${setup.voiceChannelId}/messages`, "/api/gifs/config");
  await get(`/api/channels/${setup.voiceChannelId}/read`, "POST");
  // Clicking join refetches ICE for TURN rotation, every time.
  await get("/api/ice-servers");
  return firstBadStatus;
}

/**
 * One person arriving: bootstrap, socket, auth, join text, join voice, mint an
 * SFU token. Resolves when the attempt reaches a terminal outcome; the socket
 * is left OPEN on success, because the next arrival has to find them in the
 * room.
 */
async function arrive(
  base: string,
  wsUrl: string,
  index: number,
  prefix: string,
  setup: Setup,
  opts: Options,
  occupancy: () => number,
): Promise<Arrival> {
  const token = identityToken(`${prefix}-${index}`);
  const startedAt = Date.now();
  const since = () => Date.now() - startedAt;
  const arrival: Arrival = {
    index,
    occupancyAtStart: occupancy(),
    bootstrapMs: null,
    openMs: null,
    readyMs: null,
    welcomeMs: null,
    tokenMs: null,
    outcome: "timeout",
    detail: "",
    socket: null,
  };

  try {
    await passGates(base, token);
    await api(base, token, "POST", `/api/invites/${setup.inviteCode}/join`);
  } catch (error) {
    arrival.outcome = "error";
    arrival.detail = `join: ${describeError(error)}`;
    return arrival;
  }

  if (opts.bootstrap) {
    const bad = await coldBootstrap(base, token, setup);
    arrival.bootstrapMs = since();
    if (bad !== null && bad >= 400) {
      arrival.outcome = `http:${bad}`;
      arrival.detail = "cold bootstrap";
      return arrival;
    }
  }

  // The join clock starts here, with the socket, exactly where the browser's
  // own `armJoinTimeout` starts it.
  const socketStart = Date.now();
  const sinceSocket = () => Date.now() - socketStart;
  const socket = new WebSocket(wsUrl);
  arrival.socket = socket;
  let peerId = "";
  let resumeToken = "";

  // Resolves on the first thing that ends the attempt. Never rejects: every
  // failure mode is a bucket, and a rejection here would lose the timings.
  const settled = new Promise<void>((done) => {
    let finished = false;
    const finish = (outcome: Outcome, detail = "") => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      arrival.outcome = outcome;
      arrival.detail = detail;
      done();
    };
    const timer = setTimeout(() => {
      // The client's own budget has run out, so this person has failed to
      // join even if `welcome` arrives a second later.
      finish("timeout", `no welcome in ${opts.joinTimeoutMs}ms`);
    }, opts.joinTimeoutMs);

    socket.on("open", () => {
      arrival.openMs = sinceSocket();
      socket.send(
        JSON.stringify({
          type: "auth",
          token,
          // Same per-socket negotiation `connectClient` does. A harness that
          // stays silent here keeps receiving whole rosters and measures the
          // server as it was before roster deltas, which is a real result
          // only when `--caps 0` asked for it.
          ...(opts.caps ? { caps: ["voice-roster-delta"] } : {}),
        }),
      );
    });
    socket.on("message", (data) => {
      const text = String(data);
      const type = /"type":"([^"]+)"/.exec(text)?.[1] ?? "?";
      noteFrame(type, text.length);
      if (type === "ready") {
        arrival.readyMs = sinceSocket();
        socket.send(
          JSON.stringify({
            type: "join-channel",
            channelId: setup.textChannelId,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "join-voice-room",
            voiceChannelId: setup.voiceChannelId,
            transports: ["mesh", "livekit"],
          }),
        );
        return;
      }
      if (type === "welcome") {
        arrival.welcomeMs = sinceSocket();
        try {
          const parsed = JSON.parse(text) as {
            peerId?: string;
            resumeToken?: string;
          };
          peerId = parsed.peerId ?? "";
          resumeToken = parsed.resumeToken ?? "";
        } catch {
          // The timings are what matter; a token mint we cannot address is
          // reported as a missing tokenMs rather than as a failed join.
        }
        finish("welcome");
        return;
      }
      if (type === "voice-transport-unsupported") {
        finish("transport-refused");
      } else if (type === "voice-join-refused") {
        finish("join-refused");
      } else if (type === "voice-room-full") {
        finish("room-full");
      }
    });
    socket.on("close", (code) => {
      finish(`closed:${code}`, code === 4429 ? "rate limited" : "");
    });
    socket.on("error", (error) => {
      finish("error", describeError(error));
    });
  });

  await settled;

  // What a real client does next on an SFU room, and the reason it is measured
  // separately: it is an authenticated HTTP round trip that runs while the
  // room is at its busiest, and it is the one request that can 409 or 503 long
  // after `welcome` said everything was fine.
  if (arrival.outcome === "welcome" && peerId) {
    const tokenStart = Date.now();
    try {
      await api(base, token, "POST", "/api/voice/token", {
        voiceChannelId: setup.voiceChannelId,
        peerId,
        ...(resumeToken ? { resumeToken } : {}),
      });
      arrival.tokenMs = Date.now() - tokenStart;
    } catch {
      // Recorded as a null mint against a successful join, which is exactly
      // what it is: they are in the room and have no media.
      arrival.tokenMs = null;
    }
  }
  return arrival;
}

// ------------------------------------------------------------- observation

interface Sample {
  atMs: number;
  /**
   * The commit the target is running (`APP_VERSION`), read on every sample.
   *
   * THE RIG IS SHARED. On 2026-09-07 a second agent deployed their branch to
   * `pqp-api-staging` between two runs of this script, and the second run
   * quietly measured their code: different wire volume, CPU pegged where it
   * had been idle, a ceiling one bucket higher, and nothing in the report to
   * say the binary had changed underneath it. A load test that cannot tell you
   * WHICH build it measured is not a measurement. So this is sampled, not
   * asked for once, and the report says loudly when it moves.
   */
  version: string | null;
  sockets: number;
  poolBusy: number;
  poolMax: number;
  poolWaiting: number;
  pressure: string;
  peakPoolWaiting: number;
  peakPoolBusy: number;
  largestRoom: number;
}

/**
 * Poll `GET /api/admin/metrics` once a second.
 *
 * The `runtime` block is the only part of that payload sampled per request
 * rather than served from the 30s cache (see server/src/services/metrics.ts),
 * which is precisely why it is usable as a load-test instrument: the pool
 * counters are live and the read costs no query.
 */
function startMetricsSampler(
  base: string,
  metricsToken: string,
  samples: Sample[],
  startedAt: number,
): NodeJS.Timeout | null {
  if (!metricsToken) {
    console.warn(
      "no ADMIN_METRICS_TOKEN: the pool and socket counts will not be sampled",
    );
    return null;
  }
  return setInterval(() => {
    void (async () => {
      try {
        const res = await fetch(`${base}/api/admin/metrics`, {
          headers: {
            Authorization: `Bearer ${metricsToken}`,
            "X-Forwarded-For": forgedAddress(metricsToken),
          },
        });
        if (!res.ok) {
          return;
        }
        const body = (await res.json()) as {
          version?: string | null;
          runtime?: {
            sockets?: number;
            peakPoolWaiting?: number;
            peakPoolBusy?: number;
            pool?: {
              busy?: number;
              max?: number;
              waiting?: number;
              pressure?: string;
            };
          };
          voice?: { largestRoomNow?: number };
        };
        const runtime = body.runtime ?? {};
        const pool = runtime.pool ?? {};
        samples.push({
          atMs: Date.now() - startedAt,
          version: body.version ?? null,
          sockets: runtime.sockets ?? 0,
          poolBusy: pool.busy ?? 0,
          poolMax: pool.max ?? 0,
          poolWaiting: pool.waiting ?? 0,
          pressure: pool.pressure ?? "?",
          peakPoolWaiting: runtime.peakPoolWaiting ?? 0,
          peakPoolBusy: runtime.peakPoolBusy ?? 0,
          largestRoom: body.voice?.largestRoomNow ?? 0,
        });
      } catch {
        // A missed sample is a gap in a graph, never a failed run.
      }
    })();
  }, 1_000);
}

/**
 * Stream `/proc/stat` off a Fly machine once a second and turn it into a
 * busy percentage of the whole VM.
 *
 * `ps` cannot reach a remote target, and the alternative, one `fly ssh`
 * invocation per sample, pays a session handshake every second and reports
 * the cost of measuring. One long-lived session that prints a line per second
 * costs the machine a `head` and a `sleep`.
 */
function startRemoteCpuSampler(app: string, into: number[]): ChildProcess | null {
  if (!app) {
    return null;
  }
  const child = spawn(
    "fly",
    [
      "ssh",
      "console",
      "-a",
      app,
      "-C",
      "sh -c 'while true; do head -1 /proc/stat; sleep 1; done'",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let previous: { total: number; idle: number } | null = null;
  let carry = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    carry += chunk.toString();
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("cpu ")) {
        continue;
      }
      const fields = line.trim().split(/\s+/).slice(1).map(Number);
      if (fields.length < 5 || fields.some((value) => !Number.isFinite(value))) {
        continue;
      }
      const total = fields.reduce((sum, value) => sum + value, 0);
      // idle + iowait: the machine is not doing our work in either.
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
      if (previous && total > previous.total) {
        const busy =
          1 - (idle - previous.idle) / (total - previous.total);
        into.push(Math.max(0, Math.min(1, busy)) * 100);
      }
      previous = { total, idle };
    }
  });
  child.on("error", () => {
    console.warn(`could not stream CPU from ${app}; continuing without it`);
  });
  return child;
}

// ----------------------------------------------------------------- reporting

/**
 * Nearest-rank percentile over an UNSORTED array, null when empty.
 *
 * Deliberately not `percentile` above, which takes a pre-sorted array and
 * answers NaN. Two contracts under one name is how a report ends up quietly
 * reading a percentile off unsorted data.
 */
function percentileOf(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function ms(value: number | null): string {
  return value === null ? "  -  " : `${Math.round(value)}`.padStart(5);
}

const BUCKET = 25;

function reportJoinStorm(arrivals: Arrival[], opts: Options): void {
  const welcomed = arrivals.filter((a) => a.outcome === "welcome");
  const welcomeTimes = welcomed
    .map((a) => a.welcomeMs)
    .filter((value): value is number => value !== null);

  console.log("");
  console.log(
    `arrivals: ${arrivals.length} attempted, ${welcomed.length} reached welcome, ` +
      `${arrivals.length - welcomed.length} did not`,
  );
  console.log(
    `client join budget: ${opts.joinTimeoutMs}ms (JOIN_TIMEOUT_MS in use-voice.ts)`,
  );
  console.log(
    `time to welcome: p50 ${ms(percentileOf(welcomeTimes, 50))}ms  ` +
      `p90 ${ms(percentileOf(welcomeTimes, 90))}ms  ` +
      `p99 ${ms(percentileOf(welcomeTimes, 99))}ms  ` +
      `max ${ms(welcomeTimes.length ? Math.max(...welcomeTimes) : null)}ms`,
  );

  console.log("");
  console.log(
    "by room occupancy at arrival (ms to welcome; 'over' = past the client budget)",
  );
  console.log(
    "  (welcome is timed from the socket, like the browser's own join timer;",
  );
  console.log("   boot is the cold-browser HTTP that happens before it)");
  console.log(
    "  occupancy      n   p50   p90   p99   over  failed   boot   open  ready  token",
  );
  const buckets = new Map<number, Arrival[]>();
  for (const arrival of arrivals) {
    const key = Math.floor(arrival.occupancyAtStart / BUCKET) * BUCKET;
    buckets.set(key, [...(buckets.get(key) ?? []), arrival]);
  }
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const rows = buckets.get(key)!;
    const times = rows
      .map((a) => a.welcomeMs)
      .filter((value): value is number => value !== null);
    const over = times.filter((value) => value > opts.joinTimeoutMs).length;
    const failed = rows.filter((a) => a.outcome !== "welcome").length;
    const opens = rows
      .map((a) => a.openMs)
      .filter((value): value is number => value !== null);
    const readies = rows
      .map((a) => a.readyMs)
      .filter((value): value is number => value !== null);
    const tokens = rows
      .map((a) => a.tokenMs)
      .filter((value): value is number => value !== null);
    const boots = rows
      .map((a) => a.bootstrapMs)
      .filter((value): value is number => value !== null);
    console.log(
      `  ${String(key).padStart(4)}-${String(key + BUCKET - 1).padEnd(4)} ` +
        `${String(rows.length).padStart(6)} ` +
        `${ms(percentileOf(times, 50))} ${ms(percentileOf(times, 90))} ` +
        `${ms(percentileOf(times, 99))} ${String(over).padStart(6)} ` +
        `${String(failed).padStart(7)} ${ms(percentileOf(boots, 50))} ` +
        `${ms(percentileOf(opens, 50))} ` +
        `${ms(percentileOf(readies, 50))} ${ms(percentileOf(tokens, 50))}`,
    );
  }

  console.log("");
  console.log("failures by cause");
  const causes = new Map<string, number>();
  const details = new Map<string, Set<string>>();
  for (const arrival of arrivals) {
    if (arrival.outcome === "welcome") {
      continue;
    }
    causes.set(arrival.outcome, (causes.get(arrival.outcome) ?? 0) + 1);
    if (arrival.detail) {
      const seen = details.get(arrival.outcome) ?? new Set<string>();
      seen.add(arrival.detail);
      details.set(arrival.outcome, seen);
    }
  }
  if (causes.size === 0) {
    console.log("  none");
  }
  for (const [cause, count] of [...causes].sort((a, b) => b[1] - a[1])) {
    const reasons = [...(details.get(cause) ?? [])].slice(0, 3).join(" | ");
    console.log(`  ${cause.padEnd(20)} ${String(count).padStart(6)}  ${reasons}`);
  }
  // Which side ran out is the whole question, and the harness is a side too.
  const local = arrivals.filter((a) =>
    /EMFILE|ENFILE|EADDRNOTAVAIL|ENOBUFS/.test(a.detail),
  ).length;
  if (local > 0) {
    console.log(
      `  NOTE: ${local} of those are the HARNESS running out of sockets, not the server. ` +
        "Raise ulimit -n, or drive the run from more than one machine.",
    );
  }

  // The headline: the first occupancy at which a join stopped fitting inside
  // the client's own budget. Reported from the bucketed p90 rather than from
  // the single worst arrival, so one unlucky packet does not become the answer.
  let ceiling: number | null = null;
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const rows = buckets.get(key)!;
    const times = rows
      .map((a) => a.welcomeMs)
      .filter((value): value is number => value !== null);
    const p90 = percentileOf(times, 90);
    const failedShare =
      rows.filter((a) => a.outcome !== "welcome").length / rows.length;
    if (ceiling === null && ((p90 ?? 0) > opts.joinTimeoutMs || failedShare > 0.5)) {
      ceiling = key;
    }
  }
  console.log("");
  console.log(
    ceiling === null
      ? `no occupancy in this run crossed the ${opts.joinTimeoutMs}ms budget; ` +
          `the ramp ended at ${Math.max(0, ...arrivals.map((a) => a.occupancyAtStart))} in the room`
      : `CEILING: joins stop fitting the client's ${opts.joinTimeoutMs}ms budget ` +
          `at roughly ${ceiling}-${ceiling + BUCKET - 1} people already in the room`,
  );
}

/**
 * The harness's own CPU, as a share of one core.
 *
 * NOT decoration. One Node process simulating five hundred browsers does five
 * hundred TLS handshakes and then parses every roster frame the server fans
 * out to all of them, which is quadratic in room size, so the generator can
 * saturate a core and produce a graph that looks exactly like a server slowing
 * down. Without this number a run cannot tell "the server ran out" from "the
 * harness ran out", and those have opposite fixes.
 *
 * Above roughly 80% of one core, stop believing the latencies and shard the
 * run across more processes or more machines.
 */
function harnessCpuPercent(started: NodeJS.CpuUsage, wallMs: number): number {
  const used = process.cpuUsage(started);
  return ((used.user + used.system) / 1000 / wallMs) * 100;
}

function reportResources(
  samples: Sample[],
  cpu: number[],
  harnessCpu: number,
  peakSocketsLocal: number,
  wireRates: number[],
): void {
  console.log("");
  const versions = [
    ...new Set(
      samples
        .map((sample) => sample.version)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (versions.length === 1) {
    console.log(`target ran ${versions[0]!.slice(0, 12)} for the whole run`);
  } else if (versions.length > 1) {
    console.log(
      `!! THE TARGET WAS REDEPLOYED MID-RUN: ${versions
        .map((v) => v.slice(0, 12))
        .join(" then ")}`,
    );
    console.log(
      "!! These numbers describe more than one build and are not a measurement " +
        "of any of them. Redeploy the build you meant and run it again.",
    );
  } else {
    console.log(
      "target version unknown (no ADMIN_METRICS_TOKEN): this run cannot say " +
        "which build it measured",
    );
  }
  if (samples.length === 0) {
    console.log("no server samples were collected");
  } else {
    const last = samples[samples.length - 1]!;
    const maxSockets = Math.max(...samples.map((s) => s.sockets));
    const maxBusy = Math.max(...samples.map((s) => s.poolBusy));
    const maxWaiting = Math.max(...samples.map((s) => s.poolWaiting));
    const saturated = samples.filter((s) => s.pressure === "saturated").length;
    const tight = samples.filter((s) => s.pressure === "tight").length;
    console.log(
      `server: peak sockets ${maxSockets}, pool max ${last.poolMax}, ` +
        `peak busy ${maxBusy}, peak queued ${maxWaiting} ` +
        `(process high-water: busy ${last.peakPoolBusy}, queued ${last.peakPoolWaiting})`,
    );
    console.log(
      `pool pressure: ${saturated}s saturated, ${tight}s tight, ` +
        `${samples.length - saturated - tight}s ok, out of ${samples.length} samples`,
    );
    // Max across the run, not the last sample: `voice` rides in the payload's
    // 30-second count cache (only `runtime` is per-request), so the final read
    // can be half a minute behind the room it is describing.
    console.log(
      `largest voice room the server reported: ${Math.max(...samples.map((s) => s.largestRoom))}` +
        " (30s cache, so it lags the ramp)",
    );
  }
  if (cpu.length > 0) {
    const sorted = [...cpu].sort((a, b) => a - b);
    console.log(
      `machine cpu: median ${(percentileOf(sorted, 50) ?? 0).toFixed(0)}%, ` +
        `p90 ${(percentileOf(sorted, 90) ?? 0).toFixed(0)}%, ` +
        `max ${Math.max(...cpu).toFixed(0)}% of the whole VM`,
    );
  }
  console.log(
    `harness: ${harnessCpu.toFixed(0)}% of one core, ${peakSocketsLocal} sockets held`,
  );
  if (wireRates.length > 0) {
    const peak = Math.max(...wireRates);
    console.log(
      `wire in: ${(wire.bytes / 1024 / 1024).toFixed(1)} MB over ${wire.frames} frames; ` +
        `median ${((percentileOf(wireRates, 50) ?? 0) / 1024).toFixed(0)} KB/s, ` +
        `peak ${(peak / 1024).toFixed(0)} KB/s (${((peak * 8) / 1e6).toFixed(1)} Mbit/s)`,
    );
    console.log(
      "  Signalling fan-out is O(room size) per arrival, so this is traffic that",
    );
    console.log(
      "  WOULD be spread over that many households. A peak near the harness",
    );
    console.log(
      "  machine's downlink means the run measured the link, not the server.",
    );
    console.log("");
    console.log("  what filled it, by frame type");
    console.log("    type                     frames        MB   avg bytes");
    const rows = [...wireByType].sort((a, b) => b[1].bytes - a[1].bytes);
    for (const [type, row] of rows.slice(0, 10)) {
      console.log(
        `    ${type.padEnd(24)} ${String(row.frames).padStart(6)} ` +
          `${(row.bytes / 1024 / 1024).toFixed(1).padStart(9)} ` +
          `${Math.round(row.bytes / row.frames).toString().padStart(11)}`,
      );
    }
  }
  if (harnessCpu > 80) {
    console.log(
      "  WARNING: the harness was near a full core. Above ~80% the latencies " +
        "above measure this process, not the server. Shard the run.",
    );
  }
}

/**
 * The ramp itself.
 *
 * Arrivals are launched on a 100ms ticker at a rate that steps up every
 * `--ramp-every` seconds, and each one runs to its own terminal outcome
 * concurrently, which is the point, because a real crowd does not queue.
 * Ramping stops on the first of: the client cap, the abort condition, or a
 * window in which joins have stopped fitting the client's budget. Then it
 * holds, so the last arrivals are measured against a room that is still full.
 */
async function joinStorm(
  base: string,
  wsUrl: string,
  setup: Setup,
  opts: Options,
): Promise<void> {
  const arrivals: Arrival[] = [];
  const inRoom = new Set<number>();
  const samples: Sample[] = [];
  const cpu: number[] = [];
  const startedAt = Date.now();
  const cpuStart = process.cpuUsage();
  const wireRates: number[] = [];
  let lastWireBytes = 0;
  const wireTicker = setInterval(() => {
    wireRates.push(wire.bytes - lastWireBytes);
    lastWireBytes = wire.bytes;
  }, 1_000);
  const sampler = startMetricsSampler(base, opts.metricsToken, samples, startedAt);
  const cpuChild = startRemoteCpuSampler(opts.flyApp, cpu);

  let launched = 0;
  let peakLocalSockets = 0;
  let rate = opts.arrivals;
  let carry = 0;
  let stopping = "";
  const pending = new Set<Promise<void>>();

  /** The last 40 completed arrivals: what "failures appeared" is judged on. */
  const WINDOW = 40;

  const launch = (): void => {
    const index = launched++;
    const attempt = arrive(
      base,
      wsUrl,
      index,
      opts.prefix,
      setup,
      opts,
      () => inRoom.size,
    ).then((arrival) => {
      arrivals.push(arrival);
      if (arrival.outcome === "welcome") {
        inRoom.add(index);
        arrival.socket?.on("close", () => inRoom.delete(index));
      } else {
        arrival.socket?.close();
      }
    });
    pending.add(attempt);
    void attempt.finally(() => pending.delete(attempt));
  };

  console.log(
    `ramping from ${rate}/s, +${opts.ramp}/s every ${opts.rampEvery}s, ` +
      `cap ${opts.maxClients} clients, budget ${opts.joinTimeoutMs}ms`,
  );

  const TICK_MS = 100;
  let elapsed = 0;
  let lastStep = 0;
  let lastLog = 0;
  while (!stopping && launched < opts.maxClients) {
    await new Promise((r) => setTimeout(r, TICK_MS));
    elapsed += TICK_MS;
    carry += (rate * TICK_MS) / 1000;
    while (carry >= 1 && launched < opts.maxClients) {
      carry -= 1;
      launch();
    }
    peakLocalSockets = Math.max(peakLocalSockets, inRoom.size + pending.size);
    if (elapsed - lastStep >= opts.rampEvery * 1000) {
      lastStep = elapsed;
      rate += opts.ramp;
      console.log(
        `  t+${Math.round(elapsed / 1000)}s  rate ${rate}/s  ` +
          `launched ${launched}  in room ${inRoom.size}  ` +
          `settled ${arrivals.length}`,
      );
    } else if (elapsed - lastLog >= 5_000) {
      lastLog = elapsed;
      const latest = samples[samples.length - 1];
      console.log(
        `  t+${Math.round(elapsed / 1000)}s  in room ${inRoom.size}  ` +
          `settled ${arrivals.length}` +
          (latest
            ? `  sockets ${latest.sockets}  pool ${latest.poolBusy}/${latest.poolMax}` +
              ` queued ${latest.poolWaiting} (${latest.pressure})`
            : ""),
      );
    }

    const window = arrivals.slice(-WINDOW);
    if (window.length >= WINDOW) {
      const failed = window.filter((a) => a.outcome !== "welcome").length;
      const times = window
        .map((a) => a.welcomeMs)
        .filter((value): value is number => value !== null);
      const p90 = percentileOf(times, 90) ?? 0;
      if (failed / window.length > opts.abortFailRate) {
        stopping = `${failed} of the last ${window.length} arrivals failed`;
      } else if (p90 > opts.joinTimeoutMs) {
        stopping = `p90 time to welcome ${Math.round(p90)}ms is past the client budget`;
      }
    }
  }

  console.log(
    stopping
      ? `stopping the ramp: ${stopping}`
      : `stopping the ramp: reached the ${opts.maxClients} client cap`,
  );
  // Let everything still in flight reach an outcome, then hold so the tail is
  // measured against a room that is still full.
  await Promise.all([...pending]);
  console.log(`holding ${opts.holdSeconds}s with ${inRoom.size} in the room`);
  await new Promise((r) => setTimeout(r, opts.holdSeconds * 1000));

  if (sampler) {
    clearInterval(sampler);
  }
  clearInterval(wireTicker);
  cpuChild?.kill("SIGTERM");

  arrivals.sort((a, b) => a.index - b.index);
  reportJoinStorm(arrivals, opts);
  reportResources(
    samples,
    cpu,
    harnessCpuPercent(cpuStart, Date.now() - startedAt),
    peakLocalSockets,
    wireRates,
  );

  for (const arrival of arrivals) {
    if (arrival.socket && !TERMINAL_STATES.has(arrival.socket.readyState)) {
      arrival.socket.close();
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  authSecret = opts.secret;
  // The one guard that cannot be a comment. Everything this script does is a
  // write against a real deployment, and there is no undo.
  if (/(^|\.)pqp\.gg$/.test(new URL(opts.url).hostname)) {
    throw new Error(
      "refusing to load test pqp.gg. Point --url at staging or at localhost; " +
        "see docs/STAGING.md.",
    );
  }
  let child: ChildProcess | null = null;
  let pid = opts.pid;
  if (opts.spawn) {
    child = spawnServer(opts.port);
    pid = child.pid ?? null;
  }
  const base = opts.url;
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  await waitForServer(base);

  console.log(`setting up server as ${opts.prefix}-owner`);
  const setup = await setupServer(base, opts.prefix);

  if (opts.mode === "join") {
    await joinStorm(base, wsUrl, setup, opts);
    if (child) {
      child.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  }

  if (!pid) {
    console.warn("no --pid and no --spawn: CPU will not be sampled");
  }

  console.log(`connecting ${opts.n} clients`);
  const clients: Client[] = [];
  // The address-keyed pre-auth limiter refills at 60/s and every client here
  // shares one address, so setup is paced under it: ten clients, three
  // requests each, every 600 ms.
  const CONNECT_BATCH = 10;
  const joiners = opts.voice < 0 ? opts.n : Math.min(opts.voice, opts.n);
  // Sockets connect without joining voice when a stampede is going to be
  // measured, so the burst is one event with a clock on it rather than
  // something smeared across the paced connect loop.
  const stampede = opts.voice >= 0;
  for (let start = 0; start < opts.n; start += CONNECT_BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(opts.n, start + CONNECT_BATCH); i += 1) {
      batch.push(
        connectClient(
          base,
          wsUrl,
          i,
          opts.prefix,
          setup,
          opts.caps,
          !stampede,
        ),
      );
    }
    clients.push(...(await Promise.all(batch)));
    // The address-keyed limiter in ws/index.ts is shared by every local
    // client; pacing the connect keeps setup from being what trips it.
    await new Promise((r) => setTimeout(r, 600));
  }
  // Let the join storm settle before the clock starts.
  await new Promise((r) => setTimeout(r, 2_000));

  let stampedeReport: StampedeReport | null = null;
  if (stampede) {
    stampedeReport = await runStampede(
      clients.slice(0, joiners),
      clients,
      setup,
      opts,
      pid,
    );
  }

  const inVoice = clients.filter((c) => c.inVoice).length;
  console.log(`${clients.length} connected, ${inVoice} in voice`);

  for (const client of clients) {
    client.bytes = 0;
    client.frames = 0;
    client.byType.clear();
    client.bytesByType.clear();
  }

  const voiceClients = clients.slice(0, joiners);
  const cpuStart = pid ? cpuSeconds(pid) : 0;
  const statementsStart = statementsExecuted(opts.db);
  const wallStart = Date.now();
  const TICK_MS = 100;
  const perTick = (perSecond: number) => (perSecond * TICK_MS) / 1000;
  const carry = { msg: 0, typing: 0, toggle: 0, churn: 0, views: 0 };
  let sent = 0;

  const ticker = setInterval(() => {
    carry.msg += perTick(opts.messagesPerSecond);
    carry.typing += perTick(opts.typingPerSecond);
    carry.toggle += perTick(opts.togglesPerSecond);
    carry.churn += perTick(opts.churnPerSecond);
    carry.views += perTick(opts.viewsPerSecond);

    while (carry.msg >= 1) {
      carry.msg -= 1;
      sendFrame(pick(clients), {
        type: "message-create",
        channelId: setup.textChannelId,
        body: `load ${sent} ${"x".repeat(40)}`,
        nonce: `n${sent}`,
      });
      sent += 1;
    }
    while (carry.typing >= 1) {
      carry.typing -= 1;
      sendFrame(pick(clients), {
        type: "typing",
        channelId: setup.textChannelId,
      });
      sent += 1;
    }
    while (carry.toggle >= 1) {
      carry.toggle -= 1;
      // Only somebody in the room can toggle a mute; picking from every socket
      // would spend most ticks on a frame the server drops for having no peer.
      const client = pick(voiceClients);
      client.muted = !client.muted;
      sendFrame(client, {
        type: "set-voice-state",
        muted: client.muted,
        deafened: false,
      });
      sent += 1;
    }
    // Somebody clicking between channels: the whole viewer list of the text
    // channel is re-sent to every viewer on each of these.
    while (carry.views >= 1) {
      carry.views -= 1;
      const client = pick(clients);
      sendFrame(client, { type: "leave-channel" });
      sendFrame(client, { type: "join-channel", channelId: setup.textChannelId });
      sent += 2;
    }
    while (carry.churn >= 1) {
      carry.churn -= 1;
      const client = pick(voiceClients);
      if (client.inVoice) {
        client.inVoice = false;
        sendFrame(client, { type: "leave-voice-room" });
      } else {
        sendFrame(client, {
          type: "join-voice-room",
          voiceChannelId: setup.voiceChannelId,
          transports: ["mesh", "livekit"],
        });
      }
      sent += 1;
    }
  }, TICK_MS);

  await new Promise((r) => setTimeout(r, opts.seconds * 1000));
  clearInterval(ticker);
  // Drain whatever the last tick produced.
  await new Promise((r) => setTimeout(r, 500));

  const wallSeconds = (Date.now() - wallStart) / 1000;
  const cpuUsed = pid ? cpuSeconds(pid) - cpuStart : 0;
  const totalBytes = clients.reduce((sum, c) => sum + c.bytes, 0);
  const totalFrames = clients.reduce((sum, c) => sum + c.frames, 0);
  const byType = new Map<string, number>();
  const bytesByType = new Map<string, number>();
  for (const client of clients) {
    for (const [type, count] of client.byType) {
      byType.set(type, (byType.get(type) ?? 0) + count);
    }
    for (const [type, bytes] of client.bytesByType) {
      bytesByType.set(type, (bytesByType.get(type) ?? 0) + bytes);
    }
  }

  console.log("");
  if (stampedeReport) {
    const s = stampedeReport;
    console.log(
      `=== STAMPEDE (${s.joiners} joins at once, ${clients.length} sockets, roster deltas ${opts.caps ? "on" : "off"}) ===`,
    );
    console.log(
      `  welcomed ${s.welcomed}/${s.joiners}   refused ${s.refused}   timed out ${s.timedOut}   in ${s.elapsedSeconds}s`,
    );
    console.log(
      `  time to join   p50 ${s.p50}ms  p95 ${s.p95}ms  p99 ${s.p99}ms  max ${s.max}ms`,
    );
    console.log(
      `  fan-out        ${s.framesPerJoin} frames/join, ${(s.bytesPerJoin / 1024).toFixed(1)} KB/join, ${(s.bytes / 1024 / 1024).toFixed(2)} MB total`,
    );
    console.log(
      `  server cpu     ${s.cpuSeconds}s     database ${Number.isNaN(s.statementsPerJoin) ? "n/a (no pg_stat_statements)" : `${s.statementsPerJoin} statements/join`}`,
    );
    for (const row of s.byType.slice(0, 5)) {
      console.log(
        `    ${row.type.padEnd(22)} ${String(row.frames).padStart(7)} frames ${(row.bytes / 1024 / 1024).toFixed(2).padStart(8)} MB`,
      );
    }
    console.log(
      `  convergence    ${s.convergence.socketsHoldingIt}/${s.convergence.sockets} sockets hold the exact ${s.convergence.expectedRoomSize}-peer roster; ${s.convergence.socketsThatSawAGap} saw a gap`,
    );
    console.log("");
  }
  console.log(`clients: ${clients.length}  duration: ${wallSeconds.toFixed(1)}s  client frames sent: ${sent}`);
  console.log(
    `traffic: ${opts.messagesPerSecond} msg/s, ${opts.typingPerSecond} typing/s, ${opts.togglesPerSecond} toggles/s, ${opts.churnPerSecond} voice churn/s, ${opts.viewsPerSecond} channel switches/s`,
  );
  if (pid) {
    console.log(
      `server cpu: ${cpuUsed.toFixed(2)}s over ${wallSeconds.toFixed(1)}s = ${((cpuUsed / wallSeconds) * 100).toFixed(1)}% of one core, rss ${rssMb(pid).toFixed(0)} MB`,
    );
  }
  console.log(
    `received: ${totalFrames} frames, ${(totalBytes / 1024 / 1024).toFixed(2)} MB total; per socket ${(totalFrames / clients.length / wallSeconds).toFixed(1)} frames/s, ${(totalBytes / clients.length / wallSeconds / 1024).toFixed(1)} KB/s`,
  );
  const rows = [...byType].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of rows) {
    const bytes = bytesByType.get(type) ?? 0;
    console.log(
      `  ${type.padEnd(22)} ${String(count).padStart(8)} frames ${(bytes / 1024 / 1024).toFixed(2).padStart(8)} MB  (${(count / clients.length / wallSeconds).toFixed(2)} frames/socket/s, ${(bytes / clients.length / wallSeconds / 1024).toFixed(1)} KB/socket/s)`,
    );
  }

  if (opts.json) {
    const statements = statementsExecuted(opts.db) - statementsStart;
    writeFileSync(
      opts.json,
      `${JSON.stringify(
        {
          label: opts.caps ? "roster-deltas" : "full-rosters",
          clients: clients.length,
          inVoice,
          stampede: stampedeReport,
          steady: {
            seconds: Number(wallSeconds.toFixed(1)),
            frames: totalFrames,
            bytes: totalBytes,
            bytesPerSecond: Math.round(totalBytes / wallSeconds),
            cpuSeconds: Number(cpuUsed.toFixed(2)),
            statements,
            byType: rows.map(([type, count]) => ({
              type,
              frames: count,
              bytes: bytesByType.get(type) ?? 0,
            })),
          },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote ${opts.json}`);
  }

  for (const client of clients) {
    if (!TERMINAL_STATES.has(client.socket.readyState)) {
      client.socket.close();
    }
  }
  if (child) {
    child.kill("SIGTERM");
  }
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
