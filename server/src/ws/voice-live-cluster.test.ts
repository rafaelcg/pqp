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
import type { LiveHlsStream } from "@pqp/shared";
import type { DbUser } from "../db.js";
import { createMemoryHub, type BusFrame } from "../lib/bus.js";

/**
 * A watch party's stream and state across two instances.
 *
 * Production runs two `pqp-api` machines with no session affinity, so the
 * presenter's socket and a viewer's socket are on different processes about
 * half the time. Seen live on 2026-09-14 at 14:56 UTC: the host shared from
 * machine A, a viewer on machine B stayed on "Preparando a transmissão" for
 * good, because `channel-live` (the frame that carries the playlist URL) was
 * fanned out to A's local sockets only. A minute later a second viewer on B
 * pressed "Entrar no palco", was seated, and left one second later: B's
 * welcome read its own empty egress map and said there was no stream, the
 * client believed it, and the audience-seat backstop hung them up.
 *
 * Same harness as `voice-cluster.test.ts` (two module graphs over one memory
 * hub, each with its own pool on `TEST_DATABASE_URL`, `VOICE_REGISTRY` and
 * the bus on, which is what production sets), with the egress faked PER
 * GRAPH: `liveHlsStreamFor` on B never sees A's session, exactly like the
 * real `rooms` map, so a frame on B that carries the stream can only have
 * come over the bus or out of the `hls_sessions` row.
 *
 * Pinned: a stream pushed on A reaches a sidebar socket on B, stamped for
 * that socket's user, and A's own sockets hear it once; the stop reaches B
 * with `ended: true`; a joiner on B is welcomed with the stream and B's
 * keyframe carries it; a machine that never heard the relay answers from the
 * row; a party going live on A reaches B's audience; the counters climb.
 * Skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const SERVER = "11111111-1111-4111-8111-111111111111";

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "livekit",
  isLiveKitConfigured: () => true,
}));

/**
 * The access check the catch-up runs per channel, held open on demand. The
 * window this file's last test is about is exactly "a party ended while this
 * was in flight", and a real round trip is the only thing that window is made
 * of; `accessGate.wait` makes it a place the test can stand.
 */
const accessGate = vi.hoisted(() => ({
  /** Held open from this call onwards (1-based). 0 never holds. */
  blockFrom: 0,
  wait: null as Promise<void> | null,
  calls: [] as string[],
}));

vi.mock("../services/users.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/users.js")>()),
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async (channelId: string) => {
    accessGate.calls.push(channelId);
    if (
      accessGate.wait &&
      accessGate.blockFrom > 0 &&
      accessGate.calls.length >= accessGate.blockFrom
    ) {
      await accessGate.wait;
    }
    return true;
  },
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/permissions.js", async (importOriginal) => ({
  // Spread, not replaced: `plantLiveParty` below builds a real server through
  // the real `createServer`, which seeds the default cargos through this
  // module. Only the two reads the fan-out makes are faked.
  ...(await importOriginal<typeof import("../services/permissions.js")>()),
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

vi.mock("../services/servers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/servers.js")>()),
  getChannel: async (id: string) => ({
    id,
    kind: "server",
    type: "watch_party",
    server_id: SERVER,
    voice_transport: "livekit",
  }),
  // Everyone may view every channel: a frame that failed to cross would be
  // visible here rather than hidden by a scoping rule.
  getChannelAudience: async () => ({
    serverId: SERVER,
    kind: "server",
    has: () => true,
    userIds: [],
  }),
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 3 }),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

type BusModule = typeof import("../lib/bus.js");
type VoiceModule = typeof import("./voice.js");
type SocketsModule = typeof import("./sockets.js");
type RegistryModule = typeof import("../voice/registry.js");
type DbModule = typeof import("../db.js");
type EventsModule = typeof import("./watch-party-events.js");
type TokenModule = typeof import("../voice/hls-viewer-token.js");

interface Instance {
  bus: BusModule;
  voice: VoiceModule;
  sockets: SocketsModule;
  registry: RegistryModule;
  db: DbModule;
  events: EventsModule;
  token: TokenModule;
  /** This graph's own `rooms` map. Empty on the machine not transcoding. */
  egress: Map<string, LiveHlsStream>;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
}

let hub = createMemoryHub();
let onTheWire: BusFrame[] = [];
const pools: DbModule[] = [];
const booted: Instance[] = [];
const previousFlag = process.env.VOICE_REGISTRY;

async function bootInstance(connected = true): Promise<Instance> {
  vi.resetModules();
  /**
   * THE EGRESS, PER GRAPH. `vi.mock` registers one factory for the whole file
   * and `vi.resetModules` does not re-run it, so a hoisted mock hands every
   * "instance" the SAME `rooms` map -- and B then answers for a session only A
   * is running, which is precisely the bug this file exists to catch (it did
   * hide it: the first draft of these tests passed the welcome case for the
   * wrong reason). `vi.doMock` is registered again for each graph, so each
   * gets a map of its own, exactly like two processes.
   *
   * `liveHlsStreamFromDb` is deliberately left real: the "booted after the
   * party started, never heard the relay" case below plants an `hls_sessions`
   * row for it to find.
   */
  const egress = new Map<string, LiveHlsStream>();
  vi.doMock("../voice/hls-egress.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../voice/hls-egress.js")>();
    return {
      ...actual,
      isLiveHlsEnabled: () => true,
      isLiveHlsEnabledForServer: async () => true,
      setLiveHlsChangeListener: () => {},
      setLiveHlsSfuLoadReader: () => {},
      liveHlsStreamFor: (channelId: string) => egress.get(channelId) ?? null,
      reconcileLiveHls: async (
        channelId: string,
        presenterPeerId: string | null,
      ) => {
        if (!presenterPeerId) {
          egress.delete(channelId);
          return null;
        }
        const current = egress.get(channelId);
        if (current?.presenterPeerId === presenterPeerId) {
          return current;
        }
        const startedAt = Date.now();
        const stream: LiveHlsStream = {
          hlsUrl: `/api/voice/hls-playlist/${channelId}/${startedAt}`,
          startedAt,
          presenterPeerId,
          delaySeconds: 10,
        };
        egress.set(channelId, stream);
        return stream;
      },
    };
  });
  const bus = (await import("../lib/bus.js")) as BusModule;
  const db = (await import("../db.js")) as DbModule;
  const voice = (await import("./voice.js")) as VoiceModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  const registry = (await import("../voice/registry.js")) as RegistryModule;
  const events = (await import("./watch-party-events.js")) as EventsModule;
  const token = (await import("../voice/hls-viewer-token.js")) as TokenModule;
  if (connected) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  const instance = { bus, voice, sockets, registry, db, events, token, egress };
  booted.push(instance);
  return instance;
}

function recorder(): Recorder {
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

function frames(rec: Recorder, type: string): Frame[] {
  return rec.frames.filter((f) => f.type === type);
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

/** A socket that only draws the sidebar: the channel's audience, no seat. */
function watcher(instance: Instance, userId = randomUUID()): Recorder & { userId: string } {
  const rec = recorder();
  instance.sockets.setAuthenticatedSocket(rec.socket, asUser(userId));
  return { ...rec, userId };
}

async function join(
  instance: Instance,
  userId: string,
  channel: string,
): Promise<Recorder & { peerId: string; userId: string }> {
  const rec = recorder();
  instance.sockets.setAuthenticatedSocket(rec.socket, asUser(userId));
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId: channel },
  );
  const welcome = frames(rec, "welcome")[0];
  if (!welcome) {
    throw new Error(`join was refused: ${JSON.stringify(rec.frames)}`);
  }
  return { ...rec, peerId: welcome.peerId as string, userId };
}

async function setSharing(
  instance: Instance,
  rec: Recorder & { userId: string },
  sharing: boolean,
): Promise<void> {
  await instance.voice.handleVoiceMessage(
    { socket: rec.socket, user: asUser(rec.userId) },
    { type: "set-sharing-screen", sharing },
  );
  // `pushLiveHls` is fire-and-forget behind the share; let it settle.
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function tokenOf(url: string): string | null {
  return new URL(url, "http://pqp.test").searchParams.get("t");
}

/** The user the playlist URL in this frame was stamped for. */
function stampedFor(
  instance: Instance,
  frame: Frame,
  channel: string,
): string | null {
  const stream = frame.stream as LiveHlsStream | null;
  if (!stream) {
    return null;
  }
  return (
    instance.token.verifyHlsViewerToken(tokenOf(stream.hlsUrl), {
      channelId: channel,
      startedAt: stream.startedAt,
    })?.userId ?? null
  );
}

describeDb("watch party stream and state across two instances", () => {
  beforeAll(async () => {
    vi.resetModules();
    const db = (await import("../db.js")) as DbModule;
    await db.initDb();
    pools.push(db);
  });

  afterAll(async () => {
    await Promise.all(pools.map((db) => db.closePool().catch(() => {})));
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    process.env.VOICE_PROMOTION_ROOM_SIZE = "0";
    process.env.HLS_NO_SHARER_GRACE_MS = "0";
    hub = createMemoryHub();
    onTheWire = [];
    hub.listeners.add((frame) => onTheWire.push(frame));
    accessGate.wait = null;
    accessGate.calls = [];
    accessGate.blockFrom = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    await pools[0]!
      .getPool()
      .query(
        `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances, hls_sessions`,
      );
  });

  afterEach(async () => {
    for (const instance of booted) {
      await instance.registry.settleVoiceRegistryWrites();
    }
    for (const instance of booted) {
      instance.voice.resetVoicePeers();
      instance.voice.resetHlsAudience();
      await instance.bus.closeBus();
      await instance.db.closePool().catch(() => {});
    }
    booted.length = 0;
    process.env.VOICE_REGISTRY = previousFlag;
    delete process.env.VOICE_PROMOTION_ROOM_SIZE;
    delete process.env.HLS_NO_SHARER_GRACE_MS;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("channel-live over the bus", () => {
    it("a stream pushed on A reaches a sidebar socket on B, stamped for that user, and A hears it once", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnA = watcher(a);
      const sidebarOnB = watcher(b);

      const host = await join(a, randomUUID(), channel);
      await setSharing(a, host, true);

      // A's own audience, once: the bus drops A's own frame at the origin
      // guard, so nothing comes back around.
      expect(frames(sidebarOnA, "channel-live")).toHaveLength(1);
      expect(stampedFor(a, frames(sidebarOnA, "channel-live")[0]!, channel)).toBe(
        sidebarOnA.userId,
      );

      await waitFor(
        () => frames(sidebarOnB, "channel-live").length === 1,
        "channel-live on B",
      );
      const onB = frames(sidebarOnB, "channel-live")[0]!;
      expect(onB.channelId).toBe(channel);
      expect(onB.ended).toBeUndefined();
      expect((onB.stream as LiveHlsStream).presenterPeerId).toBe(host.peerId);
      // Stamped on B, for B's socket: the frame that crossed was unstamped.
      expect(stampedFor(b, onB, channel)).toBe(sidebarOnB.userId);
      const wire = onTheWire.find((f) => f.topic === "voice.live");
      expect(wire).toBeDefined();
      expect(
        ((wire!.data as { stream: LiveHlsStream }).stream.hlsUrl).includes("?t="),
      ).toBe(false);

      // B's egress map is genuinely empty: the stream came over the bus.
      expect(b.egress.size).toBe(0);
      expect(a.egress.size).toBe(1);
      // And B now answers `GET /live` from memory, stream and all.
      expect((await b.voice.getChannelLiveState(channel)).stream?.presenterPeerId).toBe(
        host.peerId,
      );

      // Still once on A after B applied it.
      expect(frames(sidebarOnA, "channel-live")).toHaveLength(1);

      const snapA = await a.voice.getVoiceActivitySnapshot();
      const snapB = await b.voice.getVoiceActivitySnapshot();
      expect(snapA.liveHls.audienceFramesRelayed).toBe(1);
      expect(snapA.liveHls.audienceFramesFromBus).toBe(0);
      expect(snapB.liveHls.audienceFramesRelayed).toBe(0);
      expect(snapB.liveHls.audienceFramesFromBus).toBe(1);
      expect(snapB.cluster.framesReceived).toBeGreaterThan(0);
    });

    it("the stop reaches B as stream: null with ended: true, and B forgets the channel", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnB = watcher(b);
      const host = await join(a, randomUUID(), channel);
      await setSharing(a, host, true);
      await waitFor(
        () => frames(sidebarOnB, "channel-live").length === 1,
        "start on B",
      );

      await setSharing(a, host, false);
      await waitFor(
        () => frames(sidebarOnB, "channel-live").length === 2,
        "stop on B",
      );
      const stop = frames(sidebarOnB, "channel-live")[1]!;
      expect(stop.stream).toBeNull();
      expect(stop.ended).toBe(true);
      expect((await b.voice.getChannelLiveState(channel)).stream).toBeNull();
    });

    it("a joiner on B is welcomed with the stream, and B's keyframe carries it", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const host = await join(a, randomUUID(), channel);
      await setSharing(a, host, true);
      // The memory hub hands the frame to B's handler synchronously, and the
      // handler records the stream before it fans out, so once the frame is
      // on the wire B's audience state already knows the stream.
      await waitFor(
        () => onTheWire.some((f) => f.topic === "voice.live"),
        "voice.live on the wire",
      );
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect((await b.voice.getChannelLiveState(channel)).stream?.presenterPeerId).toBe(
        host.peerId,
      );

      // The viewer's socket appears on B only now, so it heard no relay: what
      // it is told comes from the welcome and the keyframe alone.
      const viewer = await join(b, randomUUID(), channel);
      const welcomeStream = frames(viewer, "voice-stream");
      expect(welcomeStream).toHaveLength(1);
      expect((welcomeStream[0]!.stream as LiveHlsStream).presenterPeerId).toBe(
        host.peerId,
      );
      expect(stampedFor(b, welcomeStream[0]!, channel)).toBe(viewer.userId);

      // A sidebar socket on B subscribes to the playlist without a seat, and
      // is answered with the stream at once...
      const sidebarOnB = watcher(b);
      await b.voice.handleVoiceMessage(
        { socket: sidebarOnB.socket, user: asUser(sidebarOnB.userId) },
        { type: "watch-live", channelId: channel, watching: true },
      );
      expect(frames(sidebarOnB, "channel-live")).toHaveLength(1);
      expect(
        (frames(sidebarOnB, "channel-live")[0]!.stream as LiveHlsStream).presenterPeerId,
      ).toBe(host.peerId);

      // ...and again on B's own keyframe, which used to read B's empty egress
      // map and say `null` for a party live one machine over.
      await vi.advanceTimersByTimeAsync(b.voice.ROSTER_AUDIENCE_KEYFRAME_MS);
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const keyframes = frames(sidebarOnB, "channel-live");
      expect(keyframes.length).toBeGreaterThanOrEqual(2);
      const last = keyframes[keyframes.length - 1]!;
      expect((last.stream as LiveHlsStream).presenterPeerId).toBe(host.peerId);
      expect(last.ended).toBeUndefined();
      expect(stampedFor(b, last, channel)).toBe(sidebarOnB.userId);
      vi.useRealTimers();
    });

    it("a machine that never heard the relay answers the welcome and watch-live from the session row", async () => {
      const channel = randomUUID();
      const presenterPeerId = randomUUID();
      await pools[0]!.getPool().query(
        `INSERT INTO channels (id, server_id, name, type, kind)
         VALUES ($1, NULL, 'gap-test', 'watch_party', 'dm')`,
        [channel],
      );
      const startedAt = new Date();
      await pools[0]!.getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, presenter_peer_id, mode)
         VALUES ($1, $2, $3, NULL, $4, 'conventional')`,
        [
          channel,
          `live/${channel}/${startedAt.getTime()}-720p30-${randomUUID()}`,
          startedAt,
          presenterPeerId,
        ],
      );
      // Booted after the party started, alone on its bus: no relay ever
      // reached it, its maps are empty, the row is all it has.
      const c = await bootInstance();

      const viewer = await join(c, randomUUID(), channel);
      const welcomeStream = frames(viewer, "voice-stream");
      expect(welcomeStream).toHaveLength(1);
      expect((welcomeStream[0]!.stream as LiveHlsStream).presenterPeerId).toBe(
        presenterPeerId,
      );
      expect(stampedFor(c, welcomeStream[0]!, channel)).toBe(viewer.userId);

      const sidebar = watcher(c);
      await c.voice.handleVoiceMessage(
        { socket: sidebar.socket, user: asUser(sidebar.userId) },
        { type: "watch-live", channelId: channel, watching: true },
      );
      const live = frames(sidebar, "channel-live")[0]!;
      expect((live.stream as LiveHlsStream).presenterPeerId).toBe(presenterPeerId);
      expect(live.ended).toBeUndefined();

      // A channel with no row at all is a positive "nothing is live".
      const quiet = randomUUID();
      const other = watcher(c);
      await c.voice.handleVoiceMessage(
        { socket: other.socket, user: asUser(other.userId) },
        { type: "watch-live", channelId: quiet, watching: true },
      );
      expect(frames(other, "channel-live")[0]).toMatchObject({
        stream: null,
        ended: true,
      });
    });

    /**
     * The memo behind `resolveChannelStream` is the one thing that can undo a
     * stop. A machine that answered a joiner from `hls_sessions` holds that
     * stream for a few seconds; if the relayed stop only reached
     * `hlsAudience`, the very next `watch-live` would fall through to the
     * memo and hand somebody an ended playlist with no `ended` marker --
     * exactly the frame the client is now written to believe.
     */
    it("a relayed stop drops a stream this machine had read from the session row", async () => {
      const channel = randomUUID();
      const presenterPeerId = randomUUID();
      await pools[0]!.getPool().query(
        `INSERT INTO channels (id, server_id, name, type, kind)
         VALUES ($1, NULL, 'memo-test', 'watch_party', 'dm')`,
        [channel],
      );
      const startedAt = new Date();
      await pools[0]!.getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, presenter_peer_id, mode)
         VALUES ($1, $2, $3, NULL, $4, 'conventional')`,
        [
          channel,
          `live/${channel}/${startedAt.getTime()}-720p30-${randomUUID()}`,
          startedAt,
          presenterPeerId,
        ],
      );
      const a = await bootInstance();
      const b = await bootInstance();

      // B learns the stream the only way it can: the row. That memoises it.
      const early = watcher(b);
      await b.voice.handleVoiceMessage(
        { socket: early.socket, user: asUser(early.userId) },
        { type: "watch-live", channelId: channel, watching: true },
      );
      expect(
        (frames(early, "channel-live")[0]!.stream as LiveHlsStream).presenterPeerId,
      ).toBe(presenterPeerId);

      // A ends it: the session row closes and the stop goes on the bus, in
      // that order, which is the order `pushLiveHls` produces.
      await pools[0]!
        .getPool()
        .query(`UPDATE hls_sessions SET ended_at = NOW() WHERE channel_id = $1`, [
          channel,
        ]);
      a.bus.publishToCluster(a.voice.VOICE_LIVE_TOPIC, {
        channelId: channel,
        stream: null,
        endsStartedAt: startedAt.getTime(),
        at: Date.now(),
      });
      await waitFor(
        () => frames(early, "channel-live").length === 2,
        "the stop on B",
      );
      expect(frames(early, "channel-live")[1]).toMatchObject({
        stream: null,
        ended: true,
      });

      // AND THE NEXT SUBSCRIBER, well inside the memo's few seconds.
      const late = watcher(b);
      await b.voice.handleVoiceMessage(
        { socket: late.socket, user: asUser(late.userId) },
        { type: "watch-live", channelId: channel, watching: true },
      );
      expect(frames(late, "channel-live")[0]).toMatchObject({
        stream: null,
        ended: true,
      });
      expect((await b.voice.getChannelLiveState(channel)).stream).toBeNull();
    });

    /**
     * The catch-up a socket gets when it authenticates enumerates the live
     * channels, then runs an access check per channel. That check is a round
     * trip and a party can end inside it, which would hand the socket the
     * snapshot's stream (a session that is over) or a bare `null` with no
     * `ended`, which this PR's own client is written to ignore. The
     * generation captured at enumeration and re-read at framing is what turns
     * that into the authoritative end it is (`sendAllVoiceRosters`).
     *
     * HONEST ABOUT WHAT IT PINS: the stop is made to land while the catch-up
     * is suspended inside an access check, but which of the catch-up's two
     * checks for this channel it lands in is not forced, so this is an
     * end-to-end invariant ("a socket is never left holding a session that
     * has ended") rather than a pin on that one interleaving. The invariant
     * is the part that mattered on 2026-09-14.
     */
    it("a stream that ends between enumeration and framing is sent as ended, not as silence", async () => {
      const channel = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const host = await join(a, randomUUID(), channel);
      await setSharing(a, host, true);
      await waitFor(
        () => onTheWire.some((f) => f.topic === "voice.live"),
        "the relay on the wire",
      );
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(
        (await b.voice.getChannelLiveState(channel)).stream?.presenterPeerId,
      ).toBe(host.peerId);

      const startedAt = (await b.voice.getChannelLiveState(channel)).stream!
        .startedAt;

      // `sendAllVoiceRosters` checks this channel twice: once for the room's
      // roster, and once for the `channel-live` catch-up AFTER it has
      // enumerated the live channels. Holding the SECOND one open is
      // standing exactly inside the window.
      let open = () => {};
      accessGate.blockFrom = 2;
      accessGate.wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      const latecomer = recorder();
      const userId = randomUUID();
      b.sockets.setAuthenticatedSocket(latecomer.socket, asUser(userId));
      // Started, NOT awaited: the catch-up enumerates, then blocks on the
      // access check, and the stop lands while it is in there.
      const catchUp = b.voice.sendAllVoiceRosters(
        latecomer.socket,
        asUser(userId),
      );
      await waitFor(
        () => accessGate.calls.length >= 2,
        "the catch-up to reach its access check",
      );
      a.bus.publishToCluster(a.voice.VOICE_LIVE_TOPIC, {
        channelId: channel,
        stream: null,
        endsStartedAt: startedAt,
        at: Date.now(),
      });
      open();
      await catchUp;

      // This socket is on B and authenticated, so the relay's own fan-out
      // reaches it as well as the catch-up: what is asserted is that NOT ONE
      // of the frames it received carries the session that has ended, and
      // that it was told in as many words that there is nothing live. The
      // snapshot's stream reaching it, with or without `ended`, is the defect.
      const live = frames(latecomer, "channel-live").filter(
        (f) => f.channelId === channel,
      );
      expect(live.length).toBeGreaterThan(0);
      expect(live.filter((f) => f.stream !== null)).toHaveLength(0);
      expect(live.some((f) => f.ended === true)).toBe(true);
    });

    it("bus off: nothing crosses, and A behaves exactly as today", async () => {
      const channel = randomUUID();
      const a = await bootInstance(false);
      const b = await bootInstance(false);
      const sidebarOnA = watcher(a);
      const sidebarOnB = watcher(b);
      const host = await join(a, randomUUID(), channel);
      await setSharing(a, host, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames(sidebarOnA, "channel-live")).toHaveLength(1);
      expect(frames(sidebarOnB, "channel-live")).toHaveLength(0);
      expect(onTheWire).toEqual([]);
      expect((await a.voice.getVoiceActivitySnapshot()).liveHls.audienceFramesRelayed).toBe(0);
    });
  });

  describe("watch-party-update over the bus", () => {
    /**
     * A real server, a real `watch_party` channel and a real live session,
     * through the real services, because `broadcastWatchParty` re-reads the
     * row on the far side and a hand-written INSERT would only prove the
     * columns this test happens to know about.
     *
     * On its OWN module graph: the graph left over from the previous test had
     * its pool closed in `afterEach`, and the instances this test is about are
     * booted after this runs. The pool is registered for `afterAll`.
     */
    async function plantLiveParty(): Promise<{ sessionId: string; channelId: string }> {
      vi.resetModules();
      const db = (await import("../db.js")) as DbModule;
      pools.push(db);
      const { upsertUser } = await import("../services/users.js");
      const { createServer, createChannel } = await import("../services/servers.js");
      const { createWatchParty } = await import("../services/watch-parties.js");
      const host = await upsertUser({
        clerkId: `clerk_${randomUUID()}`,
        displayName: "Host",
        avatarUrl: null,
      });
      const { server } = await createServer("Cinema", host.id);
      const channel = await createChannel(server.id, "sala", "watch_party");
      const row = await createWatchParty({
        channelId: channel.id,
        serverId: server.id,
        name: "Filme",
        description: null,
        startsAt: null,
        options: {},
        hostUserId: host.id,
      });
      await db
        .getPool()
        .query(`UPDATE channel_sessions SET status = 'live', went_live_at = NOW() WHERE id = $1`, [
          row.id,
        ]);
      return { sessionId: row.id, channelId: channel.id };
    }

    it("a party going live on A reaches B's audience, once each, and ending it does too", async () => {
      const { sessionId, channelId } = await plantLiveParty();
      const a = await bootInstance();
      const b = await bootInstance();
      const sidebarOnA = watcher(a);
      const sidebarOnB = watcher(b);

      await a.events.broadcastWatchParty(sessionId);
      expect(frames(sidebarOnA, "watch-party-update")).toHaveLength(1);
      expect(frames(sidebarOnA, "watch-party-update")[0]).toMatchObject({
        channelId,
        party: { state: "live" },
      });
      await waitFor(
        () => frames(sidebarOnB, "watch-party-update").length === 1,
        "watch-party-update on B",
      );
      expect(frames(sidebarOnB, "watch-party-update")[0]).toMatchObject({
        channelId,
        party: { state: "live" },
      });
      // B's walk did not publish in turn: one frame on the wire, from A.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onTheWire.filter((f) => f.topic === "watchParty.state")).toHaveLength(1);
      expect(frames(sidebarOnA, "watch-party-update")).toHaveLength(1);
      expect(a.events.watchPartyStateFrameCounters()).toEqual({ relayed: 1, fromBus: 0 });
      expect(b.events.watchPartyStateFrameCounters()).toEqual({ relayed: 0, fromBus: 1 });

      await pools[0]!
        .getPool()
        .query(`UPDATE channel_sessions SET status = 'ended', ended_at = NOW() WHERE id = $1`, [
          sessionId,
        ]);
      await a.events.broadcastWatchParty(sessionId);
      await waitFor(
        () => frames(sidebarOnB, "watch-party-update").length === 2,
        "end on B",
      );
      expect(frames(sidebarOnB, "watch-party-update")[1]).toMatchObject({
        channelId,
        party: null,
      });
    });

    it("bus off: the party stays on A", async () => {
      const { sessionId } = await plantLiveParty();
      const a = await bootInstance(false);
      const b = await bootInstance(false);
      const sidebarOnB = watcher(b);
      await a.events.broadcastWatchParty(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames(sidebarOnB, "watch-party-update")).toHaveLength(0);
      expect(onTheWire).toEqual([]);
    });
  });
});
