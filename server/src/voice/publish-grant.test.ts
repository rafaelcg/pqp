import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live half of SPEAK on the SFU: a participant who is already connected
 * when the permission changes. Same boundary as mute.test.ts, one call deep
 * (the `RoomServiceClient` RPCs); targeting and the failure contract run for
 * real.
 */
const lk = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  mutePublishedTrack: vi.fn(),
  updateParticipant: vi.fn(),
}));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      listParticipants = lk.listParticipants;
      mutePublishedTrack = lk.mutePublishedTrack;
      updateParticipant = lk.updateParticipant;
    },
  };
});

const { resetSfuAdminClient, setSfuUserCanPublish } = await import("./admin.js");
const { participantMetadataFor } = await import("./backends.js");
const { TrackType } = await import("livekit-server-sdk");

const ROOM = "channel-1";

function participant(
  identity: string,
  userId: string | null,
  tracks: Array<{ sid: string; type: number }>,
) {
  return {
    identity,
    ...(userId ? { metadata: participantMetadataFor(userId) } : {}),
    tracks,
  };
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

describe("SFU publish grant (live SPEAK change)", () => {
  beforeEach(() => {
    lk.listParticipants.mockReset().mockResolvedValue([]);
    lk.mutePublishedTrack.mockReset().mockResolvedValue(undefined);
    lk.updateParticipant.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    configureLiveKit();
  });

  afterEach(() => {
    unconfigureLiveKit();
    vi.restoreAllMocks();
  });

  it("is a no-op, not a crash, when LiveKit is not configured", async () => {
    unconfigureLiveKit();
    await expect(
      setSfuUserCanPublish(ROOM, "user-1", false, new Map()),
    ).resolves.toBe(false);
    expect(lk.listParticipants).not.toHaveBeenCalled();
  });

  it("revoking mutes every published track, then rewrites the permission, for the target only", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("peer-target", "user-1", [
        { sid: "TR_mic", type: TrackType.AUDIO },
        { sid: "TR_screen", type: TrackType.VIDEO },
      ]),
      participant("peer-bystander", "user-2", [
        { sid: "TR_other_mic", type: TrackType.AUDIO },
      ]),
    ]);

    await expect(
      setSfuUserCanPublish(ROOM, "user-1", false, new Map()),
    ).resolves.toBe(true);

    // Audio AND video: a presenter who lost SPEAK stops presenting.
    expect(lk.mutePublishedTrack.mock.calls).toEqual([
      [ROOM, "peer-target", "TR_mic", true],
      [ROOM, "peer-target", "TR_screen", true],
    ]);
    // The whole permission set is stated: partial means "the rest false".
    expect(lk.updateParticipant).toHaveBeenCalledTimes(1);
    expect(lk.updateParticipant).toHaveBeenCalledWith(ROOM, "peer-target", {
      permission: {
        canPublish: false,
        canSubscribe: true,
        canPublishData: false,
      },
    });
  });

  it("granting rewrites the permission without touching tracks", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("peer-target", "user-1", []),
    ]);

    await expect(
      setSfuUserCanPublish(ROOM, "user-1", true, new Map()),
    ).resolves.toBe(true);

    expect(lk.mutePublishedTrack).not.toHaveBeenCalled();
    expect(lk.updateParticipant).toHaveBeenCalledWith(ROOM, "peer-target", {
      permission: {
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
      },
    });
  });

  it("identifies a participant without metadata through the known peer map, and fails open otherwise", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("peer-old", null, [{ sid: "TR_a", type: TrackType.AUDIO }]),
      participant("peer-unknown", null, [{ sid: "TR_b", type: TrackType.AUDIO }]),
    ]);

    await expect(
      setSfuUserCanPublish(
        ROOM,
        "user-1",
        false,
        new Map([["peer-old", "user-1"]]),
      ),
    ).resolves.toBe(true);

    expect(lk.updateParticipant).toHaveBeenCalledTimes(1);
    expect(lk.updateParticipant.mock.calls[0]![1]).toBe("peer-old");
  });

  it("reports failure instead of rejecting when the SFU is unreachable", async () => {
    lk.listParticipants.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(
      setSfuUserCanPublish(ROOM, "user-1", false, new Map()),
    ).resolves.toBe(false);
  });
});
