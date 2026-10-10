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
  // Voice resolves the name to show through here now; the real one
  // reads `server_members.nickname`, which these tests have no table for.
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

/**
 * The only database access the status registry has. Faked so the two-instance
 * harness stays Postgres-free, and so a test can decide what a given account has
 * stored before either instance reads it.
 */
const storedStatus = new Map<string, string>();

vi.mock("../services/preferences.js", () => ({
  getPreferences: async (userId: string) => {
    const status = storedStatus.get(userId);
    return status ? { status } : {};
  },
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

/**
 * One timeline for both instances: the channel list cache drops and the
 * socket sends land here in the order they happen, so a test can say "the
 * sibling dropped its cache before it told anybody to refetch".
 */
const timeline: string[] = [];
/**
 * The server's members on either instance, for `listServerMemberIds` and
 * `readChannelsUpdateAudience` alike.
 */
let serverMembers: string[] = [];
/** How many of the next member or audience lookups throw first. */
let memberLookupFailures = 0;
/**
 * Who can see a channel, for the channel list nudge. A channel not in the map
 * has no audience, which is what every other test here wants.
 */
const channelAudiences = new Map<string, string[]>();

vi.mock("../services/servers.js", () => ({
  getChannelAudience: async () => null,
  getChannel: async () => ({ kind: "dm", server_id: null }),
  readChannelsUpdateAudience: async (
    _serverId: string,
    channelIds: readonly string[],
  ) => {
    if (memberLookupFailures > 0) {
      memberLookupFailures -= 1;
      throw new Error("database_unavailable");
    }
    const viewers = new Set(
      channelIds.flatMap((id) => channelAudiences.get(id) ?? []),
    );
    return {
      memberIds: serverMembers,
      viewerIds: serverMembers.filter((id) => viewers.has(id)),
    };
  },
  invalidateServerChannelList: (serverId: string) => {
    timeline.push(`invalidate:${serverId}`);
  },
}));

// Only the member list is faked; everything else in the module stays real,
// as it was before this mock existed.
vi.mock("../services/permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/permissions.js")>()),
  listServerMemberIds: async () => {
    if (memberLookupFailures > 0) {
      memberLookupFailures -= 1;
      throw new Error("database_unavailable");
    }
    return serverMembers;
  },
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

vi.mock("../services/threads.js", () => ({
  getThreadInfo: async () => null,
}));

type ChatModule = typeof import("./chat.js");
type BusModule = typeof import("../lib/bus.js");
type StatusModule = typeof import("./status.js");

interface Instance {
  chat: ChatModule;
  bus: BusModule;
  status: StatusModule;
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
  // Imported explicitly rather than reached through chat.js so a test can drive
  // the registry directly; the module instance is the same either way, which is
  // the whole point of the shared graph.
  const status = (await import("./status.js")) as StatusModule;
  if (connected) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  return { bus, chat, status };
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
  storedStatus.clear();
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
 * User status across two instances.
 *
 * The failure this suite exists for is the one a single-instance deployment can
 * never show you: a person's WebSocket lands on replica B while the member list
 * asking about them is served by replica A. Without the bus every member list
 * would report half the userbase offline, and — worse — a manual `invisible`
 * chosen over HTTP on A would never reach the socket on B.
 */
describe("status across two instances", () => {
  it("reports somebody connected on the other instance as online", async () => {
    const userId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const theirTab = recordingSocket();

    await b.status.registerStatusSocket(theirTab.socket, userId);

    // A holds no socket for them at all and still answers correctly.
    expect(a.status.resolveStatus(userId)).toBe("online");
    expect(a.status.resolveStatuses([userId]).get(userId)).toBe("online");
  });

  it("takes them offline when their last socket elsewhere closes", async () => {
    const userId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const theirTab = recordingSocket();
    await b.status.registerStatusSocket(theirTab.socket, userId);
    expect(a.status.resolveStatus(userId)).toBe("online");

    b.status.unregisterStatusSocket(theirTab.socket);

    // Immediately, not at the TTL: a disconnect publishes an explicit removal,
    // and waiting out the expiry would mean a minute of showing somebody who
    // closed the tab.
    expect(a.status.resolveStatus(userId)).toBe("offline");
  });

  it("carries idle across", async () => {
    const userId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const theirTab = recordingSocket();
    await b.status.registerStatusSocket(theirTab.socket, userId);

    await b.chat.handleChatMessage(
      { socket: theirTab.socket, user: asUser(userId) },
      { type: "set-idle", idle: true },
    );

    expect(a.status.resolveStatus(userId)).toBe("idle");
  });

  it("carries attention across: a backgrounded tab on B stops counting on A", async () => {
    // The push attention gate decides on whichever instance the message was
    // posted to; the person's sockets can be anywhere.
    const userId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const theirTab = recordingSocket();
    await b.status.registerStatusSocket(theirTab.socket, userId);
    expect(a.status.hasAttentiveSocket(userId)).toBe(true);

    await b.chat.handleChatMessage(
      { socket: theirTab.socket, user: asUser(userId) },
      { type: "set-attention", foreground: false },
    );
    expect(a.status.hasAttentiveSocket(userId)).toBe(false);
    // Still connected, which is what the gate-off rule keeps reading.
    expect(a.status.hasClusterSocket(userId)).toBe(true);

    await b.chat.handleChatMessage(
      { socket: theirTab.socket, user: asUser(userId) },
      { type: "set-attention", foreground: true },
    );
    expect(a.status.hasAttentiveSocket(userId)).toBe(true);
  });

  it("an attentive socket on B outweighs a background one on A, both ways round", async () => {
    const userId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const desktopOnA = recordingSocket();
    const tabOnB = recordingSocket();
    await a.status.registerStatusSocket(desktopOnA.socket, userId);
    await b.status.registerStatusSocket(tabOnB.socket, userId);
    a.status.setSocketAttention(desktopOnA.socket, false);

    expect(a.status.hasAttentiveSocket(userId)).toBe(true);
    b.status.setSocketAttention(tabOnB.socket, false);
    expect(a.status.hasAttentiveSocket(userId)).toBe(false);
    expect(b.status.hasAttentiveSocket(userId)).toBe(false);
  });

  it("reads a contribution from an older build (no attentive field) as foreground unless idle", async () => {
    // A rolling deploy puts both builds on one bus. The old one never heard
    // of attention, so every socket it holds is undeclared: !idle is exactly
    // what the new build would have said for them.
    const active = randomUUID();
    const idle = randomUUID();
    const a = await bootInstance();
    for (const listener of [...hub.listeners]) {
      listener({
        origin: "old-build",
        topic: "status.presence",
        data: {
          kind: "snapshot",
          hello: false,
          users: {
            [active]: { manual: "online", idle: false },
            [idle]: { manual: "online", idle: true },
          },
        },
      });
    }

    expect(a.status.hasAttentiveSocket(active)).toBe(true);
    expect(a.status.hasClusterSocket(idle)).toBe(true);
    expect(a.status.hasAttentiveSocket(idle)).toBe(false);
  });

  it("delivers a manual status set on one instance to the socket on the other", async () => {
    // THE FAILURE THIS EXISTS FOR. An HTTP request lands wherever the load
    // balancer sends it, which has nothing to do with where the person's socket
    // is. Without the `manual` frame, going invisible from a browser whose
    // socket lives on B would be accepted, stored, echoed back as saved — and
    // have no effect at all until the next reconnect.
    const userId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const theirTab = recordingSocket();
    await b.status.registerStatusSocket(theirTab.socket, userId);

    // The preferences route runs on A, which holds nothing for this user.
    a.status.applyManualStatus(userId, "invisible");

    expect(b.status.isInvisible(userId)).toBe(true);
    expect(b.status.resolveStatus(userId)).toBe("offline");
    // And A, which never had a socket for them, agrees — via B's own update.
    expect(a.status.resolveStatus(userId)).toBe("offline");
  });

  it("tells the account's tab on the other instance what it now is", async () => {
    // Same routing gap as above, seen from the account's other tabs: the
    // request is served by A and the tab that must update is held by B.
    const userId = randomUUID();
    const a = await bootInstance();
    const b = await bootInstance();
    const sockets = await import("./sockets.js");
    const theirTab = recordingSocket();
    sockets.setAuthenticatedSocket(theirTab.socket, asUser(userId));
    await b.status.registerStatusSocket(theirTab.socket, userId);

    a.status.applyManualStatus(userId, "away");

    expect(framesOfType(theirTab.received, "own-status")).toEqual([
      { type: "own-status", status: "away" },
    ]);
    sockets.deleteAuthenticatedSocket(theirTab.socket);
  });

  it("hides an invisible viewer from a roster built on the other instance", async () => {
    const channelId = randomUUID();
    const hidden = randomUUID();
    const watcher = randomUUID();
    storedStatus.set(hidden, "invisible");
    const a = await bootInstance();
    const b = await bootInstance();
    const hiddenTab = recordingSocket();
    const watcherTab = recordingSocket();
    await b.status.registerStatusSocket(hiddenTab.socket, hidden);
    await a.status.registerStatusSocket(watcherTab.socket, watcher);

    await b.chat.handleChatMessage(
      { socket: hiddenTab.socket, user: asUser(hidden) },
      { type: "join-channel", channelId },
    );
    await a.chat.handleChatMessage(
      { socket: watcherTab.socket, user: asUser(watcher) },
      { type: "join-channel", channelId },
    );

    // B filtered them out of the contribution it published, so A never had the
    // chance to reveal them — the filter is at the source, not at each sink.
    const roster = lastFrameOfType<{ users: Array<{ id: string }> }>(
      watcherTab.received,
      "presence-update",
    );
    expect(roster?.users.map((one) => one.id)).toEqual([watcher]);
  });

  it("ages out an instance that stops announcing", async () => {
    // The SIGKILL case, and the one failure a status registry must not have.
    // A crashed instance publishes no removal, so without the TTL its users
    // would show as online forever on every surviving replica.
    vi.useFakeTimers();
    try {
      const userId = randomUUID();
      const a = await bootInstance();
      const b = await bootInstance();
      const theirTab = recordingSocket();
      await b.status.registerStatusSocket(theirTab.socket, userId);
      const stopA = a.status.startClusterStatusRefresh(1_000);
      expect(a.status.resolveStatus(userId)).toBe("online");

      // B is killed: no clean shutdown, no final frame, it simply stops
      // speaking. Dropping its transport is exactly that.
      await b.bus.closeBus();

      // Under the TTL, A still believes what B last told it. That is correct —
      // a quiet instance is not a dead one.
      vi.advanceTimersByTime(30_000);
      expect(a.status.resolveStatus(userId)).toBe("online");

      // Past it, the contribution is gone and so is the user.
      vi.advanceTimersByTime(40_000);
      expect(a.status.resolveStatus(userId)).toBe("offline");
      stopA();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a booting instance so its first member list is not half offline", async () => {
    const userId = randomUUID();
    const a = await bootInstance();
    const theirTab = recordingSocket();
    await a.status.registerStatusSocket(theirTab.socket, userId);

    // B comes up with an empty registry and knows nothing about anybody.
    const b = await bootInstance();
    expect(b.status.resolveStatus(userId)).toBe("offline");

    // Its opening `hello` snapshot is answered by everyone already running, so
    // it converges at once rather than at the next twenty-second tick.
    const stopB = b.status.startClusterStatusRefresh(60_000);
    expect(b.status.resolveStatus(userId)).toBe("online");
    stopB();
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
    const status = (await import("./status.js")) as StatusModule;
    const { createPostgresBusTransport } = await import(
      "../lib/bus-postgres.js"
    );
    const transport = createPostgresBusTransport(DATABASE_URL);
    bus.setBusTransport(transport);
    started.push(transport);
    await transport.whenConnected();
    return { bus, chat, status };
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

  it("resolves a status held by the other instance", async () => {
    // The memory hub above is synchronous and lossless. This is the same
    // question asked over a real round trip, which is what a member list
    // actually depends on when the deployment has more than one replica.
    const userId = randomUUID();
    const a = await bootOnPostgres();
    const b = await bootOnPostgres();
    const theirTab = recordingSocket();

    await b.status.registerStatusSocket(theirTab.socket, userId);

    const deadline = Date.now() + 5_000;
    while (a.status.resolveStatus(userId) === "offline") {
      if (Date.now() > deadline) {
        throw new Error("status never crossed the postgres bus");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(a.status.resolveStatus(userId)).toBe("online");

    b.status.applyManualStatus(userId, "invisible");
    while (a.status.resolveStatus(userId) === "online") {
      if (Date.now() > deadline) {
        throw new Error("manual status never crossed the postgres bus");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(a.status.resolveStatus(userId)).toBe("offline");
  });
});

/**
 * The channel list nudge. Production runs two API containers with the bus on,
 * so a create on A must reach a member whose socket is on B, and B must drop
 * its own copy of the list first: the read cache is per process, and the
 * member's refetch can land on B.
 */
describe("channels-update across two instances", () => {
  /** A member socket on B that also writes its sends onto `timeline`. */
  function timelineSocket(): Recorder {
    const received: string[] = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => {
        received.push(payload);
        timeline.push(`send:${(JSON.parse(payload) as { type: string }).type}`);
      },
      on: () => {},
    } as unknown as WebSocket;
    return { socket, received };
  }

  it("reaches a member on the other instance after that instance drops its cached list", async () => {
    const serverId = randomUUID();
    const channelId = randomUUID();
    serverMembers = ["member", "owner"];
    channelAudiences.set(channelId, ["member", "owner"]);
    timeline.length = 0;
    const a = await bootInstance();
    // B is only ever reached through its own socket table, imported from the
    // graph `bootInstance` just built.
    await bootInstance();
    const bSockets = await import("./sockets.js");
    const member = timelineSocket();
    bSockets.setAuthenticatedSocket(member.socket, asUser("member"));
    const stranger = recordingSocket();
    bSockets.setAuthenticatedSocket(stranger.socket, asUser("stranger"));

    await a.chat.notifyChannelsUpdate(serverId, { channelIds: [channelId] });

    await vi.waitFor(() => {
      expect(framesOfType(member.received, "channels-update")).toEqual([
        { type: "channels-update", serverId },
      ]);
    });
    expect(stranger.received).toEqual([]);
    // Once on A (the origin) and once on B, and on B before the send.
    expect(timeline).toEqual([
      `invalidate:${serverId}`,
      `invalidate:${serverId}`,
      "send:channels-update",
    ]);
    // Everyone can see it, so the frame on the bus carries no user ids: B
    // resolves membership itself.
    expect(
      onTheWire
        .filter((frame) => frame.topic === "chat.channels")
        .map((frame) => frame.data),
    ).toEqual([{ type: "channels-update", serverId }]);
    bSockets.deleteAuthenticatedSocket(member.socket);
    bSockets.deleteAuthenticatedSocket(stranger.socket);
  });

  it("carries the audience across for a channel only some members can see", async () => {
    const serverId = randomUUID();
    const channelId = randomUUID();
    serverMembers = ["member", "owner", "hidden"];
    channelAudiences.set(channelId, ["member", "owner"]);
    timeline.length = 0;
    const a = await bootInstance();
    await bootInstance();
    const bSockets = await import("./sockets.js");
    const member = timelineSocket();
    bSockets.setAuthenticatedSocket(member.socket, asUser("member"));
    const hidden = recordingSocket();
    bSockets.setAuthenticatedSocket(hidden.socket, asUser("hidden"));

    await a.chat.notifyChannelsUpdate(serverId, { channelIds: [channelId] });

    await vi.waitFor(() => {
      expect(framesOfType(member.received, "channels-update")).toHaveLength(1);
    });
    // The member who cannot see the channel hears nothing, on either side.
    expect(hidden.received).toEqual([]);
    expect(
      onTheWire
        .filter((frame) => frame.topic === "chat.channels")
        .map((frame) => frame.data),
    ).toEqual([
      { type: "channels-update", serverId, userIds: ["member", "owner"] },
    ]);
    // B still dropped its cached list before it sent.
    expect(timeline).toEqual([
      `invalidate:${serverId}`,
      `invalidate:${serverId}`,
      "send:channels-update",
    ]);
    bSockets.deleteAuthenticatedSocket(member.socket);
    bSockets.deleteAuthenticatedSocket(hidden.socket);
  });

  it("retries a failed audience lookup instead of dropping the nudge", async () => {
    const serverId = randomUUID();
    const channelId = randomUUID();
    serverMembers = ["member", "owner"];
    channelAudiences.set(channelId, ["member", "owner"]);
    const a = await bootInstance();
    const aSockets = await import("./sockets.js");
    const member = recordingSocket();
    aSockets.setAuthenticatedSocket(member.socket, asUser("member"));
    memberLookupFailures = 1;

    await a.chat.notifyChannelsUpdate(serverId, { channelIds: [channelId] });

    expect(memberLookupFailures).toBe(0);
    expect(framesOfType(member.received, "channels-update")).toEqual([
      { type: "channels-update", serverId },
    ]);
    aSockets.deleteAuthenticatedSocket(member.socket);
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
