import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * What a person is called inside a call.
 *
 * Two bugs lived here. A member with a nickname had their *account* name read
 * out to the whole voice channel, because voice was the one surface that did
 * not resolve `server_members.nickname`. And a rename mid-call never reached
 * the room at all: the label is copied onto the peer when it joins, so it
 * stayed whatever it was that moment, for everybody.
 *
 * No database: `resolveMemberName` is faked, since what it reads is its own
 * tested concern in `services/users.test.ts`. What is pinned here is that
 * voice asks it at all, and that a rename travels as `peer-updated` rather
 * than as a second `peer-joined` (which would play the join cue at everyone).
 */

const naming = vi.hoisted(() => ({ shown: new Map<string, string>() }));

vi.mock("../services/users.js", () => ({
  canAccessChannel: async () => true,
  resolveMemberName: async (
    _serverId: string | null,
    user: { id: string; display_name: string },
  ) => naming.shown.get(user.id) ?? user.display_name,
}));

// The mocked channel below belongs to a server, so the join path runs the
// CONNECT check. Every bit set: what this file is about is the name, not who
// may enter.
vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => (1n << 64n) - 1n,
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
  resolveRingableConversation: async () => null,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({
    kind: "server",
    type: "voice",
    server_id: "11111111-1111-4111-8111-111111111111",
  }),
  getChannelAudience: async () => ({
    serverId: null,
    kind: "server",
    has: () => true,
  }),
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
}));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "mesh" as const,
  isLiveKitConfigured: () => false,
}));

const {
  handleVoiceMessage,
  refreshVoiceIdentity,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { deleteAuthenticatedSocket, setAuthenticatedSocket } = await import(
  "./sockets.js"
);

const VOICE = randomUUID();

interface Recorder {
  socket: WebSocket;
  received: string[];
}

function recorder(): Recorder {
  const received: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => received.push(payload),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, received };
}

function asUser(id: string, name: string): DbUser {
  return { id, display_name: name, avatar_url: null } as unknown as DbUser;
}

function framesOfType(rec: Recorder, type: string): Record<string, unknown>[] {
  return rec.received
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

describe("what a peer is called in a call", () => {
  const open: Recorder[] = [];

  beforeEach(() => {
    for (const rec of open.splice(0)) {
      deleteAuthenticatedSocket(rec.socket);
    }
    resetVoicePeers();
    naming.shown.clear();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
  });

  async function join(userId: string, name: string): Promise<Recorder> {
    const rec = recorder();
    open.push(rec);
    const user = asUser(userId, name);
    setAuthenticatedSocket(rec.socket, user);
    await handleVoiceMessage(
      { socket: rec.socket, user },
      { type: "join-voice-room", voiceChannelId: VOICE },
    );
    return rec;
  }

  it("uses the server nickname, not the name on the account", async () => {
    const qriox = randomUUID();
    naming.shown.set(qriox, "Qriox");

    const first = await join(randomUUID(), "Ana");
    const second = await join(qriox, "Rafael Cammarano");

    // Their own welcome names them the way the server does.
    const [welcome] = framesOfType(second, "welcome");
    expect((welcome?.self as { displayName: string }).displayName).toBe("Qriox");

    // And so does the arrival everybody else sees.
    const [joined] = framesOfType(first, "peer-joined");
    expect((joined?.peer as { displayName: string }).displayName).toBe("Qriox");
    expect(JSON.stringify(first.received)).not.toContain("Rafael Cammarano");
  });

  it("carries a rename into the room without announcing an arrival", async () => {
    const qriox = randomUUID();
    const watcher = await join(randomUUID(), "Ana");
    await join(qriox, "Rafael Cammarano");
    watcher.received.length = 0;

    naming.shown.set(qriox, "Qriox");
    await refreshVoiceIdentity(qriox, {
      display_name: "Rafael Cammarano",
      avatar_url: "https://example.test/a.png",
    });

    const updates = framesOfType(watcher, "peer-updated");
    expect(updates).toHaveLength(1);
    const peer = updates[0]!.peer as {
      displayName: string;
      avatarUrl: string | null;
      userId: string;
    };
    expect(peer.userId).toBe(qriox);
    expect(peer.displayName).toBe("Qriox");
    expect(peer.avatarUrl).toBe("https://example.test/a.png");

    // Not a second arrival: that would play the join cue at everyone in the
    // room every time somebody edited their profile.
    expect(framesOfType(watcher, "peer-joined")).toHaveLength(0);

    // The occupancy badge outside the call is refreshed too.
    const roster = framesOfType(watcher, "voice-roster").at(-1);
    const participants = roster?.participants as { displayName: string }[];
    expect(participants.map((p) => p.displayName)).toContain("Qriox");
  });

  it("keeps the server nickname when the same peer reattaches", async () => {
    const previousClerk = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "sk_test_voice_identity";
    try {
      const qriox = randomUUID();
      naming.shown.set(qriox, "Qriox");

      const watcher = await join(randomUUID(), "Ana");
      const rec = recorder();
      open.push(rec);
      const user = asUser(qriox, "Rafael Cammarano");
      setAuthenticatedSocket(rec.socket, user);
      await handleVoiceMessage(
        { socket: rec.socket, user },
        { type: "join-voice-room", voiceChannelId: VOICE, resume: true },
      );
      const [welcome] = framesOfType(rec, "welcome");
      const peerId = welcome?.peerId as string;
      const token = welcome?.resumeToken as string;
      expect(peerId).toBeTruthy();
      expect(token).toBeTruthy();

      watcher.received.length = 0;
      removeVoicePeerBySocket(rec.socket);
      expect(framesOfType(watcher, "peer-left")).toHaveLength(0);

      const again = recorder();
      open.push(again);
      setAuthenticatedSocket(again.socket, user);
      await handleVoiceMessage(
        { socket: again.socket, user },
        {
          type: "join-voice-room",
          voiceChannelId: VOICE,
          resume: true,
          resumePeerId: peerId,
          resumeToken: token,
        },
      );

      const [joined] = framesOfType(watcher, "peer-joined");
      expect((joined?.peer as { displayName: string }).displayName).toBe(
        "Qriox",
      );
      expect(JSON.stringify(watcher.received)).not.toContain(
        "Rafael Cammarano",
      );
    } finally {
      process.env.CLERK_SECRET_KEY = previousClerk;
    }
  });

  it("does nothing for somebody who is not in a call", async () => {
    const stranger = randomUUID();
    const watcher = await join(randomUUID(), "Ana");
    watcher.received.length = 0;

    await refreshVoiceIdentity(stranger, {
      display_name: "Nobody",
      avatar_url: null,
    });
    expect(watcher.received).toHaveLength(0);
  });
});
