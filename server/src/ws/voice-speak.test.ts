import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * SPEAK on the WS side: what a listener is told at join, what the room will
 * not let them claim, and what happens when the bit flips under somebody who
 * is already in the call. The SFU calls are mocked one function deep
 * (`setSfuUserCanPublish`, pinned in voice/publish-grant.test.ts); the
 * permission arithmetic is mocked to a per-user bitfield so no database is
 * needed.
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
  return {
    computeMemberPermissions: async (_serverId: string, userId: string) =>
      bits.byUser.get(userId) ?? PERMISSION_DEFAULT_EVERYONE,
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
  reevaluateVoiceSpeak,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { deliverPermissionsUpdate } = await import("./chat.js");
const { setSfuUserCanPublish } = await import("../voice/admin.js");
const { Permission } = await import("@pqp/shared");

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

function framesOf(rec: Recorder, type: string): Frame[] {
  return rec.frames.filter((f) => f.type === type);
}

async function join(rec: Recorder, userId: string, voiceChannelId: string) {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    { type: "join-voice-room", voiceChannelId },
  );
  return rec;
}

const LISTENER_BITS = Permission.CONNECT;
const SPEAKER_BITS =
  Permission.CONNECT | Permission.SPEAK | Permission.STREAM;

describe("SPEAK in voice rooms", () => {
  beforeEach(() => {
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    bits.byUser.clear();
    backend.configured = "mesh";
    vi.mocked(setSfuUserCanPublish).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("at join", () => {
    it("tells a listener so on welcome, top level and on self", async () => {
      bits.byUser.set("quiet", LISTENER_BITS);
      const rec = await join(recorder(), "quiet", STAGE);
      const welcome = frame(rec, "welcome")!;
      expect(welcome.canSpeak).toBe(false);
      expect(welcome.canStream).toBe(false);
      expect((welcome.self as { canSpeak: boolean }).canSpeak).toBe(false);
      expect((welcome.self as { canStream: boolean }).canStream).toBe(false);
    });

    it("says true for a member with SPEAK, and by default", async () => {
      bits.byUser.set("loud", SPEAKER_BITS);
      const loud = await join(recorder(), "loud", STAGE);
      const anyone = await join(recorder(), "anyone", STAGE);
      expect(frame(loud, "welcome")!.canSpeak).toBe(true);
      expect(frame(loud, "welcome")!.canStream).toBe(true);
      expect(frame(anyone, "welcome")!.canSpeak).toBe(true);
      expect(frame(anyone, "welcome")!.canStream).toBe(true);
      // The listener flag rides on the roster others receive too.
      const peers = frame(anyone, "welcome")!.peers as Array<{
        userId: string;
        canSpeak: boolean;
      }>;
      expect(peers.find((p) => p.userId === "loud")?.canSpeak).toBe(true);
    });

    it("never denies a conversation call, whatever the member's server bits", async () => {
      bits.byUser.set("quiet", LISTENER_BITS);
      const rec = await join(recorder(), "quiet", DM_CALL);
      expect(frame(rec, "welcome")!.canSpeak).toBe(true);
    });
  });

  describe("what a listener cannot claim", () => {
    it("refuses a screen share and a camera", async () => {
      bits.byUser.set("quiet", LISTENER_BITS);
      const rec = await join(recorder(), "quiet", STAGE);
      await handleVoiceMessage(
        { socket: rec.socket, user: asUser("quiet") },
        { type: "set-sharing-screen", sharing: true },
      );
      await handleVoiceMessage(
        { socket: rec.socket, user: asUser("quiet") },
        { type: "set-camera", streamId: "cam-1" },
      );
      expect(frame(rec, "screen-share-denied")).toBeDefined();
      expect(frame(rec, "camera-denied")).toBeDefined();

      // Nobody sees them presenting.
      const watcher = await join(recorder(), "watcher", STAGE);
      const peers = frame(watcher, "welcome")!.peers as Array<{
        userId: string;
        sharingScreen: boolean;
        cameraStreamId: string | null;
      }>;
      const quiet = peers.find((p) => p.userId === "quiet")!;
      expect(quiet.sharingScreen).toBe(false);
      expect(quiet.cameraStreamId ?? null).toBeNull();
    });

    it("lets a speaker keep the mic when Stream is denied", async () => {
      bits.byUser.set("mic", Permission.CONNECT | Permission.SPEAK);
      const rec = await join(recorder(), "mic", STAGE);
      const welcome = frame(rec, "welcome")!;
      expect(welcome.canSpeak).toBe(true);
      expect(welcome.canStream).toBe(false);

      await handleVoiceMessage(
        { socket: rec.socket, user: asUser("mic") },
        { type: "set-sharing-screen", sharing: true },
      );
      await handleVoiceMessage(
        { socket: rec.socket, user: asUser("mic") },
        { type: "set-camera", streamId: "cam-1" },
      );
      expect(frame(rec, "screen-share-denied")).toBeDefined();
      expect(frame(rec, "camera-denied")).toBeDefined();

      await handleVoiceMessage(
        { socket: rec.socket, user: asUser("mic") },
        { type: "set-voice-state", muted: false, deafened: false },
      );
      const watcher = await join(recorder(), "watcher", STAGE);
      const peers = frame(watcher, "welcome")!.peers as Array<{
        userId: string;
        muted: boolean;
      }>;
      expect(peers.find((p) => p.userId === "mic")!.muted).toBe(false);
    });

    it("keeps a listener shown as muted even if their client says otherwise", async () => {
      bits.byUser.set("quiet", LISTENER_BITS);
      const rec = await join(recorder(), "quiet", STAGE);
      await handleVoiceMessage(
        { socket: rec.socket, user: asUser("quiet") },
        { type: "set-voice-state", muted: false, deafened: false },
      );
      const watcher = await join(recorder(), "watcher", STAGE);
      const peers = frame(watcher, "welcome")!.peers as Array<{
        userId: string;
        muted: boolean;
      }>;
      expect(peers.find((p) => p.userId === "quiet")!.muted).toBe(true);
    });
  });

  describe("live permission change", () => {
    it("mesh room: revokes and restores with a frame, and never calls the SFU", async () => {
      bits.byUser.set("member", SPEAKER_BITS);
      const rec = await join(recorder(), "member", STAGE);
      expect(frame(rec, "welcome")!.canSpeak).toBe(true);

      bits.byUser.set("member", LISTENER_BITS);
      await reevaluateVoiceSpeak(SERVER);
      expect(framesOf(rec, "voice-speak-changed")).toEqual([
        {
          type: "voice-speak-changed",
          voiceChannelId: STAGE,
          canSpeak: false,
          canStream: false,
        },
      ]);

      // Idempotent: nothing changed, nothing sent.
      await reevaluateVoiceSpeak(SERVER);
      expect(framesOf(rec, "voice-speak-changed")).toHaveLength(1);

      bits.byUser.set("member", SPEAKER_BITS);
      await reevaluateVoiceSpeak(SERVER);
      expect(framesOf(rec, "voice-speak-changed").at(-1)).toEqual({
        type: "voice-speak-changed",
        voiceChannelId: STAGE,
        canSpeak: true,
        canStream: true,
      });
      expect(setSfuUserCanPublish).not.toHaveBeenCalled();
    });

    it("SFU room: the grant follows the bit, scoped to that user and room", async () => {
      backend.configured = "livekit";
      bits.byUser.set("member", SPEAKER_BITS);
      const rec = await join(recorder(), "member", STAGE);
      const bystander = await join(recorder(), "bystander", STAGE);
      const peerId = frame(rec, "welcome")!.peerId as string;

      bits.byUser.set("member", LISTENER_BITS);
      await reevaluateVoiceSpeak(SERVER);

      expect(frame(rec, "voice-speak-changed")).toMatchObject({ canSpeak: false });
      expect(frame(bystander, "voice-speak-changed")).toBeUndefined();
      expect(setSfuUserCanPublish).toHaveBeenCalledTimes(1);
      const [room, userId, grant, identities] = vi.mocked(
        setSfuUserCanPublish,
      ).mock.calls[0]!;
      expect(room).toBe(STAGE);
      expect(userId).toBe("member");
      expect(grant).toEqual({ canSpeak: false, canStream: false });
      expect(identities.get(peerId)).toBe("member");

      bits.byUser.set("member", SPEAKER_BITS);
      await reevaluateVoiceSpeak(SERVER);
      expect(setSfuUserCanPublish).toHaveBeenLastCalledWith(
        STAGE,
        "member",
        { canSpeak: true, canStream: true },
        expect.any(Map),
      );
    });

    it("a presenter who loses SPEAK stops presenting on the roster", async () => {
      bits.byUser.set("member", SPEAKER_BITS);
      const rec = await join(recorder(), "member", STAGE);
      await handleVoiceMessage(
        { socket: rec.socket, user: asUser("member") },
        { type: "set-sharing-screen", sharing: true },
      );
      bits.byUser.set("member", LISTENER_BITS);
      await reevaluateVoiceSpeak(SERVER);

      const watcher = await join(recorder(), "watcher", STAGE);
      const peers = frame(watcher, "welcome")!.peers as Array<{
        userId: string;
        sharingScreen: boolean;
        muted: boolean;
        canSpeak: boolean;
      }>;
      const member = peers.find((p) => p.userId === "member")!;
      expect(member.sharingScreen).toBe(false);
      expect(member.muted).toBe(true);
      expect(member.canSpeak).toBe(false);
    });

    it("only touches rooms that belong to the bumped server", async () => {
      bits.byUser.set("member", SPEAKER_BITS);
      const here = await join(recorder(), "member", STAGE);
      const elsewhere = await join(recorder(), "member-2", OTHER_ROOM);
      bits.byUser.set("member", LISTENER_BITS);
      bits.byUser.set("member-2", LISTENER_BITS);

      await reevaluateVoiceSpeak(OTHER_SERVER);
      expect(frame(here, "voice-speak-changed")).toBeUndefined();
      expect(frame(elsewhere, "voice-speak-changed")).toMatchObject({
        canSpeak: false,
      });
    });

    it("runs off the permissions-update fan-out, so a role edit reaches the room", async () => {
      bits.byUser.set("member", SPEAKER_BITS);
      const rec = await join(recorder(), "member", STAGE);
      bits.byUser.set("member", LISTENER_BITS);

      deliverPermissionsUpdate(SERVER, 1, []);
      // The listener is fire-and-forget; give its awaits a few turns.
      for (let i = 0; i < 20 && !frame(rec, "voice-speak-changed"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(frame(rec, "voice-speak-changed")).toMatchObject({
        canSpeak: false,
      });
    });
  });
});
