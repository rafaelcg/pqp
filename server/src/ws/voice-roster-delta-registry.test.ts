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
import type { VoiceParticipant } from "@pqp/shared";

/**
 * ROSTER DELTAS WITH `VOICE_REGISTRY=postgres`, WHICH IS HOW PRODUCTION RUNS.
 *
 * `voice-roster-delta.test.ts` proves the delta path against the in-process
 * room. Production does not use the in-process room: with the registry on
 * the roster is read from `voice_peers`, and until 2026-09-07 that path
 * sent a whole `voice-roster` to every audience socket on every change,
 * with `const delta = registryOn() ? null : foldRoomEvents(events)` as the
 * entire reason. Every delta test was green, the metrics counter
 * `voice.roster.deltas` read 0 in production, and the zero was attributed to
 * browsers that had not reloaded. The size-times-audience product that broke
 * the 2026-09-05 watch party was still being paid in full.
 *
 * So this file runs the same receiver rule against a real Postgres with the
 * flag on. The delta here is not a folded event queue (a join on another
 * instance never enters this process's queue) but the rows diffed against
 * what this process last sent, and the tests below pin what that has to get
 * right: `joined` / `updated` / `left` from a diff, the same `seq` on the
 * delta and the whole roster of one window, the two keyframe clocks, a whole
 * roster whenever the diff base is unknown (a forgotten channel, a failed
 * read), and the counters that will say from outside whether any of this is
 * running.
 *
 * Skips without a database, like `voice-registry.test.ts`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const backend = vi.hoisted(() => ({ configured: "livekit" as "mesh" | "livekit" }));

/** One roster read fails when this is set; it clears itself. */
const registryFault = vi.hoisted(() => ({ failNextRosterRead: false }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
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

/** Everyone can see the channel: the audience is the multiplier under test. */
vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "11111111-1111-4111-8111-111111111111",
  }),
  getChannelAudience: async () => ({
    serverId: "11111111-1111-4111-8111-111111111111",
    kind: "server",
    has: () => true,
    userIds: [],
  }),
  getServerVoiceProfile: async () => ({ isCommunity: false, memberCount: 500 }),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve()),
}));

/**
 * The real registry, with one seam: the roster read can be made to fail
 * once, which is the "registry read failed" case `sendRoster` handles by
 * falling back to its own peers. Only `listVoiceRoster` is wrapped, so the
 * rows are still written and read everywhere else.
 */
vi.mock("../voice/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voice/registry.js")>();
  return {
    ...actual,
    listVoiceRoster: async (channelId: string) => {
      if (registryFault.failNextRosterRead) {
        registryFault.failNextRosterRead = false;
        throw new Error("simulated registry outage");
      }
      return actual.listVoiceRoster(channelId);
    },
  };
});

const { setCoalesceImmediate } = await import("./fanout.js");
setCoalesceImmediate(true);

const { getPool, initDb, closePool } = await import("../db.js");
const {
  forgetSentRoster,
  getVoiceActivitySnapshot,
  handleVoiceMessage,
  refreshVoiceIdentity,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  sendAllVoiceRosters,
  ROSTER_KEYFRAME_MS,
  ROSTER_AUDIENCE_KEYFRAME_MS,
} = await import("./voice.js");
const { settleVoiceRegistryWrites } = await import("../voice/registry.js");
const {
  SOCKET_CAPS,
  setAuthenticatedSocket,
  deleteAuthenticatedSocket,
} = await import("./sockets.js");

interface Frame {
  type: string;
  [key: string]: unknown;
}

/**
 * A receiver that follows the published rule and nothing else, the same one
 * `voice-roster-delta.test.ts` uses: it reads only what the schema documents
 * and applies only the rule the schema states, so every assertion about
 * convergence is about the SERVER.
 */
class Client {
  readonly socket: WebSocket;
  readonly user: DbUser;
  readonly frames: Frame[] = [];
  belief = new Map<string, VoiceParticipant>();
  seq = 0;
  gaps = 0;

  constructor(
    readonly channelId: string,
    delta: boolean,
  ) {
    this.user = {
      id: randomUUID(),
      display_name: `User ${randomUUID().slice(0, 4)}`,
      avatar_url: null,
    } as unknown as DbUser;
    this.socket = {
      readyState: 1,
      send: (payload: string) => {
        const parsed = JSON.parse(payload) as Frame;
        this.frames.push(parsed);
        this.apply(parsed);
      },
      on: () => {},
    } as unknown as WebSocket;
    setAuthenticatedSocket(
      this.socket,
      this.user,
      delta ? [SOCKET_CAPS.voiceRosterDelta] : [],
    );
  }

  private apply(frame: Frame): void {
    if (frame.voiceChannelId !== this.channelId) {
      return;
    }
    if (frame.type === "voice-roster") {
      this.belief = new Map(
        (frame.participants as VoiceParticipant[]).map((p) => [p.peerId, p]),
      );
      this.seq = (frame.seq as number | undefined) ?? 0;
      if (this.belief.size === 0) {
        this.seq = 0;
      }
      return;
    }
    if (frame.type !== "voice-roster-delta") {
      return;
    }
    const seq = frame.seq as number;
    if (seq !== this.seq + 1) {
      this.gaps += 1;
      return;
    }
    const next = new Map(this.belief);
    for (const peer of (frame.joined as VoiceParticipant[]) ?? []) {
      next.set(peer.peerId, peer);
    }
    for (const peer of (frame.updated as VoiceParticipant[]) ?? []) {
      next.set(peer.peerId, peer);
    }
    for (const peerId of (frame.left as string[]) ?? []) {
      next.delete(peerId);
    }
    if (next.size !== (frame.size as number)) {
      this.gaps += 1;
      return;
    }
    this.belief = next;
    this.seq = next.size === 0 ? 0 : seq;
  }

  framesOfType(type: string): Frame[] {
    return this.frames.filter(
      (f) => f.type === type && f.voiceChannelId === this.channelId,
    );
  }

  /** Every roster frame, whole or delta, for this channel. */
  rosterFrames(): Frame[] {
    return this.frames.filter(
      (f) =>
        (f.type === "voice-roster" || f.type === "voice-roster-delta") &&
        f.voiceChannelId === this.channelId,
    );
  }

  frameWithSeq(seq: number): Frame | undefined {
    return this.rosterFrames().find((f) => f.seq === seq);
  }

  peerId(): string {
    return this.frames.find((f) => f.type === "welcome")?.peerId as string;
  }

  peerIds(): string[] {
    return [...this.belief.keys()].sort();
  }
}

const open: Client[] = [];

/**
 * The real clock, for the poll below, and a movable offset for the server:
 * the keyframe clocks are compared against `Date.now()`, and the tests move
 * it forward rather than waiting. An offset rather than a frozen value so
 * nothing in `pg` that reads the clock is handed a time that never advances.
 */
const realNow = Date.now.bind(Date);
let offset = 0;

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = realNow() + 5_000;
  while (!check()) {
    if (realNow() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function client(channelId: string, delta = true): Client {
  const c = new Client(channelId, delta);
  open.push(c);
  return c;
}

/**
 * The join handler awaits its own roster run, so when this returns the frame
 * describing the joiner has been written to every socket.
 */
async function join(c: Client): Promise<void> {
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    {
      type: "join-voice-room",
      voiceChannelId: c.channelId,
      transports: ["mesh", "livekit"],
    },
  );
}

/** State changes and leaves fire their roster off; wait for the frame. */
async function setMuted(c: Client, muted: boolean, seenBy: Client): Promise<void> {
  const seq = seenBy.seq + 1;
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    { type: "set-voice-state", muted, deafened: false },
  );
  await waitFor(() => seenBy.frameWithSeq(seq) !== undefined, `seq ${seq} after mute`);
}

async function leave(c: Client, seenBy: Client): Promise<void> {
  const seq = seenBy.seq + 1;
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    { type: "leave-voice-room" },
  );
  await waitFor(() => seenBy.frameWithSeq(seq) !== undefined, `seq ${seq} after leave`);
}

/** The room as the server holds it, read the only way a test can: a fresh socket. */
async function serverRoom(channelId: string): Promise<string[]> {
  const probe = client(channelId, false);
  await sendAllVoiceRosters(probe.socket, probe.user);
  const roster = probe.framesOfType("voice-roster").at(-1);
  return (((roster?.participants as VoiceParticipant[] | undefined) ?? []).map(
    (p) => p.peerId,
  )).sort();
}

async function expectConverged(c: Client, channelId: string): Promise<void> {
  expect(c.peerIds()).toEqual(await serverRoom(channelId));
  expect(c.gaps).toBe(0);
}

async function rowCount(channelId: string): Promise<number> {
  const result = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM voice_peers WHERE channel_id = $1`,
    [channelId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

const userIds = (peers: unknown) =>
  ((peers as VoiceParticipant[] | undefined) ?? []).map((p) => p.userId);

const previousFlag = process.env.VOICE_REGISTRY;

describeDb("voice roster deltas with the registry on", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const c of open.splice(0)) {
      deleteAuthenticatedSocket(c.socket);
    }
    registryFault.failNextRosterRead = false;
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    backend.configured = "livekit";
    await getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    await settleVoiceRegistryWrites();
    resetVoicePeers();
    process.env.VOICE_REGISTRY = previousFlag;
    vi.restoreAllMocks();
  });

  it("sends a socket that asked a delta built from the rows, and one that did not a whole roster with the same seq", async () => {
    const channel = randomUUID();
    const modern = client(channel);
    const legacy = client(channel, false);
    const first = client(channel);
    await join(first);
    // The first frame of a room is a keyframe for everybody: this process has
    // not described the room yet, so there is nothing for a patch to sit on.
    expect(modern.framesOfType("voice-roster")).toHaveLength(1);
    expect(modern.framesOfType("voice-roster-delta")).toHaveLength(0);
    expect(modern.frameWithSeq(1)?.type).toBe("voice-roster");

    const second = client(channel);
    await join(second);
    // Both peers are rows, and the delta is the diff of those rows against
    // the roster sent above, not a folded local queue.
    expect(await rowCount(channel)).toBe(2);

    const delta = modern.framesOfType("voice-roster-delta").at(-1);
    expect(delta).toBeDefined();
    expect(delta?.seq).toBe(2);
    expect(delta?.size).toBe(2);
    expect(userIds(delta?.joined)).toEqual([second.user.id]);
    expect(delta?.updated).toBeUndefined();
    expect(delta?.left).toBeUndefined();
    expect(modern.framesOfType("voice-roster")).toHaveLength(1);

    // The old client saw the same window as a whole roster, same seq.
    expect(legacy.framesOfType("voice-roster-delta")).toHaveLength(0);
    const full = legacy.framesOfType("voice-roster").at(-1);
    expect(full?.seq).toBe(2);
    expect(userIds(full?.participants).sort()).toEqual(
      [first.user.id, second.user.id].sort(),
    );

    await expectConverged(modern, channel);
    await expectConverged(legacy, channel);
  });

  it("carries a flag change as updated and a departure as left, on the room's clock and the audience's", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const a = client(channel);
    const b = client(channel);
    await join(a);
    await join(b);
    expect(watcher.seq).toBe(2);

    await setMuted(a, true, watcher);
    const updated = watcher.frameWithSeq(3);
    expect(updated?.type).toBe("voice-roster-delta");
    expect(updated?.size).toBe(2);
    expect(userIds(updated?.updated)).toEqual([a.user.id]);
    expect((updated?.updated as VoiceParticipant[])[0]?.muted).toBe(true);
    expect(updated?.joined).toBeUndefined();
    expect(updated?.left).toBeUndefined();

    await leave(b, watcher);
    const left = watcher.frameWithSeq(4);
    expect(left?.type).toBe("voice-roster-delta");
    expect(left?.size).toBe(1);
    expect(left?.left).toEqual([b.peerId()]);
    expect(left?.joined).toBeUndefined();
    expect(left?.updated).toBeUndefined();
    expect(await rowCount(channel)).toBe(1);

    // Ten seconds on: `a` is in the call and owed a whole roster; the
    // watcher is a badge and is not.
    const aWhole = a.framesOfType("voice-roster").length;
    const watcherWhole = watcher.framesOfType("voice-roster").length;
    offset += ROSTER_KEYFRAME_MS;
    const c = client(channel);
    await join(c);
    expect(a.framesOfType("voice-roster")).toHaveLength(aWhole + 1);
    expect(a.frameWithSeq(5)?.type).toBe("voice-roster");
    expect(watcher.framesOfType("voice-roster")).toHaveLength(watcherWhole);
    expect(watcher.frameWithSeq(5)?.type).toBe("voice-roster-delta");
    expect(userIds(watcher.frameWithSeq(5)?.joined)).toEqual([c.user.id]);

    // Thirty seconds on, the watcher's own clock falls due.
    offset += ROSTER_AUDIENCE_KEYFRAME_MS;
    const d = client(channel);
    await join(d);
    expect(watcher.frameWithSeq(6)?.type).toBe("voice-roster");
    expect(watcher.framesOfType("voice-roster")).toHaveLength(watcherWhole + 1);

    await expectConverged(watcher, channel);
    await expectConverged(a, channel);
    expect(watcher.belief.size).toBe(3);
    expect([...watcher.belief.values()].find((p) => p.userId === a.user.id)?.muted).toBe(
      true,
    );
  });

  it("describes the room whole again after forgetting what it sent, and after a registry read fails", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const a = client(channel);
    await join(a);
    const b = client(channel);
    await join(b);
    expect(watcher.frameWithSeq(2)?.type).toBe("voice-roster-delta");

    // The process forgot what it last sent (a restart, an evicted channel).
    // The next frame must be the whole room: a delta diffed against nothing
    // would either list everybody as joined or nobody at all.
    forgetSentRoster(channel);
    const c = client(channel);
    await join(c);
    const third = watcher.frameWithSeq(3);
    expect(third?.type).toBe("voice-roster");
    expect(userIds(third?.participants).sort()).toEqual(
      [a.user.id, b.user.id, c.user.id].sort(),
    );
    expect(watcher.framesOfType("voice-roster-delta")).toHaveLength(1);

    // And deltas resume on the base that snapshot laid down.
    const d = client(channel);
    await join(d);
    const fourth = watcher.frameWithSeq(4);
    expect(fourth?.type).toBe("voice-roster-delta");
    expect(fourth?.size).toBe(4);
    expect(userIds(fourth?.joined)).toEqual([d.user.id]);

    // The rows could not be read for one run. That run is served from this
    // instance's own peers, whole, and the memory is dropped with it, so the
    // run after (the first successful read) is whole as well rather than a
    // diff against a picture that may have been half the room.
    registryFault.failNextRosterRead = true;
    await setMuted(a, true, watcher);
    expect(registryFault.failNextRosterRead).toBe(false);
    expect(watcher.frameWithSeq(5)?.type).toBe("voice-roster");
    await setMuted(b, true, watcher);
    expect(watcher.frameWithSeq(6)?.type).toBe("voice-roster");
    await setMuted(c, true, watcher);
    const seventh = watcher.frameWithSeq(7);
    expect(seventh?.type).toBe("voice-roster-delta");
    expect(userIds(seventh?.updated)).toEqual([c.user.id]);

    await expectConverged(watcher, channel);
    expect(
      [...watcher.belief.values()].filter((p) => p.muted).map((p) => p.userId).sort(),
    ).toEqual([a.user.id, b.user.id, c.user.id].sort());
  });

  it("writes nothing when the rows say what the last frame said", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const a = client(channel);
    await join(a);
    const b = client(channel);
    await join(b);
    const framesBefore = watcher.rosterFrames().length;

    // A relabel to the same name: the peer is rewritten, the row is
    // rewritten, a roster run is requested, and the diff finds nothing. The
    // sockets are exactly as caught up as they were, so no frame goes out
    // and no sequence number is spent.
    await refreshVoiceIdentity(a.user.id, {
      display_name: a.user.display_name,
      avatar_url: null,
    });
    await settleVoiceRegistryWrites();
    expect(watcher.rosterFrames()).toHaveLength(framesBefore);
    expect(watcher.seq).toBe(2);

    // A real change is still seq 3, with no gap for the receiver.
    const c = client(channel);
    await join(c);
    expect(watcher.frameWithSeq(3)?.type).toBe("voice-roster-delta");
    await expectConverged(watcher, channel);
  });

  it("counts deltas and snapshots on the branch each socket was served from", async () => {
    // The counter that says, from `GET /api/admin/metrics`, whether this is
    // running in production. It read 0 there for as long as the registry
    // path sent no deltas, and nothing else would have said so.
    const channel = randomUUID();
    const modern = client(channel);
    const legacy = client(channel, false);
    const a = client(channel);
    const b = client(channel);
    expect((await getVoiceActivitySnapshot()).roster).toMatchObject({
      deltas: 0,
      snapshots: 0,
    });

    await join(a);
    // The first frame: a whole roster to all four sockets.
    let roster = (await getVoiceActivitySnapshot()).roster;
    expect(roster).toMatchObject({ deltas: 0, snapshots: 4, audienceSnapshots: 3 });

    await join(b);
    // The second: a delta to the three that asked, a whole roster to the one
    // that did not, and that one is in the audience.
    const snapshot = await getVoiceActivitySnapshot();
    roster = snapshot.roster;
    expect(roster).toMatchObject({
      deltas: 3,
      snapshots: 5,
      audienceSnapshots: 4,
      sockets: 4,
      socketsOnDeltas: 3,
    });
    // Counted against the room the rows describe, so the two numbers can be
    // read side by side on the dashboard.
    expect(snapshot.activeRooms).toBe(1);
    expect(snapshot.participants).toBe(2);
    void modern;
    void legacy;
  });
});
