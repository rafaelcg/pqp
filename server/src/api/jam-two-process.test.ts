import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { jamFrameSchema, type JamFrame } from "@pqp/shared";

/**
 * TWO REAL API PROCESSES on the Postgres bus, the way production's two
 * replicas run (`CLUSTER_BUS=postgres`, one database). Alice writes on api-a;
 * Bob watches the jam channel on api-b. Every jam frame Bob gets on b could
 * only have come over NOTIFY, which the single-process suite
 * (`jam.test.ts`) cannot prove: the in-memory hub never serialises a payload
 * the way `pg_notify` does, and a frame type missing from
 * `CHAT_SERVER_MESSAGE_TYPES` is dropped by the receiving side silently.
 * Pitfall 12 is exactly "tested with the flag off": here the bus is on, the
 * flag is a row flipped through the dashboard's door, and the read cache is at
 * its production default.
 *
 * Also proved over a real socket: a message into a jam channel is refused,
 * and a socket that did not join the jam channel hears nothing of it.
 */

// These suites TRUNCATE, so they only run against a database on this machine
// (localhost, 127.0.0.1 or ::1): `TEST_DATABASE_URL` first, `DATABASE_URL` only
// on CI, where the runner's database is a local throwaway. A URL that points
// anywhere else makes them skip instead of truncating it.
function localTestDatabase(): string | undefined {
  const url =
    process.env.TEST_DATABASE_URL ?? (process.env.CI ? process.env.DATABASE_URL : undefined);
  if (!url) {
    return undefined;
  }
  try {
    const host = new URL(url).hostname;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ? url : undefined;
  } catch {
    return undefined;
  }
}
const DATABASE_URL = localTestDatabase();
const describeDb = DATABASE_URL ? describe : describe.skip;

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(SERVER_DIR, "node_modules", ".bin", "tsx");
const TOKEN = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
const ALICE = "dev-local-token:alice";
const BOB = "dev-local-token:bob";
const BUCKET = "jam-two";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

// A fake object store the two APIs sign against and HEAD.
const objects = new Map<string, { type: string; body: Buffer }>();
let s3: Server;
let s3Endpoint = "";

async function startFakeS3(): Promise<void> {
  s3 = createServer((req, res) => {
    const key = decodeURIComponent(
      new URL(req.url ?? "/", "http://localhost").pathname.replace(`/${BUCKET}/`, ""),
    );
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, {
          type: String(req.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        });
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    const found = objects.get(key);
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": found.body.length, "content-type": found.type });
    res.end(req.method === "HEAD" ? undefined : found.body);
  });
  await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", () => resolve()));
  s3Endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
}

interface Api {
  name: string;
  port: number;
  child: ChildProcess;
  log: string[];
}

async function startApi(name: string): Promise<Api> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL,
    CLUSTER_BUS: "postgres",
    VOICE_REGISTRY: "postgres",
    DEV_AUTH_BYPASS: "true",
    DEV_SEED: "false",
    NODE_ENV: "development",
    ADMIN_METRICS_TOKEN: TOKEN,
    FEATURE_FLAGS_TTL_MS: String(10 * 60_000),
    JAM_CHANNELS: "",
    READ_CACHE: "",
    LIVEKIT_URL: "",
    LIVE_HLS_ENABLED: "",
    WORKER_MODE: "",
    S3_ENDPOINT: s3Endpoint,
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: "jam-two",
    S3_SECRET_ACCESS_KEY: "jam-two-secret",
    S3_FORCE_PATH_STYLE: "true",
  };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const child = spawn(TSX, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited during boot:\n${log.join("")}`);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok && log.join("").includes("flags.started")) {
      return { name, port, child, log };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill("SIGKILL");
  throw new Error(`${name} never became healthy:\n${log.join("")}`);
}

async function stopApi(api: Api | undefined): Promise<void> {
  if (!api || api.child.exitCode !== null || api.child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => api.child.once("exit", () => resolve()));
  api.child.kill("SIGTERM");
  const timer = setTimeout(() => api.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function call<T = Record<string, unknown>>(
  api: Api,
  method: string,
  path: string,
  auth: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Frame = Record<string, any>;

/** A signed-in socket that has joined one channel, keeping every frame. */
async function openSocket(api: Api, token: string, channelId: string) {
  const frames: Frame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${api.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()) as Frame);
    } catch {
      // not JSON: not ours
    }
  });
  try {
    socket.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => frames.some((frame) => frame.type === "ready"), 10_000, "ready");
    socket.send(JSON.stringify({ type: "join-channel", channelId }));
    await waitFor(
      () => frames.some((frame) => String(frame.type).startsWith("presence")),
      10_000,
      "the join",
    );
  } catch (error) {
    socket.close();
    throw error;
  }
  return { socket, frames };
}

const isJam = (frame: Frame): boolean => String(frame.type).startsWith("jam-");

describeDb("jam frames between two API processes on the Postgres bus", () => {
  let a: Api | undefined;
  let b: Api | undefined;
  let jamId: string;
  let generalId: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    await startFakeS3();
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(
        `TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides,
                  feature_flag_audit
         RESTART IDENTITY CASCADE`,
      );
    const { upsertUser } = await import("../services/users.js");
    const { createServer: createPqpServer, createChannel } = await import("../services/servers.js");
    const alice = await upsertUser({
      clerkId: "dev_local_user_alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    const bob = await upsertUser({
      clerkId: "dev_local_user_bob",
      displayName: "Bob",
      avatarUrl: null,
    });
    await db
      .getPool()
      .query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE`);
    const created = await createPqpServer("Banda", alice.id);
    await db
      .getPool()
      .query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [created.server.id, bob.id],
      );
    generalId = created.channels.find((channel) => channel.type === "text")!.id;
    jamId = (await createChannel(created.server.id, "jam", "jam")).id;
    await db.closePool();

    // One at a time: two boots running schema.sql at once contend for locks.
    a = await startApi("api-a");
    b = await startApi("api-b");

    const flip = await call(a, "PUT", "/api/admin/flags", TOKEN, {
      key: "jam_channels",
      enabled: true,
    });
    expect(flip.status).toBe(200);
    // B hears the flip over the bus, not its ten minute timer.
    const deadline = Date.now() + 12_000;
    for (;;) {
      const config = await call<{ enabled: boolean }>(b, "GET", "/api/jam/config", BOB);
      if (config.body.enabled || Date.now() > deadline) {
        expect(config.body.enabled).toBe(true);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 150_000);

  afterAll(async () => {
    for (const socket of sockets) {
      socket.close();
    }
    await Promise.all([stopApi(a), stopApi(b)]);
    await new Promise<void>((done) => (s3 ? s3.close(() => done()) : done()));
  }, 30_000);

  it("every song and track frame written on api-a reaches the channel's viewer on api-b", async () => {
    const reader = await openSocket(b!, BOB, jamId);
    // Looking at another channel: the jam frames are not for this socket.
    const sidebar = await openSocket(b!, BOB, generalId);
    sockets.push(reader.socket, sidebar.socket);
    const jamFrames = () => reader.frames.filter(isJam);
    const next = async (type: string, what: string): Promise<JamFrame> => {
      await waitFor(() => jamFrames().some((f) => f.type === type), 10_000, what);
      return jamFrameSchema.parse(jamFrames().find((f) => f.type === type));
    };

    // A song.
    const song = await call<{ song: { id: string } }>(a!, "POST", `/api/channels/${jamId}/jam-songs`, ALICE, {
      title: "Wonderwall",
      artist: "Oasis",
      joinMode: "wanted",
      wantedInstruments: ["bass"],
    });
    expect(song.status, JSON.stringify(song.body)).toBe(201);
    const songId = song.body.song.id;
    const created = await next("jam-song-created", "the new song on api-b");
    expect(created).toMatchObject({ channelId: jamId, song: { id: songId, title: "Wonderwall" } });

    // A track, through the real presign, PUT and claim, all on api-a.
    const bytes = Buffer.from("pretend this is opus");
    const ticket = await call<{ uploadId: string; uploadUrl: string }>(
      a!,
      "POST",
      `/api/jam-songs/${songId}/uploads`,
      ALICE,
      { kind: "audio", contentType: "audio/webm", byteSize: bytes.length },
    );
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const put = await fetch(ticket.body.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "audio/webm" },
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    const track = await call<{ track: { id: string } }>(
      a!,
      "POST",
      `/api/jam-songs/${songId}/tracks`,
      ALICE,
      { instrument: "guitar", audioUploadId: ticket.body.uploadId, durationMs: 12_000, peaks: [0.2, 0.7] },
    );
    expect(track.status, JSON.stringify(track.body)).toBe(201);
    const trackId = track.body.track.id;
    const added = await next("jam-track-added", "the new track on api-b");
    expect(added).toMatchObject({
      type: "jam-track-added",
      song: { id: songId, trackCount: 1, instruments: ["guitar"] },
      track: { id: trackId, instrument: "guitar", inMix: true, peaks: [0.2, 0.7] },
    });
    // The URL that crossed the bus is a working one, from b's point of view.
    const url = (added as Extract<JamFrame, { type: "jam-track-added" }>).track.audioUrl;
    expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(bytes);

    // An edit, a vote, a removal of the track, a removal of the song.
    expect(
      (await call(a!, "PATCH", `/api/jam-tracks/${trackId}`, ALICE, { gain: 1.5, offsetMs: -80 })).status,
    ).toBe(200);
    expect(await next("jam-track-updated", "the edit on api-b")).toMatchObject({
      track: { id: trackId, gain: 1.5, offsetMs: -80 },
    });
    expect((await call(a!, "PUT", `/api/jam-tracks/${trackId}/vote`, ALICE)).status).toBe(200);
    expect(await next("jam-track-votes", "the vote on api-b")).toMatchObject({
      trackId,
      songId,
      voteCount: 1,
    });
    // Bob votes from b; the count reaches a viewer on a.
    const onA = await openSocket(a!, ALICE, jamId);
    sockets.push(onA.socket);
    expect((await call(b!, "PUT", `/api/jam-tracks/${trackId}/vote`, BOB)).status).toBe(200);
    await waitFor(
      () => onA.frames.some((f) => f.type === "jam-track-votes" && f.voteCount === 2),
      10_000,
      "the vote written on b, heard on a",
    );
    expect((await call(a!, "PATCH", `/api/jam-songs/${songId}`, ALICE, { joinMode: "closed" })).status).toBe(
      200,
    );
    expect(await next("jam-song-updated", "the song edit on api-b")).toMatchObject({
      song: { id: songId, joinMode: "closed", wantedInstruments: [] },
    });
    expect((await call(a!, "DELETE", `/api/jam-tracks/${trackId}`, ALICE)).status).toBe(204);
    expect(await next("jam-track-deleted", "the track removal on api-b")).toMatchObject({
      trackId,
      song: { id: songId, trackCount: 0 },
    });
    expect((await call(a!, "DELETE", `/api/jam-songs/${songId}`, ALICE)).status).toBe(204);
    expect(await next("jam-song-deleted", "the song removal on api-b")).toEqual({
      type: "jam-song-deleted",
      channelId: jamId,
      songId,
    });

    // All seven kinds arrived, once each (the vote twice: Alice's and Bob's).
    expect(jamFrames().map((f) => f.type).sort()).toEqual(
      [
        "jam-song-created",
        "jam-track-added",
        "jam-track-updated",
        "jam-track-votes",
        "jam-track-votes",
        "jam-song-updated",
        "jam-track-deleted",
        "jam-song-deleted",
      ].sort(),
    );
    // And the socket looking elsewhere heard none of it.
    expect(sidebar.frames.filter(isJam)).toEqual([]);

    // B's own read agrees with what A wrote.
    const list = await call<{ songs: unknown[] }>(b!, "GET", `/api/channels/${jamId}/jam-songs`, BOB);
    expect(list.body.songs).toEqual([]);
  }, 60_000);

  it("a message into a jam channel is refused over a real socket", async () => {
    const reader = await openSocket(b!, BOB, jamId);
    sockets.push(reader.socket);
    reader.socket.send(
      JSON.stringify({ type: "message-create", channelId: jamId, body: "alguém aí?", nonce: "jam-msg-1" }),
    );
    await waitFor(
      () => reader.frames.some((f) => f.type === "message-rejected"),
      10_000,
      "the refusal",
    );
    expect(reader.frames.find((f) => f.type === "message-rejected")).toMatchObject({
      reason: "no-access",
    });
    expect(reader.frames.some((f) => f.type === "message-broadcast")).toBe(false);
  }, 30_000);
});
