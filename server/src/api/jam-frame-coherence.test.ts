import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { jamFrameSchema, type JamFrame, type JamSongSummary, type JamTrack } from "@pqp/shared";

/**
 * A FRAME AND A READ CAN NEVER DISAGREE (docs/JAM_PUBLIC.md, "A frame is a read").
 *
 * QA of the phone apps found a song shown as "pronta" (or with the wrong "falta ...") for as long
 * as the wall was not read again: `jam-track-added` carried a summary computed BEFORE the take's
 * public row existed, when an outside take still looked like a part of the band, while every read
 * already left it out. Two real API processes on the Postgres bus (`CLUSTER_BUS=postgres`,
 * `VOICE_REGISTRY=postgres`, the way production runs), real sockets joined to the jam channel, and
 * for every frame a viewer receives, THAT viewer's own read of the song made right then:
 *
 * - the frame's summary is the read's summary, field for field (the song's own read and the
 *   channel's list), and
 * - the frame's track is in the viewer's read with the same `inMix` (a deleted track is not), so
 *   a frame adds nothing a read would not.
 *
 * For: an in-mix take, a waiting outside take, an accepted one, a refused one, an accept that was
 * undone, and a song edit with a take waiting. Then the two rules about the starter's live notice:
 * a starter who blocked the sender is not nudged (the take still waits in the inbox), and with
 * `jam_take_notices` off no notice frame reaches the starter at all (the inbox still lists it).
 */

function localTestDatabase(): string | undefined {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
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
const BUCKET = "jam-frames";

const ALICE = "dev-local-token:alice"; // the starter, owner of the server
const BOB = "dev-local-token:bob"; // another member of the server
const CAROL = "dev-local-token:carol"; // not in the server: records through public access
const DAVE = "dev-local-token:dave"; // not in the server; the starter blocks him

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

const objects = new Map<string, { type: string; body: Buffer }>();
let s3: Server;
let s3Endpoint = "";

async function startFakeS3(): Promise<void> {
  s3 = createServer((req, res) => {
    const key = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname.replace(`/${BUCKET}/`, ""));
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, { type: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
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
    JAM_PUBLIC: "",
    JAM_TAKE_NOTICES: "",
    JAM_PUBLIC_NEW_ACCOUNT_REVIEW: "false",
    READ_CACHE: "",
    LIVEKIT_URL: "",
    LIVE_HLS_ENABLED: "",
    WORKER_MODE: "",
    S3_ENDPOINT: s3Endpoint,
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: "jam-frames",
    S3_SECRET_ACCESS_KEY: "jam-frames-secret",
    S3_FORCE_PATH_STYLE: "true",
  };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const child = spawn(TSX, ["src/index.ts"], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
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

async function call<T = Record<string, any>>(
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Frame = Record<string, any>;

/** A signed-in socket, optionally joined to one channel, keeping every frame it is sent. */
interface Viewer {
  name: string;
  token: string;
  /** The API its socket is on; its reads go to the OTHER one, so a frame crossing the bus meets a read on the sibling. */
  home: Api;
  reads: Api;
  socket: WebSocket;
  frames: Frame[];
  cursor: number;
  /** Where the live take notices are read from, apart from the jam frames' cursor. */
  noticeCursor: number;
}

async function openViewer(name: string, token: string, home: Api, reads: Api, channelId: string | null): Promise<Viewer> {
  const frames: Frame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${home.port}/ws`);
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
  socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => frames.some((frame) => frame.type === "ready"), 10_000, `${name}: ready`);
  if (channelId) {
    socket.send(JSON.stringify({ type: "join-channel", channelId }));
    await waitFor(() => frames.some((frame) => String(frame.type).startsWith("presence")), 10_000, `${name}: the join`);
  }
  return { name, token, home, reads, socket, frames, cursor: frames.length, noticeCursor: frames.length };
}

/** The next jam frame of this type that this viewer is sent, after the ones already taken. */
async function nextFrame(viewer: Viewer, type: string): Promise<JamFrame> {
  let found: Frame | undefined;
  await waitFor(
    () => {
      const index = viewer.frames.findIndex((frame, at) => at >= viewer.cursor && frame.type === type);
      if (index === -1) {
        return false;
      }
      found = viewer.frames[index];
      viewer.cursor = index + 1;
      return true;
    },
    10_000,
    `${viewer.name}: ${type}`,
  );
  return jamFrameSchema.parse(found);
}

/** The take notices this viewer was sent live since the last time it asked (and forgets them). */
function takeNotices(viewer: Viewer): Frame[] {
  const notices = viewer.frames.filter((frame, at) => at >= viewer.noticeCursor && frame.type === "jam-public-notice" && frame.kind === "take");
  viewer.noticeCursor = viewer.frames.length;
  return notices;
}

describeDb("a jam frame and the same viewer's read, on two API processes", () => {
  let a: Api | undefined;
  let b: Api | undefined;
  let jamId: string;
  let songId: string;
  let carolId: string;
  let daveId: string;
  const viewers: Viewer[] = [];
  const kindsChecked = new Set<string>();

  const api = () => ({ a: a!, b: b! });

  async function upload(auth: string, on: Api): Promise<string> {
    const bytes = Buffer.from(`take ${Math.random()}`);
    const ticket = await call<{ uploadId: string; uploadUrl: string }>(
      on,
      "POST",
      `/api/jam-songs/${songId}/uploads`,
      auth,
      { kind: "audio", contentType: "audio/webm", byteSize: bytes.length },
    );
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const put = await fetch(ticket.body.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "audio/webm" },
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    return ticket.body.uploadId;
  }

  async function addTake(auth: string, on: Api, instrument: string) {
    const audioUploadId = await upload(auth, on);
    const reply = await call<{ track: JamTrack; song: JamSongSummary }>(on, "POST", `/api/jam-songs/${songId}/tracks`, auth, {
      instrument,
      audioUploadId,
      durationMs: 12_000,
      peaks: [0.2, 0.7],
      publicConsent: "yes",
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return { ...reply.body, audioUploadId };
  }

  /** What this viewer's own read says about the song right now. */
  async function readOf(viewer: Viewer) {
    const detail = await call<{ song: JamSongSummary; tracks: JamTrack[] }>(viewer.reads, "GET", `/api/jam-songs/${songId}`, viewer.token);
    const list = await call<{ songs: JamSongSummary[] }>(viewer.reads, "GET", `/api/channels/${jamId}/jam-songs`, viewer.token);
    return { status: detail.status, song: detail.body.song, tracks: detail.body.tracks ?? [], listed: list.body.songs.find((one) => one.id === songId) };
  }

  /** The frame is what the viewer's read says: the same summary, and no track the read does not have. */
  async function expectFrameIsTheRead(viewer: Viewer, frame: JamFrame): Promise<void> {
    kindsChecked.add(frame.type);
    const read = await readOf(viewer);
    if (frame.type === "jam-song-deleted") {
      expect(read.status, `${viewer.name} reads the deleted song`).toBe(404);
      return;
    }
    if (frame.type === "jam-track-votes") {
      return;
    }
    expect(read.status, `${viewer.name}: ${frame.type}`).toBe(200);
    expect(frame.song, `${viewer.name}: the ${frame.type} summary against their song read`).toEqual(read.song);
    expect(read.listed, `${viewer.name}: the ${frame.type} summary against their list read`).toEqual(frame.song);
    if (frame.type === "jam-track-deleted") {
      expect(read.tracks.map((track) => track.id), `${viewer.name}: a deleted track is not in the read`).not.toContain(frame.trackId);
      return;
    }
    if (frame.type === "jam-track-added" || frame.type === "jam-track-updated") {
      const same = read.tracks.find((track) => track.id === frame.track.id);
      expect(same, `${viewer.name}: the frame's track is in their read`).toBeDefined();
      expect(frame.track.inMix, `${viewer.name}: inMix of the frame's track`).toBe(same!.inMix);
      expect(frame.track.instrument).toBe(same!.instrument);
      expect(frame.track.authorId).toBe(same!.authorId);
    }
  }

  /** Both channel viewers get the frame, and for each of them it is their own read. */
  async function bothHear(type: JamFrame["type"]): Promise<JamFrame> {
    const [alice, bob] = viewers;
    const [forAlice, forBob] = await Promise.all([nextFrame(alice!, type), nextFrame(bob!, type)]);
    await expectFrameIsTheRead(alice!, forAlice);
    await expectFrameIsTheRead(bob!, forBob);
    expect(forBob).toEqual(forAlice);
    return forAlice;
  }

  beforeAll(async () => {
    await startFakeS3();
    process.env.DATABASE_URL = DATABASE_URL;
    const db = await import("../db.js");
    await db.initDb();
    await db
      .getPool()
      .query(`TRUNCATE users, servers, channels, feature_flags, feature_flag_overrides, feature_flag_audit RESTART IDENTITY CASCADE`);
    const { upsertUser } = await import("../services/users.js");
    const { createServer: createPqpServer, createChannel } = await import("../services/servers.js");
    const people: Record<string, { id: string }> = {};
    for (const name of ["alice", "bob", "carol", "dave"]) {
      people[name] = await upsertUser({ clerkId: `dev_local_user_${name}`, displayName: name, avatarUrl: null });
    }
    carolId = people.carol!.id;
    daveId = people.dave!.id;
    await db.getPool().query(`UPDATE users SET age_checked_at = NOW(), age_check_passed = TRUE, created_at = NOW() - INTERVAL '30 days'`);
    const created = await createPqpServer("Banda", people.alice!.id);
    await db
      .getPool()
      .query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`, [created.server.id, people.bob!.id]);
    jamId = (await createChannel(created.server.id, "jam", "jam")).id;
    await db.closePool();

    // One at a time: two boots running schema.sql at once contend for locks.
    a = await startApi("api-a");
    b = await startApi("api-b");

    for (const key of ["jam_channels", "jam_public", "jam_take_notices"]) {
      const flip = await call(a, "PUT", "/api/admin/flags", TOKEN, { key, enabled: true });
      expect(flip.status, key).toBe(200);
    }
    const off = await call(a, "PUT", "/api/admin/flags", TOKEN, { key: "jam_public_new_account_review", enabled: false });
    expect(off.status).toBe(200);
    // B hears the flips over the bus, not its ten minute timer.
    await waitFor(
      async () => (await call<{ enabled: boolean }>(b!, "GET", "/api/jam/config", BOB)).body.enabled === true,
      12_000,
      "jam_channels on api-b",
    );
    await waitFor(
      async () => (await call<{ enabled: boolean }>(b!, "GET", "/api/jam-public/config", BOB)).body.enabled === true,
      12_000,
      "jam_public on api-b",
    );

    // The starter's socket is on b and the other member's on a, so every frame crosses the bus to one of them.
    viewers.push(await openViewer("alice", ALICE, b, a, jamId));
    viewers.push(await openViewer("bob", BOB, a, b, jamId));
    // The outsider holds a socket and asks for the channel: it is not hers to join, and no jam frame ever reaches it.
    const carol = await openViewer("carol", CAROL, b, a, null);
    carol.socket.send(JSON.stringify({ type: "join-channel", channelId: jamId }));
    viewers.push(carol);
  }, 150_000);

  afterAll(async () => {
    for (const viewer of viewers) {
      viewer.socket.close();
    }
    await Promise.all([stopApi(a), stopApi(b)]);
    await new Promise<void>((done) => (s3 ? s3.close(() => done()) : done()));
  }, 30_000);

  it("an in-mix take, a waiting outside take, an accept, an undone accept and a refusal: every frame is the viewer's read", async () => {
    const { a: apiA, b: apiB } = api();

    // The starter's song, wanting bass and drums, with her own guitar take: in the mix.
    const created = await call<{ song: { id: string } }>(apiA, "POST", `/api/channels/${jamId}/jam-songs`, ALICE, {
      title: "Wonderwall",
      artist: "Oasis",
      joinMode: "wanted",
      wantedInstruments: ["bass", "drums"],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    songId = created.body.song.id;
    const own = await addTake(ALICE, apiA, "guitar");
    expect(own.track.inMix).toBe(true);
    const inMix = (await bothHear("jam-track-added")) as Extract<JamFrame, { type: "jam-track-added" }>;
    expect(inMix.song).toMatchObject({ instruments: ["guitar"], missingInstruments: ["bass", "drums"], trackCount: 1 });

    // She makes it public; an outsider records bass on it.
    const published = await call(apiA, "PUT", `/api/jam-songs/${songId}/public`, ALICE, {});
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    // A WAITING outside take: the band is still guitar alone, and what the song asks for is unchanged,
    // in the frame both members are sent, in the sender's own answer, and in every read.
    const waiting = await addTake(CAROL, apiA, "bass");
    expect(waiting.track.inMix).toBe(false);
    const added = (await bothHear("jam-track-added")) as Extract<JamFrame, { type: "jam-track-added" }>;
    expect(added.track.id).toBe(waiting.track.id);
    expect(added.track.inMix).toBe(false);
    expect(added.song).toMatchObject({ instruments: ["guitar"], missingInstruments: ["bass", "drums"], trackCount: 2 });
    // The sender's answer is her own public read.
    const carolRead = await call<{ song: JamSongSummary }>(apiB, "GET", `/api/jam-songs/${songId}`, CAROL);
    expect(waiting.song).toEqual(carolRead.body.song);
    expect(waiting.song).toMatchObject({ instruments: ["guitar"], missingInstruments: ["bass", "drums"] });
    // A RETRY of the same claim (the answer was lost): 200, the same track, and the room hears the take again
    // (a frame is applied by id), as the same read, so a first attempt that died after committing is made good.
    const retry = await call<{ track: JamTrack; song: JamSongSummary }>(apiB, "POST", `/api/jam-songs/${songId}/tracks`, CAROL, {
      instrument: "bass",
      audioUploadId: waiting.audioUploadId,
      durationMs: 12_000,
      peaks: [0.2, 0.7],
      publicConsent: "yes",
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.track.id).toBe(waiting.track.id);
    expect(retry.body.song).toEqual(carolRead.body.song);
    const again = (await bothHear("jam-track-added")) as Extract<JamFrame, { type: "jam-track-added" }>;
    expect(again.track.id).toBe(waiting.track.id);
    expect(again.song).toMatchObject({ instruments: ["guitar"], missingInstruments: ["bass", "drums"], trackCount: 2 });
    // The starter is told live (over the bus: the take landed on api-a, her socket is on api-b) and the inbox has it.
    await waitFor(() => viewers[0]!.frames.some((f) => f.type === "jam-public-notice" && f.kind === "take"), 10_000, "the starter's notice");
    expect(takeNotices(viewers[0]!)).toMatchObject([{ songId, instrument: "bass", admitted: false, trackId: waiting.track.id }]);

    // ACCEPTED: bass is in the band and no longer missing.
    expect((await call(apiB, "PATCH", `/api/jam-tracks/${waiting.track.id}`, ALICE, { inMix: true })).status).toBe(200);
    const accepted = (await bothHear("jam-track-updated")) as Extract<JamFrame, { type: "jam-track-updated" }>;
    expect(accepted.track.inMix).toBe(true);
    expect(accepted.song).toMatchObject({ instruments: ["guitar", "bass"], missingInstruments: ["drums"] });

    // UNDONE: the take goes back to waiting, and the song asks for bass again.
    expect((await call(apiA, "PATCH", `/api/jam-tracks/${waiting.track.id}`, ALICE, { inMix: false })).status).toBe(200);
    const undone = (await bothHear("jam-track-updated")) as Extract<JamFrame, { type: "jam-track-updated" }>;
    expect(undone.track.inMix).toBe(false);
    expect(undone.song).toMatchObject({ instruments: ["guitar"], missingInstruments: ["bass", "drums"] });

    // A song edit with a take waiting: the summary of the update frame is the read's as well.
    expect((await call(apiB, "PATCH", `/api/jam-songs/${songId}`, ALICE, { title: "Wonderwall (ao vivo)" })).status).toBe(200);
    const edited = (await bothHear("jam-song-updated")) as Extract<JamFrame, { type: "jam-song-updated" }>;
    expect(edited.song).toMatchObject({ title: "Wonderwall (ao vivo)", instruments: ["guitar"], missingInstruments: ["bass", "drums"] });

    // REFUSED: the starter deletes the waiting take; the track is gone from both reads and the song is unchanged.
    expect((await call(apiA, "DELETE", `/api/jam-tracks/${waiting.track.id}`, ALICE)).status).toBe(204);
    const refused = (await bothHear("jam-track-deleted")) as Extract<JamFrame, { type: "jam-track-deleted" }>;
    expect(refused.trackId).toBe(waiting.track.id);
    expect(refused.song).toMatchObject({ instruments: ["guitar"], missingInstruments: ["bass", "drums"], trackCount: 1 });

    // The outsider was never sent a channel frame: her read of the channel is not hers to hear about.
    expect(viewers[2]!.frames.filter((frame) => /^jam-(song|track)-/.test(String(frame.type)))).toEqual([]);
    expect(carolId).toBeTruthy();
  }, 90_000);

  it("a starter who blocked the sender gets no live notice; the take still shows to the members and waits in the inbox", async () => {
    const { a: apiA, b: apiB } = api();
    expect((await call(apiA, "POST", "/api/blocks", ALICE, { userId: daveId })).status).toBe(201);
    takeNotices(viewers[0]!);

    const blocked = await addTake(DAVE, apiB, "drums");
    // A frame is a read for the members, blocked sender or not (a block hides nothing from the room).
    const added = (await bothHear("jam-track-added")) as Extract<JamFrame, { type: "jam-track-added" }>;
    expect(added.track.id).toBe(blocked.track.id);
    expect(added.song).toMatchObject({ instruments: ["guitar"], missingInstruments: ["bass", "drums"] });
    // But no nudge for the starter: no "new part" frame (give a late bus delivery its time), no item, no push.
    await pause(700);
    expect(takeNotices(viewers[0]!)).toEqual([]);
    expect((await call<{ notices: unknown[] }>(apiA, "GET", "/api/jam-public/notices", ALICE)).body.notices).toEqual([]);
    // The inbox is state: it lists the take, so the starter can still refuse it.
    const inbox = await call<{ takes: Array<{ track: { id: string } }> }>(apiB, "GET", "/api/jam-public/inbox", ALICE);
    expect(inbox.body.takes.map((item) => item.track.id)).toEqual([blocked.track.id]);
    expect((await call(apiA, "DELETE", `/api/jam-tracks/${blocked.track.id}`, ALICE)).status).toBe(204);
    await bothHear("jam-track-deleted");
    expect((await call(apiA, "DELETE", `/api/blocks/${daveId}`, ALICE)).status).toBe(200);
  }, 60_000);

  it("jam_take_notices off: no notice frame and no card reach the starter, the inbox still lists the take; on again, they do", async () => {
    const { a: apiA, b: apiB } = api();
    const alice = viewers[0]!;
    // Something to read through: with the flag on, a waiting take is an item for the starter on both machines.
    const before = await addTake(CAROL, apiA, "drums");
    await bothHear("jam-track-added");
    await waitFor(
      async () => (await call<{ notices: unknown[] }>(apiB, "GET", "/api/jam-public/notices", ALICE)).body.notices.length === 1,
      10_000,
      "the item on api-b",
    );
    takeNotices(alice);

    const off = await call(apiA, "PUT", "/api/admin/flags", TOKEN, { key: "jam_take_notices", enabled: false });
    expect(off.status).toBe(200);
    // Both machines read the row (the bus carries it): the starter's notices read is empty on each.
    for (const on of [apiA, apiB]) {
      await waitFor(
        async () => (await call<{ notices: unknown[] }>(on, "GET", "/api/jam-public/notices", ALICE)).body.notices.length === 0,
        10_000,
        `the flag off on ${on.name}`,
      );
    }

    // A take lands on each machine while it is off.
    const second = await addTake(CAROL, apiA, "bass");
    await bothHear("jam-track-added");
    const third = await addTake(BOB, apiB, "drums");
    await bothHear("jam-track-added");
    await pause(700);
    expect(takeNotices(alice), "no live notice while the flag is off").toEqual([]);
    for (const on of [apiA, apiB]) {
      expect((await call<{ notices: unknown[] }>(on, "GET", "/api/jam-public/notices", ALICE)).body.notices).toEqual([]);
    }
    // The waiting strip and the song's block read the inbox, which does not depend on the switch. (Bob is a member:
    // his take is a channel take, a second drums one so it waits by the channel's own rule, and is not a request.)
    const inbox = await call<{ takes: Array<{ track: { id: string } }> }>(apiB, "GET", "/api/jam-public/inbox", ALICE);
    expect(inbox.body.takes.map((item) => item.track.id).sort()).toEqual([before.track.id, second.track.id].sort());
    expect(inbox.body.takes.map((item) => item.track.id)).not.toContain(third.track.id);

    // On again: the next outside take is announced, live and as an item.
    const on = await call(apiA, "PUT", "/api/admin/flags", TOKEN, { key: "jam_take_notices", enabled: true });
    expect(on.status).toBe(200);
    for (const instance of [apiA, apiB]) {
      await waitFor(
        async () => (await call<{ notices: unknown[] }>(instance, "GET", "/api/jam-public/notices", ALICE)).body.notices.length === 1,
        10_000,
        `the flag on on ${instance.name}`,
      );
    }
    takeNotices(alice);
    const last = await addTake(CAROL, apiB, "bass");
    await bothHear("jam-track-added");
    await waitFor(() => alice.frames.some((f, at) => at >= alice.noticeCursor && f.type === "jam-public-notice" && f.kind === "take"), 10_000, "the notice, flag on");
    expect(takeNotices(alice)).toMatchObject([{ songId, instrument: "bass", trackId: last.track.id }]);
  }, 90_000);

  it("the song's deletion is the viewer's read too, and every frame kind a write sends was checked", async () => {
    const { a: apiA } = api();
    // The starter takes the song down (she may delete it with takes still waiting).
    expect((await call(apiA, "DELETE", `/api/jam-songs/${songId}`, ALICE)).status).toBe(204);
    await bothHear("jam-song-deleted");
    expect([...kindsChecked].sort()).toEqual(
      ["jam-song-deleted", "jam-song-updated", "jam-track-added", "jam-track-deleted", "jam-track-updated"].sort(),
    );
  }, 60_000);
});
