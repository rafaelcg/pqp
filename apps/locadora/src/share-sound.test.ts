import { describe, expect, it } from "vitest";
import type { ShareAudioApi, ShareAudioBlock } from "@pqp/app-sdk";
import type { TapBlock } from "./audio";
import { wireShareSound } from "./share-sound";

function fakes() {
  let wanted: ((on: boolean) => void) | null = null;
  const sent: ShareAudioBlock[] = [];
  const api: ShareAudioApi = {
    send: (block) => void sent.push(block),
    onWanted: (callback) => {
      wanted = callback;
      return () => {
        wanted = null;
      };
    },
  };
  let tap: ((block: TapBlock) => void) | null = null;
  const hub = {
    setTap(listener: ((block: TapBlock) => void) | null) {
      tap = listener;
    },
  };
  return {
    api,
    hub,
    sent,
    push: (on: boolean) => wanted?.(on),
    listening: () => wanted !== null,
    tapping: () => tap !== null,
    play: (block: TapBlock) => tap?.(block),
  };
}

const block: TapBlock = { rate: 48000, channels: 2, samples: new Float32Array([0.5, 0.5]).buffer };

describe("the game's sound in a share of the pane", () => {
  it("reads nothing until the page asks for it", () => {
    const rig = fakes();
    wireShareSound(rig.api, rig.hub);
    expect(rig.tapping()).toBe(false);
    expect(rig.sent).toHaveLength(0);
  });

  it("hands the host every block the hub reads while a share wants it, and stops when it does not", () => {
    const rig = fakes();
    wireShareSound(rig.api, rig.hub);
    rig.push(true);
    expect(rig.tapping()).toBe(true);
    rig.play(block);
    expect(rig.sent).toEqual([block]);
    rig.push(false);
    expect(rig.tapping()).toBe(false);
    rig.play(block);
    expect(rig.sent).toHaveLength(1);
  });

  it("stands down completely when torn down", () => {
    const rig = fakes();
    const stop = wireShareSound(rig.api, rig.hub);
    rig.push(true);
    stop();
    expect(rig.listening()).toBe(false);
    expect(rig.tapping()).toBe(false);
  });
});
