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
import type { DbUser } from "../db.js";
import { createMemoryHub } from "../lib/bus.js";

/**
 * THE RECONCILE HAS TO HAPPEN WHERE THE TRANSCODE IS.
 *
 * Production runs two `pqp-api` machines behind a proxy with no session
 * affinity, so a viewer's frame lands on whichever one it lands on. Every
 * path into `pushLiveHls` is written against THIS process's maps: its peers,
 * `rooms` in `hls-egress.ts`, `llRooms` in `hls-remux.ts`. On the machine
 * that holds none of them the whole call is a no-op — including the mode
 * re-check at the top of `reconcileLiveHlsNow`, which is the only thing that
 * would notice a party demoted off the LL path and start its conventional
 * ladder.
 *
 * On 2026-09-14 that is exactly what happened: viewers joining on machine A,
 * presenter and egress on machine B, and the re-check never ran on B at all.
 *
 * The fix is one topic: an instance that does not own the channel says
 * "reconcile this" on the bus, and the owner does its own local half. This
 * file pins the three halves of that — published by the non-owner, applied
 * by the owner and only the owner, and never published at all on one machine.
 *
 * Two real module graphs over one memory hub, the `voice-cluster.test.ts`
 * harness, because `rooms` and the bus subscriptions have to be genuinely
 * separate for the question to mean anything, and `VOICE_REGISTRY=postgres`
 * because that is the flag production sets (pitfall 12). Skips without a
 * database.
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

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { id: string; display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

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

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "11111111-1111-4111-8111-111111111111",
  }),
  getChannelAudience: async () => ({
    serverId: null,
    kind: "server",
    has: () => true,
  }),
  // A big server, so `resolveVoiceTransport` pins the room to LiveKit: a
  // watch party is an SFU room by policy, and `pushLiveHls` returns at once
  // on a mesh one.
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 50 }),
}));

vi.mock("../voice/admin.js", () => ({
  cancelSfuPrivateResweep: vi.fn(),
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve()),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

type BusModule = typeof import("../lib/bus.js");
type VoiceModule = typeof import("./voice.js");
type SocketsModule = typeof import("./sockets.js");
type EgressModule = typeof import("../voice/hls-egress.js");
type DbModule = typeof import("../db.js");

interface Instance {
  bus: BusModule;
  voice: VoiceModule;
  sockets: SocketsModule;
  egress: EgressModule;
  db: DbModule;
}

let hub = createMemoryHub();
const pools: DbModule[] = [];
const booted: Instance[] = [];

async function bootInstance(connected = true): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const voice = (await import("./voice.js")) as VoiceModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  const egress = (await import("../voice/hls-egress.js")) as EgressModule;
  if (connected) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  // A media server that answers every call, so a reconcile can really run.
  egress.setLiveHlsTestHooks({
    egress: {
      startTrackCompositeEgress: async () => ({ egressId: "unused" }),
      stopEgress: async () => {},
      listEgress: async () => [],
    },
  });
  const instance = { bus, voice, sockets, egress, db };
  booted.push(instance);
  return instance;
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

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A viewer's whole visit to the room on this instance. The departure is what
 * reaches `pushLiveHls` (the arrival reaches it through the roster paths a
 * real client's own `set-screen-share` and state frames drive); either way
 * the question is the same one the incident asked: this instance reconciles
 * a channel whose transcode is somewhere else.
 */
async function viewerVisits(instance: Instance, channel: string): Promise<void> {
  const rec = recorder();
  const user = asUser(randomUUID());
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
    { type: "leave-voice-room" },
  );
}

/**
 * This instance holds the transcode, as an adoption across a deploy leaves
 * it. Answers the stream, so the caller can tell the other machine about it
 * the way `pushLiveHls` would.
 */
function ownHere(instance: Instance, channel: string) {
  const stream = instance.egress.adoptLiveHlsSession({
    channelId: channel,
    egressId: `EG_${channel.slice(0, 8)}`,
    startedAt: Date.now() - 60_000,
    presenterPeerId: "peer-presenter",
    videoTrackId: "TR_V",
    rung: "720p30",
  });
  expect(stream).not.toBeNull();
  expect(instance.egress.liveHlsOwnsChannel(channel)).toBe(true);
  return stream!;
}

/**
 * "There is a party on this channel", said by the machine running it — the
 * `voice.live` frame `pushLiveHls` publishes after every stream change. What
 * fills `hlsAudience` on the OTHER machine, and what gates the reconcile
 * relay: an instance with no idea a party exists has nothing to relay about.
 */
function announceLive(
  from: Instance,
  channel: string,
  stream: { hlsUrl: string; startedAt: number; presenterPeerId: string },
): void {
  from.bus.publishToCluster(from.voice.VOICE_LIVE_TOPIC, {
    channelId: channel,
    stream,
    endsStartedAt: null,
    at: Date.now(),
  });
}

const previousRegistry = process.env.VOICE_REGISTRY;

describeDb("voice.hlsReconcile: the owner machine runs the reconcile", () => {
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
    process.env.VOICE_REGISTRY = "postgres";
    // A stream is ended the moment its sharer is gone, with no grace: the
    // grace exists for a presenter blinking out mid-party, and here it would
    // only make the assertion wait five seconds for the same answer.
    process.env.HLS_NO_SHARER_GRACE_MS = "0";
    // The old end-of-share timing is what this pins; the presenter return
    // window (voice.ts presenterReturnGraceMs) has its own tests.
    process.env.HLS_PRESENTER_RETURN_GRACE_MS = "0";
    hub = createMemoryHub();
    logEvent.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await pools[0]!.getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_retired_peers, voice_instances CASCADE`,
    );
  });

  afterEach(async () => {
    for (const instance of booted) {
      instance.voice.resetVoicePeers();
      instance.egress.resetLiveHlsForTests();
      await instance.bus.closeBus();
      await instance.db.closePool().catch(() => undefined);
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previousRegistry;
    delete process.env.HLS_NO_SHARER_GRACE_MS;
    delete process.env.HLS_PRESENTER_RETURN_GRACE_MS;
    vi.restoreAllMocks();
  });

  it("relays a reconcile from the machine with the viewer to the machine with the transcode", async () => {
    const channel = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const stream = ownHere(b, channel);
    expect(a.egress.liveHlsOwnsChannel(channel)).toBe(false);
    // B tells the cluster there is a party, exactly as its own `pushLiveHls`
    // does. This is what A knows about the channel, and all it knows.
    announceLive(b, channel, stream);
    // The memory transport delivers synchronously, and the handler's own
    // fan-out is a promise; one turn is enough for A to have recorded it.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // On A this is the no-op that started the incident: no room, no LL
    // session, nothing at all to reconcile.
    await viewerVisits(a, channel);

    // The only thing in either process that can empty B's `rooms` map for
    // this channel is B's own reconcile.
    await waitFor(
      () => b.egress.liveHlsStreamFor(channel) === null,
      "B's own reconcile to run against its session",
    );
    // Counted on both sides, because "published" and "applied" are different
    // claims (the shape of pitfall 12).
    const snapshotA = await a.voice.getVoiceActivitySnapshot();
    const snapshotB = await b.voice.getVoiceActivitySnapshot();
    expect(snapshotA.cluster.hlsReconcileRelayed).toBeGreaterThan(0);
    expect(snapshotA.cluster.hlsReconcileApplied).toBe(0);
    expect(snapshotB.cluster.hlsReconcileApplied).toBeGreaterThan(0);
    expect(logEvent).toHaveBeenCalledWith("voice.hlsReconcileFromBus", {
      channelId: channel,
    });
  });

  it("is dropped by an instance that does not own the channel", async () => {
    const channel = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();

    // A has been told there is a party (so it relays), and NOBODY holds the
    // transcode any more — the machine that did has restarted, or the session
    // ended. B must do nothing with the intent but drop it.
    announceLive(b, channel, {
      hlsUrl: `/api/voice/hls-playlist/${channel}/1000`,
      startedAt: Date.now() - 60_000,
      presenterPeerId: "peer-presenter",
    });
    await viewerVisits(a, channel);
    // The memory transport delivers synchronously, so once A has published,
    // B has either handled it or dropped it. One turn of the loop covers the
    // `pushLiveHls` that publishes it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const snapshotA = await a.voice.getVoiceActivitySnapshot();
    expect(snapshotA.cluster.hlsReconcileRelayed).toBeGreaterThan(0);
    const snapshotB = await b.voice.getVoiceActivitySnapshot();
    expect(snapshotB.cluster.hlsReconcileApplied).toBe(0);
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.hlsReconcileFromBus",
      expect.anything(),
    );
  });

  it("publishes nothing on a single machine", async () => {
    const channel = randomUUID();
    const solo = await bootInstance(false);

    await viewerVisits(solo, channel);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // With no bus there is no other machine to tell, and the single-instance
    // path is byte-for-byte what it was.
    const snapshot = await solo.voice.getVoiceActivitySnapshot();
    expect(snapshot.cluster.hlsReconcileRelayed).toBe(0);
  });
});
