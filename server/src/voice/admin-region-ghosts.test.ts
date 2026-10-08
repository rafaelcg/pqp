import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
        this.box = boxes.get(host)!;
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
  evictSfuUser,
  evictSfuUsersExcept,
  resetSfuAdminClient,
  settleSfuEvictions,
  stopSfuResweeps,
} = await import("./admin.js");
const { participantMetadataFor } = await import("./backends.js");
const { pinRoomRegion, resetRoomRegions } = await import("./regions.js");

const call = (): Call => vi.fn<(...args: unknown[]) => Promise<unknown>>();
const notFound = () =>
  Object.assign(new Error("requested room does not exist"), { status: 404, code: "not_found" });
const box = (): Box => ({
  listRooms: call().mockResolvedValue([]),
  listParticipants: call().mockRejectedValue(notFound()),
  removeParticipant: call().mockResolvedValue(undefined),
  mutePublishedTrack: call().mockResolvedValue(undefined),
});
const HOME = "wss://sfu.example.test";
const MIA = "wss://sfu-mia.example.test";
const LHR = "wss://sfu-lhr.example.test";

describe("REVIEW repro: participant on a box other than the room's current pin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    boxes.clear();
    boxes.set(HOME, box());
    boxes.set(MIA, box());
    boxes.set(LHR, box());
    process.env.LIVEKIT_URL = HOME;
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = `mia:${MIA},lhr:${LHR}`;
    delete process.env.VOICE_REGISTRY;
    resetSfuAdminClient();
    resetRoomRegions();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    stopSfuResweeps();
    delete process.env.SFU_REGION_SCOPED_CALLS;
    resetSfuAdminClient();
    resetRoomRegions();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const flag of ["on", "off"]) {
    it(`[flag ${flag}] scoped ban reaches a ghost on Miami while the room is pinned to Sao Paulo`, async () => {
      process.env.SFU_REGION_SCOPED_CALLS = flag;
      pinRoomRegion("room-r", "sao");
      boxes.get(HOME)!.listRooms.mockResolvedValue([{ name: "room-r" }]);
      boxes.get(HOME)!.listParticipants.mockResolvedValue([
        { identity: "peer-bob", metadata: participantMetadataFor("bob"), tracks: [] },
      ]);
      boxes.get(MIA)!.listRooms.mockResolvedValue([{ name: "room-r" }]);
      boxes.get(MIA)!.listParticipants.mockResolvedValue([
        { identity: "peer-mal", metadata: participantMetadataFor("mallory"), tracks: [] },
      ]);

      await evictSfuUser("mallory", ["room-r"], new Map());
      await settleSfuEvictions();

      expect(boxes.get(MIA)!.removeParticipant).toHaveBeenCalledWith(
        "room-r",
        "peer-mal",
        expect.anything(),
      );
    });

    it(`[flag ${flag}] private re-sweep follows a re-pin to the box a stale token points at`, async () => {
      process.env.SFU_REGION_SCOPED_CALLS = flag;
      const evictedAt = Math.floor(Date.now() / 1000);
      await evictSfuUsersExcept("room-p", new Set(["keeper"]), new Map(), "sao");
      await settleSfuEvictions();
      pinRoomRegion("room-p", "mia");
      boxes.get(MIA)!.listParticipants.mockResolvedValue([
        { identity: "peer-mal", metadata: participantMetadataFor("mallory", evictedAt - 60), tracks: [] },
        { identity: "peer-keep", metadata: participantMetadataFor("keeper"), tracks: [] },
      ]);
      await vi.advanceTimersByTimeAsync(5000 * 3);
      await settleSfuEvictions();
      expect(boxes.get(MIA)!.removeParticipant).toHaveBeenCalledWith(
        "room-p",
        "peer-mal",
        expect.anything(),
      );
    });
  }
});
