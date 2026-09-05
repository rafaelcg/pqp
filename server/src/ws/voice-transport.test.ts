import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * A voice room has ONE media transport and the server states it.
 *
 * The bug this suite pins down was silent by construction: clients resolved
 * mesh-vs-SFU independently, once per join, and announced it to nobody. One
 * client on mesh in an otherwise-SFU room sends offers that the SFU clients
 * drop (no peer-connection manager), and never appears in their peer lists at
 * all — so everybody saw everybody in the sidebar and one of them could not be
 * heard, indistinguishable from being muted. No error, anywhere.
 *
 * The tests below therefore assert the *visibility* of the failure as much as
 * the failure itself: a client that cannot run the room's transport must not
 * become a participant, and must be told why in a way it can act on.
 *
 * No database: the service layer under the peer bookkeeping is faked.
 */

const backend = vi.hoisted(() => ({ configured: "mesh" as "mesh" | "livekit" }));

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => backend.configured,
  isLiveKitConfigured: () => backend.configured === "livekit",
}));

vi.mock("../services/users.js", () => ({
  // Voice resolves the name to show through here now; the real one
  // reads `server_members.nickname`, which these tests have no table for.
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

// The timeout chokepoint queries Postgres, and this suite deliberately runs
// without one. Enforcement itself is proved end-to-end against a real database
// in services/sanctions.test.ts; here it only has to be out of the way.
vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

// A channel with a server behind it runs the CONNECT check, which reads
// Postgres. Everyone here is allowed in; access is proved elsewhere.
vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => (1n << 64n) - 1n,
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
}));

/**
 * Rows the transport policy reads. A channel absent from `channels` is a plain
 * server voice channel with no server row behind it, which is what every test
 * that predates the policy was written against: it resolves to the configured
 * default, so those tests describe the deployment ceiling unchanged.
 */
const rows = vi.hoisted(() => ({
  channels: new Map<
    string,
    {
      kind: string;
      type: string;
      server_id?: string;
      voice_transport?: "mesh" | "livekit" | null;
    }
  >(),
  servers: new Map<string, { isCommunity: boolean; memberCount: number }>(),
  /** How many times the policy went to the database for a server. */
  profileReads: 0,
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async (channelId: string) =>
    rows.channels.get(channelId) ?? { kind: "server", type: "voice" },
  getChannelAudience: async () => null,
  getServerVoiceProfile: async (serverId: string) => {
    rows.profileReads += 1;
    return rows.servers.get(serverId) ?? null;
  },
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
}));

const {
  getRoomTransport,
  handleVoiceMessage,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
  sendAllVoiceRosters,
} = await import("./voice.js");

const { MESH_VOICE_LIMIT } = await import("@pqp/shared");

type Transport = "mesh" | "livekit";

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

function typesOf(rec: Recorder): string[] {
  return rec.frames.map((f) => f.type);
}

const sockets: Recorder[] = [];

function track(rec: Recorder): Recorder {
  sockets.push(rec);
  return rec;
}

/** Join, declaring what this client can run. Returns everything it received. */
async function join(
  rec: Recorder,
  userId: string,
  voiceChannelId: string,
  transports?: Transport[],
): Promise<Recorder> {
  await handleVoiceMessage(
    { socket: rec.socket, user: asUser(userId) },
    transports
      ? { type: "join-voice-room", voiceChannelId, transports }
      : { type: "join-voice-room", voiceChannelId },
  );
  return rec;
}

/** Peer id the server assigned, or null if the join was refused. */
function peerIdOf(rec: Recorder): string | null {
  const welcome = frame(rec, "welcome");
  return welcome ? (welcome.peerId as string) : null;
}

describe("voice room transport", () => {
  let channel: string;

  beforeEach(() => {
    sockets.length = 0;
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    backend.configured = "mesh";
    channel = randomUUID();
    rows.channels.clear();
    rows.servers.clear();
    rows.profileReads = 0;
  });

  /**
   * THE POLICY. LiveKit Cloud bills participant-minutes, and a call between
   * three friends gains nothing from it, so with the SFU configured a room
   * still opens on mesh unless it can outgrow the mesh: a server of ten or
   * more, a listed community, or a channel the owner pinned to the SFU.
   */
  describe("which transport a room opens on (SFU configured)", () => {
    let serverId: string;

    /** A voice channel in a server of `memberCount` members. */
    function serverChannel(
      memberCount: number,
      extra: { isCommunity?: boolean; override?: "mesh" | "livekit" } = {},
    ): string {
      serverId = randomUUID();
      rows.servers.set(serverId, {
        isCommunity: extra.isCommunity ?? false,
        memberCount,
      });
      rows.channels.set(channel, {
        kind: "server",
        type: "voice",
        server_id: serverId,
        voice_transport: extra.override ?? null,
      });
      return channel;
    }

    beforeEach(() => {
      backend.configured = "livekit";
    });

    it("opens a DM call on mesh", async () => {
      rows.channels.set(channel, { kind: "dm", type: "text" });
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("mesh");
      // Nothing to look up for a conversation.
      expect(rows.profileReads).toBe(0);
    });

    it("opens a voice channel in a nine-member server on mesh", async () => {
      serverChannel(9);
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("mesh");
      expect(getRoomTransport(channel)).toBe("mesh");
    });

    it("admits a mesh-only native client to a small server's room", async () => {
      serverChannel(4);
      const phone = track(await join(recorder(), "u1", channel, ["mesh"]));

      expect(frame(phone, "welcome")?.transport).toBe("mesh");
      expect(typesOf(phone)).not.toContain("voice-transport-unsupported");
    });

    it("opens a voice channel in a ten-member server on the SFU", async () => {
      serverChannel(10);
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("livekit");
    });

    it("still refuses a mesh-only client from a large server's room", async () => {
      // No silent fallback: the room is an SFU room, and a client that cannot
      // run it is told so, exactly as before the policy.
      serverChannel(40);
      const phone = track(await join(recorder(), "u1", channel, ["mesh"]));

      expect(frame(phone, "voice-transport-unsupported")).toMatchObject({
        transport: "livekit",
      });
      expect(peerIdOf(phone)).toBeNull();
    });

    it("opens a three-member listed community on the SFU", async () => {
      serverChannel(3, { isCommunity: true });
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("livekit");
    });

    it("lets the channel override force the SFU on a small server", async () => {
      serverChannel(5, { override: "livekit" });
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("livekit");
      // The override settles it without reading the server at all.
      expect(rows.profileReads).toBe(0);
    });

    it("lets the channel override force mesh on a large community", async () => {
      serverChannel(500, { isCommunity: true, override: "mesh" });
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("mesh");
    });

    it("keeps a small server's room on mesh at the mesh ceiling, with the usual refusal", async () => {
      serverChannel(9);
      for (let i = 0; i < MESH_VOICE_LIMIT; i++) {
        track(await join(recorder(), `u${i}`, channel, ["mesh", "livekit"]));
      }
      const extra = track(
        await join(recorder(), "extra", channel, ["mesh", "livekit"]),
      );

      expect(frame(extra, "voice-room-full")).toMatchObject({
        limit: MESH_VOICE_LIMIT,
      });
      expect(getRoomTransport(channel)).toBe("mesh");
    });

    it("decides once per pin: later joins do not re-read, and a live room never flips", async () => {
      serverChannel(9);
      track(await join(recorder(), "u1", channel, ["mesh", "livekit"]));
      expect(rows.profileReads).toBe(1);

      // The server crosses the threshold mid-call.
      rows.servers.set(serverId, { isCommunity: false, memberCount: 10 });
      const second = track(
        await join(recorder(), "u2", channel, ["mesh", "livekit"]),
      );

      expect(frame(second, "welcome")?.transport).toBe("mesh");
      expect(rows.profileReads).toBe(1);
    });

    it("re-decides for the next call once the room empties", async () => {
      serverChannel(9);
      const first = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );
      expect(frame(first, "welcome")?.transport).toBe("mesh");

      rows.servers.set(serverId, { isCommunity: false, memberCount: 10 });
      await handleVoiceMessage(
        { socket: first.socket, user: asUser("u1") },
        { type: "leave-voice-room" },
      );

      const next = track(
        await join(recorder(), "u2", channel, ["mesh", "livekit"]),
      );
      expect(frame(next, "welcome")?.transport).toBe("livekit");
      expect(rows.profileReads).toBe(2);
    });

    it("logs one transportPinned line per pin, with the reason", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        serverChannel(9);
        track(await join(recorder(), "u1", channel, ["mesh", "livekit"]));
        track(await join(recorder(), "u2", channel, ["mesh", "livekit"]));

        const pinned = log.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes("voice.transportPinned"));
        expect(pinned).toHaveLength(1);
        expect(pinned[0]).toContain(`channelId=${channel}`);
        expect(pinned[0]).toContain("transport=mesh");
        expect(pinned[0]).toContain("reason=small");
      } finally {
        log.mockRestore();
      }
    });

    it("stays mesh everywhere, without a lookup, when LiveKit is not configured", async () => {
      backend.configured = "mesh";
      serverChannel(500, { isCommunity: true, override: "livekit" });
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("mesh");
      expect(rows.profileReads).toBe(0);
    });
  });

  describe("mesh-only deployment (the default self-host)", () => {
    it("states mesh on the wire and admits a mesh-only client", async () => {
      const rec = track(await join(recorder(), "u1", channel, ["mesh"]));

      const welcome = frame(rec, "welcome");
      expect(welcome?.transport).toBe("mesh");
      expect(typesOf(rec)).not.toContain("voice-transport-unsupported");
    });

    it("puts a client that could also do SFU on mesh anyway", async () => {
      // The other half of the split: the server decides, so a client with an
      // SFU available does not get to unilaterally use it.
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("mesh");
    });

    it("relays mesh signaling between peers, as it always did", async () => {
      const a = track(await join(recorder(), "u1", channel, ["mesh"]));
      const b = track(await join(recorder(), "u2", channel, ["mesh"]));
      const from = peerIdOf(a)!;
      const to = peerIdOf(b)!;
      b.frames.length = 0;

      await handleVoiceMessage(
        { socket: a.socket, user: asUser("u1") },
        { type: "offer", from, to, sdp: "v=0" },
      );

      expect(frame(b, "offer")).toMatchObject({ from, sdp: "v=0" });
    });

    it("still enforces the mesh ceiling", async () => {
      for (let i = 0; i < MESH_VOICE_LIMIT; i++) {
        track(await join(recorder(), `u${i}`, channel, ["mesh"]));
      }
      const extra = track(await join(recorder(), "extra", channel, ["mesh"]));

      expect(frame(extra, "voice-room-full")).toBeDefined();
      expect(peerIdOf(extra)).toBeNull();
    });
  });

  describe("SFU deployment", () => {
    beforeEach(() => {
      backend.configured = "livekit";
    });

    it("states livekit on the wire", async () => {
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );

      expect(frame(rec, "welcome")?.transport).toBe("livekit");
    });

    it("does not apply the mesh ceiling", async () => {
      for (let i = 0; i < MESH_VOICE_LIMIT + 3; i++) {
        const rec = track(
          await join(recorder(), `u${i}`, channel, ["mesh", "livekit"]),
        );
        expect(peerIdOf(rec)).not.toBeNull();
      }
    });

    /**
     * THE PARTITION. A client that can only do mesh used to be admitted, appear
     * in everyone's roster, and be inaudible forever.
     */
    it("refuses a mesh-only client instead of admitting it silently", async () => {
      const incumbent = track(
        await join(recorder(), "incumbent", channel, ["mesh", "livekit"]),
      );
      incumbent.frames.length = 0;
      const meshOnly = track(await join(recorder(), "u2", channel, ["mesh"]));

      // Told, specifically, and told which transport it needed.
      expect(frame(meshOnly, "voice-transport-unsupported")).toEqual({
        type: "voice-transport-unsupported",
        voiceChannelId: channel,
        transport: "livekit",
      });
      // Not admitted: no peer id was ever issued to it.
      expect(peerIdOf(meshOnly)).toBeNull();
      // And distinguishable from the other ways a join can fail.
      expect(typesOf(meshOnly)).not.toContain("voice-room-full");
      expect(typesOf(meshOnly)).not.toContain("welcome");
    });

    it("never shows the refused client to the people in the call", async () => {
      const incumbent = track(
        await join(recorder(), "incumbent", channel, ["mesh", "livekit"]),
      );
      incumbent.frames.length = 0;

      track(await join(recorder(), "ghost", channel, ["mesh"]));

      // No arrival was announced...
      expect(typesOf(incumbent)).not.toContain("peer-joined");
      // ...and the roster a fresh socket is handed does not name them either,
      // so nobody is left talking to a participant who is not there.
      const observer = track(recorder());
      await sendAllVoiceRosters(observer.socket, asUser("observer"));
      const roster = frame(observer, "voice-roster");
      expect(roster?.transport).toBe("livekit");
      expect(
        (roster?.participants as { userId: string }[]).map((p) => p.userId),
      ).toEqual(["incumbent"]);
    });

    it("drops mesh signaling sent into an SFU room", async () => {
      const a = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );
      const b = track(
        await join(recorder(), "u2", channel, ["mesh", "livekit"]),
      );
      const from = peerIdOf(a)!;
      const to = peerIdOf(b)!;
      b.frames.length = 0;

      await handleVoiceMessage(
        { socket: a.socket, user: asUser("u1") },
        { type: "offer", from, to, sdp: "v=0" },
      );

      expect(frame(b, "offer")).toBeUndefined();
    });

    it("admits a client that predates the capability field", async () => {
      // Absent capabilities are read permissively: the only clients that omit
      // them are older builds, and refusing all of them would be a worse
      // deploy than leaving them on the behaviour they already had.
      const rec = track(await join(recorder(), "old", channel));

      expect(frame(rec, "welcome")?.transport).toBe("livekit");
    });
  });

  describe("a live room's transport does not change under it", () => {
    it("keeps the pinned transport when the config changes mid-call", async () => {
      backend.configured = "livekit";
      track(await join(recorder(), "first", channel, ["mesh", "livekit"]));

      // LiveKit config disappears (restart with different env, operator
      // rollback). The call in progress stays where it started: there is no
      // way to move a live room between transports without cutting everyone's
      // audio, and half a room moving is the partition again.
      backend.configured = "mesh";

      const later = track(
        await join(recorder(), "second", channel, ["mesh", "livekit"]),
      );
      expect(frame(later, "welcome")?.transport).toBe("livekit");
      expect(getRoomTransport(channel)).toBe("livekit");
    });

    it("picks the transport up again once the room empties", async () => {
      backend.configured = "livekit";
      const rec = track(await join(recorder(), "u1", channel, ["mesh"]));
      expect(peerIdOf(rec)).toBeNull();

      const joined = track(
        await join(recorder(), "u2", channel, ["mesh", "livekit"]),
      );
      expect(frame(joined, "welcome")?.transport).toBe("livekit");

      backend.configured = "mesh";
      await handleVoiceMessage(
        { socket: joined.socket, user: asUser("u2") },
        { type: "leave-voice-room" },
      );

      // Empty room, new config: the next call gets it without a restart.
      expect(getRoomTransport(channel)).toBe("mesh");
      const after = track(await join(recorder(), "u3", channel, ["mesh"]));
      expect(frame(after, "welcome")?.transport).toBe("mesh");
    });

    it("does not re-decide the transport when the last peer rejoins", async () => {
      backend.configured = "livekit";
      const rec = track(
        await join(recorder(), "u1", channel, ["mesh", "livekit"]),
      );
      backend.configured = "mesh";

      // A reconnect re-sends join-voice-room on the same socket. Removing the
      // old peer first would empty the room and silently re-pin it to mesh
      // while everyone else stays on the SFU.
      rec.frames.length = 0;
      await join(rec, "u1", channel, ["mesh", "livekit"]);

      expect(frame(rec, "welcome")?.transport).toBe("livekit");
    });

    it("drops the refused client's stale peer rather than leaving a ghost", async () => {
      // Joined while the room was mesh, then reconnects into a room that has
      // since become an SFU room and which this client cannot run.
      const rec = track(await join(recorder(), "u1", channel, ["mesh"]));
      expect(peerIdOf(rec)).not.toBeNull();

      backend.configured = "livekit";
      resetVoiceRoomTransports();
      const other = track(
        await join(recorder(), "u2", randomUUID(), ["mesh", "livekit"]),
      );
      expect(peerIdOf(other)).not.toBeNull();

      rec.frames.length = 0;
      await join(rec, "u1", channel, ["mesh"]);

      expect(frame(rec, "voice-transport-unsupported")).toBeDefined();
      const observer = track(recorder());
      await sendAllVoiceRosters(observer.socket, asUser("observer"));
      const rosters = observer.frames.filter((f) => f.type === "voice-roster");
      expect(
        rosters.flatMap((r) => r.participants as { userId: string }[]),
      ).toHaveLength(1);
    });
  });
});
