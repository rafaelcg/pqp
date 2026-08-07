import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * User status, on one instance. The cross-instance half lives in cluster.test.ts,
 * which is where the two-module-graph machinery already is.
 *
 * The preference store is faked so this runs without Postgres — it is the only
 * database access the status registry has, and what it returns is exactly what
 * the "survives a reconnect" test needs to control.
 */

const storedStatus = new Map<string, string>();
let preferenceReads = 0;

vi.mock("../services/preferences.js", () => ({
  getPreferences: async (userId: string) => {
    preferenceReads += 1;
    const status = storedStatus.get(userId);
    return status ? { status } : {};
  },
}));

// chat.ts is imported for the presence and typing paths; these keep it off the
// database, exactly as cluster.test.ts does.
vi.mock("../services/users.js", () => ({ canAccessChannel: async () => true }));
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
vi.mock("../services/servers.js", () => ({ getChannelAudience: async () => null }));
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

import { handleChatMessage } from "./chat.js";
import {
  applyManualStatus,
  isInvisible,
  registerStatusSocket,
  resolveStatus,
  resolveStatuses,
  resetStatusRegistry,
  unregisterStatusSocket,
} from "./status.js";

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

function framesOfType<T>(received: string[], type: string): T[] {
  return received
    .map((raw) => JSON.parse(raw) as { type: string })
    .filter((frame) => frame.type === type) as T[];
}

function lastFrameOfType<T>(received: string[], type: string): T | undefined {
  const frames = framesOfType<T>(received, type);
  return frames[frames.length - 1];
}

beforeEach(() => {
  resetStatusRegistry();
  storedStatus.clear();
  preferenceReads = 0;
});

describe("resolving a status", () => {
  it("reads as offline for somebody with no socket", async () => {
    // The whole reason `offline` needs no column: it is the absence of a
    // connection, and an account nobody has ever heard of resolves to it too.
    expect(resolveStatus(randomUUID())).toBe("offline");

    const userId = randomUUID();
    const tab = recordingSocket();
    await registerStatusSocket(tab.socket, userId);
    expect(resolveStatus(userId)).toBe("online");

    unregisterStatusSocket(tab.socket);
    expect(resolveStatus(userId)).toBe("offline");
  });

  it("goes idle only when every tab has gone quiet", async () => {
    const userId = randomUUID();
    const one = recordingSocket();
    const two = recordingSocket();
    await registerStatusSocket(one.socket, userId);
    await registerStatusSocket(two.socket, userId);

    await handleChatMessage(
      { socket: one.socket, user: asUser(userId) },
      { type: "set-idle", idle: true },
    );
    // Somebody typing in one window is not away because another has been open
    // and untouched since this morning.
    expect(resolveStatus(userId)).toBe("online");

    await handleChatMessage(
      { socket: two.socket, user: asUser(userId) },
      { type: "set-idle", idle: true },
    );
    expect(resolveStatus(userId)).toBe("idle");

    await handleChatMessage(
      { socket: two.socket, user: asUser(userId) },
      { type: "set-idle", idle: false },
    );
    expect(resolveStatus(userId)).toBe("online");
  });

  it("forgets idle with the socket that reported it", async () => {
    const userId = randomUUID();
    const first = recordingSocket();
    await registerStatusSocket(first.socket, userId);
    await handleChatMessage(
      { socket: first.socket, user: asUser(userId) },
      { type: "set-idle", idle: true },
    );
    expect(resolveStatus(userId)).toBe("idle");

    // A dropped socket proves nothing about the person, so the derived state
    // dies with it — which is why the client re-announces on reconnect.
    unregisterStatusSocket(first.socket);
    const second = recordingSocket();
    await registerStatusSocket(second.socket, userId);
    expect(resolveStatus(userId)).toBe("online");
  });

  it("lets a manual choice beat the inactivity timer", async () => {
    const userId = randomUUID();
    const tab = recordingSocket();
    await registerStatusSocket(tab.socket, userId);
    applyManualStatus(userId, "dnd");
    await handleChatMessage(
      { socket: tab.socket, user: asUser(userId) },
      { type: "set-idle", idle: true },
    );
    // "Do not interrupt me" is something they said; idle is something a timer
    // guessed. The timer must not overwrite the statement.
    expect(resolveStatus(userId)).toBe("dnd");
  });

  it("resolves a whole member list in one pass", async () => {
    const [here, away, never] = [randomUUID(), randomUUID(), randomUUID()];
    const hereTab = recordingSocket();
    const awayTab = recordingSocket();
    await registerStatusSocket(hereTab.socket, here);
    await registerStatusSocket(awayTab.socket, away);
    await handleChatMessage(
      { socket: awayTab.socket, user: asUser(away) },
      { type: "set-idle", idle: true },
    );

    const statuses = resolveStatuses([here, away, never]);
    expect(statuses.get(here)).toBe("online");
    expect(statuses.get(away)).toBe("idle");
    // Every requested id gets an answer, including one nobody has ever seen.
    expect(statuses.get(never)).toBe("offline");
  });
});

describe("a manual status and the connection it outlives", () => {
  it("survives a reconnect", async () => {
    const userId = randomUUID();
    storedStatus.set(userId, "dnd");

    const first = recordingSocket();
    await registerStatusSocket(first.socket, userId);
    expect(resolveStatus(userId)).toBe("dnd");

    unregisterStatusSocket(first.socket);
    expect(resolveStatus(userId)).toBe("offline");

    // The registry forgot everything about them — the choice came back from
    // Postgres, which is the entire argument for storing it there rather than
    // on the socket.
    const second = recordingSocket();
    await registerStatusSocket(second.socket, userId);
    expect(resolveStatus(userId)).toBe("dnd");
  });

  it("reads the preference once per user, not once per tab", async () => {
    const userId = randomUUID();
    storedStatus.set(userId, "invisible");
    const one = recordingSocket();
    const two = recordingSocket();
    await registerStatusSocket(one.socket, userId);
    await registerStatusSocket(two.socket, userId);

    expect(preferenceReads).toBe(1);
    expect(resolveStatus(userId)).toBe("offline");
  });

  it("never shows somebody as online before their choice is known", async () => {
    // The ordering that makes invisibility trustworthy: registration resolves
    // the stored value BEFORE the socket is visible to anything. Registering
    // first and patching later would leave a real window, on every single sign
    // in, in which somebody who asked to be hidden reads as online.
    const userId = randomUUID();
    storedStatus.set(userId, "invisible");
    const tab = recordingSocket();
    const pending = registerStatusSocket(tab.socket, userId);

    expect(resolveStatus(userId)).toBe("offline");
    await pending;
    expect(resolveStatus(userId)).toBe("offline");
    expect(isInvisible(userId)).toBe(true);
  });

  it("does not resurrect somebody whose socket closed mid-lookup", async () => {
    const userId = randomUUID();
    storedStatus.set(userId, "online");
    const dead = recordingSocket(3 /* CLOSED */);
    await registerStatusSocket(dead.socket, userId);
    // A registration for a socket nothing will ever close would leave the user
    // online forever on this process.
    expect(resolveStatus(userId)).toBe("offline");
  });
});

describe("invisibility", () => {
  // A fresh channel per test: `channelPresence` is module state in chat.ts and
  // outlives `resetStatusRegistry`, so a shared id would accumulate every
  // previous test's viewers.
  let channelId = randomUUID();
  beforeEach(() => {
    channelId = randomUUID();
  });

  async function join(recorder: Recorder, userId: string) {
    await handleChatMessage(
      { socket: recorder.socket, user: asUser(userId) },
      { type: "join-channel", channelId },
    );
  }

  it("resolves to offline, never to invisible", async () => {
    const userId = randomUUID();
    storedStatus.set(userId, "invisible");
    const tab = recordingSocket();
    await registerStatusSocket(tab.socket, userId);

    // The type says this cannot be "invisible"; the test says the value agrees.
    expect(resolveStatus(userId)).toBe("offline");
    expect(resolveStatuses([userId]).get(userId)).toBe("offline");
  });

  it("keeps a hidden viewer out of the channel roster", async () => {
    const hidden = randomUUID();
    const watcher = randomUUID();
    storedStatus.set(hidden, "invisible");
    const hiddenTab = recordingSocket();
    const watcherTab = recordingSocket();
    await registerStatusSocket(hiddenTab.socket, hidden);
    await registerStatusSocket(watcherTab.socket, watcher);

    await join(hiddenTab, hidden);
    await join(watcherTab, watcher);

    const roster = lastFrameOfType<{ users: Array<{ id: string }> }>(
      watcherTab.received,
      "presence-update",
    );
    expect(roster?.users.map((one) => one.id)).toEqual([watcher]);
  });

  it("still delivers the roster TO the hidden viewer", async () => {
    // Invisibility takes away what others see, not what you can see.
    const hidden = randomUUID();
    const watcher = randomUUID();
    storedStatus.set(hidden, "invisible");
    const hiddenTab = recordingSocket();
    const watcherTab = recordingSocket();
    await registerStatusSocket(hiddenTab.socket, hidden);
    await registerStatusSocket(watcherTab.socket, watcher);

    await join(hiddenTab, hidden);
    await join(watcherTab, watcher);

    const roster = lastFrameOfType<{ users: Array<{ id: string }> }>(
      hiddenTab.received,
      "presence-update",
    );
    expect(roster?.users.map((one) => one.id)).toEqual([watcher]);
  });

  it("suppresses the typing indicator", async () => {
    const hidden = randomUUID();
    const watcher = randomUUID();
    storedStatus.set(hidden, "invisible");
    const hiddenTab = recordingSocket();
    const watcherTab = recordingSocket();
    await registerStatusSocket(hiddenTab.socket, hidden);
    await registerStatusSocket(watcherTab.socket, watcher);
    await join(hiddenTab, hidden);
    await join(watcherTab, watcher);
    watcherTab.received.length = 0;

    await handleChatMessage(
      { socket: hiddenTab.socket, user: asUser(hidden) },
      { type: "typing", channelId },
    );

    // You can be given away by a message you thought better of sending.
    expect(framesOfType(watcherTab.received, "typing-broadcast")).toHaveLength(0);
  });

  it("stops hiding them the moment they turn it off", async () => {
    const hidden = randomUUID();
    const watcher = randomUUID();
    storedStatus.set(hidden, "invisible");
    const hiddenTab = recordingSocket();
    const watcherTab = recordingSocket();
    await registerStatusSocket(hiddenTab.socket, hidden);
    await registerStatusSocket(watcherTab.socket, watcher);
    await join(hiddenTab, hidden);
    await join(watcherTab, watcher);

    applyManualStatus(hidden, "online");
    // The roster is rebuilt on the next presence event, which a re-join is.
    await join(watcherTab, watcher);

    const roster = lastFrameOfType<{ users: Array<{ id: string }> }>(
      watcherTab.received,
      "presence-update",
    );
    expect(roster?.users.map((one) => one.id).sort()).toEqual(
      [hidden, watcher].sort(),
    );
    expect(resolveStatus(hidden)).toBe("online");
  });
});
