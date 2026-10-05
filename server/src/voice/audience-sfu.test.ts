import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Audience mode's media half against fake LiveKit boxes, one per region:
 * `reconcileSfuRoomPublishGrants` (`voice/admin.ts`). What is pinned here:
 *
 * - only what is wrong is touched (a matching participant costs one compare);
 * - a revoke mutes the published mic first, then rewrites the permission;
 * - a participant nobody can name (an egress) is left alone;
 * - a failure is reported per person, and a box that does not answer is
 *   `unreachable`, so the host is shown it instead of a claim that it worked;
 * - the call goes to the room's pinned box (Miami, London), and a revoke's
 *   first pass (`wide`) asks every box, which is how a participant left on
 *   the box the room used to be on is still silenced.
 */
type Call = Mock<(...args: unknown[]) => Promise<unknown>>;

interface Box {
  listParticipants: Call;
  mutePublishedTrack: Call;
  updateParticipant: Call;
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
      listParticipants(...args: unknown[]) {
        return this.box.listParticipants(...args);
      }
      mutePublishedTrack(...args: unknown[]) {
        return this.box.mutePublishedTrack(...args);
      }
      updateParticipant(...args: unknown[]) {
        return this.box.updateParticipant(...args);
      }
    },
  };
});

const { reconcileSfuRoomPublishGrants, resetSfuAdminClient, stopSfuResweeps } = await import(
  "./admin.js"
);
const { participantMetadataFor } = await import("./backends.js");
const { pinRoomRegion, resetRoomRegions } = await import("./regions.js");
const { TrackSource, TrackType } = await import("livekit-server-sdk");

const HOME = "wss://sfu.example.test";
const MIA = "wss://sfu-mia.example.test";
const LHR = "wss://sfu-lhr.example.test";

function call(): Call {
  return vi.fn<(...args: unknown[]) => Promise<unknown>>();
}

function notFound(): Error {
  return Object.assign(new Error("requested room does not exist"), {
    status: 404,
    code: "not_found",
  });
}

function box(): Box {
  return {
    listParticipants: call().mockRejectedValue(notFound()),
    mutePublishedTrack: call().mockResolvedValue(undefined),
    updateParticipant: call().mockResolvedValue(undefined),
  };
}

/** A participant connected with the everyday grant (may publish anything). */
function talking(identity: string, userId: string | null) {
  return {
    identity,
    ...(userId ? { metadata: participantMetadataFor(userId) } : {}),
    permission: { canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: [] },
    tracks: [
      { sid: `MIC_${identity}`, type: TrackType.AUDIO, source: TrackSource.MICROPHONE, muted: false },
    ],
  };
}

/** A participant already silenced exactly as audience mode would. */
function silenced(identity: string, userId: string) {
  return {
    identity,
    metadata: participantMetadataFor(userId),
    permission: { canPublish: false, canSubscribe: true, canPublishData: false, canPublishSources: [] },
    tracks: [],
  };
}

const AUDIENCE = { canSpeak: false, canStream: false };
const STAGE = { canSpeak: true, canStream: true };

/** host runs the stage; everybody else is the audience. */
const grantFor = async (userId: string) => (userId === "host" ? STAGE : AUDIENCE);

function configure(regions: boolean) {
  process.env.LIVEKIT_URL = HOME;
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  if (regions) {
    process.env.LIVEKIT_REGIONS = `mia:${MIA},lhr:${LHR}`;
  } else {
    delete process.env.LIVEKIT_REGIONS;
  }
  resetSfuAdminClient();
  resetRoomRegions();
}

describe("reconcileSfuRoomPublishGrants", () => {
  beforeEach(() => {
    boxes.clear();
    boxes.set(HOME, box());
    boxes.set(MIA, box());
    boxes.set(LHR, box());
    delete process.env.SFU_REGION_SCOPED_CALLS;
    delete process.env.VOICE_REGISTRY;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stopSfuResweeps();
    for (const name of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_REGIONS"]) {
      delete process.env[name];
    }
    resetSfuAdminClient();
    resetRoomRegions();
    vi.restoreAllMocks();
  });

  it("does nothing, and says it skipped, without LiveKit", async () => {
    const result = await reconcileSfuRoomPublishGrants("room", grantFor, new Map());
    expect(result).toMatchObject({ skipped: true, checked: 0 });
  });

  describe("one box", () => {
    beforeEach(() => configure(false));

    it("silences the audience (mic muted first, then the permission), leaves the stage, the already-silenced and the unnamed alone", async () => {
      const home = boxes.get(HOME)!;
      home.listParticipants.mockResolvedValue([
        talking("peer-host", "host"),
        talking("peer-member", "member"),
        silenced("peer-quiet", "quiet"),
        talking("EG_egress", null),
      ]);

      const result = await reconcileSfuRoomPublishGrants("room", grantFor, new Map());

      expect(result).toEqual({
        checked: 3,
        updated: 1,
        failedUserIds: [],
        unreachable: false,
        skipped: false,
      });
      expect(home.mutePublishedTrack.mock.calls).toEqual([
        ["room", "peer-member", "MIC_peer-member", true],
      ]);
      expect(home.updateParticipant.mock.calls).toEqual([
        [
          "room",
          "peer-member",
          { permission: { canPublish: false, canSubscribe: true, canPublishData: false } },
        ],
      ]);
    });

    it("restores the everyday grant when audience mode goes off", async () => {
      const home = boxes.get(HOME)!;
      home.listParticipants.mockResolvedValue([silenced("peer-member", "member")]);
      const result = await reconcileSfuRoomPublishGrants(
        "room",
        async () => STAGE,
        new Map(),
      );
      expect(result.updated).toBe(1);
      expect(home.mutePublishedTrack).not.toHaveBeenCalled();
      expect(home.updateParticipant).toHaveBeenCalledWith("room", "peer-member", {
        permission: { canPublish: true, canSubscribe: true, canPublishData: false },
      });
    });

    it("an invited speaker gets the microphone source and nothing else", async () => {
      const home = boxes.get(HOME)!;
      home.listParticipants.mockResolvedValue([silenced("peer-member", "member")]);
      await reconcileSfuRoomPublishGrants(
        "room",
        async () => ({ canSpeak: true, canStream: false }),
        new Map(),
      );
      expect(home.updateParticipant).toHaveBeenCalledWith("room", "peer-member", {
        permission: {
          canPublish: true,
          canSubscribe: true,
          canPublishData: false,
          canPublishSources: [TrackSource.MICROPHONE],
        },
      });
    });

    it("names a participant from the identities it was given when the metadata has none", async () => {
      const home = boxes.get(HOME)!;
      home.listParticipants.mockResolvedValue([talking("peer-old", null)]);
      const result = await reconcileSfuRoomPublishGrants(
        "room",
        grantFor,
        new Map([["peer-old", "member"]]),
      );
      expect(result.updated).toBe(1);
    });

    it("reports a participant whose rewrite failed, and keeps going for the rest", async () => {
      const home = boxes.get(HOME)!;
      home.listParticipants.mockResolvedValue([
        talking("peer-a", "alice"),
        talking("peer-b", "bob"),
      ]);
      home.updateParticipant.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "peer-a") {
          throw new Error("twirp error unknown: connect ETIMEDOUT");
        }
      });
      const result = await reconcileSfuRoomPublishGrants("room", grantFor, new Map());
      expect(result.failedUserIds).toEqual(["alice"]);
      expect(result.updated).toBe(1);
      expect(result.unreachable).toBe(false);
      const lines = vi.mocked(console.log).mock.calls.map((entry) => String(entry[0]));
      expect(
        lines.some(
          (line) =>
            line.includes("voice.audienceMode.enforceFailed") &&
            line.includes("stage=update") &&
            line.includes("userId=alice"),
        ),
      ).toBe(true);
    });

    it("says the box is unreachable when it cannot even list the room", async () => {
      boxes
        .get(HOME)!
        .listParticipants.mockRejectedValue(new Error("connect ECONNREFUSED"));
      const result = await reconcileSfuRoomPublishGrants("room", grantFor, new Map());
      expect(result.unreachable).toBe(true);
      expect(result.failedUserIds).toEqual([]);
    });

    it("resolves each person once however many seats they hold", async () => {
      const home = boxes.get(HOME)!;
      home.listParticipants.mockResolvedValue([
        talking("peer-1", "member"),
        talking("peer-2", "member"),
      ]);
      const resolver = vi.fn(grantFor);
      await reconcileSfuRoomPublishGrants("room", resolver, new Map());
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(home.updateParticipant).toHaveBeenCalledTimes(2);
    });
  });

  describe("a room pinned to London", () => {
    beforeEach(() => {
      configure(true);
      pinRoomRegion("room-lhr", "lhr");
    });

    it("asks London alone for an ordinary pass", async () => {
      boxes.get(LHR)!.listParticipants.mockResolvedValue([talking("peer-member", "member")]);
      const result = await reconcileSfuRoomPublishGrants("room-lhr", grantFor, new Map());
      expect(result.updated).toBe(1);
      expect(boxes.get(LHR)!.updateParticipant).toHaveBeenCalledTimes(1);
      expect(boxes.get(HOME)!.listParticipants).not.toHaveBeenCalled();
      expect(boxes.get(MIA)!.listParticipants).not.toHaveBeenCalled();
    });

    it("a revoke's first pass asks every box, and silences somebody left on the old one", async () => {
      boxes.get(LHR)!.listParticipants.mockResolvedValue([talking("peer-member", "member")]);
      // A participant whose socket dropped, still on the box the room was on
      // before it was re-pinned.
      boxes.get(MIA)!.listParticipants.mockResolvedValue([talking("peer-ghost", "ghost")]);

      const result = await reconcileSfuRoomPublishGrants("room-lhr", grantFor, new Map(), {
        wide: true,
      });

      expect([HOME, MIA, LHR].map((host) => boxes.get(host)!.listParticipants.mock.calls.length))
        .toEqual([1, 1, 1]);
      expect(result.updated).toBe(2);
      expect(boxes.get(MIA)!.updateParticipant).toHaveBeenCalledWith(
        "room-lhr",
        "peer-ghost",
        expect.objectContaining({ permission: expect.objectContaining({ canPublish: false }) }),
      );
    });

    it("a box the room is not known to be on failing is not 'unreachable'; London failing is", async () => {
      boxes.get(LHR)!.listParticipants.mockResolvedValue([]);
      boxes.get(MIA)!.listParticipants.mockRejectedValue(new Error("connect ETIMEDOUT"));
      const wide = await reconcileSfuRoomPublishGrants("room-lhr", grantFor, new Map(), {
        wide: true,
      });
      expect(wide.unreachable).toBe(false);

      boxes.get(LHR)!.listParticipants.mockRejectedValue(new Error("connect ETIMEDOUT"));
      const pinned = await reconcileSfuRoomPublishGrants("room-lhr", grantFor, new Map());
      expect(pinned.unreachable).toBe(true);
    });
  });
});
