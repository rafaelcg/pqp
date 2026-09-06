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
 * Never point this at a shared database: it creates users and a server.
 */
/* eslint-disable no-console -- a CLI report is its stdout */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { WebSocket } from "ws";

interface Options {
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
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
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
  };
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
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!opts.url) {
    opts.url = `http://localhost:${opts.port}`;
  }
  return opts;
}

const DEV_TOKEN = "dev-local-token";

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
      },
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
}

interface Setup {
  textChannelId: string;
  voiceChannelId: string;
  inviteCode: string;
}

async function setupServer(base: string, prefix: string): Promise<Setup> {
  const owner = `${DEV_TOKEN}:${prefix}-owner`;
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
}

const TERMINAL_STATES = new Set([WebSocket.CLOSING, WebSocket.CLOSED]);

function sendFrame(client: Client, frame: unknown): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(frame));
  }
}

async function connectClient(
  base: string,
  wsUrl: string,
  index: number,
  prefix: string,
  setup: Setup,
): Promise<Client> {
  const token = `${DEV_TOKEN}:${prefix}-${index}`;
  await passGates(base, token);
  await api(base, token, "POST", `/api/invites/${setup.inviteCode}/join`);

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
      } else if (type === "welcome") {
        client.inVoice = true;
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
  socket.send(JSON.stringify({ type: "auth", token }));
  await ready;
  sendFrame(client, { type: "join-channel", channelId: setup.textChannelId });
  sendFrame(client, {
    type: "join-voice-room",
    voiceChannelId: setup.voiceChannelId,
    transports: ["mesh", "livekit"],
  });
  return client;
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

async function waitForServer(base: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${DEV_TOKEN}` },
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let child: ChildProcess | null = null;
  let pid = opts.pid;
  if (opts.spawn) {
    child = spawnServer(opts.port);
    pid = child.pid ?? null;
  }
  const base = opts.url;
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  await waitForServer(base);
  if (!pid) {
    console.warn("no --pid and no --spawn: CPU will not be sampled");
  }

  console.log(`setting up server as ${opts.prefix}-owner`);
  const setup = await setupServer(base, opts.prefix);

  console.log(`connecting ${opts.n} clients`);
  const clients: Client[] = [];
  // The address-keyed pre-auth limiter refills at 60/s and every client here
  // shares one address, so setup is paced under it: ten clients, three
  // requests each, every 600 ms.
  const CONNECT_BATCH = 10;
  for (let start = 0; start < opts.n; start += CONNECT_BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(opts.n, start + CONNECT_BATCH); i += 1) {
      batch.push(connectClient(base, wsUrl, i, opts.prefix, setup));
    }
    clients.push(...(await Promise.all(batch)));
    // The address-keyed limiter in ws/index.ts is shared by every local
    // client; pacing the connect keeps setup from being what trips it.
    await new Promise((r) => setTimeout(r, 600));
  }
  // Let the join storm settle before the clock starts.
  await new Promise((r) => setTimeout(r, 2_000));
  const inVoice = clients.filter((c) => c.inVoice).length;
  console.log(`${clients.length} connected, ${inVoice} in voice`);

  for (const client of clients) {
    client.bytes = 0;
    client.frames = 0;
    client.byType.clear();
    client.bytesByType.clear();
  }

  const cpuStart = pid ? cpuSeconds(pid) : 0;
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
      const client = pick(clients);
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
      const client = pick(clients);
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
