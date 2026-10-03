import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * SFU moderation routes each call to the box a room lives on, and a sick
 * remote box can no longer decide how long moderation takes.
 *
 * Production, 2026-09-24..10-03: 872 timeouts, every one against London or
 * Miami, none against Sao Paulo, for rooms that were in Sao Paulo, because
 * every call asked every box and waited for the slowest. These tests give each
 * box its own fake and a clock, so "which box was called" and "how long did
 * the caller wait" are the assertions. `admin-regions.test.ts` keeps the
 * unknown-room behaviour (ask every box) pinned.
 */
type Call = Mock<(...args: unknown[]) => Promise<unknown>>;

interface Box {
  listRooms: Call;
  listParticipants: Call;
  removeParticipant: Call;
  mutePublishedTrack: Call;
}

const boxes = vi.hoisted(() => new Map<string, Box>());

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      private readonly box: Box;
      constructor(host: string) {
        const box = boxes.get(host);
        if (!box) {
          throw new Error(`no fake for ${host}`);
        }
        this.box = box;
      }
      listRooms(...args: unknown[]) {
        return this.box.listRooms(...args);
      }
      listParticipants(...args: unknown[]) {
        return this.box.listParticipants(...args);
      }
      removeParticipant(...args: unknown[]) {
        return this.box.removeParticipant(...args);
      }
      mutePublishedTrack(...args: unknown[]) {
        return this.box.mutePublishedTrack(...args);
      }
    },
  };
});

const {
  evictSfuRoom,
  evictSfuUser,
  evictSfuUsersExcept,
  resetSfuAdminClient,
  setSfuUserMuted,
  settleSfuEvictions,
  stopSfuResweeps,
} = await import("./admin.js");
const { participantMetadataFor } = await import("./backends.js");
const { pinRoomRegion, resetRoomRegions } = await import("./regions.js");
const { BUDGET_PRIOR_MS, CIRCUIT_COOLDOWN_MS, CIRCUIT_FAILURES, sfuControlPlaneReport } =
  await import("./sfu-control-plane.js");
const { TrackType } = await import("livekit-server-sdk");

function call(): Call {
  return vi.fn<(...args: unknown[]) => Promise<unknown>>();
}

function notFound(): Error {
  return Object.assign(new Error("requested room does not exist"), {
    status: 404,
    code: "not_found",
  });
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })),
      ms,
    ),
  );
}

function box(): Box {
  return {
    listRooms: call().mockResolvedValue([]),
    listParticipants: call().mockRejectedValue(notFound()),
    removeParticipant: call().mockResolvedValue(undefined),
    mutePublishedTrack: call().mockResolvedValue(undefined),
  };
}

const HOME = "wss://sfu.example.test";
const MIA = "wss://sfu-mia.example.test";
const LHR = "wss://sfu-lhr.example.test";

function audioParticipant(identity: string, userId: string) {
  return {
    identity,
    metadata: participantMetadataFor(userId),
    tracks: [{ sid: `TR_${identity}`, type: TrackType.AUDIO }],
  };
}

function logLines(): string[] {
  return (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((entry) =>
    String(entry[0]),
  );
}

describe("SFU moderation scoped to a room's region", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Second 6 of a half minute: outside the window in which a repeat also
    // looks at the boxes a room is not known to be on (`widePassNow`).
    vi.setSystemTime(new Date("2026-10-03T12:00:06Z"));
    boxes.clear();
    boxes.set(HOME, box());
    boxes.set(MIA, box());
    boxes.set(LHR, box());
    process.env.LIVEKIT_URL = HOME;
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = `mia:${MIA},lhr:${LHR}`;
    delete process.env.SFU_REGION_SCOPED_CALLS;
    delete process.env.VOICE_REGISTRY;
    resetSfuAdminClient();
    resetRoomRegions();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stopSfuResweeps();
    for (const name of [
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "LIVEKIT_REGIONS",
      "SFU_REGION_SCOPED_CALLS",
    ]) {
      delete process.env[name];
    }
    resetSfuAdminClient();
    resetRoomRegions();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("a room known to live in Sao Paulo", () => {
    it("never touches Miami or London, so a dead region cannot delay it", async () => {
      pinRoomRegion("room-sao", "sao");
      boxes.get(HOME)!.listParticipants.mockResolvedValue([audioParticipant("peer-1", "user-1")]);
      // Both remote boxes hang for the SDK's whole window.
      boxes.get(MIA)!.listParticipants.mockImplementation(() => timeoutAfter(5000));
      boxes.get(LHR)!.listParticipants.mockImplementation(() => timeoutAfter(5000));

      const startedAt = Date.now();
      const changed = await setSfuUserMuted("room-sao", "user-1", true, new Map());

      expect(changed).toBe(true);
      // Resolved without advancing the clock at all.
      expect(Date.now() - startedAt).toBe(0);
      expect(boxes.get(MIA)!.listParticipants).not.toHaveBeenCalled();
      expect(boxes.get(LHR)!.listParticipants).not.toHaveBeenCalled();
      expect(boxes.get(HOME)!.mutePublishedTrack).toHaveBeenCalledWith("room-sao", "peer-1", "TR_peer-1", true);
      expect(logLines().filter((line) => line.includes("voice.sfuRegionCallFailed"))).toEqual([]);
    });

    /**
     * A known pin says where the room is NOW, not where somebody holding a
     * pre-eviction token still is (a ghost on the box the room used to be on),
     * so an eviction looks at every box once, and its repeats only look at
     * the other boxes in a five-second window every half minute. These are
     * the volume the 872 timeouts came from, which is why the repeats stay
     * scoped.
     */
    it("looks at every box on the first pass, and its repeats stay on Sao Paulo outside the wide window", async () => {
      pinRoomRegion("room-sao", "sao");
      boxes.get(HOME)!.listParticipants.mockResolvedValue([
        { identity: "peer-1", metadata: participantMetadataFor("user-1") },
      ]);

      await evictSfuRoom("room-sao");
      expect([HOME, MIA, LHR].map((host) => boxes.get(host)!.listParticipants.mock.calls.length)).toEqual([1, 1, 1]);

      // :06 to :26: repeats at :11, :16, :21, :26.
      await vi.advanceTimersByTimeAsync(5000 * 4);
      await settleSfuEvictions();
      expect(boxes.get(HOME)!.listParticipants.mock.calls.length).toBe(5);
      expect(boxes.get(MIA)!.listParticipants.mock.calls.length).toBe(1);
      expect(boxes.get(LHR)!.listParticipants.mock.calls.length).toBe(1);

      // The repeat that lands in :30 to :35 looks everywhere again.
      await vi.advanceTimersByTimeAsync(5000 + 1000);
      await settleSfuEvictions();
      expect(boxes.get(MIA)!.listParticipants.mock.calls.length).toBe(2);
      expect(boxes.get(LHR)!.listParticipants.mock.calls.length).toBe(2);
    });

    it("asks the hinted box on every pass and every box on the first, when the pin is already gone", async () => {
      // The caller read the pin before the last peer left; by now the map has forgotten it.
      boxes.get(HOME)!.listParticipants.mockResolvedValue([]);

      await evictSfuRoom("room-gone", "sao");
      expect(boxes.get(MIA)!.listParticipants).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000 * 3);
      await settleSfuEvictions();

      expect(boxes.get(HOME)!.listParticipants.mock.calls.length).toBe(4);
      expect(boxes.get(MIA)!.listParticipants).toHaveBeenCalledTimes(1);
      expect(boxes.get(LHR)!.listParticipants).toHaveBeenCalledTimes(1);
    });

    it("carries the hint through a channel-private sweep, and looks everywhere on its first pass", async () => {
      await evictSfuUsersExcept("room-gone", new Set(["user-ok"]), new Map(), "sao");
      await settleSfuEvictions();
      expect(boxes.get(HOME)!.listParticipants).toHaveBeenCalledTimes(1);
      expect(boxes.get(MIA)!.listParticipants).toHaveBeenCalledTimes(1);
    });

    it("lists a user's rooms on every box on the first pass, and on Sao Paulo alone in the repeats", async () => {
      pinRoomRegion("room-a", "sao");
      pinRoomRegion("room-b", "sao");

      void evictSfuUser("user-1", ["room-a", "room-b"], new Map());
      await vi.advanceTimersByTimeAsync(0);
      expect(boxes.get(HOME)!.listRooms).toHaveBeenCalledWith(["room-a", "room-b"]);
      expect(boxes.get(MIA)!.listRooms).toHaveBeenCalledTimes(1);
      expect(boxes.get(LHR)!.listRooms).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000 * 4);
      await settleSfuEvictions();
      expect(boxes.get(HOME)!.listRooms.mock.calls.length).toBe(5);
      expect(boxes.get(MIA)!.listRooms).toHaveBeenCalledTimes(1);
      expect(boxes.get(LHR)!.listRooms).toHaveBeenCalledTimes(1);
    });

    it("does not let a remote box hold up the first pass's work on Sao Paulo", async () => {
      pinRoomRegion("room-sao", "sao");
      boxes.get(HOME)!.listParticipants.mockResolvedValue([
        { identity: "peer-1", metadata: participantMetadataFor("user-1") },
      ]);
      boxes.get(MIA)!.listParticipants.mockImplementation(() => timeoutAfter(5000));

      const pending = evictSfuRoom("room-sao");
      await vi.advanceTimersByTimeAsync(0);
      expect(boxes.get(HOME)!.removeParticipant).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
    });
  });

  describe("a room known to live elsewhere", () => {
    it("goes to that box alone, with the box's own full timeout", async () => {
      pinRoomRegion("room-mia", "mia");
      boxes.get(MIA)!.listParticipants.mockResolvedValue([audioParticipant("peer-1", "user-1")]);

      const changed = await setSfuUserMuted("room-mia", "user-1", true, new Map());

      expect(changed).toBe(true);
      expect(boxes.get(HOME)!.listParticipants).not.toHaveBeenCalled();
      expect(boxes.get(LHR)!.listParticipants).not.toHaveBeenCalled();
      expect(boxes.get(MIA)!.mutePublishedTrack).toHaveBeenCalledTimes(1);
    });

    it("is not cut short or skipped for being slow: that box is the only place the person can be", async () => {
      pinRoomRegion("room-mia", "mia");
      boxes.get(MIA)!.listParticipants.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 4500));
        return [audioParticipant("peer-1", "user-1")];
      });

      const pending = setSfuUserMuted("room-mia", "user-1", true, new Map());
      await vi.advanceTimersByTimeAsync(4500);
      await expect(pending).resolves.toBe(true);
    });

    it("still reports the failure when the one box it asked cannot answer", async () => {
      pinRoomRegion("room-mia", "mia");
      boxes.get(MIA)!.listParticipants.mockRejectedValue(new Error("connect ETIMEDOUT"));

      await expect(setSfuUserMuted("room-mia", "user-1", true, new Map())).resolves.toBe(false);
      expect(logLines().some((line) => line.includes("voice.sfuMuteFailed") && line.includes("region=mia"))).toBe(true);
    });

    it("reads a room pinned to a region the deployment no longer runs as home", async () => {
      pinRoomRegion("room-old", "syd");
      boxes.get(HOME)!.listParticipants.mockResolvedValue([audioParticipant("peer-1", "user-1")]);

      await expect(setSfuUserMuted("room-old", "user-1", true, new Map())).resolves.toBe(true);
      expect(boxes.get(MIA)!.listParticipants).not.toHaveBeenCalled();
    });
  });

  describe("a room whose region is not known", () => {
    it("asks every box in parallel, lands the home mute at once, and a moderator's mute waits for the SDK window and no less", async () => {
      boxes.get(HOME)!.listParticipants.mockResolvedValue([audioParticipant("peer-1", "user-1")]);
      boxes.get(MIA)!.listParticipants.mockImplementation(() => timeoutAfter(5000));
      boxes.get(LHR)!.listParticipants.mockImplementation(() => timeoutAfter(5000));

      const pending = setSfuUserMuted("room-unknown", "user-1", true, new Map());
      await vi.advanceTimersByTimeAsync(0);
      // The home mute landed before either remote box answered.
      expect(boxes.get(HOME)!.mutePublishedTrack).toHaveBeenCalledTimes(1);

      // A one-shot has no budget: cutting it short would be a mute not applied.
      await vi.advanceTimersByTimeAsync(BUDGET_PRIOR_MS);
      expect(boxes.get(MIA)!.listParticipants).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000 - BUDGET_PRIOR_MS);
      await expect(pending).resolves.toBe(true);
      const failures = logLines().filter((line) => line.includes("voice.sfuRegionCallFailed"));
      expect(failures.length).toBe(2);
      expect(failures.every((line) => line.includes("errorClass=timeout") && line.includes("mode=oneshot"))).toBe(true);
    });

    it("lets the home box's removal land at once while a remote box is still being waited on", async () => {
      boxes.get(HOME)!.listRooms.mockResolvedValue([{ name: "room-1" }]);
      boxes.get(HOME)!.listParticipants.mockResolvedValue([
        { identity: "peer-1", metadata: participantMetadataFor("user-1") },
      ]);
      boxes.get(MIA)!.listRooms.mockImplementation(() => timeoutAfter(5000));
      boxes.get(LHR)!.listRooms.mockImplementation(() => timeoutAfter(5000));

      const pending = evictSfuUser("user-1", null, new Map());
      await vi.advanceTimersByTimeAsync(0);

      expect(boxes.get(HOME)!.removeParticipant).toHaveBeenCalledTimes(1);
      expect(boxes.get(MIA)!.listRooms).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
    });

    describe("the repeats of a sweep (the volume the 872 timeouts came from)", () => {
      /** Start an eviction of an unknown room whose Miami box always times out after `ms`. */
      async function sickMiami(ms: number) {
        boxes.get(MIA)!.listParticipants.mockImplementation(() => timeoutAfter(ms));
        boxes.get(LHR)!.listParticipants.mockRejectedValue(notFound());
        void evictSfuRoom("room-unknown");
        await vi.advanceTimersByTimeAsync(0);
      }

      it("cuts a repeat off at the budget, well before the SDK's timeout", async () => {
        await sickMiami(5000);
        // The first pass (a one-shot) times out at 5 s; the repeat that starts then is budgeted.
        await vi.advanceTimersByTimeAsync(5000);
        expect(sfuControlPlaneReport(["mia"]).mia!.failuresByClass).toEqual({ timeout: 1 });
        await vi.advanceTimersByTimeAsync(BUDGET_PRIOR_MS);
        expect(sfuControlPlaneReport(["mia"]).mia!.failuresByClass).toEqual({
          timeout: 1,
          budget: 1,
        });
        expect(BUDGET_PRIOR_MS).toBeLessThan(5000);
        // One line per region per ten seconds: the first says what it was, the budget one is counted.
        const lines = logLines().filter((line) => line.includes("voice.sfuRegionCallFailed"));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("caller=sweep-room");
        expect(lines[0]).toContain("mode=oneshot");
        expect(lines[0]).toContain("errorClass=timeout");
      });

      it("stops asking a region that keeps failing, says so, and asks again after the cooldown", async () => {
        await sickMiami(100);
        // First pass at t=0, repeats at 5 s and 10 s: three consecutive failures.
        await vi.advanceTimersByTimeAsync(10_100);
        expect(boxes.get(MIA)!.listParticipants).toHaveBeenCalledTimes(CIRCUIT_FAILURES);
        expect(sfuControlPlaneReport(["mia"]).mia!.circuitOpen).toBe(true);

        // The next repeats are skipped: Miami is not called, Sao Paulo and London are.
        // (15 s, so the one-line-per-ten-seconds window has passed for the report.)
        await vi.advanceTimersByTimeAsync(15_000);
        expect(boxes.get(MIA)!.listParticipants).toHaveBeenCalledTimes(CIRCUIT_FAILURES);
        expect(boxes.get(HOME)!.listParticipants.mock.calls.length).toBeGreaterThan(CIRCUIT_FAILURES);
        expect(logLines().some((line) => line.includes("voice.sfuRegionPartial") && line.includes("skipped=mia"))).toBe(true);
        expect(logLines().some((line) => line.includes("voice.sfuRegionCircuit") && line.includes("state=open"))).toBe(true);
        expect(sfuControlPlaneReport(["mia"]).mia!.skippedByCircuit).toBeGreaterThan(0);

        // After the cooldown one probe goes out, and a healthy answer closes the circuit.
        boxes.get(MIA)!.listParticipants.mockRejectedValue(notFound());
        await vi.advanceTimersByTimeAsync(CIRCUIT_COOLDOWN_MS);
        expect(boxes.get(MIA)!.listParticipants.mock.calls.length).toBeGreaterThan(CIRCUIT_FAILURES);
        expect(sfuControlPlaneReport(["mia"]).mia!.circuitOpen).toBe(false);
      });

      it("does not skip the first pass of an eviction, or a moderator's mute, for a region whose circuit is open", async () => {
        await sickMiami(100);
        await vi.advanceTimersByTimeAsync(10_100);
        expect(sfuControlPlaneReport(["mia"]).mia!.circuitOpen).toBe(true);
        const before = boxes.get(MIA)!.listParticipants.mock.calls.length;

        // The person is on Miami, in a room nobody has a pin for.
        boxes.get(MIA)!.listParticipants.mockResolvedValue([audioParticipant("peer-1", "user-1")]);
        await expect(setSfuUserMuted("room-other", "user-1", true, new Map())).resolves.toBe(true);
        expect(boxes.get(MIA)!.mutePublishedTrack).toHaveBeenCalledTimes(1);

        boxes.get(MIA)!.listParticipants.mockResolvedValue([
          { identity: "peer-2", metadata: participantMetadataFor("user-2") },
        ]);
        void evictSfuRoom("room-another");
        await vi.advanceTimersByTimeAsync(0);
        await settleSfuEvictions();
        expect(boxes.get(MIA)!.removeParticipant).toHaveBeenCalledTimes(1);
        expect(boxes.get(MIA)!.listParticipants.mock.calls.length).toBeGreaterThanOrEqual(before + 2);
      });
    });
  });

  describe("with the runtime flag off", () => {
    it("is the old behaviour: every box is asked about a Sao Paulo room and the slowest sets the pace", async () => {
      process.env.SFU_REGION_SCOPED_CALLS = "off";
      pinRoomRegion("room-sao", "sao");
      boxes.get(HOME)!.listParticipants.mockResolvedValue([audioParticipant("peer-1", "user-1")]);
      boxes.get(MIA)!.listParticipants.mockImplementation(() => timeoutAfter(4900));
      boxes.get(LHR)!.listParticipants.mockRejectedValue(notFound());

      const startedAt = Date.now();
      const pending = setSfuUserMuted("room-sao", "user-1", true, new Map());
      await vi.advanceTimersByTimeAsync(4900);
      await expect(pending).resolves.toBe(true);

      expect(Date.now() - startedAt).toBe(4900);
      expect(boxes.get(MIA)!.listParticipants).toHaveBeenCalled();
      expect(boxes.get(LHR)!.listParticipants).toHaveBeenCalled();
    });
  });
});
