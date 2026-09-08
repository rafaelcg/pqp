import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * START_WATCH_PARTY on the WS side. A `watch_party` room is a voice room
 * whose stage is gated by its own bit: the everyday STREAM default is not
 * enough there, an admin's ALL is, and a per-channel overwrite flips it.
 * Same fixture as voice-speak.test.ts: permissions are mocked to a per-user
 * bitfield, so the bits below are the *resolved* channel bits (an overwrite
 * is already applied by the time voice.ts sees them).
 */

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

/** userId → resolved bits. Absent means the @everyone default (SPEAK on). */
const bits = vi.hoisted(() => ({ byUser: new Map<string, bigint>() }));

vi.mock("../services/permissions.js", async () => {
  const { PERMISSION_DEFAULT_EVERYONE } = await import("@pqp/shared");
  const forUser = (userId: string) =>
    bits.byUser.get(userId) ?? PERMISSION_DEFAULT_EVERYONE;
  return {
    computeMemberPermissions: async (_serverId: string, userId: string) =>
      forUser(userId),
    resolveMemberChannelPermissions: async (
      _serverId: string,
      userId: string,
    ) => ({ permissions: forUser(userId), nickname: null }),
  };
});

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
  resolveRingableConversation: async () => null,
}));

const SERVER = randomUUID();
const OTHER_SERVER = randomUUID();
const STAGE = randomUUID();
const CINEMA = randomUUID();
const OTHER_ROOM = randomUUID();
const DM_CALL = randomUUID();

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => {
    if (id === DM_CALL) {
      return { id, kind: "conversation", type: "text", server_id: null };
    }
    if (id === OTHER_ROOM) {
      return { id, kind: "server", type: "voice", server_id: OTHER_SERVER };
    }
    if (id === CINEMA) {
      return { id, kind: "server", type: "watch_party", server_id: SERVER };
    }
    return { id, kind: "server", type: "voice", server_id: SERVER };
  },
  getChannelAudience: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
}));

const {
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { setSfuUserCanPublish } = await import("../voice/admin.js");
const {
  Permission,
  PERMISSION_ALL,
  PERMISSION_DEFAULT_EVERYONE,
  PERMISSION_DEFAULT_MODERATOR,
} = await import("@pqp/shared");

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
}

function recorder(): Recorder {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  return { socket, frames };
}

function asUser(id: string): DbUser {
  return {
    id,
    display_name: `User ${id}`,
    avatar_url: null,
  } as unknown as DbUser;
}

function frame(rec: Recorder, type: string): Frame | undefined {
  return rec.frames.find((f) => f.type === type);
}

async function join(rec: Recorder, userId: string, voiceChannelId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId },
  );
  return rec;
}


async function claimStage(rec: Recorder, userId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "set-sharing-screen", sharing: true },
  );
}

describe("START_WATCH_PARTY in a watch party room", () => {
  beforeEach(() => {
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    bits.byUser.clear();
    backend.configured = "mesh";
    vi.mocked(setSfuUserCanPublish).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("lets an admin take the stage", async () => {
    bits.byUser.set("admin", PERMISSION_ALL);
    const rec = await join(recorder(), "admin", CINEMA);
    expect(frame(rec, "welcome")!.canStream).toBe(true);
    await claimStage(rec, "admin");
    expect(frame(rec, "screen-share-denied")).toBeUndefined();
    const watcher = await join(recorder(), "watcher", CINEMA);
    const peers = frame(watcher, "welcome")!.peers as Array<{
      userId: string;
      sharingScreen: boolean;
    }>;
    expect(peers.find((p) => p.userId === "admin")?.sharingScreen).toBe(true);
  });

  it("refuses a plain member, even with the everyday Stream bit", async () => {
    bits.byUser.set("member", PERMISSION_DEFAULT_EVERYONE);
    expect(PERMISSION_DEFAULT_EVERYONE & Permission.STREAM).toBe(
      Permission.STREAM,
    );
    const rec = await join(recorder(), "member", CINEMA);
    expect(frame(rec, "welcome")!.canStream).toBe(false);
    await claimStage(rec, "member");
    expect(frame(rec, "screen-share-denied")).toBeDefined();
    const watcher = await join(recorder(), "watcher", CINEMA);
    const peers = frame(watcher, "welcome")!.peers as Array<{
      userId: string;
      sharingScreen: boolean;
    }>;
    expect(peers.find((p) => p.userId === "member")?.sharingScreen).toBe(false);
  });

  it("an overwrite flips it: granted to a member, revoked from a mod", async () => {
    bits.byUser.set(
      "guest-host",
      PERMISSION_DEFAULT_EVERYONE | Permission.START_WATCH_PARTY,
    );
    const guest = await join(recorder(), "guest-host", CINEMA);
    expect(frame(guest, "welcome")!.canStream).toBe(true);
    await claimStage(guest, "guest-host");
    expect(frame(guest, "screen-share-denied")).toBeUndefined();

    bits.byUser.set(
      "benched-mod",
      (PERMISSION_DEFAULT_EVERYONE | PERMISSION_DEFAULT_MODERATOR) &
        ~Permission.START_WATCH_PARTY,
    );
    const mod = await join(recorder(), "benched-mod", CINEMA);
    expect(frame(mod, "welcome")!.canStream).toBe(false);
    await claimStage(mod, "benched-mod");
    expect(frame(mod, "screen-share-denied")).toBeDefined();
  });

  it("still lets the same member share in a plain voice room", async () => {
    bits.byUser.set("member", PERMISSION_DEFAULT_EVERYONE);
    const rec = await join(recorder(), "member", STAGE);
    expect(frame(rec, "welcome")!.canStream).toBe(true);
    await claimStage(rec, "member");
    expect(frame(rec, "screen-share-denied")).toBeUndefined();
  });
});
