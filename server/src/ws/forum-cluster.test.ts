import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  forumPostSummarySchema,
  isChatServerMessage,
  type ForumPostSummary,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { createMemoryHub, type BusFrame } from "../lib/bus.js";

/**
 * Forum frames across two instances, one bus: the shape of `cluster.test.ts`
 * (two module graphs under `vi.resetModules()`, so `connections`,
 * `channelPresence` and the bus registry are genuinely two copies), applied to
 * what a forum sends. Production runs `CLUSTER_BUS=postgres` on two machines,
 * so a forum viewer is as likely to sit on the sibling as on the instance that
 * took the write; these pin that every forum frame reaches them:
 *
 *  - a new post's `forum-post-upsert`, and the forum's `channel-activity` for
 *    a sidebar socket on the sibling;
 *  - the bump a reply on A makes, as an upsert on B;
 *  - `forum-post-removed`, to the forum's viewers AND an open post on B.
 *
 * The relay only accepts frame types listed in `CHAT_SERVER_MESSAGE_TYPES`;
 * the first test fails if the two forum types ever fall off that list.
 * Postgres-free, with the same service fakes as `cluster.test.ts`.
 */

const FORUM_ID = randomUUID();
const POST_ID = randomUUID();
const SERVER_ID = randomUUID();

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

vi.mock("../services/preferences.js", () => ({
  getPreferences: async () => ({}),
  getPreferencesForUsers: async () => new Map(),
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

/** The forum's audience: everyone in the server can see it. */
const forumAudience = ["author", "reader", "lurker"];

vi.mock("../services/servers.js", () => ({
  getChannelAudience: async (channelId: string) =>
    channelId === FORUM_ID
      ? {
          serverId: SERVER_ID,
          kind: "server",
          userIds: forumAudience,
          has: (id: string) => forumAudience.includes(id),
        }
      : null,
  getChannel: async () => ({ kind: "dm", server_id: null }),
  readChannelsUpdateAudience: async () => ({ memberIds: [], viewerIds: [] }),
  invalidateServerChannelList: () => {},
}));

vi.mock("../services/permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/permissions.js")>()),
  listServerMemberIds: async () => [],
}));

vi.mock("../services/embeds.js", () => ({
  extractFirstUrl: () => null,
  fetchAndCacheEmbed: async () => null,
  getEmbedCacheState: async () => ({ fresh: true, embed: null }),
}));

vi.mock("../services/messages.js", () => ({
  createMessage: async () => ({ id: randomUUID(), created_at: new Date() }),
  getReplyParent: async () => null,
  mapMessage: (row: { id: string }) => ({ id: row.id, body: "resposta" }),
}));

vi.mock("../services/outgoing-webhooks.js", () => ({
  enqueueOutgoingMessageCreated: async () => 0,
}));

vi.mock("../services/push.js", () => ({
  pushChannelActivity: () => {},
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

/** The post is a thread with no origin message: what makes the send path bump. */
vi.mock("../services/threads.js", () => ({
  getThreadInfo: async (channelId: string) =>
    channelId === POST_ID
      ? {
          id: POST_ID,
          parentChannelId: FORUM_ID,
          rootMessageId: null,
          name: "Notebook não liga",
          replyCount: 0,
          lastMessageAt: null,
          createdAt: new Date().toISOString(),
          participants: [],
        }
      : null,
}));

/**
 * The biggest summary a real post produces: a 100-character title, a full
 * preview, five tags and a presigned thumbnail URL of realistic length.
 */
function summary(overrides: Partial<ForumPostSummary> = {}): ForumPostSummary {
  return forumPostSummarySchema.parse({
    id: POST_ID,
    forumId: FORUM_ID,
    title: "Ç".repeat(100),
    authorId: randomUUID(),
    authorName: "Alguém com um nome de exibição comprido",
    authorAvatarUrl: `https://api.pqp.gg/api/avatars/${randomUUID()}?v=1`,
    authorIsWebhook: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pinnedAt: null,
    lockedAt: null,
    resolvedAt: null,
    acceptedAnswerId: null,
    preview: "ã".repeat(200),
    openingDeleted: false,
    openingKind: "text",
    attachmentCount: 3,
    replyCount: 12,
    reactionCount: 4,
    topReaction: { emoji: "👍", count: 3 },
    thumbnailUrl: `https://bucket.r2.cloudflarestorage.com/attachments/${randomUUID()}/print.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${"a".repeat(60)}&X-Amz-Date=20261011T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${"f".repeat(64)}`,
    thumbnailAttachmentId: randomUUID(),
    thumbnailWidth: 1280,
    thumbnailHeight: 720,
    tagIds: Array.from({ length: 5 }, () => randomUUID()),
    ...overrides,
  });
}

const bumped = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../services/forums.js", () => ({
  bumpForumPostActivity: async (postId: string) => {
    bumped.calls.push(postId);
    return postId === POST_ID ? FORUM_ID : null;
  },
  getForumPostSummary: async () => summary({ replyCount: 13 }),
}));

type ChatModule = typeof import("./chat.js");
type BusModule = typeof import("../lib/bus.js");
type SocketsModule = typeof import("./sockets.js");

interface Instance {
  chat: ChatModule;
  bus: BusModule;
  sockets: SocketsModule;
}

let hub = createMemoryHub();
let onTheWire: BusFrame[] = [];

async function bootInstance(): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const chat = (await import("./chat.js")) as ChatModule;
  const sockets = (await import("./sockets.js")) as SocketsModule;
  bus.setBusTransport(bus.createMemoryTransport(hub));
  return { bus, chat, sockets };
}

interface Recorder {
  socket: WebSocket;
  received: string[];
}

function recordingSocket(): Recorder {
  const received: string[] = [];
  const socket = {
    readyState: 1,
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
  } as DbUser;
}

function framesOfType<T = Record<string, unknown>>(received: string[], type: string): T[] {
  return received
    .map((raw) => JSON.parse(raw) as { type: string })
    .filter((frame) => frame.type === type) as T[];
}

/** A socket on `instance`, authenticated as `userId`, optionally viewing a channel. */
async function connect(
  instance: Instance,
  userId: string,
  view?: { channel?: string; thread?: string },
): Promise<Recorder> {
  const recorder = recordingSocket();
  instance.sockets.setAuthenticatedSocket(recorder.socket, asUser(userId));
  if (view?.channel) {
    await instance.chat.handleChatMessage(
      { socket: recorder.socket, user: asUser(userId) },
      { type: "join-channel", channelId: view.channel },
    );
  }
  if (view?.thread) {
    await instance.chat.handleChatMessage(
      { socket: recorder.socket, user: asUser(userId) },
      { type: "thread-join", channelId: view.thread },
    );
  }
  recorder.received.length = 0;
  return recorder;
}

beforeEach(() => {
  hub = createMemoryHub();
  onTheWire = [];
  bumped.calls.length = 0;
  hub.listeners.add((frame) => onTheWire.push(frame));
});

describe("forum frames across two instances", () => {
  it("both forum frame types are accepted by the channel relay", () => {
    expect(isChatServerMessage({ type: "forum-post-upsert" })).toBe(true);
    expect(isChatServerMessage({ type: "forum-post-removed" })).toBe(true);
  });

  it("a new post on A reaches the forum's viewer on B, and lights the sidebar of a member on B", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const viewer = await connect(b, "reader", { channel: FORUM_ID });
    const sidebar = await connect(b, "lurker", { channel: randomUUID() });
    const author = await connect(a, "author", { channel: FORUM_ID });
    onTheWire.length = 0;

    const post = summary();
    await a.chat.announceForumPost(post, "author");

    await vi.waitFor(() => {
      expect(framesOfType(viewer.received, "forum-post-upsert")).toEqual([
        { type: "forum-post-upsert", forumId: FORUM_ID, post },
      ]);
      expect(framesOfType(sidebar.received, "channel-activity")).toEqual([
        expect.objectContaining({
          type: "channel-activity",
          channelId: FORUM_ID,
          serverId: SERVER_ID,
          mention: false,
        }),
      ]);
    });
    // The forum's own viewer is looking at it: a row, not a badge.
    expect(framesOfType(viewer.received, "channel-activity")).toEqual([]);
    // The author's own tab on A gets the row once (the local pass, not an echo)
    // and no badge for their own post.
    expect(framesOfType(author.received, "forum-post-upsert")).toHaveLength(1);
    expect(framesOfType(author.received, "channel-activity")).toEqual([]);
    // Nothing in a server channel's activity frame carries the post's content.
    expect(JSON.stringify(framesOfType(sidebar.received, "channel-activity"))).not.toContain(
      post.title,
    );
    // One publish each, and the biggest real summary rides inline on NOTIFY
    // (the Postgres bus spills anything over 7000 bytes to a table).
    const broadcasts = onTheWire.filter((frame) => frame.topic === "chat.broadcast");
    expect(broadcasts).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(broadcasts[0]))).toBeLessThan(7000);
    expect(onTheWire.filter((frame) => frame.topic === "chat.activity")).toHaveLength(1);
  });

  it("a reply on A bumps the post and the forum's viewer on B gets the fresh row", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const viewer = await connect(b, "reader", { channel: FORUM_ID });
    const replier = await connect(a, "author", { thread: POST_ID });

    await a.chat.handleChatMessage(
      { socket: replier.socket, user: asUser("author") },
      { type: "message-create", channelId: POST_ID, body: "resposta" },
    );

    expect(bumped.calls).toEqual([POST_ID]);
    await vi.waitFor(() => {
      const rows = framesOfType<{ post: ForumPostSummary }>(
        viewer.received,
        "forum-post-upsert",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.post.replyCount).toBe(13);
    });
  });

  it("a message in a plain channel does not bump anything", async () => {
    const a = await bootInstance();
    const sender = await connect(a, "author", { channel: randomUUID() });
    const channelId = randomUUID();
    await a.chat.handleChatMessage(
      { socket: sender.socket, user: asUser("author") },
      { type: "message-create", channelId, body: "oi" },
    );
    expect(bumped.calls).toEqual([]);
  });

  it("a deleted post leaves the list on B and closes the open post on B", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const listViewer = await connect(b, "reader", { channel: FORUM_ID });
    const postViewer = await connect(b, "lurker", {
      channel: randomUUID(),
      thread: POST_ID,
    });

    a.chat.announceForumPostRemoved(FORUM_ID, POST_ID);

    const removed = { type: "forum-post-removed", forumId: FORUM_ID, postId: POST_ID };
    await vi.waitFor(() => {
      expect(framesOfType(listViewer.received, "forum-post-removed")).toEqual([removed]);
      expect(framesOfType(postViewer.received, "forum-post-removed")).toEqual([removed]);
    });
  });
});
