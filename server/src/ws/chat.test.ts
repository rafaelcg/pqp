import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { Permission } from "@pqp/shared";
import type { DbUser } from "../db.js";

/**
 * Fan-out reads the `channelPresence` index instead of scanning every socket on
 * the process, which makes the index — not `conn.channelId` — the thing that
 * decides who hears a message. These tests pin the two properties that stops
 * being obvious once that is true: everyone viewing the channel is in the
 * index, and the sender's own copy is delivered exactly once.
 *
 * No database: the whole service layer below the socket bookkeeping is faked,
 * so this runs everywhere `pnpm test` does, Postgres or not.
 */

vi.mock("../services/users.js", () => ({
  // Voice resolves the name to show through here now; the real one
  // reads `server_members.nickname`, which these tests have no table for.
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: vi.fn(async () => true),
}));

// The timeout chokepoint queries Postgres, and this suite deliberately runs
// without one. Enforcement itself is proved end-to-end against a real database
// in services/sanctions.test.ts; here it only has to be out of the way.
vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: vi.fn(async () => false),
  restoreDmParticipants: vi.fn(async () => {}),
}));

vi.mock("../services/blocks.js", () => ({
  listBlockersOf: async () => new Set<string>(),
}));

// Null audience short-circuits `notifyChannelActivity`, which is a different
// fan-out (unread badges, over every authenticated socket) than the one under
// test here.
vi.mock("../services/servers.js", () => ({
  getChannelAudience: async () => null,
  getChannel: vi.fn(async () => ({ kind: "dm", server_id: null })),
}));

vi.mock("../services/permissions.js", () => ({
  bumpPermissionsVersion: async () => 1,
  computeMemberPermissions: vi.fn(async () => 0n),
  listServerMemberIds: async () => [],
}));

vi.mock("../services/embeds.js", () => ({
  extractFirstUrl: () => null,
  fetchAndCacheEmbed: async () => null,
  getEmbedCacheState: async () => ({ fresh: true, embed: null }),
}));

vi.mock("../services/messages.js", () => ({
  createMessage: vi.fn(async () => ({ id: "message-1" })),
  getReplyParent: vi.fn(async () => null),
  mapMessage: (row: { id: string }) => ({ id: row.id, body: "hi" }),
}));

vi.mock("../services/outgoing-webhooks.js", () => ({
  enqueueOutgoingMessageCreated: async () => 0,
}));

vi.mock("../services/reactions.js", () => ({
  getMessageChannelId: async () => null,
  toggleReaction: async () => ({ added: true }),
  resolveChannelMemberName: async (
    _channelId: string,
    _userId: string,
    fallback: string,
  ) => fallback,
}));

vi.mock("../services/polls.js", () => ({
  votePoll: async () => null,
  closePoll: async () => null,
}));

// --- threads --- "not a thread" keeps the chip-refresh tail of the message
// path (and the thread-join validation) inert; the thread machinery itself is
// proved against a real database in services/threads.test.ts and
// api/threads.test.ts.
vi.mock("../services/threads.js", () => ({
  getThreadInfo: async () => null,
}));

/**
 * Slow mode's clock lives in Postgres now (`channel_slowmode_sends`), and this
 * suite deliberately runs without one. Faked here with the same contract so
 * the tests below keep proving what they are actually about: which channel
 * types are covered, which permissions walk through, and that a refusal for
 * another reason never spends a turn. That the *storage* is correct -- one
 * budget per person per channel, shared across machines, one winner under a
 * race -- is proved against a real database in api/slow-mode.test.ts, which
 * is the only place it can be proved.
 */
const slowModeClock = new Map<string, { at: number; seconds: number }>();

vi.mock("../services/slow-mode.js", () => ({
  chargeSlowMode: async (channelId: string, userId: string, seconds: number) => {
    const key = `${channelId}:${userId}`;
    const previous = slowModeClock.get(key);
    const now = Date.now();
    if (previous && now - previous.at < seconds * 1000) {
      // Flat interval rather than the true remainder: a stub that subtracts
      // wall-clock elapsed makes every assertion below a millisecond race.
      // What the real remainder is gets asserted where a real clock runs.
      return { ok: false as const, retryAfterMs: seconds * 1000 };
    }
    slowModeClock.set(key, { at: now, seconds });
    return { ok: true as const };
  },
  refundSlowMode: async (channelId: string, userId: string) => {
    slowModeClock.delete(`${channelId}:${userId}`);
  },
  sweepSlowModeClocks: async () => 0,
}));

const {
  broadcastToChannel,
  deliverPermissionsUpdate,
  handleChatMessage,
  notifyFriendActivity,
  postChannelMessage,
  resetChatRateLimits,
} = await import("./chat.js");
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "./sockets.js"
);
const { canAccessChannel } = await import("../services/users.js");
const { isDmSendBlocked, restoreDmParticipants } = await import(
  "../services/dms.js"
);
const { getChannel } = await import("../services/servers.js");
const { computeMemberPermissions } = await import("../services/permissions.js");
const { createMessage, getReplyParent } = await import(
  "../services/messages.js"
);

interface Recorder {
  socket: WebSocket;
  received: string[];
}

/** `on` is a no-op: nothing here ever closes, so nothing needs the handler. */
function recordingSocket(readyState = 1): Recorder {
  const received: string[] = [];
  const socket = {
    readyState,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

function asUser(id: string): DbUser {
  return {
    id,
    clerk_id: `clerk_${id}`,
    display_name: id,
    username: id,
    discriminator: "0001",
    avatar_url: null,
  };
}

function framesOfType(received: string[], type: string): unknown[] {
  return received
    .map((raw) => JSON.parse(raw) as { type: string })
    .filter((frame) => frame.type === type);
}

/**
 * Connections live in module state and these sockets never close, so every test
 * works in a channel nobody else touched. Real uuids because the client frames
 * are schema-validated before they reach any of this.
 */
function nextChannelId(): string {
  return randomUUID();
}

async function join(recorder: Recorder, userId: string, channelId: string) {
  await handleChatMessage(
    { socket: recorder.socket, user: asUser(userId) },
    { type: "join-channel", channelId },
  );
  recorder.received.length = 0;
}

describe("broadcastToChannel", () => {
  beforeEach(() => {
    resetChatRateLimits();
  });

  it("delivers to everyone viewing the channel", async () => {
    const channelId = nextChannelId();
    const first = recordingSocket();
    const second = recordingSocket();
    await join(first, "user-a", channelId);
    await join(second, "user-b", channelId);

    broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });

    expect(framesOfType(first.received, "message-deleted")).toHaveLength(1);
    expect(framesOfType(second.received, "message-deleted")).toHaveLength(1);
  });

  it("does not deliver to someone viewing a different channel", async () => {
    const channelId = nextChannelId();
    const otherChannelId = nextChannelId();
    const here = recordingSocket();
    const elsewhere = recordingSocket();
    await join(here, "user-a", channelId);
    await join(elsewhere, "user-b", otherChannelId);

    broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });

    expect(framesOfType(here.received, "message-deleted")).toHaveLength(1);
    expect(elsewhere.received).toHaveLength(0);
  });

  it("delivers to alsoSocket even when it is viewing nothing", async () => {
    const channelId = nextChannelId();
    const viewer = recordingSocket();
    await join(viewer, "user-a", channelId);
    const sender = recordingSocket();

    broadcastToChannel(
      channelId,
      { type: "message-deleted", channelId, messageId: "m1" },
      sender.socket,
    );

    expect(framesOfType(viewer.received, "message-deleted")).toHaveLength(1);
    expect(framesOfType(sender.received, "message-deleted")).toHaveLength(1);
  });

  it("delivers exactly one copy to an alsoSocket that is also viewing", async () => {
    // The usual case — you are looking at the channel you post in — so a
    // double send here would double every bubble in the app.
    const channelId = nextChannelId();
    const sender = recordingSocket();
    await join(sender, "user-a", channelId);

    broadcastToChannel(
      channelId,
      { type: "message-deleted", channelId, messageId: "m1" },
      sender.socket,
    );

    expect(framesOfType(sender.received, "message-deleted")).toHaveLength(1);
  });

  it("skips sockets that are not open", async () => {
    const channelId = nextChannelId();
    const closing = recordingSocket(3);
    await join(closing, "user-a", channelId);

    broadcastToChannel(
      channelId,
      { type: "message-deleted", channelId, messageId: "m1" },
      closing.socket,
    );

    expect(closing.received).toHaveLength(0);
  });

  it("stops delivering once the viewer leaves", async () => {
    const channelId = nextChannelId();
    const leaver = recordingSocket();
    await join(leaver, "user-a", channelId);
    await handleChatMessage(
      { socket: leaver.socket, user: asUser("user-a") },
      { type: "leave-channel", channelId },
    );
    leaver.received.length = 0;

    broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });

    expect(leaver.received).toHaveLength(0);
  });

  it("keeps delivering to a socket that joined implicitly by posting", async () => {
    // A client that posts without ever sending `join-channel` had its
    // `channelId` set and nothing else. That was invisible while fan-out
    // re-scanned that field; against the presence index it means every later
    // message in the channel is silently dropped for that socket.
    const channelId = nextChannelId();
    const poster = recordingSocket();
    await handleChatMessage(
      { socket: poster.socket, user: asUser("user-a") },
      { type: "message-create", channelId, body: "hello" },
    );
    expect(framesOfType(poster.received, "message-broadcast")).toHaveLength(1);
    poster.received.length = 0;

    broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "message-1",
    });

    expect(framesOfType(poster.received, "message-deleted")).toHaveLength(1);
  });
});

/**
 * The friend nudge — the frame that closes the "B is staring at the app and
 * sees nothing" hole.
 *
 * Addressed to one PERSON rather than to a channel, so it is tested against the
 * authenticated-socket registry directly: no join, no presence index, and
 * therefore nothing about a channel that could accidentally widen it.
 */
describe("notifyFriendActivity", () => {
  const asked = "11111111-1111-1111-1111-111111111111";
  const bystander = "22222222-2222-2222-2222-222222222222";
  const open: Recorder[] = [];

  function connect(userId: string, readyState = 1): Recorder {
    const recorder = recordingSocket(readyState);
    setAuthenticatedSocket(recorder.socket, asUser(userId));
    open.push(recorder);
    return recorder;
  }

  afterEach(() => {
    for (const recorder of open) {
      deleteAuthenticatedSocket(recorder.socket);
    }
    open.length = 0;
  });

  it("reaches every socket the addressee holds — laptop and phone both", () => {
    const laptop = connect(asked);
    const phone = connect(asked);

    notifyFriendActivity(asked, "request");

    for (const recorder of [laptop, phone]) {
      expect(framesOfType(recorder.received, "friend-activity")).toEqual([
        { type: "friend-activity", kind: "request" },
      ]);
    }
  });

  /**
   * THE ONE THAT MATTERS. A nudge that leaked would tell an uninvolved account
   * that *somebody* somewhere has a friend request, which is both noise and a
   * badge on a screen with nothing behind it. It is deliberately absent from
   * `CHAT_SERVER_MESSAGE_TYPES` for the same reason; this is the other half of
   * that guard, on the delivery side.
   */
  it("reaches nobody else", () => {
    const target = connect(asked);
    const other = connect(bystander);

    notifyFriendActivity(asked, "accepted");

    expect(framesOfType(target.received, "friend-activity")).toHaveLength(1);
    expect(other.received).toHaveLength(0);
  });

  it("carries the kind, so an accept and a request are distinguishable", () => {
    const target = connect(asked);

    notifyFriendActivity(asked, "accepted");

    expect(framesOfType(target.received, "friend-activity")).toEqual([
      { type: "friend-activity", kind: "accepted" },
    ]);
  });

  it("skips a socket that is not open rather than throwing at the route", () => {
    const closing = connect(asked, 3 /* CLOSED */);

    expect(() => notifyFriendActivity(asked, "request")).not.toThrow();
    expect(closing.received).toHaveLength(0);
  });

  it("is a no-op when the addressee is connected nowhere", () => {
    const other = connect(bystander);

    expect(() => notifyFriendActivity(asked, "request")).not.toThrow();
    expect(other.received).toHaveLength(0);
  });
});

/**
 * Same addressing as the friend nudge: one server’s members, never a channel
 * fan-out. Membership is passed in so this suite still runs without Postgres.
 */
describe("deliverPermissionsUpdate", () => {
  const member = "11111111-1111-1111-1111-111111111111";
  const bystander = "22222222-2222-2222-2222-222222222222";
  const serverId = "33333333-3333-3333-3333-333333333333";
  const open: Recorder[] = [];

  function connect(userId: string, readyState = 1): Recorder {
    const recorder = recordingSocket(readyState);
    setAuthenticatedSocket(recorder.socket, asUser(userId));
    open.push(recorder);
    return recorder;
  }

  afterEach(() => {
    for (const recorder of open) {
      deleteAuthenticatedSocket(recorder.socket);
    }
    open.length = 0;
  });

  it("reaches every socket a member holds", () => {
    const laptop = connect(member);
    const phone = connect(member);

    deliverPermissionsUpdate(serverId, 7, [member]);

    for (const recorder of [laptop, phone]) {
      expect(framesOfType(recorder.received, "permissions-update")).toEqual([
        { type: "permissions-update", serverId, version: 7 },
      ]);
    }
  });

  it("reaches nobody else", () => {
    const target = connect(member);
    const other = connect(bystander);

    deliverPermissionsUpdate(serverId, 4, [member]);

    expect(framesOfType(target.received, "permissions-update")).toHaveLength(1);
    expect(other.received).toHaveLength(0);
  });

  it("skips a socket that is not open rather than throwing at the route", () => {
    const closing = connect(member, 3 /* CLOSED */);

    expect(() =>
      deliverPermissionsUpdate(serverId, 1, [member]),
    ).not.toThrow();
    expect(closing.received).toHaveLength(0);
  });

  it("is a no-op when nobody in the member list is connected", () => {
    const other = connect(bystander);

    expect(() =>
      deliverPermissionsUpdate(serverId, 1, [member]),
    ).not.toThrow();
    expect(other.received).toHaveLength(0);
  });
});

describe("message-rejected", () => {
  const nonce = "n1";

  beforeEach(() => {
    resetChatRateLimits();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(canAccessChannel).mockResolvedValue(true);
    vi.mocked(isDmSendBlocked).mockResolvedValue(false);
    vi.mocked(restoreDmParticipants).mockClear();
    vi.mocked(getChannel).mockResolvedValue({
      kind: "dm",
      server_id: null,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(0n);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(canAccessChannel).mockReset();
    vi.mocked(canAccessChannel).mockResolvedValue(true);
    vi.mocked(isDmSendBlocked).mockReset();
    vi.mocked(isDmSendBlocked).mockResolvedValue(false);
    vi.mocked(getChannel).mockReset();
    vi.mocked(getChannel).mockResolvedValue({
      kind: "dm",
      server_id: null,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockReset();
    vi.mocked(computeMemberPermissions).mockResolvedValue(0n);
    vi.mocked(getReplyParent).mockReset();
    vi.mocked(getReplyParent).mockResolvedValue(null);
    vi.mocked(createMessage).mockReset();
    vi.mocked(createMessage).mockResolvedValue({
      id: "message-1",
    } as Awaited<ReturnType<typeof createMessage>>);
  });

  async function post(
    recorder: Recorder,
    userId: string,
    channelId: string,
    extra: { nonce?: string; body?: string; replyToId?: string } = {},
  ) {
    await handleChatMessage(
      { socket: recorder.socket, user: asUser(userId) },
      {
        type: "message-create",
        channelId,
        body: extra.body ?? "hello",
        nonce: extra.nonce ?? nonce,
        ...(extra.replyToId ? { replyToId: extra.replyToId } : {}),
      },
    );
  }

  it("tells the sender when the rate limiter refuses the create", async () => {
    const channelId = nextChannelId();
    const sender = recordingSocket();
    for (let i = 0; i < 10; i += 1) {
      await post(sender, "user-a", channelId, { nonce: `burst-${i}` });
    }
    sender.received.length = 0;

    await post(sender, "user-a", channelId);

    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-rejected")).toEqual([
      {
        type: "message-rejected",
        channelId,
        nonce,
        reason: "rate-limited",
        retryAfterMs: 1000,
      },
    ]);
  });

  it("tells the sender when they cannot access the channel", async () => {
    vi.mocked(canAccessChannel).mockResolvedValue(false);
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId);

    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-rejected")).toEqual([
      {
        type: "message-rejected",
        channelId,
        nonce,
        reason: "no-access",
      },
    ]);
  });

  it("tells the sender when SEND_MESSAGES is missing", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(1n << 6n);
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId);

    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-rejected")).toEqual([
      {
        type: "message-rejected",
        channelId,
        nonce,
        reason: "cannot-send",
      },
    ]);
  });

  it("tells the sender, and only the sender, when the DM is blocked", async () => {
    vi.mocked(isDmSendBlocked).mockResolvedValue(true);
    const channelId = nextChannelId();
    const sender = recordingSocket();
    const other = recordingSocket();
    await join(other, "user-b", channelId);
    other.received.length = 0;

    await post(sender, "user-a", channelId);

    expect(framesOfType(sender.received, "message-rejected")).toEqual([
      {
        type: "message-rejected",
        channelId,
        nonce,
        reason: "undeliverable",
      },
    ]);
    expect(other.received).toHaveLength(0);
    expect(restoreDmParticipants).not.toHaveBeenCalled();
  });

  it("refuses a character into a non-server channel", async () => {
    const posted = await postChannelMessage({
      author: { ...asUser("bot"), is_character: true },
      channelId: nextChannelId(),
      body: "oi",
    });
    expect(posted).toEqual({ ok: false, reason: "cannot-send" });
  });

  it("restores a closed 1:1 from the shared send path", async () => {
    const channelId = nextChannelId();
    const posted = await postChannelMessage({
      author: asUser("user-a"),
      channelId,
      body: "hello",
    });
    expect(posted.ok).toBe(true);
    expect(restoreDmParticipants).toHaveBeenCalledWith(channelId);
  });

  it("drops a foreign reply silently and does not spend slow mode", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    const channelId = nextChannelId();
    const foreignParent = {
      id: "00000000-0000-4000-8000-000000000001",
      channel_id: "00000000-0000-4000-8000-000000000002",
      author_id: "user-b",
      author_name: "b",
      body: "x",
    };
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "text",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
    );
    vi.mocked(getReplyParent).mockResolvedValue(foreignParent);

    const sender = recordingSocket();
    await post(sender, "user-a", channelId, {
      replyToId: foreignParent.id,
    });
    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(0);

    vi.mocked(getReplyParent).mockResolvedValue(null);
    sender.received.length = 0;
    await post(sender, "user-a", channelId);
    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-broadcast").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("tells a held member to wait, with the remaining interval", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "text",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId, { nonce: "first" });
    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
    sender.received.length = 0;

    await post(sender, "user-a", channelId);

    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-rejected")).toEqual([
      {
        type: "message-rejected",
        channelId,
        nonce,
        reason: "slow-mode",
        retryAfterMs: 5000,
      },
    ]);
  });

  it("lets MANAGE_MESSAGES bypass slow mode", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "text",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL |
        Permission.SEND_MESSAGES |
        Permission.MANAGE_MESSAGES,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId, { nonce: "first" });
    await post(sender, "user-a", channelId, { nonce: "second" });

    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-broadcast").length).toBeGreaterThanOrEqual(
      2,
    );
  });

  /**
   * The write is the last thing that can fail, and it charges before it runs
   * because the alternative -- charge after -- lets a burst through. So the
   * one case where a turn is spent on nothing has to hand it back: no
   * message landed, so nothing is owed.
   */
  it("hands the turn back when the write produces nothing", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "text",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    vi.mocked(createMessage).mockResolvedValueOnce(
      null as Awaited<ReturnType<typeof createMessage>>,
    );
    await post(sender, "user-a", channelId, { nonce: "swallowed" });
    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(0);

    // The next send is not held: the failed one cost nothing.
    await post(sender, "user-a", channelId, { nonce: "real" });
    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
    expect(
      framesOfType(sender.received, "message-broadcast").length,
    ).toBeGreaterThanOrEqual(1);
  });

  /**
   * MANAGE_CHANNELS is the other half of the convention. The person who set
   * the interval is in the room to work it, and making them wait behind their
   * own number is a surprise every time -- Discord exempts both bits and so
   * does the composer, which reads the same pair to decide whether to hold.
   */
  it("lets MANAGE_CHANNELS bypass slow mode", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "text",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL |
        Permission.SEND_MESSAGES |
        Permission.MANAGE_CHANNELS,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId, { nonce: "first" });
    await post(sender, "user-a", channelId, { nonce: "second" });

    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
    expect(
      framesOfType(sender.received, "message-broadcast").length,
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * One person's wait is their own. A channel-wide bucket would have looked
   * identical in every single-sender test above and turned a busy room into
   * one message every N seconds between everybody, which is not slow mode.
   */
  it("holds the sender who spoke, not the next person to speak", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "text",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
    );
    const channelId = nextChannelId();
    const first = recordingSocket();
    const second = recordingSocket();

    await post(first, "user-a", channelId, { nonce: "a1" });
    await post(second, "user-b", channelId, { nonce: "b1" });
    expect(framesOfType(first.received, "message-rejected")).toHaveLength(0);
    expect(framesOfType(second.received, "message-rejected")).toHaveLength(0);

    await post(first, "user-a", channelId, { nonce: "a2" });
    expect(framesOfType(first.received, "message-rejected")).toHaveLength(1);
  });

  /**
   * A voice channel carries its own chat, shown beside the call, and that
   * chat is where a busy room floods. It used to be exempt, so a moderator
   * running a 510-member community had the one tool for a flood greyed out on
   * the only surface that was flooding.
   */
  it("enforces slow mode on a voice channel's chat", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "voice",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId, { nonce: "first" });
    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
    sender.received.length = 0;

    await post(sender, "user-a", channelId);
    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(0);
    expect(framesOfType(sender.received, "message-rejected")).toEqual([
      {
        type: "message-rejected",
        channelId,
        nonce,
        reason: "slow-mode",
        retryAfterMs: 5000,
      },
    ]);
  });

  it("still lets MANAGE_MESSAGES through a voice channel's slow mode", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "voice",
      slowmode_seconds: 5,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL |
        Permission.SEND_MESSAGES |
        Permission.MANAGE_MESSAGES,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId, { nonce: "first" });
    await post(sender, "user-a", channelId, { nonce: "second" });

    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
  });

  it("leaves a voice channel with the interval off alone", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "voice",
      slowmode_seconds: 0,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId, { nonce: "first" });
    await post(sender, "user-a", channelId, { nonce: "second" });

    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
  });

  it("reads a thread's own interval, not a parent inherit", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getChannel).mockResolvedValue({
      kind: "server",
      server_id: serverId,
      type: "thread",
      slowmode_seconds: 0,
    } as Awaited<ReturnType<typeof getChannel>>);
    vi.mocked(computeMemberPermissions).mockResolvedValue(
      Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
    );
    const channelId = nextChannelId();
    const sender = recordingSocket();

    await post(sender, "user-a", channelId, { nonce: "first" });
    await post(sender, "user-a", channelId, { nonce: "second" });

    expect(framesOfType(sender.received, "message-rejected")).toHaveLength(0);
  });
});

describe("presence fan-out under load", () => {
  beforeEach(() => {
    resetChatRateLimits();
  });

  it("folds a burst of joins into one presence frame per viewer", async () => {
    const channelId = nextChannelId();
    const watcher = recordingSocket();
    await join(watcher, "watcher", channelId);

    // Ten people arriving inside one coalescing window. Before the window
    // existed this was ten viewer-list snapshots to every socket in the
    // channel, quadratic in its size.
    const arrivals = Array.from({ length: 10 }, (_, i) => {
      const rec = recordingSocket();
      return handleChatMessage(
        { socket: rec.socket, user: asUser(`arrival-${i}`) },
        { type: "join-channel", channelId },
      );
    });
    await Promise.all(arrivals);

    const frames = framesOfType(watcher.received, "presence-update") as Array<{
      users: Array<{ id: string }>;
    }>;
    expect(frames.length).toBeLessThan(10);
    // The one that went out is authoritative: it lists everybody.
    const last = frames[frames.length - 1]!;
    expect(last.users.map((u) => u.id).sort()).toEqual(
      ["watcher", ...Array.from({ length: 10 }, (_, i) => `arrival-${i}`)].sort(),
    );
  });

  it("drops typing and presence, never messages, for a socket over the backpressure threshold", async () => {
    const channelId = nextChannelId();
    const stuck = recordingSocket();
    // A megabyte and change queued and not draining.
    (stuck.socket as unknown as { bufferedAmount: number }).bufferedAmount =
      2 * 1024 * 1024;
    const typist = recordingSocket();
    await join(stuck, "stuck", channelId);
    await join(typist, "typist", channelId);
    stuck.received.length = 0;

    await handleChatMessage(
      { socket: typist.socket, user: asUser("typist") },
      { type: "typing", channelId },
    );
    expect(framesOfType(stuck.received, "typing-broadcast")).toHaveLength(0);
    expect(framesOfType(stuck.received, "presence-update")).toHaveLength(0);

    broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: randomUUID(),
    });
    expect(framesOfType(stuck.received, "message-deleted")).toHaveLength(1);
  });

  it("sends the same encoded Buffer to every viewer", async () => {
    const channelId = nextChannelId();
    const a = recordingSocket();
    const b = recordingSocket();
    await join(a, "a", channelId);
    await join(b, "b", channelId);
    broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: randomUUID(),
    });
    const fromA = a.received[a.received.length - 1] as unknown;
    const fromB = b.received[b.received.length - 1] as unknown;
    expect(Buffer.isBuffer(fromA)).toBe(true);
    expect(fromA).toBe(fromB);
  });
});

