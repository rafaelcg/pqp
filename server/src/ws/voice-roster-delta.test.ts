import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import type { VoiceParticipant } from "@pqp/shared";

/**
 * THE ROSTER IS SENT AS A DELTA, AND A DELTA IS ONLY WORTH ANYTHING IF EVERY
 * RECEIVER PROVABLY ENDS UP HOLDING THE SAME ROOM THE SERVER HOLDS.
 *
 * #260 bounded how often a roster goes out. It left the frame the size of the
 * room, and size times audience is what broke on 2026-09-05: 130 people in a
 * 508-member community meant ~45 KB to every socket, twice a second, while
 * arrivals were failing to be welcomed inside the client's own give-up timer.
 *
 * So the fan-out now sends what changed. That trades one guarantee for
 * another: a snapshot is self-correcting and a patch is not, so these tests
 * exist to hold the replacement guarantee rather than to admire the byte
 * count. Every test below applies frames through `Client`, which implements
 * the receiver rule in `voiceRosterDeltaMessageSchema` exactly as the real
 * client does, and then asserts the client's belief equals the server's room.
 *
 * A test that only checked "a delta was sent" would pass against a server that
 * had silently stopped sending anything useful, so the assertions are always
 * about the reconstructed roster, and `expectConverged` refuses to pass on an
 * empty room unless the room really is empty.
 */

const backend = vi.hoisted(() => ({ configured: "livekit" as "mesh" | "livekit" }));

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

/**
 * The audience is every member of the server, which is the whole point: a
 * roster goes to people who can *see* the channel, not to the people in the
 * call, and that is the multiplier the delta exists to remove.
 */
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

const { setCoalesceImmediate } = await import("./fanout.js");
setCoalesceImmediate(true);

const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  sendAllVoiceRosters,
  setVoiceUserServerMuted,
  ROSTER_KEYFRAME_MS,
} = await import("./voice.js");

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
 * A receiver that follows the published rule and nothing else.
 *
 * Deliberately not a shared helper with the production client: the point is to
 * check the SERVER against the written contract, so this reads only fields the
 * schema documents and applies only the rule the schema states.
 */
class Client {
  readonly socket: WebSocket;
  readonly user: DbUser;
  readonly frames: Frame[] = [];
  /** peerId -> participant, this client's whole belief about the room. */
  belief = new Map<string, VoiceParticipant>();
  seq = 0;
  /** Deltas this client refused because they did not follow its held state. */
  gaps = 0;
  /** When true, frames are counted but not applied: a socket gone quiet. */
  deaf = false;

  constructor(
    readonly channelId: string,
    delta: boolean,
  ) {
    this.user = {
      id: randomUUID(),
      display_name: `User ${this.frames.length}`,
      avatar_url: null,
    } as unknown as DbUser;
    this.socket = {
      readyState: 1,
      send: (payload: string) => {
        const parsed = JSON.parse(payload) as Frame;
        this.frames.push(parsed);
        if (!this.deaf) {
          this.apply(parsed);
        }
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
    return this.frames.filter((f) => f.type === type);
  }

  peerIds(): string[] {
    return [...this.belief.keys()].sort();
  }
}

const open: Client[] = [];

/**
 * Let every coalesced fan-out land before the next thing happens.
 *
 * `broadcastRoster` is fire-and-forget from most call sites and the coalescer
 * fires on a microtask under `setCoalesceImmediate`, so without this a test
 * can create a socket in the window between an action and the frame that
 * reports it — which is a real situation (it is exactly the mid-call arrival
 * the keyframe exists for) but not the one each test below is about.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function client(channelId: string, delta = true): Client {
  const c = new Client(channelId, delta);
  open.push(c);
  return c;
}

async function join(c: Client): Promise<void> {
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    {
      type: "join-voice-room",
      voiceChannelId: c.channelId,
      transports: ["mesh", "livekit"],
    },
  );
  await flush();
}

async function setMuted(c: Client, muted: boolean): Promise<void> {
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    { type: "set-voice-state", muted, deafened: false },
  );
  await flush();
}

async function leave(c: Client): Promise<void> {
  await handleVoiceMessage(
    { socket: c.socket, user: c.user },
    { type: "leave-voice-room" },
  );
  await flush();
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

/**
 * The assertion this whole file is for. Not "a delta arrived" — that would
 * pass against a server that sent one useless frame and then went silent — but
 * "this receiver, having applied only what it was sent, holds exactly the room
 * the server holds", plus a check that it was not handed a snapshot every time
 * (which would be true and would also mean the optimisation is not happening).
 */
async function expectConverged(c: Client, channelId: string): Promise<void> {
  expect(c.peerIds()).toEqual(await serverRoom(channelId));
  expect(c.gaps).toBe(0);
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  for (const c of open.splice(0)) {
    deleteAuthenticatedSocket(c.socket);
  }
  resetVoicePeers();
  resetVoiceRateLimits();
  resetVoiceRoomTransports();
  backend.configured = "livekit";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("voice roster deltas", () => {
  it("sends a delta to a client that asked and a whole roster to one that did not", async () => {
    const channel = randomUUID();
    const modern = client(channel);
    const legacy = client(channel, false);
    const first = client(channel);
    await join(first);
    // The first fan-out of a room is always a keyframe: nothing has described
    // it yet, so there is no state for a patch to sit on.
    expect(modern.framesOfType("voice-roster")).toHaveLength(1);

    const second = client(channel);
    await join(second);

    const delta = modern.framesOfType("voice-roster-delta").at(-1);
    expect(delta).toBeDefined();
    expect((delta?.joined as VoiceParticipant[]).map((p) => p.userId)).toEqual([
      second.user.id,
    ]);
    expect(delta?.size).toBe(2);

    // The old client saw the same news as a whole roster, exactly as before.
    expect(legacy.framesOfType("voice-roster-delta")).toHaveLength(0);
    const full = legacy.framesOfType("voice-roster").at(-1);
    expect((full?.participants as VoiceParticipant[]).map((p) => p.userId).sort())
      .toEqual([first.user.id, second.user.id].sort());

    await expectConverged(modern, channel);
    await expectConverged(legacy, channel);
  });

  it("converges on the server's room across joins, mutes and leaves", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const inRoom: Client[] = [];
    for (let i = 0; i < 6; i += 1) {
      const c = client(channel);
      inRoom.push(c);
      await join(c);
    }
    await setMuted(inRoom[0]!, true);
    await setMuted(inRoom[3]!, true);
    await leave(inRoom[1]!);
    await setMuted(inRoom[0]!, false);
    await leave(inRoom[4]!);
    const late = client(channel);
    inRoom.push(late);
    await join(late);

    // The watcher never joined the call and was never sent a full roster after
    // the first, yet holds the room exactly.
    expect(watcher.framesOfType("voice-roster-delta").length).toBeGreaterThan(3);
    await expectConverged(watcher, channel);
    expect(watcher.belief.size).toBe(5);
    // And the mute really travelled, not just the membership.
    const muted = [...watcher.belief.values()].filter((p) => p.muted);
    expect(muted.map((p) => p.userId)).toEqual([inRoom[3]!.user.id]);
  });

  it("carries a moderator mute as a delta about that person alone", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const target = client(channel);
    const other = client(channel);
    await join(target);
    await join(other);

    const before = watcher.framesOfType("voice-roster-delta").length;
    await setVoiceUserServerMuted(channel, target.user.id, true);
    await flush();

    const delta = watcher.framesOfType("voice-roster-delta").at(-1);
    expect(watcher.framesOfType("voice-roster-delta").length).toBe(before + 1);
    expect((delta?.updated as VoiceParticipant[]).map((p) => p.userId)).toEqual([
      target.user.id,
    ]);
    expect((delta?.updated as VoiceParticipant[])[0]?.serverMuted).toBe(true);
    await expectConverged(watcher, channel);
    expect(watcher.belief.get([...watcher.belief.keys()][0]!)).toBeDefined();
    expect(
      [...watcher.belief.values()].filter((p) => p.serverMuted).map((p) => p.userId),
    ).toEqual([target.user.id]);
  });

  it("stops applying after a gap, and the next keyframe repairs it", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const a = client(channel);
    await join(a);
    await expectConverged(watcher, channel);

    // A frame this socket never sees: the wire is not the only way to lose
    // one, and the receiver must not be able to tell the difference.
    watcher.deaf = true;
    const b = client(channel);
    await join(b);
    watcher.deaf = false;

    const c = client(channel);
    await join(c);
    // The delta describing `c` is seq n+2 against a client holding n. It is
    // refused rather than applied, because applying it would leave `b`
    // permanently invisible with nothing to notice it.
    expect(watcher.gaps).toBeGreaterThan(0);
    expect(watcher.belief.size).toBe(1);

    // The keyframe is the repair, and it needs nothing from the client.
    now += ROSTER_KEYFRAME_MS;
    const d = client(channel);
    await join(d);
    expect(watcher.framesOfType("voice-roster").length).toBe(2);
    expect(watcher.peerIds()).toEqual(await serverRoom(channel));
    expect(watcher.belief.size).toBe(4);
  });

  it("refuses a delta whose size does not match what applying it produced", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const a = client(channel);
    await join(a);
    const b = client(channel);
    await join(b);

    // Hand the receiver a well-sequenced delta that lies about the outcome.
    // Nothing the server does produces this; the check exists because `seq`
    // alone cannot see a divergence that is not a lost frame.
    const held = watcher.belief.size;
    const rogue = {
      type: "voice-roster-delta",
      voiceChannelId: channel,
      seq: watcher.seq + 1,
      size: held + 5,
      joined: [],
    };
    watcher.socket.send(JSON.stringify(rogue));
    expect(watcher.gaps).toBe(1);
    expect(watcher.belief.size).toBe(held);
  });

  it("sends a whole roster again once the keyframe interval passes", async () => {
    const channel = randomUUID();
    const watcher = client(channel);
    const a = client(channel);
    await join(a);
    expect(watcher.framesOfType("voice-roster")).toHaveLength(1);

    now += ROSTER_KEYFRAME_MS - 1;
    const b = client(channel);
    await join(b);
    expect(watcher.framesOfType("voice-roster")).toHaveLength(1);

    now += 1;
    const c = client(channel);
    await join(c);
    expect(watcher.framesOfType("voice-roster")).toHaveLength(2);
    await expectConverged(watcher, channel);
  });

  it("restarts the sequence when the room empties, so the next call needs no snapshot", async () => {
    const channel = randomUUID();
    const a = client(channel);
    await join(a);
    await leave(a);

    // A socket that has been here the whole time now holds nothing, and the
    // server has forgotten the room's sequence with it.
    const watcher = client(channel);
    const b = client(channel);
    await join(b);
    // First fan-out of the new call: a keyframe, because the keyframe clock is
    // per channel and this channel has just been described.
    now += ROSTER_KEYFRAME_MS;
    const c = client(channel);
    await join(c);
    const d = client(channel);
    await join(d);

    const delta = watcher.framesOfType("voice-roster-delta").at(-1);
    expect(delta).toBeDefined();
    await expectConverged(watcher, channel);
    expect(watcher.belief.size).toBe(3);
  });

  it("hands a socket that authenticates mid-call a snapshot it can build deltas on", async () => {
    const channel = randomUUID();
    const a = client(channel);
    await join(a);
    const b = client(channel);
    await join(b);

    // Somebody opens the app while the call is running.
    const late = client(channel);
    await sendAllVoiceRosters(late.socket, late.user);
    expect(late.belief.size).toBe(2);

    const c = client(channel);
    await join(c);
    // The next delta lands on the sequence that snapshot carried, with no
    // round trip and no gap.
    expect(late.gaps).toBe(0);
    await expectConverged(late, channel);
    expect(late.belief.size).toBe(3);
  });

  it("costs a fraction of the bytes a whole roster costs, at room size", async () => {
    const channel = randomUUID();
    const modern = client(channel);
    const legacy = client(channel, false);
    const inRoom: Client[] = [];
    for (let i = 0; i < 30; i += 1) {
      const c = client(channel);
      inRoom.push(c);
      await join(c);
    }
    for (const c of inRoom) {
      await setMuted(c, true);
    }

    const bytes = (c: Client, ...types: string[]) =>
      c.frames
        .filter((f) => types.includes(f.type))
        .reduce((sum, f) => sum + JSON.stringify(f).length, 0);

    const deltaBytes = bytes(modern, "voice-roster", "voice-roster-delta");
    const fullBytes = bytes(legacy, "voice-roster");
    // Not a benchmark: the ratio is what the change is FOR, and a regression
    // that quietly reverted to whole rosters would still pass every other test
    // in this file.
    expect(deltaBytes * 5).toBeLessThan(fullBytes);
    await expectConverged(modern, channel);
    await expectConverged(legacy, channel);
  });
});
