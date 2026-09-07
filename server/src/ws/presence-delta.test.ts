import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * PRESENCE IS SENT AS A DELTA, AND A DELTA IS ONLY WORTH ANYTHING IF EVERY
 * RECEIVER PROVABLY ENDS UP HOLDING THE SAME VIEWER LIST THE SERVER HOLDS.
 *
 * `presence-update` lists every viewer of a channel and goes to every viewer
 * of that channel, so it is quadratic in the channel's size and it fires on
 * every arrival and departure. #260's coalescer bounded how OFTEN; it left the
 * frame the size of the audience. Once the voice roster stopped being the
 * biggest thing on the wire (#314) this became it, measured on the harness at
 * 846 MB of the 1104 MB the server wrote in a 30-second run.
 *
 * So the fan-out now sends who arrived and who left. That trades one guarantee
 * for another — a snapshot is self-correcting and a patch is not — so these
 * tests exist to hold the replacement guarantee rather than to admire the byte
 * count. Every test applies frames through `Client`, which implements the
 * receiver rule in `presenceDeltaSchema` exactly as `use-chat.ts` does, and
 * then asserts the client's belief equals the server's channel.
 *
 * A test that only checked "a delta was sent" would pass against a server that
 * had silently stopped sending anything useful, so the assertions are about
 * the reconstructed list, and `expectHolds` refuses to pass vacuously on an
 * empty list unless the channel really is empty.
 *
 * No database: the service layer below the socket bookkeeping is faked, so
 * this runs everywhere `pnpm test` does, Postgres or not.
 */

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

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  restoreDmParticipants: async () => {},
}));

vi.mock("../services/blocks.js", () => ({
  listBlockersOf: async () => new Set<string>(),
}));

vi.mock("../services/servers.js", () => ({
  getChannelAudience: async () => null,
  getChannel: async () => ({ kind: "dm", server_id: null }),
}));

vi.mock("../services/permissions.js", () => ({
  bumpPermissionsVersion: async () => 1,
  computeMemberPermissions: async () => 0n,
  listServerMemberIds: async () => [],
}));

vi.mock("../services/embeds.js", () => ({
  extractFirstUrl: () => null,
  fetchAndCacheEmbed: async () => null,
  getEmbedCacheState: async () => ({ fresh: true, embed: null }),
}));

vi.mock("../services/messages.js", () => ({
  createMessage: async () => ({ id: "message-1" }),
  getReplyParent: async () => null,
  mapMessage: (row: { id: string }) => ({ id: row.id, body: "hi" }),
}));

vi.mock("../services/outgoing-webhooks.js", () => ({
  enqueueOutgoingMessageCreated: async () => 0,
}));

vi.mock("../services/reactions.js", () => ({
  getMessageChannelId: async () => null,
  toggleReaction: async () => ({ added: true }),
  resolveChannelMemberName: async () => "someone",
}));

vi.mock("../services/polls.js", () => ({
  closePoll: async () => null,
  votePoll: async () => null,
}));

vi.mock("../services/push.js", () => ({
  pushChannelActivity: async () => {},
}));

vi.mock("../services/threads.js", () => ({
  getThreadInfo: async () => null,
}));

/**
 * Who is hidden, as `localPresenceUsers` asks.
 *
 * Mocked rather than driven through the real status registry because the
 * registry needs a socket registration and a database read to hold a manual
 * status, and neither is what the test below is about. The filter itself is
 * status.ts's business and is proved in status.test.ts; what belongs here is
 * the delta-specific half — that hiding somebody reaches BOTH frame shapes,
 * which is a claim about this file.
 */
const hidden = vi.hoisted(() => new Set<string>());

vi.mock("./status.js", () => ({
  isInvisible: (userId: string) => hidden.has(userId),
  isPresentForHere: () => true,
  setSocketIdle: () => {},
}));

const {
  handleChatMessage,
  resetChatRateLimits,
  resetPresenceCoalescer,
  resetPresenceSequences,
  getPresenceFanoutStats,
  PRESENCE_KEYFRAME_MS,
} = await import("./chat.js");
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "./sockets.js"
);
const { setCoalesceImmediate } = await import("./fanout.js");


setCoalesceImmediate(true);

interface Viewer {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * A socket that applies presence frames the way the real client does.
 *
 * The receiver rule is implemented here IN FULL — the sequence check and the
 * size check, and a refusal to keep patching once either fails — because a
 * harness that ignored `seq` would agree with a server that had quietly
 * stopped describing changes, and every test below would pass on a broken
 * fan-out.
 */
class Client {
  readonly socket: WebSocket;
  readonly user: DbUser;
  /** userId -> the viewer, as this client believes the channel to be. */
  belief = new Map<string, Viewer>();
  /** Last sequence applied. 0 is "no baseline", as on the wire. */
  seq = 0;
  /** How many frames of each kind this socket was actually sent. */
  snapshots = 0;
  deltas = 0;
  /** Times a gap or a size mismatch made this client stop patching. */
  desynced = 0;
  /** Frames this client was told to ignore, to simulate a loss. */
  private ignore = 0;

  constructor(
    readonly channelId: string,
    readonly userId: string,
    readonly wantsDeltas: boolean,
  ) {
    this.user = asUser(userId);
    this.socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (payload: string | Buffer) => this.receive(String(payload)),
      on: () => {},
    } as unknown as WebSocket;
    setAuthenticatedSocket(
      this.socket,
      this.user,
      wantsDeltas ? ["presence-delta"] : [],
    );
  }

  /** Drop the next `n` frames on the floor, as a bad link would. */
  loseNext(n: number): void {
    this.ignore = n;
  }

  private receive(raw: string): void {
    const frame = JSON.parse(raw) as {
      type: string;
      channelId?: string;
      users?: Viewer[];
      joined?: Viewer[];
      left?: string[];
      seq?: number;
      size?: number;
    };
    if (frame.type === "presence-update") {
      this.snapshots += 1;
    } else if (frame.type === "presence-delta") {
      this.deltas += 1;
    } else {
      return;
    }
    if (frame.channelId !== this.channelId) {
      return;
    }
    if (this.ignore > 0) {
      this.ignore -= 1;
      return;
    }
    if (frame.type === "presence-update") {
      // Authoritative: whatever the sequence said and whatever was believed,
      // the channel is this.
      this.belief = new Map((frame.users ?? []).map((u) => [u.id, u]));
      this.seq = frame.seq ?? 0;
      return;
    }
    if (frame.seq !== this.seq + 1) {
      this.desynced += 1;
      return;
    }
    const next = new Map(this.belief);
    for (const user of frame.joined ?? []) {
      next.set(user.id, user);
    }
    for (const id of frame.left ?? []) {
      next.delete(id);
    }
    if (next.size !== frame.size) {
      this.desynced += 1;
      return;
    }
    this.belief = next;
    this.seq = frame.seq;
  }

  ids(): string[] {
    return [...this.belief.keys()].sort();
  }
}

function asUser(id: string): DbUser {
  return {
    id,
    clerk_id: `clerk_${id}`,
    display_name: `name-${id}`,
    username: id,
    discriminator: "0001",
    avatar_url: null,
  } as DbUser;
}

const open: Client[] = [];

function client(channelId: string, userId: string, deltas = true): Client {
  const c = new Client(channelId, userId, deltas);
  open.push(c);
  return c;
}

/**
 * Let every coalesced fan-out land before the next thing happens.
 *
 * `broadcastPresence` is fire-and-forget on every leave path and the coalescer
 * fires on a microtask under `setCoalesceImmediate`, so without this a test
 * can act in the window between a departure and the frame that reports it.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

async function join(c: Client): Promise<void> {
  await handleChatMessage(
    { socket: c.socket, user: c.user },
    { type: "join-channel", channelId: c.channelId },
  );
  await flush();
}

async function leave(c: Client): Promise<void> {
  await handleChatMessage(
    { socket: c.socket, user: c.user },
    { type: "leave-channel" },
  );
  await flush();
}

/**
 * Every client named holds exactly `expected`, and `expected` is not empty
 * unless it is meant to be — so a fan-out that stopped saying anything cannot
 * make this pass.
 */
function expectHolds(clients: Client[], expected: string[]): void {
  const want = [...expected].sort();
  for (const c of clients) {
    expect(c.ids(), `client ${c.userId} disagrees`).toEqual(want);
    expect(c.desynced, `client ${c.userId} lost sync`).toBe(0);
  }
}

beforeEach(() => {
  for (const c of open) {
    deleteAuthenticatedSocket(c.socket);
  }
  open.length = 0;
  resetChatRateLimits();
  resetPresenceCoalescer();
  resetPresenceSequences();
  hidden.clear();
  vi.useRealTimers();
});

describe("presence deltas converge", () => {
  it("a delta receiver ends up holding exactly what the server holds", async () => {
    const channelId = randomUUID();
    const a = client(channelId, "user-a");
    await join(a);
    const b = client(channelId, "user-b");
    await join(b);
    const c = client(channelId, "user-c");
    await join(c);

    // Everyone sees everyone, reconstructed from deltas rather than lists.
    expectHolds([a, b, c], ["user-a", "user-b", "user-c"]);
    // And it really was deltas: `a` was here first, so every arrival after its
    // own baseline reached it as a patch.
    expect(a.deltas).toBeGreaterThan(0);

    await leave(b);
    expectHolds([a, c], ["user-a", "user-c"]);
  });

  it("a joiner gets a baseline, so it is never stuck on a wrong count", async () => {
    const channelId = randomUUID();
    const a = client(channelId, "user-a");
    const b = client(channelId, "user-b");
    await join(a);
    await join(b);

    // The late arrival held nothing when it joined a channel that was already
    // occupied. Without the unicast baseline the coalesced delta reporting its
    // own arrival would read as a gap and it would sit on an empty list until
    // the next keyframe.
    const late = client(channelId, "user-late");
    await join(late);

    expect(late.snapshots).toBeGreaterThan(0);
    expectHolds([late], ["user-a", "user-b", "user-late"]);
  });

  it("an old client keeps receiving whole lists, byte-for-byte as before", async () => {
    const channelId = randomUUID();
    const legacy = client(channelId, "user-legacy", false);
    await join(legacy);
    const newcomer = client(channelId, "user-new");
    await join(newcomer);
    const third = client(channelId, "user-third");
    await join(third);

    // Never a delta, always the whole list, and the whole list is right.
    expect(legacy.deltas).toBe(0);
    expect(legacy.snapshots).toBeGreaterThan(0);
    expectHolds([legacy], ["user-legacy", "user-new", "user-third"]);
    // And the negotiating socket beside it did get deltas, so this is a real
    // per-socket split rather than the feature being off.
    expect(newcomer.deltas).toBeGreaterThan(0);
  });

  it("an old and a new client in the same channel agree about it", async () => {
    const channelId = randomUUID();
    const legacy = client(channelId, "user-legacy", false);
    const modern = client(channelId, "user-modern");
    await join(legacy);
    await join(modern);
    const extra = client(channelId, "user-extra");
    await join(extra);
    await leave(legacy);

    expectHolds([modern, extra], ["user-modern", "user-extra"]);
  });
});

describe("presence deltas recover", () => {
  it("a lost frame stops the patching rather than diverging quietly", async () => {
    const channelId = randomUUID();
    const a = client(channelId, "user-a");
    await join(a);
    const b = client(channelId, "user-b");
    await join(b);

    // `a` never sees the frame announcing `c`.
    a.loseNext(1);
    const c = client(channelId, "user-c");
    await join(c);

    // The next delta is seq+2 as far as `a` is concerned, so it refuses it.
    const d = client(channelId, "user-d");
    await join(d);
    expect(a.desynced).toBeGreaterThan(0);
    // Refusing means staying behind, never inventing a list: `a` holds a
    // strict subset of the truth and no phantom.
    for (const id of a.ids()) {
      expect(["user-a", "user-b", "user-c", "user-d"]).toContain(id);
    }
    // Nobody who did not lose a frame is affected.
    expectHolds([b], ["user-a", "user-b", "user-c", "user-d"]);
  });

  it("the periodic whole list repairs a client that fell behind", async () => {
    const channelId = randomUUID();
    const a = client(channelId, "user-a");
    await join(a);
    const b = client(channelId, "user-b");
    await join(b);

    a.loseNext(1);
    const c = client(channelId, "user-c");
    await join(c);
    const d = client(channelId, "user-d");
    await join(d);
    expect(a.desynced).toBeGreaterThan(0);

    // Ten seconds later the server owes everyone a keyframe, whether or not
    // anybody asked and whether or not anybody could tell they needed one.
    // This is the whole convergence argument: staleness is bounded by the
    // constant, by construction.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + PRESENCE_KEYFRAME_MS + 1);
    const e = client(channelId, "user-e");
    await join(e);
    vi.useRealTimers();

    expect(a.ids()).toEqual(
      ["user-a", "user-b", "user-c", "user-d", "user-e"].sort(),
    );
  });

  it("the sequence restarts when the channel empties, so the next call is applicable", async () => {
    const channelId = randomUUID();
    const a = client(channelId, "user-a");
    const b = client(channelId, "user-b");
    await join(a);
    await join(b);
    await leave(a);
    await leave(b);

    // A brand new viewer holds nothing and must be able to follow along from
    // the first frame, with no extra round trip and no special case.
    const fresh = client(channelId, "user-fresh");
    await join(fresh);
    const second = client(channelId, "user-second");
    await join(second);

    expectHolds([fresh], ["user-fresh", "user-second"]);
  });
});

describe("presence deltas keep the rules presence already had", () => {
  it("an invisible viewer is in no snapshot and in no delta", async () => {
    const channelId = randomUUID();
    const seen = client(channelId, "user-seen");
    await join(seen);

    const lurker = client(channelId, "user-hidden");
    hidden.add("user-hidden");
    await join(lurker);

    // Invisibility is enforced where the roster is built, so it holds on both
    // frame shapes for free — but "for free" is exactly the kind of claim that
    // stops being true silently, so it is pinned.
    expect(seen.ids()).not.toContain("user-hidden");
    // And the hidden person still receives the channel: invisibility takes
    // away what others see, never what you can.
    expect(lurker.ids()).toContain("user-seen");

    // And coming back is an ordinary arrival on both shapes: the delta names
    // them, nothing special-cases them.
    hidden.delete("user-hidden");
    const nudge = client(channelId, "user-nudge");
    await join(nudge);
    expect(seen.ids()).toContain("user-hidden");
  });

  it("a delta is not droppable, because deltas compose and snapshots supersede", async () => {
    const channelId = randomUUID();
    const stuck = client(channelId, "user-stuck");
    const stuckLegacy = client(channelId, "user-stuck-legacy", false);
    await join(stuck);
    await join(stuckLegacy);

    // Both sockets are now a megabyte behind and not draining.
    for (const c of [stuck, stuckLegacy]) {
      (c.socket as unknown as { bufferedAmount: number }).bufferedAmount =
        2 * 1024 * 1024;
    }
    const deltasBefore = stuck.deltas;
    const snapshotsBefore = stuckLegacy.snapshots;

    const arrival = client(channelId, "user-arrival");
    await join(arrival);

    // The whole list is superseded by the next one, so dropping it costs
    // nothing. A delta is not: dropping it would silently corrupt every later
    // one, and they are small by construction, so it is sent regardless.
    expect(stuck.deltas).toBeGreaterThan(deltasBefore);
    expect(stuckLegacy.snapshots).toBe(snapshotsBefore);
  });
});

describe("the fan-out says what it is doing", () => {
  it("counts deltas against snapshots, with the denominator that reads them", async () => {
    const channelId = randomUUID();
    const modern = client(channelId, "user-modern");
    const legacy = client(channelId, "user-legacy", false);
    await join(modern);
    await join(legacy);
    const third = client(channelId, "user-third");
    await join(third);

    const stats = getPresenceFanoutStats();
    // Both halves. A deploy where every frame is a snapshot because no client
    // negotiated the capability is a silent no-op that looks exactly like a
    // healthy one without the denominator (CLAUDE.md pitfall 9).
    expect(stats.deltas).toBeGreaterThan(0);
    expect(stats.snapshots).toBeGreaterThan(0);
    expect(stats.sockets).toBeGreaterThanOrEqual(3);
    expect(stats.socketsOnDeltas).toBeGreaterThanOrEqual(2);
    expect(stats.socketsOnDeltas).toBeLessThan(stats.sockets);
  });
});
