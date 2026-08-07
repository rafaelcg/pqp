import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
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
  canAccessChannel: async () => true,
}));

// The timeout chokepoint queries Postgres, and this suite deliberately runs
// without one. Enforcement itself is proved end-to-end against a real database
// in services/sanctions.test.ts; here it only has to be out of the way.
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

// Null audience short-circuits `notifyChannelActivity`, which is a different
// fan-out (unread badges, over every authenticated socket) than the one under
// test here.
vi.mock("../services/servers.js", () => ({
  getChannelAudience: async () => null,
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

vi.mock("../services/reactions.js", () => ({
  getMessageChannelId: async () => null,
  toggleReaction: async () => ({ added: true }),
}));

const { broadcastToChannel, handleChatMessage, resetChatRateLimits } =
  await import("./chat.js");

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
