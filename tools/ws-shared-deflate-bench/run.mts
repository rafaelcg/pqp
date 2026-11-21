/**
 * COMPRESS-ONCE FAN-OUT BENCH: one large frame to N sockets, three ways.
 *
 *   ws      the shipped compression, `ws` compressing once per socket
 *           (`broadcastEncoded` with `ws_shared_deflate` off: today)
 *   shared  the same sockets and settings, `ws_shared_deflate` on
 *           (`lib/ws-shared-deflate.ts`: compressed once, same bytes to all)
 *   off     no permessage-deflate at all, for scale
 *
 * Each mode runs in its own process (so one mode's zlib contexts cannot sit in
 * the next one's memory reading), with the clients in a second process. The
 * frame is a 250-person `voice-roster` with random ids, about 92 KB, encoded
 * once to a Buffer as the server does, and sent through the real
 * `broadcastEncoded` from `server/src/ws/fanout.ts` over a server built with
 * the real `WS_PER_MESSAGE_DEFLATE`. Every client parses every frame and acks
 * it; one warm-up fan-out, then ROUNDS measured ones.
 *
 * Reported per mode: server processor time per fan-out (user + system), RSS
 * growth per socket after the warm-up, median wall time of a fan-out (bound by
 * the single client process inflating, so not a server number), event-loop
 * delay, and, for `shared`, the path's own counters.
 *
 *   pnpm --filter @pqp/server exec tsx ../tools/ws-shared-deflate-bench/run.mts [N=1000] [ROUNDS=20] [modes=ws,shared,off]
 *
 * Machine-dependent, run on an idle machine; one run per row.
 */
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { AddressInfo } from "node:net";

const self = fileURLToPath(import.meta.url);
// `ws` is the server's dependency; resolve it from there, the version it runs.
const ws = createRequire(new URL("../../server/package.json", import.meta.url))(
  "ws",
) as typeof import("ws");
const role = process.argv[2];

if (role === "--mode") {
  await runMode(process.argv[3]!, Number(process.argv[4]), Number(process.argv[5]));
} else if (role === "--clients") {
  await runClients(Number(process.argv[3]), Number(process.argv[4]), process.argv[5] === "on");
} else {
  const n = Number(process.argv[2] ?? 1000);
  const rounds = Number(process.argv[3] ?? 20);
  const modes = (process.argv[4] ?? "ws,shared,off").split(",");
  const results: unknown[] = [];
  for (const mode of modes) {
    results.push(
      await new Promise((resolve, reject) => {
        const child = fork(self, ["--mode", mode, String(n), String(rounds)], {
          env: { ...process.env, WS_SHARED_DEFLATE: mode === "shared" ? "true" : "false" },
          execArgv: [...process.execArgv, "--expose-gc"],
        });
        child.on("message", resolve);
        child.on("error", reject);
        child.on("exit", (code) => code !== 0 && reject(new Error(`${mode} exited ${code}`)));
      }),
    );
  }
  console.log(JSON.stringify({ node: process.versions.node, n, rounds, results }, null, 2));
}

function roster(people: number) {
  const participants = [];
  for (let i = 0; i < people; i += 1) {
    participants.push({
      peerId: randomUUID(),
      userId: randomUUID(),
      displayName: `player_${randomBytes(4).toString("hex")}`,
      avatarUrl:
        i % 5 === 0 ? null : `https://img.clerk.com/imageworks/FieldUpload_${randomBytes(13).toString("hex")}`,
      sharingScreen: i % 25 === 0,
      muted: i % 3 === 0,
      deafened: false,
      canSpeak: true,
      serverMuted: false,
      cameraStreamId: i % 4 === 0 ? randomBytes(10).toString("hex") : null,
      screenAudioStreamId: i % 25 === 0 ? randomBytes(10).toString("hex") : null,
      handRaisedAt: i % 4 === 0 ? 1_700_000_000_000 + i : null,
    });
  }
  return { type: "voice-roster", voiceChannelId: randomUUID(), participants, seq: 12 };
}

async function runMode(mode: string, n: number, rounds: number): Promise<void> {
  const { WebSocketServer } = ws;
  const { WS_PER_MESSAGE_DEFLATE } = await import("../../server/src/lib/ws-compression.ts");
  const { broadcastEncoded, encodeFrame } = await import("../../server/src/ws/fanout.ts");
  const { sharedDeflateStats } = await import("../../server/src/lib/ws-shared-deflate.ts");
  const frame = encodeFrame(roster(250));

  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    maxPayload: 128 * 1024,
    perMessageDeflate: mode === "off" ? false : WS_PER_MESSAGE_DEFLATE,
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const sockets: import("ws").WebSocket[] = [];
  let acks = 0;
  let waiter: { n: number; resolve: () => void } | null = null;
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", () => {
      acks += 1;
      if (waiter && acks >= waiter.n) waiter.resolve();
    });
  });

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const base = process.memoryUsage();
  const clients = fork(self, ["--clients", String(port), String(n), mode === "off" ? "off" : "on"]);
  let clientErrors = 0;
  clients.on("message", (message) => {
    if (typeof message === "object" && message && "errors" in message) {
      clientErrors = (message as { errors: number }).errors;
    }
  });
  await new Promise<void>((resolve) => clients.on("message", (m) => m === "connected" && resolve()));
  while (sockets.length < n) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 500));

  const fanOut = async () => {
    acks = 0;
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<void>((resolve, reject) => {
      waiter = { n, resolve };
      timer = setTimeout(
        () => reject(new Error(`${mode}: ${acks}/${n} acks after 30 s`)),
        30_000,
      );
    });
    broadcastEncoded(sockets, frame, { droppable: true });
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  };
  await fanOut();
  await new Promise((r) => setTimeout(r, 300));
  gc?.();
  const after = process.memoryUsage();

  const loop = monitorEventLoopDelay({ resolution: 1 });
  const walls: number[] = [];
  let cpu = 0;
  loop.enable();
  for (let r = 0; r < rounds; r += 1) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    await fanOut();
    walls.push(performance.now() - t0);
    const c = process.cpuUsage(c0);
    cpu += c.user + c.system;
    await new Promise((r) => setTimeout(r, 100));
  }
  loop.disable();
  clients.send("report");
  await new Promise((r) => setTimeout(r, 200));
  const median = [...walls].sort((a, b) => a - b)[Math.floor(walls.length / 2)]!;
  process.send!({
    mode,
    frameBytes: frame.length,
    serverCpuMsPerFanout: +(cpu / 1000 / rounds).toFixed(1),
    rssPerSocketKB: Math.round((after.rss - base.rss) / n / 1024),
    fanoutWallMsMedian: +median.toFixed(1),
    eventLoopDelayMs: {
      p50: +(loop.percentile(50) / 1e6).toFixed(1),
      p99: +(loop.percentile(99) / 1e6).toFixed(1),
      max: +(loop.max / 1e6).toFixed(1),
    },
    clientDecodeErrors: clientErrors,
    ...(mode === "shared" ? { shared: sharedDeflateStats() } : {}),
  });
  clients.kill();
  for (const socket of sockets) socket.terminate();
  wss.close();
  setTimeout(() => process.exit(0), 50);
}

async function runClients(port: number, n: number, compressed: boolean): Promise<void> {
  const { WebSocket } = ws;
  let open = 0;
  let errors = 0;
  for (let i = 0; i < n; i += 1) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: compressed });
    socket.on("open", () => {
      open += 1;
      if (open === n) process.send!("connected");
    });
    socket.on("message", (data) => {
      try {
        if ((JSON.parse(data.toString()) as { type?: string }).type !== "voice-roster") errors += 1;
      } catch {
        errors += 1;
      }
      socket.send("a");
    });
    socket.on("error", () => (errors += 1));
    if (i % 200 === 199) await new Promise((r) => setTimeout(r, 50));
  }
  process.on("message", (message) => {
    if (message === "report") process.send!({ errors });
  });
}
