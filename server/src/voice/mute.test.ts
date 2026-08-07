import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SFU server mute — the only real server-side mute this product has. Like
 * admin.test.ts, the mocked boundary is exactly one call deep (the
 * `RoomServiceClient` RPCs); participant selection, track filtering and the
 * failure contract are genuinely executed.
 */
const lk = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  mutePublishedTrack: vi.fn(),
}));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      listParticipants = lk.listParticipants;
      mutePublishedTrack = lk.mutePublishedTrack;
    },
  };
});

const { resetSfuAdminClient, setSfuUserMuted } = await import("./admin.js");
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

describe("SFU server mute", () => {
  beforeEach(() => {
    lk.listParticipants.mockReset().mockResolvedValue([]);
    lk.mutePublishedTrack.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    configureLiveKit();
  });

  afterEach(() => {
    unconfigureLiveKit();
    vi.restoreAllMocks();
  });

  it("is a refusal, not a crash, when LiveKit is not configured", async () => {
    unconfigureLiveKit();
    await expect(setSfuUserMuted(ROOM, "user-1", true, new Map())).resolves.toBe(
      false,
    );
    expect(lk.listParticipants).not.toHaveBeenCalled();
  });

  it("mutes every audio track of the target and nothing of anyone else", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("peer-target", "user-1", [
        { sid: "TR_mic", type: TrackType.AUDIO },
        { sid: "TR_screen_video", type: TrackType.VIDEO },
        { sid: "TR_screen_audio", type: TrackType.AUDIO },
      ]),
      participant("peer-bystander", "user-2", [
        { sid: "TR_other_mic", type: TrackType.AUDIO },
      ]),
    ]);

    await expect(setSfuUserMuted(ROOM, "user-1", true, new Map())).resolves.toBe(
      true,
    );

    const muted = lk.mutePublishedTrack.mock.calls.map((call) => call[2]);
    expect(muted.sort()).toEqual(["TR_mic", "TR_screen_audio"]);
    // Video is never touched: this is a mute, not a blackout.
    expect(muted).not.toContain("TR_screen_video");
    for (const call of lk.mutePublishedTrack.mock.calls) {
      expect(call[0]).toBe(ROOM);
      expect(call[1]).toBe("peer-target");
      expect(call[3]).toBe(true);
    }
  });

  it("unmutes with the same selection when muted=false", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("peer-target", "user-1", [
        { sid: "TR_mic", type: TrackType.AUDIO },
      ]),
    ]);

    await expect(
      setSfuUserMuted(ROOM, "user-1", false, new Map()),
    ).resolves.toBe(true);
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith(
      ROOM,
      "peer-target",
      "TR_mic",
      false,
    );
  });

  it("resolves identity from the local roster when metadata predates it", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("legacy-peer", null, [
        { sid: "TR_mic", type: TrackType.AUDIO },
      ]),
    ]);

    await expect(
      setSfuUserMuted(ROOM, "user-1", true, new Map([["legacy-peer", "user-1"]])),
    ).resolves.toBe(true);
    expect(lk.mutePublishedTrack).toHaveBeenCalledWith(
      ROOM,
      "legacy-peer",
      "TR_mic",
      true,
    );
  });

  it("fails open on an unidentifiable participant — never mutes a bystander", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("mystery-peer", null, [
        { sid: "TR_mic", type: TrackType.AUDIO },
      ]),
    ]);

    await expect(setSfuUserMuted(ROOM, "user-1", true, new Map())).resolves.toBe(
      false,
    );
    expect(lk.mutePublishedTrack).not.toHaveBeenCalled();
  });

  it("reports failure instead of rejecting when the SFU is unreachable", async () => {
    lk.listParticipants.mockRejectedValue(new Error("connect ECONNREFUSED"));

    // Unlike the evictions, the caller awaits this and turns `false` into an
    // honest HTTP error — the mute IS the action, not post-commit cleanup.
    await expect(setSfuUserMuted(ROOM, "user-1", true, new Map())).resolves.toBe(
      false,
    );
  });

  it("reports failure when the mute RPC itself is refused", async () => {
    lk.listParticipants.mockResolvedValue([
      participant("peer-target", "user-1", [
        { sid: "TR_mic", type: TrackType.AUDIO },
      ]),
    ]);
    lk.mutePublishedTrack.mockRejectedValue(new Error("permission denied"));

    await expect(setSfuUserMuted(ROOM, "user-1", true, new Map())).resolves.toBe(
      false,
    );
  });
});
