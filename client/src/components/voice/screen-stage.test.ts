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
});
