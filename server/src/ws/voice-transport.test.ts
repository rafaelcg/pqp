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
}));

vi.mock("../services/servers.js", () => ({
  getChannel: async () => ({ kind: "server", type: "voice" }),
  getChannelAudience: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
}));

const {
  getRoomTransport,
  handleVoiceMessage,
  removeVoicePeerBySocket,
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
    for (const rec of sockets.splice(0)) {
      removeVoicePeerBySocket(rec.socket);
    }
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    backend.configured = "mesh";
    channel = randomUUID();
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
      removeVoicePeerBySocket(joined.socket);

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
