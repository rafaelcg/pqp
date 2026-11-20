import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { DbUser } from "../db.js";

/**
 * THE PRODUCT FAN-OUT, OVER REAL COMPRESSED SOCKETS, WITH THE FLAG ON.
 *
 * `lib/ws-shared-deflate.test.ts` proves the shared frame against every kind
 * of receiver by calling `broadcastEncoded` directly. This file proves the
 * other half (CLAUDE.md pitfall 12): that call sites production runs, chat
 * presence and channel broadcasts here, really reach that path, and that what
 * they send through it decodes. The server half of each socket is a real `ws`
 * socket from a server built with the shipped `WS_PER_MESSAGE_DEFLATE`,
 * registered in the socket table the way `ws/index.ts` registers one; the
 * client half is a real `ws` client, some with the extension and some without.
 *
 * The service layer is faked the way `presence-delta.test.ts` fakes it.
 */

process.env.WS_SHARED_DEFLATE = "true";

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

vi.mock("./status.js", () => ({
  isInvisible: () => false,
  isPresentForHere: () => true,
  setSocketIdle: () => {},
}));

const { handleChatMessage, broadcastToChannel } = await import("./chat.js");
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "./sockets.js"
);
const { setCoalesceImmediate } = await import("./fanout.js");
const { WS_PER_MESSAGE_DEFLATE } = await import("../lib/ws-compression.js");
const { resetSharedDeflateStats, sharedDeflateStats } = await import(
  "../lib/ws-shared-deflate.js"
);

setCoalesceImmediate(true);

interface Pair {
  user: DbUser;
  server: WebSocket;
  client: WebSocket;
  frames: Array<Record<string, unknown>>;
  errors: string[];
}

function asUser(id: string): DbUser {
  return {
    id,
    clerk_id: `clerk_${id}`,
    display_name: `a reasonably long display name for ${id}`,
    username: id,
    discriminator: "0001",
    avatar_url: `https://img.example/avatars/${id}/${randomUUID()}.png`,
  } as DbUser;
}

let wss: WebSocketServer;
let port = 0;
const accepted: WebSocket[] = [];
const pairs: Pair[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeAll(async () => {
  wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  port = (wss.address() as AddressInfo).port;
  wss.on("connection", (socket) => accepted.push(socket));
});

afterAll(async () => {
  for (const pair of pairs) {
    deleteAuthenticatedSocket(pair.server);
    pair.client.terminate();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function connect(
  index: number,
  compressed: boolean,
  deltas: boolean,
): Promise<Pair> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`, {
    perMessageDeflate: compressed,
  });
  const frames: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  client.on("message", (data, isBinary) => {
    if (isBinary) errors.push("binary");
    try {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch (error) {
      errors.push(String(error));
    }
  });
  client.on("error", (error) => errors.push(String(error)));
  const before = accepted.length;
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  await until(() => accepted.length > before);
  const server = accepted[accepted.length - 1]!;
  expect(server.extensions.includes("permessage-deflate")).toBe(compressed);
  const pair: Pair = { user: asUser(`user-${index}`), server, client, frames, errors };
  setAuthenticatedSocket(server, pair.user, deltas ? ["presence-delta"] : []);
  pairs.push(pair);
  return pair;
}

describe("chat fan-out with ws_shared_deflate on", () => {
  it("presence snapshots and channel broadcasts take the shared path and every client decodes them", async () => {
    const channelId = randomUUID();
    const room: Pair[] = [];
    for (let i = 0; i < 80; i += 1) {
      // A quarter without the extension; half are old clients that only take
      // whole lists (the snapshots are the big frames that get shared).
      room.push(await connect(i, i % 4 !== 0, i % 2 === 0));
    }
    resetSharedDeflateStats();
    for (const pair of room) {
      await handleChatMessage(
        { socket: pair.server, user: pair.user },
        { type: "join-channel", channelId },
      );
      await flush();
    }
    const body = "a long message ".repeat(200);
    broadcastToChannel(channelId, {
      type: "message-update",
      message: { id: "m-1", channelId, body },
    } as never);

    await until(() =>
      room.every((pair) =>
        pair.frames.some((frame) => frame.type === "message-update"),
      ),
    );
    const everyone = room.map((pair) => pair.user.id).sort();
    for (const pair of room) {
      expect(pair.errors).toEqual([]);
      const update = pair.frames.find((frame) => frame.type === "message-update");
      expect((update!.message as { body: string }).body).toBe(body);
    }
    // The old clients' last whole list names everyone: the shared snapshot
    // decoded to exactly the list the server built.
    for (const pair of room.filter((_, i) => i % 2 === 1)) {
      const lists = pair.frames.filter((frame) => frame.type === "presence-update");
      const last = lists[lists.length - 1]!;
      expect(
        (last.users as Array<{ id: string }>).map((u) => u.id).sort(),
      ).toEqual(everyone);
    }
    const stats = sharedDeflateStats();
    expect(stats.broadcasts).toBeGreaterThan(10);
    expect(stats.sockets).toBeGreaterThan(stats.compressions * 5);
    expect(stats.plainSockets).toBeGreaterThan(0);
    expect(stats.fallbacks.wsInternals).toBe(0);
    expect(stats.fallbacks.contextTakeover).toBe(0);
    expect(stats.fallbacks.verifyFailed).toBe(0);
  }, 60_000);
});
