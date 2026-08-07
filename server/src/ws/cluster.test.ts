import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import { createMemoryHub, type BusFrame } from "../lib/bus.js";

/**
 * Two server "instances", one bus.
 *
 * A real second process is not needed to catch the failures that matter here —
 * a second *module graph* is. `connections`, `channelPresence` and the bus
 * subscription registry are all module state, so importing `chat.js` twice
 * under `vi.resetModules()` produces two independent instances that share
 * nothing except the hub the test hands them. That is exactly the shape of a
 * two-replica deploy, and it is what makes "did this actually cross" a real
 * question rather than a tautology.
 *
 * What is pinned below: a message published on A reaches a viewer on B, does
 * not loop back, does not double-deliver to the publisher's own viewers — and
 * with no transport installed, nothing crosses at all, which is the promise
 * that the flag being off leaves today's behaviour untouched.
 *
 * Same service-layer fakes as chat.test.ts, so this runs without Postgres.
 */

vi.mock("../services/users.js", () => ({
  canAccessChannel: async () => true,
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

type ChatModule = typeof import("./chat.js");
type BusModule = typeof import("../lib/bus.js");

interface Instance {
  chat: ChatModule;
  bus: BusModule;
}

let hub = createMemoryHub();
/** Every frame that touched the bus, for asserting nothing was republished. */
let onTheWire: BusFrame[] = [];

/**
 * A fresh module graph per call. `resetModules` is what makes the two copies
 * independent; the mocks above survive it.
 */
async function bootInstance(connected = true): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const chat = (await import("./chat.js")) as ChatModule;
  if (connected) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  return { bus, chat };
}

interface Recorder {
  socket: WebSocket;
  received: string[];
}

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

function lastFrameOfType<T>(received: string[], type: string): T | undefined {
  const frames = framesOfType(received, type) as T[];
  return frames[frames.length - 1];
}

async function join(
  instance: Instance,
  recorder: Recorder,
  userId: string,
  channelId: string,
) {
  await instance.chat.handleChatMessage(
    { socket: recorder.socket, user: asUser(userId) },
    { type: "join-channel", channelId },
  );
  recorder.received.length = 0;
}

beforeEach(() => {
  hub = createMemoryHub();
  onTheWire = [];
  hub.listeners.add((frame) => onTheWire.push(frame));
});

describe("chat across two instances", () => {
  it("delivers a broadcast from one instance to a viewer on the other", async () => {
    const channelId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const remote = recordingSocket();
    await join(b, remote, "user-b", channelId);

    a.chat.broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });

    expect(framesOfType(remote.received, "message-deleted")).toHaveLength(1);
  });

  it("does not republish a frame it received from the bus", async () => {
    const channelId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const local = recordingSocket();
    const remote = recordingSocket();
    await join(a, local, "user-a", channelId);
    await join(b, remote, "user-b", channelId);
    onTheWire.length = 0;

    a.chat.broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });

    // One publish, from A. If B re-broadcast what it received this would climb
    // (and, without the origin check, would not terminate at all).
    expect(onTheWire.filter((f) => f.topic === "chat.broadcast")).toHaveLength(
      1,
    );
    // And exactly one copy each — the publisher's own viewer is served by the
    // local pass, not by the echo Postgres would deliver back to it.
    expect(framesOfType(local.received, "message-deleted")).toHaveLength(1);
    expect(framesOfType(remote.received, "message-deleted")).toHaveLength(1);
  });

  it("delivers a posted message to a viewer on the other instance", async () => {
    const channelId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const remote = recordingSocket();
    await join(b, remote, "user-b", channelId);
    const sender = recordingSocket();

    await a.chat.handleChatMessage(
      { socket: sender.socket, user: asUser("user-a") },
      { type: "message-create", channelId, body: "hello" },
    );

    expect(framesOfType(sender.received, "message-broadcast")).toHaveLength(1);
    expect(framesOfType(remote.received, "message-broadcast")).toHaveLength(1);
  });

  it("merges presence from both instances", async () => {
    const channelId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const here = recordingSocket();
    const there = recordingSocket();

    await a.chat.handleChatMessage(
      { socket: here.socket, user: asUser("user-a") },
      { type: "join-channel", channelId },
    );
    await b.chat.handleChatMessage(
      { socket: there.socket, user: asUser("user-b") },
      { type: "join-channel", channelId },
    );

    const onA = lastFrameOfType<{ users: Array<{ id: string }> }>(
      here.received,
      "presence-update",
    );
    const onB = lastFrameOfType<{ users: Array<{ id: string }> }>(
      there.received,
      "presence-update",
    );
    expect(onA?.users.map((u) => u.id).sort()).toEqual(["user-a", "user-b"]);
    expect(onB?.users.map((u) => u.id).sort()).toEqual(["user-a", "user-b"]);
  });

  it("withdraws presence when the last viewer on an instance leaves", async () => {
    const channelId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const here = recordingSocket();
    const there = recordingSocket();
    await join(a, here, "user-a", channelId);
    await join(b, there, "user-b", channelId);

    await b.chat.handleChatMessage(
      { socket: there.socket, user: asUser("user-b") },
      { type: "leave-channel" },
    );

    const onA = lastFrameOfType<{ users: Array<{ id: string }> }>(
      here.received,
      "presence-update",
    );
    expect(onA?.users.map((u) => u.id)).toEqual(["user-a"]);
  });

  it("carries typing to viewers on the other instance", async () => {
    const channelId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const typist = recordingSocket();
    const watcher = recordingSocket();
    await join(a, typist, "user-a", channelId);
    await join(b, watcher, "user-b", channelId);

    await a.chat.handleChatMessage(
      { socket: typist.socket, user: asUser("user-a") },
      { type: "typing", channelId },
    );

    expect(framesOfType(watcher.received, "typing-broadcast")).toHaveLength(1);
    // The typist never hears themselves, on either instance.
    expect(framesOfType(typist.received, "typing-broadcast")).toHaveLength(0);
  });

  it("evicts a viewer held by the other instance", async () => {
    // A kick, ban or channel going private is handled by whichever instance got
    // the HTTP request. Without this the evicted user keeps receiving the
    // channel from every other instance until they reconnect.
    const channelId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const remote = recordingSocket();
    await join(b, remote, "user-b", channelId);

    a.chat.evictChannelViewers(channelId, { onlyUserIds: ["user-b"] });
    a.chat.broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });

    expect(framesOfType(remote.received, "message-deleted")).toHaveLength(0);
  });

  it("keeps serving local sockets when the transport is broken", async () => {
    const channelId = randomUUID();
    const a = await bootInstance();
    a.bus.setBusTransport({
      name: "broken",
      publish() {
        throw new Error("bus is down");
      },
      onFrame() {},
      close: async () => {},
    });
    const local = recordingSocket();
    await join(a, local, "user-a", channelId);

    expect(() =>
      a.chat.broadcastToChannel(channelId, {
        type: "message-deleted",
        channelId,
        messageId: "m1",
      }),
    ).not.toThrow();
    expect(framesOfType(local.received, "message-deleted")).toHaveLength(1);
  });
});

/**
 * The same crossing, over the transport production would actually use. The
 * memory hub above is synchronous and lossless; this proves the wiring holds
 * when delivery is a real round trip through Postgres — and that an instance
 * still ignores the NOTIFY Postgres hands back to it.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

describeDb("chat over the postgres bus", () => {
  const started: Array<{ close: () => Promise<void> }> = [];

  async function bootOnPostgres(): Promise<Instance> {
    vi.resetModules();
    const bus = (await import("../lib/bus.js")) as BusModule;
    const chat = (await import("./chat.js")) as ChatModule;
    const { createPostgresBusTransport } = await import(
      "../lib/bus-postgres.js"
    );
    const transport = createPostgresBusTransport(DATABASE_URL);
    bus.setBusTransport(transport);
    started.push(transport);
    await transport.whenConnected();
    return { bus, chat };
  }

  afterAll(async () => {
    await Promise.all(started.map((transport) => transport.close()));
  });

  it("delivers a broadcast to a viewer on the other instance", async () => {
    const channelId = randomUUID();
    const a = await bootOnPostgres();
    const b = await bootOnPostgres();
    const local = recordingSocket();
    const remote = recordingSocket();
    await join(a, local, "user-a", channelId);
    await join(b, remote, "user-b", channelId);

    a.chat.broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });

    const deadline = Date.now() + 5_000;
    while (framesOfType(remote.received, "message-deleted").length === 0) {
      if (Date.now() > deadline) {
        throw new Error("frame never crossed the postgres bus");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Delivered once on each side: locally by the direct pass, remotely by the
    // bus, and never twice on the publisher despite NOTIFY echoing to it.
    expect(framesOfType(remote.received, "message-deleted")).toHaveLength(1);
    expect(framesOfType(local.received, "message-deleted")).toHaveLength(1);
  });
});

describe("with the bus off (the default)", () => {
  it("publishes nothing and shares nothing", async () => {
    const channelId = randomUUID();
    const a = await bootInstance(false);
    const b = await bootInstance(false);
    const local = recordingSocket();
    const remote = recordingSocket();
    await join(a, local, "user-a", channelId);
    await join(b, remote, "user-b", channelId);

    a.chat.broadcastToChannel(channelId, {
      type: "message-deleted",
      channelId,
      messageId: "m1",
    });
    await a.chat.handleChatMessage(
      { socket: local.socket, user: asUser("user-a") },
      { type: "typing", channelId },
    );
    a.chat.evictChannelViewers(channelId, { onlyUserIds: ["user-b"] });

    expect(onTheWire).toEqual([]);
    // Instance A behaves exactly as it does today…
    expect(framesOfType(local.received, "message-deleted")).toHaveLength(1);
    // …and B is a separate world, presence included.
    expect(remote.received).toEqual([]);
  });

  it("reports its own viewers only, with no remote contributions", async () => {
    const channelId = randomUUID();
    const a = await bootInstance(false);
    const b = await bootInstance(false);
    const local = recordingSocket();
    const remote = recordingSocket();

    await a.chat.handleChatMessage(
      { socket: local.socket, user: asUser("user-a") },
      { type: "join-channel", channelId },
    );
    await b.chat.handleChatMessage(
      { socket: remote.socket, user: asUser("user-b") },
      { type: "join-channel", channelId },
    );

    expect(
      lastFrameOfType<{ users: Array<{ id: string }> }>(
        local.received,
        "presence-update",
      )?.users.map((u) => u.id),
    ).toEqual(["user-a"]);
    expect(
      lastFrameOfType<{ users: Array<{ id: string }> }>(
        remote.received,
        "presence-update",
      )?.users.map((u) => u.id),
    ).toEqual(["user-b"]);
  });
});
