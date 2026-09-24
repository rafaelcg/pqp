import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Moderation with more than one SFU box.
 *
 * A banned account's LiveKit connection outlives its WebSocket, and so the
 * process's region pin, so moderation cannot ask "which box is this room on"
 * and trust the answer. It asks every box, and only the box that holds the
 * participant is told to remove or mute them. These tests give each box its
 * own fake so that "which box was called" is the assertion.
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
  listSfuRooms,
  pingSfuRegion,
  resetSfuAdminClient,
  setSfuUserMuted,
  settleSfuEvictions,
  stopSfuResweeps,
} = await import("./admin.js");
const { participantMetadataFor } = await import("./backends.js");
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

describe("SFU moderation across regions", () => {
  beforeEach(() => {
    boxes.clear();
    boxes.set(HOME, box());
    boxes.set(MIA, box());
    process.env.LIVEKIT_URL = HOME;
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = `mia:${MIA}`;
    resetSfuAdminClient();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stopSfuResweeps();
    for (const name of [
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "LIVEKIT_REGIONS",
    ]) {
      delete process.env[name];
    }
    resetSfuAdminClient();
    vi.restoreAllMocks();
  });

  it("finds a banned user on the box that holds them, and removes them there only", async () => {
    boxes.get(HOME)!.listRooms.mockResolvedValue([]);
    boxes.get(MIA)!.listRooms.mockResolvedValue([{ name: "channel-1" }]);
    boxes.get(MIA)!.listParticipants.mockResolvedValue([
      { identity: "peer-bad", metadata: participantMetadataFor("user-bad") },
      { identity: "peer-ok", metadata: participantMetadataFor("user-ok") },
    ]);

    await evictSfuUser("user-bad", ["channel-1"], new Map());
    await settleSfuEvictions();

    expect(boxes.get(HOME)!.listRooms).toHaveBeenCalled();
    expect(boxes.get(MIA)!.listRooms).toHaveBeenCalled();
    expect(boxes.get(MIA)!.removeParticipant).toHaveBeenCalledTimes(1);
    expect(boxes.get(MIA)!.removeParticipant.mock.calls[0]![1]).toBe("peer-bad");
    expect(boxes.get(HOME)!.removeParticipant).not.toHaveBeenCalled();
  });

  it("empties a deleted channel's room wherever it is, and not-found elsewhere is not an error", async () => {
    boxes.get(MIA)!.listParticipants.mockResolvedValue([
      { identity: "peer-1", metadata: participantMetadataFor("user-1") },
    ]);

    await evictSfuRoom("channel-1");
    await settleSfuEvictions();

    expect(boxes.get(MIA)!.removeParticipant).toHaveBeenCalledTimes(1);
    expect(boxes.get(HOME)!.removeParticipant).not.toHaveBeenCalled();
    const failures = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("voice.sfuEvictFailed"));
    expect(failures).toEqual([]);
  });

  it("server-mutes on the box that holds the participant", async () => {
    boxes.get(MIA)!.listParticipants.mockResolvedValue([
      {
        identity: "peer-1",
        metadata: participantMetadataFor("user-1"),
        tracks: [{ sid: "TR_audio", type: TrackType.AUDIO }],
      },
    ]);

    const changed = await setSfuUserMuted("channel-1", "user-1", true, new Map());

    expect(changed).toBe(true);
    expect(boxes.get(MIA)!.mutePublishedTrack).toHaveBeenCalledWith(
      "channel-1",
      "peer-1",
      "TR_audio",
      true,
    );
    expect(boxes.get(HOME)!.mutePublishedTrack).not.toHaveBeenCalled();
  });

  it("an empty answer is not trusted while another box could not be asked", async () => {
    boxes.get(HOME)!.listParticipants.mockResolvedValue([]);
    boxes.get(MIA)!.listParticipants.mockRejectedValue(new Error("connect ETIMEDOUT"));

    await evictSfuRoom("channel-1");
    await settleSfuEvictions();

    const lines = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (entry) => String(entry[0]),
    );
    expect(lines.some((line) => line.includes("voice.sfuRegionCallFailed"))).toBe(true);
    expect(lines.some((line) => line.includes("voice.sfuEvictFailed"))).toBe(true);
  });

  it("still reports a failure when no box answers at all", async () => {
    const changed = await setSfuUserMuted("channel-1", "user-1", true, new Map());
    expect(changed).toBe(false);
  });

  it("keeps the dashboard's home reading on the home box, and probes a region by id", async () => {
    boxes.get(HOME)!.listRooms.mockResolvedValue([{ name: "a" }]);
    boxes.get(MIA)!.listRooms.mockResolvedValue([{ name: "b" }, { name: "c" }]);

    expect(await listSfuRooms()).toEqual([{ name: "a" }]);
    await expect(pingSfuRegion("mia")).resolves.toBeUndefined();
    await expect(pingSfuRegion("lon")).rejects.toThrow("not configured");
  });
});
