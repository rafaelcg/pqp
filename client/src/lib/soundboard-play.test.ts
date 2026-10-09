import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A clip that is still loading when the listener deafens or leaves must not
 * start afterwards. `playSoundboardClip` asks again once the bytes are
 * decoded.
 */

const started = vi.hoisted(() => ({ count: 0, release: null as null | (() => void) }));

vi.mock("@/lib/sounds", () => ({
  sharedAudioContext: () => ({
    state: "running",
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
    createGain: () => ({
      gain: { value: 1, cancelScheduledValues: () => undefined },
      connect: () => undefined,
    }),
    createBufferSource: () => ({
      connect: () => undefined,
      start: () => {
        started.count += 1;
      },
      stop: () => undefined,
    }),
  }),
  decodeAudioBuffer: async () => {
    await new Promise<void>((resolve) => {
      started.release = resolve;
    });
    return {} as AudioBuffer;
  },
  unlockSounds: () => undefined,
}));

describe("playSoundboardClip", () => {
  beforeEach(() => {
    started.count = 0;
    started.release = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
    );
  });

  it("does not start a clip when the listener deafened while it loaded", async () => {
    const { playSoundboardClip } = await import("./soundboard");
    let hearing = true;
    const pending = playSoundboardClip("builtin:buzina", () => hearing);
    await vi.waitFor(() => expect(started.release).not.toBeNull());
    hearing = false;
    started.release?.();
    await pending;
    expect(started.count).toBe(0);
  });
});
