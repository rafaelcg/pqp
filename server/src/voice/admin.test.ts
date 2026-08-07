import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SFU half of moderation. These tests stand in for something that cannot be
 * exercised locally — a real LiveKit deployment — so the boundary they mock is
 * exactly one call deep: the `RoomServiceClient` methods. Everything on our
 * side of that boundary (when a client is built at all, which participants are
 * selected, what happens when the SDK throws) is genuinely executed.
 */
const lk = vi.hoisted(() => ({
  hosts: [] as string[],
  listRooms: vi.fn(),
  listParticipants: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      constructor(host: string) {
        lk.hosts.push(host);
      }
      listRooms = lk.listRooms;
      listParticipants = lk.listParticipants;
      removeParticipant = lk.removeParticipant;
    },
  };
});

const {
  evictSfuRoom,
  evictSfuUser,
  evictSfuUsersExcept,
  resetSfuAdminClient,
  settleSfuEvictions,
} = await import("./admin.js");
const { participantMetadataFor } = await import("./backends.js");

function participant(identity: string, userId?: string) {
  return {
    identity,
    ...(userId ? { metadata: participantMetadataFor(userId) } : {}),
  };
}

function rooms(...names: string[]) {
  return names.map((name) => ({ name }));
}

/** Identities passed to removeParticipant, ignoring room/options. */
function removedIdentities(): string[] {
  return lk.removeParticipant.mock.calls.map((call) => call[1] as string);
}

function configureLiveKit() {
  process.env.LIVEKIT_URL = "wss://sfu.example.test";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  resetSfuAdminClient();
}

function unconfigureLiveKit() {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  resetSfuAdminClient();
}

describe("SFU eviction", () => {
  beforeEach(() => {
    lk.hosts.length = 0;
    lk.listRooms.mockReset().mockResolvedValue([]);
    lk.listParticipants.mockReset().mockResolvedValue([]);
    lk.removeParticipant.mockReset().mockResolvedValue(undefined);
    // Quiet the deliberate failure paths; assertions below cover the logging.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    unconfigureLiveKit();
  });

  describe("when LiveKit is not configured (the default deployment)", () => {
    beforeEach(unconfigureLiveKit);

    it("never builds a client or touches the network", async () => {
      await evictSfuUser("user-1", ["channel-1"], new Map());
      await evictSfuUsersExcept("channel-1", new Set(["user-2"]), new Map());
      await evictSfuRoom("channel-1");
      await settleSfuEvictions();

      expect(lk.hosts).toEqual([]);
      expect(lk.listRooms).not.toHaveBeenCalled();
      expect(lk.listParticipants).not.toHaveBeenCalled();
      expect(lk.removeParticipant).not.toHaveBeenCalled();
    });

    it("stays a no-op when only part of the config is present", async () => {
      process.env.LIVEKIT_URL = "wss://sfu.example.test";
      resetSfuAdminClient();

      await evictSfuUser("user-1", ["channel-1"], new Map());
      await settleSfuEvictions();

      expect(lk.listRooms).not.toHaveBeenCalled();
    });
  });

  describe("when LiveKit is configured", () => {
    beforeEach(configureLiveKit);

    it("hands LIVEKIT_URL to the admin client unchanged", async () => {
      await evictSfuRoom("channel-1");
      await settleSfuEvictions();

      expect(lk.hosts).toEqual(["wss://sfu.example.test"]);
    });

    it("evicts only the banned user, across the rooms it was scoped to", async () => {
      lk.listRooms.mockResolvedValue(rooms("voice-a", "voice-b"));
      lk.listParticipants.mockImplementation(async (room: string) =>
        room === "voice-a"
          ? [participant("peer-1", "banned"), participant("peer-2", "other")]
          : [participant("peer-3", "banned")],
      );

      await evictSfuUser("banned", ["voice-a", "voice-b", "text-c"], new Map());
      await settleSfuEvictions();

      // The whole channel list goes to LiveKit, which answers with the rooms
      // that actually exist — one call instead of one per channel.
      expect(lk.listRooms).toHaveBeenCalledWith([
        "voice-a",
        "voice-b",
        "text-c",
      ]);
      expect(removedIdentities().sort()).toEqual(["peer-1", "peer-3"]);
    });

    it("revokes the evicted token so the ejection is not just a disconnect", async () => {
      lk.listRooms.mockResolvedValue(rooms("voice-a"));
      lk.listParticipants.mockResolvedValue([participant("peer-1", "banned")]);
      const before = Math.floor(Date.now() / 1000);

      await evictSfuUser("banned", ["voice-a"], new Map());
      await settleSfuEvictions();

      const [room, identity, options] = lk.removeParticipant.mock.calls[0]!;
      expect(room).toBe("voice-a");
      expect(identity).toBe("peer-1");
      // Strictly after "now": the boundary is `nbf < ts` at one-second
      // resolution, so a token minted in the same second must still be voided.
      expect(options.revokeTokenTs).toBeGreaterThan(BigInt(before));
    });

    it("sweeps every room when the caller cannot scope the eviction", async () => {
      lk.listRooms.mockResolvedValue(rooms("voice-a"));
      lk.listParticipants.mockResolvedValue([participant("peer-1", "banned")]);

      await evictSfuUser("banned", null, new Map());
      await settleSfuEvictions();

      expect(lk.listRooms).toHaveBeenCalledWith(undefined);
      expect(removedIdentities()).toEqual(["peer-1"]);
    });

    it("does not widen an empty scope into every room", async () => {
      await evictSfuUser("banned", [], new Map());
      await settleSfuEvictions();

      expect(lk.listRooms).not.toHaveBeenCalled();
    });

    it("resolves a metadata-less participant from the local roster", async () => {
      lk.listRooms.mockResolvedValue(rooms("voice-a"));
      lk.listParticipants.mockResolvedValue([
        participant("legacy-peer"),
        participant("stranger-peer"),
      ]);

      await evictSfuUser(
        "banned",
        ["voice-a"],
        new Map([["legacy-peer", "banned"]]),
      );
      await settleSfuEvictions();

      // Fails open: the unidentifiable participant is left in the call rather
      // than a bystander being ejected from a room that is still theirs.
      expect(removedIdentities()).toEqual(["legacy-peer"]);
    });

    it("clears everyone when a channel goes away", async () => {
      lk.listParticipants.mockResolvedValue([
        participant("peer-1", "user-1"),
        participant("peer-2", "user-2"),
        participant("peer-3"),
      ]);

      await evictSfuRoom("voice-a");
      await settleSfuEvictions();

      expect(removedIdentities().sort()).toEqual([
        "peer-1",
        "peer-2",
        "peer-3",
      ]);
    });

    it("keeps the allowed users when a channel turns private, and fails closed", async () => {
      lk.listParticipants.mockResolvedValue([
        participant("peer-allowed", "user-1"),
        participant("peer-revoked", "user-2"),
        participant("peer-unknown"),
      ]);

      await evictSfuUsersExcept("voice-a", new Set(["user-1"]), new Map());
      await settleSfuEvictions();

      expect(removedIdentities().sort()).toEqual([
        "peer-revoked",
        "peer-unknown",
      ]);
    });

    describe("failure isolation", () => {
      it("does not reject when the room listing fails", async () => {
        lk.listRooms.mockRejectedValue(new Error("livekit unreachable"));

        await expect(
          evictSfuUser("banned", ["voice-a"], new Map()),
        ).resolves.toBeUndefined();
        await expect(settleSfuEvictions()).resolves.toBeUndefined();
      });

      it("does not reject when the participant listing fails", async () => {
        lk.listParticipants.mockRejectedValue(new Error("room not found"));

        await expect(evictSfuRoom("voice-a")).resolves.toBeUndefined();
        await expect(settleSfuEvictions()).resolves.toBeUndefined();
      });

      it("logs a loud, greppable line when a removal fails", async () => {
        const logged = vi.spyOn(console, "log").mockImplementation(() => {});
        lk.listParticipants.mockResolvedValue([participant("peer-1", "user-1")]);
        lk.removeParticipant.mockRejectedValue(new Error("boom"));

        await evictSfuRoom("voice-a");
        await settleSfuEvictions();

        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(
          lines.some(
            (line) =>
              line.startsWith("[pqp] voice.sfuEvictFailed") &&
              line.includes("peer-1") &&
              line.includes("boom"),
          ),
        ).toBe(true);
      });

      it("keeps evicting the rest of the room after one removal fails", async () => {
        lk.listParticipants.mockResolvedValue([
          participant("peer-1", "user-1"),
          participant("peer-2", "user-2"),
        ]);
        lk.removeParticipant.mockImplementation(
          async (_room: string, identity: string) => {
            if (identity === "peer-1") {
              throw new Error("boom");
            }
          },
        );

        await evictSfuRoom("voice-a");
        await settleSfuEvictions();

        expect(removedIdentities().sort()).toEqual(["peer-1", "peer-2"]);
      });
    });
  });
});
