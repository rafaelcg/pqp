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

const {
  broadcastToChannel,
  deliverPermissionsUpdate,
  handleChatMessage,
  notifyFriendActivity,
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
  });

  async function post(
    recorder: Recorder,
    userId: string,
    channelId: string,
    extra: { nonce?: string; body?: string } = {},
  ) {
    await handleChatMessage(
      { socket: recorder.socket, user: asUser(userId) },
      {
        type: "message-create",
        channelId,
        body: extra.body ?? "hello",
        nonce: extra.nonce ?? nonce,
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

  it("does not enforce slow mode on a voice channel", async () => {
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

