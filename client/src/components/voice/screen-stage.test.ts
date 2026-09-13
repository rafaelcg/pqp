import { describe, expect, it } from "vitest";
import { collectScreenTiles, screenShareStageLayout } from "./screen-stage";

describe("screenShareStageLayout", () => {
  it("splits only two shares on a wide window", () => {
    expect(screenShareStageLayout(2, true)).toBe("split");
    expect(screenShareStageLayout(2, false)).toBe("focus");
    expect(screenShareStageLayout(1, true)).toBe("focus");
    expect(screenShareStageLayout(3, true)).toBe("focus");
  });
});

describe("collectScreenTiles", () => {
  /** Only the fields `collectScreenTiles` reads. */
  const peer = (over: Record<string, unknown> = {}) =>
    ({
      peerId: "p2",
      userId: "u2",
      displayName: "Bia",
      screenStream: { id: "video" },
      screenAudioStream: null,
      ...over,
    }) as never;

  it("carries the presenter's userId, so a volume survives their reconnect", () => {
    // peerId changes when somebody drops and rejoins; the volume maps are
    // keyed on the account for exactly that reason.
    const [tile] = collectScreenTiles({
      peerIds: ["p2"],
      localPeerId: "p1",
      localName: "eu",
      localStream: null,
      remotePeers: [peer()],
      fallbackName: "alguem",
    });
    expect(tile!.userId).toBe("u2");
    expect(tile!.isSelf).toBe(false);
  });

  it("says whether the share arrived with sound", () => {
    // Read from what was received, not from what the presenter ticked: the
    // listener's question is whether there is anything here to turn down.
    const [silent] = collectScreenTiles({
      peerIds: ["p2"],
      localPeerId: "p1",
      localName: "eu",
      localStream: null,
      remotePeers: [peer()],
      fallbackName: "alguem",
    });
    expect(silent!.hasAudio).toBe(false);

    const [loud] = collectScreenTiles({
      peerIds: ["p2"],
      localPeerId: "p1",
      localName: "eu",
      localStream: null,
      remotePeers: [peer({ screenAudioStream: { id: "audio" } })],
      fallbackName: "alguem",
    });
    expect(loud!.hasAudio).toBe(true);
  });

  it("never offers a volume for our own share", () => {
    // Our own machine is already playing it; a slider here would move nothing
    // and imply it moved something for the room.
    const [mine] = collectScreenTiles({
      peerIds: ["p1"],
      localPeerId: "p1",
      localName: "eu",
      localStream: { id: "mine" } as never,
      remotePeers: [],
      fallbackName: "alguem",
    });
    expect(mine!.isSelf).toBe(true);
    expect(mine!.hasAudio).toBe(false);
    expect(mine!.userId).toBeNull();
  });

  it("puts the HLS playlist on the remote presenter, never on ourselves", () => {
    const liveStream = {
      hlsUrl: "https://live.example.test/live.m3u8",
      presenterPeerId: "p2",
      delaySeconds: 10,
    };
    const [theirs] = collectScreenTiles({
      peerIds: ["p2"],
      localPeerId: "p1",
      localName: "eu",
      localStream: null,
      remotePeers: [peer()],
      fallbackName: "alguem",
      liveStream,
    });
    expect(theirs!.hlsUrl).toBe(liveStream.hlsUrl);
    expect(theirs!.delaySeconds).toBe(10);

    const [mine] = collectScreenTiles({
      peerIds: ["p1"],
      localPeerId: "p1",
      localName: "eu",
      localStream: { id: "mine" } as never,
      remotePeers: [],
      fallbackName: "alguem",
      liveStream: { ...liveStream, presenterPeerId: "p1" },
    });
    expect(mine!.hlsUrl).toBeNull();
  });
});

describe("the presenter's camera on a screen tile", () => {
  const peer = (over: Record<string, unknown> = {}) =>
    ({
      peerId: "p2",
      userId: "u2",
      displayName: "Bia",
      screenStream: { id: "video" },
      screenAudioStream: null,
      ...over,
    }) as never;

  const liveStream = {
    hlsUrl: "https://api.test/film",
    cameraHlsUrl: "https://api.test/cam",
    presenterPeerId: "p2",
    delaySeconds: 10,
  };

  it("carries the camera playlist beside the film's", () => {
    const [tile] = collectScreenTiles({
      peerIds: ["p2"],
      localPeerId: "p1",
      localName: "eu",
      localStream: null,
      remotePeers: [peer()],
      fallbackName: "alguem",
      liveStream,
    });
    expect(tile!.hlsUrl).toBe("https://api.test/film");
    expect(tile!.cameraHlsUrl).toBe("https://api.test/cam");
  });

  it("gives nobody else's tile the presenter's camera", () => {
    const [tile] = collectScreenTiles({
      peerIds: ["p3"],
      localPeerId: "p1",
      localName: "eu",
      localStream: null,
      remotePeers: [peer({ peerId: "p3" })],
      fallbackName: "alguem",
      liveStream,
    });
    expect(tile!.hlsUrl).toBeNull();
    expect(tile!.cameraHlsUrl).toBeNull();
  });

  it("never gives the presenter their own camera back", () => {
    // A host watching themselves ten seconds late is not useful, and that
    // goes double for their own face.
    const [tile] = collectScreenTiles({
      peerIds: ["p1"],
      localPeerId: "p1",
      localName: "eu",
      localStream: null,
      remotePeers: [],
      fallbackName: "alguem",
      liveStream: { ...liveStream, presenterPeerId: "p1" },
    });
    expect(tile!.hlsUrl).toBeNull();
    expect(tile!.cameraHlsUrl ?? null).toBeNull();
  });
});
