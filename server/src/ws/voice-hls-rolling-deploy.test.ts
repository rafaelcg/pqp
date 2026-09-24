import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WebSocket } from "ws";
import { EgressStatus } from "livekit-server-sdk";
import type { DbUser } from "../db.js";
import { createMemoryHub } from "../lib/bus.js";

/**
 * A ROLLING DEPLOY MID-SHOW MUST NOT END THE SHOW.
 *
 * The 2026-09-24 rehearsal (channel `ad99074f`, two API replicas on one box)
 * lost its broadcast twice in one rolling deploy, and then never got it back:
 *
 *  1. api-a restarted and its new process ADOPTED the running ladder at boot.
 *     The presenter's socket resumed on api-b. api-b refused to adopt a
 *     session a live machine owned (correct), and api-a, seeing no sharer
 *     among ITS OWN peers, ended the session five seconds later
 *     (`hlsStopped reason=no-share`).
 *  2. The presenter then resumed on api-a, which started a brand-new session;
 *     a minute later the socket moved to api-b again and the same thing
 *     happened. After that nothing restarted it at all: the host was "live
 *     and sharing" with no stream for three minutes.
 *
 * This file plays that deploy with two (then three, then four) real module
 * graphs of the whole voice stack over one memory bus and one real Postgres,
 * `VOICE_REGISTRY=postgres` and the bus on, which is what production runs
 * (pitfall 12). Each graph is one API process: its own peers, its own
 * `rooms`, its own instance id and heartbeat. A "restart" is the real
 * sequence: the process's sockets close with the seat held for resume, the
 * process dies (lease withdrawn, bus closed), a new graph boots and runs the
 * boot reconcile, and the presenter's client resumes its seat on whichever
 * machine it lands on.
 *
 * The media box is one fake shared by every graph, the way the real one is
 * shared by both replicas: it lists, starts and stops egresses (and pqp-remux
 * sessions for the LL half), and a running one's playlist advances with the
 * clock. The viewer polls that playlist throughout and the assertions are the
 * ones the audience cares about: the SAME session the whole way through,
 * its media sequence always moving, exactly one ladder running at every
 * sample (never zero, never two), nothing stopped, nothing ended, and no row
 * closed. And then the other half: a presenter who really stops sharing still
 * ends the broadcast within the ordinary grace.
 *
 * Skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/log.js")>();
  return { ...actual, logEvent };
});

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "livekit",
  isLiveKitConfigured: () => true,
}));

vi.mock("../services/users.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/users.js")>();
  return {
    ...actual,
    resolveMemberName: async (
      _serverId: string | null,
      user: { id: string; display_name: string },
    ) => user.display_name,
    canAccessChannel: async () => true,
  };
});

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => (1n << 64n) - 1n,
  resolveMemberChannelPermissions: async () => ({
    permissions: (1n << 64n) - 1n,
    nickname: null,
  }),
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  resolveRingableConversation: async () => null,
}));

/** The real server and channel rows, created per test (the session rows need them). */
const fixture = vi.hoisted(() => ({ serverId: "", channelId: "" }));

vi.mock("../services/servers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/servers.js")>();
  return {
    ...actual,
    getChannel: async (id: string) => ({
      id,
      kind: "server",
      type: "watch_party",
      server_id: fixture.serverId,
      voice_transport: "livekit",
    }),
    getChannelAudience: async () => ({
      serverId: fixture.serverId,
      kind: "server",
      has: () => true,
      userIds: [],
    }),
    getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 50 }),
  };
});

vi.mock("../voice/admin.js", () => ({
  cancelSfuPrivateResweep: vi.fn(),
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

// ---------------------------------------------------------------------------
// The media box: one for the whole cluster, as in production.
// ---------------------------------------------------------------------------

interface BoxEgress {
  egressId: string;
  room: string;
  /** `live/<channel>/<startedAt>-<rung>`, parsed back out of the output. */
  startedAt: number;
  rung: string;
  startedMs: number;
  stoppedMs: number | null;
}

interface BoxRemux {
  sessionId: string;
  room: string;
  startedMs: number;
  stoppedMs: number | null;
}

const box = {
  egresses: new Map<string, BoxEgress>(),
  remux: new Map<string, BoxRemux>(),
  starts: [] as string[],
  stops: [] as string[],
  remuxStarts: [] as string[],
  remuxStops: [] as string[],
  /** Whether the presenter's screen track is published on the SFU. */
  screenPublished: true,
  next: 0,
  reset() {
    this.egresses.clear();
    this.remux.clear();
    this.starts = [];
    this.stops = [];
    this.remuxStarts = [];
    this.remuxStops = [];
    this.screenPublished = true;
    this.next = 0;
  },
};

const fakeEgress = {
  startTrackCompositeEgress: async (
    roomName: string,
    output: { filenamePrefix?: string },
  ) => {
    box.next += 1;
    const egressId = `EG_${box.next}`;
    const match = /\/(\d+)-([a-z0-9]+)$/.exec(output.filenamePrefix ?? "");
    box.egresses.set(egressId, {
      egressId,
      room: roomName,
      startedAt: Number(match?.[1] ?? 0),
      rung: match?.[2] ?? "?",
      startedMs: Date.now(),
      stoppedMs: null,
    });
    box.starts.push(egressId);
    return { egressId };
  },
  stopEgress: async (egressId: string) => {
    const egress = box.egresses.get(egressId);
    if (egress && egress.stoppedMs === null) {
      egress.stoppedMs = Date.now();
    }
    box.stops.push(egressId);
  },
  listEgress: async () =>
    [...box.egresses.values()]
      .filter((egress) => egress.stoppedMs === null)
      .map((egress) => ({
        egressId: egress.egressId,
        status: EgressStatus.EGRESS_ACTIVE,
        roomName: egress.room,
        startedAt: egress.startedMs,
      })),
};

const REMUX_CONTROL = "https://egress.example.test:8443";

/** `pqp-remuxd`'s control API, over the same `fetch` seam the real client uses. */
async function fakeRemuxApi(url: string, init: RequestInit): Promise<Response> {
  const path = url.slice(REMUX_CONTROL.length);
  const method = (init.method ?? "GET").toUpperCase();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const describeSession = (session: BoxRemux) => ({
    sessionId: session.sessionId,
    room: session.room,
    channelId: session.room,
    subscribed: true,
    startedAtMs: session.startedMs,
    lastPartAtMs: Date.now(),
    lastIdrAtMs: Date.now(),
    openSegmentMs: null,
    partsWritten: 1 + Math.floor((Date.now() - session.startedMs) / 100),
    bytesServed: 0,
    state: "running",
    demoted: false,
    demotedReason: null,
  });
  if (method === "GET" && path === "/sessions") {
    return json({
      sessions: [...box.remux.values()]
        .filter((session) => session.stoppedMs === null)
        .map(describeSession),
    });
  }
  if (method === "POST" && path === "/sessions") {
    const body = JSON.parse(String(init.body)) as { sessionId: string; room: string };
    const existing = box.remux.get(body.sessionId);
    if (!existing || existing.stoppedMs !== null) {
      box.remux.set(body.sessionId, {
        sessionId: body.sessionId,
        room: body.room,
        startedMs: Date.now(),
        stoppedMs: null,
      });
      box.remuxStarts.push(body.sessionId);
    }
    return json(describeSession(box.remux.get(body.sessionId)!), 201);
  }
  if (method === "DELETE" && path.startsWith("/sessions/")) {
    const id = path.slice("/sessions/".length);
    const session = box.remux.get(id);
    if (session && session.stoppedMs === null) {
      session.stoppedMs = Date.now();
    }
    box.remuxStops.push(id);
    return new Response(null, { status: 204 });
  }
  return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// One graph per API process.
// ---------------------------------------------------------------------------

type BusModule = typeof import("../lib/bus.js");
type VoiceModule = typeof import("./voice.js");
type SocketsModule = typeof import("./sockets.js");
type EgressModule = typeof import("../voice/hls-egress.js");
type RemuxModule = typeof import("../voice/hls-remux.js");
type CleanupModule = typeof import("../voice/hls-cleanup.js");
type RegistryModule = typeof import("../voice/registry.js");
type DbModule = typeof import("../db.js");

interface Instance {
  name: string;
  bus: BusModule;
  voice: VoiceModule;
  sockets: SocketsModule;
  egress: EgressModule;
  remux: RemuxModule;
  cleanup: CleanupModule;
  registry: RegistryModule;
  db: DbModule;
  dead: boolean;
}

let hub = createMemoryHub();
const pools: DbModule[] = [];
const booted: Instance[] = [];

/**
 * A process starting: its own module graph, joined to the cluster bus, its
 * heartbeat written, and the boot reconcile run exactly as `index.ts` runs it
 * (conventional adoption, then the LL one).
 */
async function bootInstance(name: string): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const voice = (await import("./voice.js")) as VoiceModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  const egress = (await import("../voice/hls-egress.js")) as EgressModule;
  const remux = (await import("../voice/hls-remux.js")) as RemuxModule;
  const cleanup = (await import("../voice/hls-cleanup.js")) as CleanupModule;
  const registry = (await import("../voice/registry.js")) as RegistryModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  egress.setLiveHlsTestHooks({
    egress: fakeEgress,
    findTracks: async () =>
      box.screenPublished
        ? { videoTrackId: "TR_SCREEN", audioTrackId: "TR_MUSIC", sourceHeight: 720 }
        : null,
    playlistReady: true,
  });
  remux.setHlsRemuxTestHooks({ fetch: fakeRemuxApi });
  await registry.heartbeatVoiceInstance();
  const instance: Instance = {
    name,
    bus,
    voice,
    sockets,
    egress,
    remux,
    cleanup,
    registry,
    db,
    dead: false,
  };
  booted.push(instance);
  await cleanup.reconcileStaleHlsSessions();
  if (remux.isLiveHlsLLEnabled()) {
    await remux.adoptLlHlsSessions();
  }
  return instance;
}

/**
 * A process going away the way a deploy takes it: every socket closes with
 * the seat held for resume (what the drain's 1001 does), the lease is
 * withdrawn (`shutdown` in `index.ts`), and nothing it held in memory
 * survives. The media box is untouched.
 */
async function drainAndKill(instance: Instance, sockets: WebSocket[]): Promise<void> {
  for (const socket of sockets) {
    instance.voice.removeVoicePeerBySocket(socket);
  }
  await instance.registry.settleVoiceRegistryWrites();
  instance.dead = true;
  instance.voice.resetVoicePeers();
  instance.egress.resetLiveHlsForTests();
  await instance.bus.closeBus();
  await pools[0]!.getPool().query(
    `DELETE FROM voice_instances WHERE instance_id = $1`,
    [instance.bus.INSTANCE_ID],
  );
  await instance.db.closePool().catch(() => undefined);
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

function recorder(): { socket: WebSocket; frames: Frame[] } {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
    close: () => {},
  } as unknown as WebSocket;
  return { socket, frames };
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      if (process.env.DEBUG_DRILL) {
        for (const [name, detail] of logEvent.mock.calls) {
          if (/hls|resume|Resume|orphan/i.test(String(name))) {
            console.error(name, JSON.stringify(detail).slice(0, 300));
          }
        }
      }
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Presenter {
  userId: string;
  peerId: string;
  resumeToken: string;
  socket: WebSocket;
}

async function presenterJoinsAndShares(
  instance: Instance,
  userId: string,
  channel: string,
): Promise<Presenter> {
  const rec = recorder();
  const user = asUser(userId);
  instance.sockets.setAuthenticatedSocket(rec.socket, user);
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user },
    { type: "join-voice-room", voiceChannelId: channel, resume: true },
  );
  const welcome = rec.frames.find((frame) => frame.type === "welcome");
  if (!welcome) {
    throw new Error(`join was refused: ${JSON.stringify(rec.frames)}`);
  }
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user },
    { type: "set-sharing-screen", sharing: true },
  );
  return {
    userId,
    peerId: welcome.peerId as string,
    resumeToken: welcome.resumeToken as string,
    socket: rec.socket,
  };
}

/** The presenter's client reconnecting and resuming its seat on `instance`. */
async function presenterResumes(
  instance: Instance,
  presenter: Presenter,
  channel: string,
): Promise<void> {
  const rec = recorder();
  const user = asUser(presenter.userId);
  instance.sockets.setAuthenticatedSocket(rec.socket, user);
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user },
    {
      type: "join-voice-room",
      voiceChannelId: channel,
      resume: true,
      resumePeerId: presenter.peerId,
      resumeToken: presenter.resumeToken,
    },
  );
  const welcome = rec.frames.find((frame) => frame.type === "welcome");
  if (!welcome || welcome.peerId !== presenter.peerId || welcome.resumed !== true) {
    throw new Error(`resume did not reattach the seat: ${JSON.stringify(rec.frames)}`);
  }
  presenter.socket = rec.socket;
  if (typeof welcome.resumeToken === "string") {
    presenter.resumeToken = welcome.resumeToken;
  }
  // What every client does after a resume: re-declare its state, the share
  // included. This is the frame that reached `pushLiveHls` on api-b at
  // 06:00:42.936 in the rehearsal.
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user },
    { type: "set-sharing-screen", sharing: true },
  );
}

/** A viewer with a seat arriving and leaving: both reach `pushLiveHls`. */
async function viewerVisits(instance: Instance, channel: string): Promise<void> {
  const rec = recorder();
  const user = asUser(randomUUID());
  instance.sockets.setAuthenticatedSocket(rec.socket, user);
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user },
    { type: "join-voice-room", voiceChannelId: channel, resume: true },
  );
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user },
    { type: "leave-voice-room" },
  );
  await instance.registry.settleVoiceRegistryWrites();
}

function owners(channel: string): string[] {
  return booted
    .filter((instance) => !instance.dead && instance.egress.liveHlsOwnsChannel(channel))
    .map((instance) => instance.name);
}

/**
 * What the audience sees, sampled every 25 ms for the whole drill: which
 * session is on the box for this channel, how many ladders are running, and
 * the playlist's media sequence, which advances only while its transcode is
 * alive.
 */
function startViewer(channel: string, mode: "conventional" | "ll") {
  const samples: { at: number; sessions: number[]; running: number; sequence: number | null }[] = [];
  const read = () => {
    const now = Date.now();
    if (mode === "conventional") {
      const live = [...box.egresses.values()].filter(
        (egress) => egress.room === channel && egress.stoppedMs === null,
      );
      const sessions = [...new Set(live.map((egress) => egress.startedAt))];
      const primary = live.sort((a, b) => a.startedMs - b.startedMs)[0];
      samples.push({
        at: now,
        sessions,
        running: sessions.length,
        sequence: primary ? Math.floor((now - primary.startedMs) / 25) : null,
      });
    } else {
      const live = [...box.remux.values()].filter(
        (session) => session.room === channel && session.stoppedMs === null,
      );
      samples.push({
        at: now,
        sessions: live.map((session) => session.startedMs),
        running: live.length,
        sequence: live[0] ? Math.floor((now - live[0].startedMs) / 25) : null,
      });
    }
  };
  read();
  const timer = setInterval(read, 25);
  return {
    samples,
    stop: () => {
      clearInterval(timer);
      read();
    },
  };
}

async function sessionRows(channel: string) {
  const result = await pools[0]!.getPool().query<{
    object_prefix: string;
    ended_at: Date | null;
    instance_id: string | null;
    mode: string;
  }>(
    `SELECT object_prefix, ended_at, instance_id, mode
       FROM hls_sessions WHERE channel_id = $1 ORDER BY object_prefix`,
    [channel],
  );
  return result.rows;
}

const ENV_KEYS = [
  "VOICE_REGISTRY",
  "HLS_NO_SHARER_GRACE_MS",
  "LIVE_HLS_ENABLED",
  "LIVE_HLS_PUBLIC_BASE_URL",
  "LIVE_HLS_S3_BUCKET",
  "LIVE_HLS_S3_ACCESS_KEY_ID",
  "LIVE_HLS_S3_SECRET_ACCESS_KEY",
  "LIVE_HLS_S3_ENDPOINT",
  "LIVE_HLS_LADDER",
  "LIVE_HLS_LL",
  "LIVE_HLS_REMUX_CONTROL_URL",
  "LIVE_HLS_REMUX_CONTROL_SECRET",
  "LIVE_HLS_REMUX_ORIGIN_URL",
  "LIVE_HLS_PLAYLIST_BASE_URL",
] as const;
const savedEnv = new Map<string, string | undefined>();

describeDb("a watch party survives a rolling deploy of both API machines", () => {
  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    pools.push(db);
  });

  afterAll(async () => {
    await Promise.all(pools.map((db) => db.closePool().catch(() => undefined)));
  });

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
    }
    process.env.VOICE_REGISTRY = "postgres";
    // SHORT ON PURPOSE. The grace is what ended the rehearsal's party, and at
    // five seconds a regression would only show up if the drill happened to
    // outlast it. At 300 ms the old behaviour ends the session inside every
    // single step below, so this file cannot pass by being quick.
    process.env.HLS_NO_SHARER_GRACE_MS = "300";
    process.env.LIVE_HLS_ENABLED = "true";
    process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    process.env.LIVE_HLS_LADDER = "720p30,480p30";
    hub = createMemoryHub();
    box.reset();
    logEvent.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pool = pools[0]!.getPool();
    await pool.query(
      `TRUNCATE voice_rooms, voice_peers, voice_retired_peers, voice_instances,
                hls_sessions, channel_sessions, users, servers, channels
       RESTART IDENTITY CASCADE`,
    );
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id, display_name, username, discriminator)
       VALUES ($1, 'Host', $1, '0001') RETURNING id`,
      [`clerk_${randomUUID().slice(0, 8)}`],
    );
    const server = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Ensaio', $1) RETURNING id`,
      [owner.rows[0]!.id],
    );
    fixture.serverId = server.rows[0]!.id;
    const channel = await pool.query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'cinema', 'watch_party', 0) RETURNING id`,
      [fixture.serverId],
    );
    fixture.channelId = channel.rows[0]!.id;
  });

  afterEach(async () => {
    for (const instance of booted) {
      if (instance.dead) {
        continue;
      }
      instance.voice.resetVoicePeers();
      instance.egress.resetLiveHlsForTests();
      await instance.bus.closeBus();
      await instance.db.closePool().catch(() => undefined);
    }
    booted.length = 0;
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  async function drill(mode: "conventional" | "ll") {
    const channel = fixture.channelId;
    const a1 = await bootInstance("api-a#1");
    const b1 = await bootInstance("api-b#1");
    const presenter = await presenterJoinsAndShares(a1, randomUUID(), channel);

    await waitFor(() => owners(channel).length === 1, "the show to go live");
    expect(owners(channel)).toEqual(["api-a#1"]);
    const liveStream =
      a1.egress.liveHlsStreamFor(channel) ?? a1.remux.llStreamFor(channel);
    expect(liveStream?.mode ?? "conventional").toBe(mode);
    const startedAt = liveStream!.startedAt;
    const startsAtGoLive = mode === "conventional" ? box.starts.length : box.remuxStarts.length;
    expect(startsAtGoLive).toBeGreaterThan(0);
    // The other machine has heard about the party (its audience needs it).
    await waitFor(
      async () => (await b1.voice.getChannelLiveState(channel)).stream?.startedAt === startedAt,
      "api-b to learn the show is live",
    );

    const viewer = startViewer(channel, mode);
    const ownership: string[][] = [];
    const watchOwners = setInterval(() => ownership.push(owners(channel)), 25);

    // ---- api-a restarts. Its new process adopts the ladder at boot, and the
    // presenter's socket resumes on api-b: the rehearsal's first failure.
    await drainAndKill(a1, [presenter.socket]);
    const a2 = await bootInstance("api-a#2");
    expect(owners(channel)).toEqual(["api-a#2"]);
    await presenterResumes(b1, presenter, channel);
    await waitFor(() => owners(channel).join() === "api-b#1", "the session to follow the presenter to api-b");
    // Longer than the grace that used to end it, with the presenter on api-b.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(owners(channel)).toEqual(["api-b#1"]);

    // ---- api-b restarts. Its new process adopts at boot BEFORE the presenter
    // is back, and the presenter lands on api-a#2.
    await drainAndKill(b1, [presenter.socket]);
    const b2 = await bootInstance("api-b#2");
    expect(owners(channel)).toEqual(["api-b#2"]);
    // A beat with the presenter nowhere at all, while the audience keeps
    // arriving on api-b#2 (every join and leave reconciles the channel, which
    // is how the rehearsal's owner found "no sharer" in the first place). The
    // seat is held for resume, so the broadcast is too.
    await viewerVisits(b2, channel);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await viewerVisits(b2, channel);
    await b2.voice.sweepHlsSharersWithoutSession();
    expect(owners(channel)).toEqual(["api-b#2"]);
    await presenterResumes(a2, presenter, channel);
    await waitFor(() => owners(channel).join() === "api-a#2", "the session to follow the presenter to api-a#2");

    // ---- no deploy, just a blip: the presenter's socket drops on api-a#2
    // and reconnects through the proxy to api-b#2, both machines alive. The
    // rehearsal's second failure.
    a2.voice.removeVoicePeerBySocket(presenter.socket);
    await a2.registry.settleVoiceRegistryWrites();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(owners(channel)).toEqual(["api-a#2"]);
    await presenterResumes(b2, presenter, channel);
    await waitFor(() => owners(channel).join() === "api-b#2", "the session to follow the presenter to api-b#2");
    await new Promise((resolve) => setTimeout(resolve, 800));
    // And the sweep, run on both machines, changes nothing on a healthy party.
    await a2.voice.sweepHlsSharersWithoutSession();
    await b2.voice.sweepHlsSharersWithoutSession();

    clearInterval(watchOwners);
    viewer.stop();

    // ---- what the audience saw.
    const samples = viewer.samples;
    expect(samples.length).toBeGreaterThan(100);
    // Exactly one ladder at every sample: never zero, never two.
    expect(samples.filter((sample) => sample.running !== 1)).toEqual([]);
    // The same session all the way through, so no viewer reloaded anything.
    const sessions = new Set(samples.flatMap((sample) => sample.sessions));
    expect(sessions.size).toBe(1);
    // And its playlist kept moving.
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!.sequence!).toBeGreaterThanOrEqual(samples[i - 1]!.sequence!);
    }
    expect(samples.at(-1)!.sequence! - samples[0]!.sequence!).toBeGreaterThan(100);
    // At most one machine monitoring it at any moment (zero only in the
    // instant between a handover's release and the adoption).
    expect(ownership.filter((names) => names.length > 1)).toEqual([]);
    // Nothing started after go-live, nothing stopped, no row closed.
    expect(mode === "conventional" ? box.starts.length : box.remuxStarts.length).toBe(startsAtGoLive);
    expect(box.stops).toEqual([]);
    expect(box.remuxStops).toEqual([]);
    const rows = await sessionRows(channel);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.ended_at !== null)).toEqual([]);
    expect(rows.every((row) => row.instance_id === b2.bus.INSTANCE_ID)).toBe(true);
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsStopped", expect.anything());
    expect(logEvent).not.toHaveBeenCalledWith("voice.hlsLlStopped", expect.anything());
    // The paths that did it, counted where they ran.
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsHandedOver",
      expect.objectContaining({ channelId: channel, mode }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsSharerHeld",
      expect.objectContaining({ channelId: channel, reason: "seat-orphaned" }),
    );

    // ---- and a presenter who REALLY stops sharing still ends it promptly.
    const stoppedAt = Date.now();
    await b2.voice.handleVoiceMessage(
      { socket: presenter.socket, user: asUser(presenter.userId) },
      { type: "set-sharing-screen", sharing: false },
    );
    await waitFor(
      () =>
        mode === "conventional"
          ? [...box.egresses.values()].every((egress) => egress.stoppedMs !== null)
          : [...box.remux.values()].every((session) => session.stoppedMs !== null),
      "a genuine end of share to end the broadcast",
    );
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    expect(owners(channel)).toEqual([]);
    return { startedAt };
  }

  it("conventional ladder: the same session, one ladder, a moving playlist, through both restarts and a blip", async () => {
    await drill("conventional");
  }, 60_000);

  it("low-latency (pqp-remux): the same, for an LL session", async () => {
    process.env.LIVE_HLS_LL = "true";
    process.env.LIVE_HLS_REMUX_CONTROL_URL = REMUX_CONTROL;
    process.env.LIVE_HLS_REMUX_CONTROL_SECRET = "test-remux-secret";
    process.env.LIVE_HLS_REMUX_ORIGIN_URL = "https://hls-origin.example.test";
    // The edge front: nothing else can serve an LL playlist, so without it
    // the mode resolves to the ladder (`llPlaylistFrontConfigured`).
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    const pool = pools[0]!.getPool();
    const host = await pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM servers WHERE id = $1`,
      [fixture.serverId],
    );
    await pool.query(
      `INSERT INTO channel_sessions
         (channel_id, title, status, created_by, low_latency_requested)
       VALUES ($1, 'Ensaio', 'live', $2, TRUE)`,
      [fixture.channelId, host.rows[0]!.owner_id],
    );
    await drill("ll");
  }, 60_000);

  it("a session whose rows never landed is not handed over: it stays where it is monitored", async () => {
    const channel = fixture.channelId;
    const a = await bootInstance("api-a");
    const b = await bootInstance("api-b");
    // A room in memory with no `hls_sessions` row behind it (its insert
    // failed at start). Nothing anywhere could adopt it.
    const startedAt = Date.now() - 30_000;
    a.egress.adoptLiveHlsSession({
      channelId: channel,
      egressId: "EG_rowless",
      startedAt,
      presenterPeerId: "peer-presenter",
      videoTrackId: "TR_SCREEN",
      rung: "480p30",
    });

    const released = await a.egress.releaseLiveHlsSession({
      channelId: channel,
      startedAt,
      toInstanceId: b.bus.INSTANCE_ID,
      presenterPeerId: "peer-presenter",
    });

    expect(released).toBe(false);
    expect(owners(channel)).toEqual(["api-a"]);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsHandoverCancelled",
      expect.objectContaining({ channelId: channel, reason: "no-session-row" }),
    );
  }, 30_000);

  it("rows left naming a machine that holds nothing are given back to the machine with the presenter", async () => {
    const channel = fixture.channelId;
    const a = await bootInstance("api-a");
    const b = await bootInstance("api-b");
    // A handover landed on api-b after the presenter had already moved on,
    // so nothing was adopted: the rows name api-b, api-b holds no room, and
    // the presenter is sharing on api-a.
    const rec = recorder();
    const userId = randomUUID();
    a.sockets.setAuthenticatedSocket(rec.socket, asUser(userId));
    await a.voice.handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "join-voice-room", voiceChannelId: channel, resume: true },
    );
    const peerId = rec.frames.find((frame) => frame.type === "welcome")!.peerId as string;
    const startedAt = Date.now() - 60_000;
    const egressId = (
      await fakeEgress.startTrackCompositeEgress(channel, {
        filenamePrefix: `live/${channel}/${startedAt}-480p30`,
      })
    ).egressId;
    await pools[0]!.getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, egress_id, presenter_peer_id,
          video_track_id, audio_track_id, rung, instance_id)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, 'TR_SCREEN', 'TR_MUSIC', '480p30', $6)`,
      [channel, `live/${channel}/${startedAt}-480p30`, startedAt, egressId, peerId, b.bus.INSTANCE_ID],
    );
    // api-a has been told there is a party (it relays only then).
    a.bus.publishToCluster(a.voice.VOICE_LIVE_TOPIC, {
      channelId: channel,
      stream: {
        hlsUrl: `/api/voice/hls-playlist/${channel}/${startedAt}`,
        startedAt,
        presenterPeerId: peerId,
        delaySeconds: 10,
      },
      endsStartedAt: null,
      at: Date.now(),
    });
    b.bus.publishToCluster(b.voice.VOICE_LIVE_TOPIC, {
      channelId: channel,
      stream: {
        hlsUrl: `/api/voice/hls-playlist/${channel}/${startedAt}`,
        startedAt,
        presenterPeerId: peerId,
        delaySeconds: 10,
      },
      endsStartedAt: null,
      at: Date.now(),
    });
    const startsBefore = box.starts.length;

    await a.voice.handleVoiceMessage(
      { socket: rec.socket, user: asUser(userId) },
      { type: "set-sharing-screen", sharing: true },
    );

    await waitFor(() => owners(channel).join() === "api-a", "api-a to adopt the given-back session");
    expect(a.egress.liveHlsStreamFor(channel)?.startedAt).toBe(startedAt);
    expect(box.starts.length).toBe(startsBefore);
    expect(box.stops).toEqual([]);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsRowsDisowned",
      expect.objectContaining({ channelId: channel }),
    );
  }, 30_000);

  it("a host still sharing with no session anywhere gets one back from the sweep", async () => {
    const channel = fixture.channelId;
    const a = await bootInstance("api-a");
    // The share arrives before the SFU has the track (or the start failed
    // for any other reason): no session, and no further event will come.
    box.screenPublished = false;
    await presenterJoinsAndShares(a, randomUUID(), channel);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(owners(channel)).toEqual([]);
    box.screenPublished = true;

    const pushed = await a.voice.sweepHlsSharersWithoutSession();

    expect(pushed).toBe(1);
    await waitFor(() => owners(channel).length === 1, "the sweep to start the broadcast");
    expect(logEvent).toHaveBeenCalledWith(
      "voice.hlsSharerWithoutSession",
      expect.objectContaining({ channelId: channel }),
    );
    // Once running, the sweep leaves it alone.
    const starts = box.starts.length;
    expect(await a.voice.sweepHlsSharersWithoutSession()).toBe(0);
    expect(box.starts.length).toBe(starts);
  }, 30_000);
});
