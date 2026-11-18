// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkOutputDevice,
  playElement,
  replayAllPlayback,
  resetAudioPlaybackHealthForTests,
  stuckPlaybackCount,
  takeOutputMissingEvents,
  trackPlaybackElement,
} from "./audio-playback-health";
import { setAudioSelfHealForTests } from "./audio-self-heal-flag";

/** An `<audio>` whose `play()` the test decides, and whose `paused` follows it. */
function element(refuse: () => boolean) {
  const el = document.createElement("audio");
  let paused = true;
  Object.defineProperty(el, "paused", { get: () => paused });
  el.play = vi.fn(async () => {
    if (refuse()) {
      const err = new Error("not allowed");
      err.name = "NotAllowedError";
      throw err;
    }
    paused = false;
  });
  const pause = () => {
    paused = true;
    el.dispatchEvent(new Event("pause"));
  };
  Object.defineProperty(el, "srcObject", { value: {}, writable: true });
  return { el, pause };
}

afterEach(() => {
  resetAudioPlaybackHealthForTests();
  setAudioSelfHealForTests(false);
  vi.unstubAllGlobals();
});

describe("audio playback health", () => {
  it("counts an element the browser refused, and the next press anywhere plays it", async () => {
    setAudioSelfHealForTests(true);
    let refuse = true;
    const { el } = element(() => refuse);
    trackPlaybackElement(el, "bob");
    expect(await playElement(el)).toBe(false);
    expect(stuckPlaybackCount()).toBe(1);
    refuse = false;
    document.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(stuckPlaybackCount()).toBe(0));
  });

  it("with the flag off, a refusal arms nothing", async () => {
    const { el } = element(() => true);
    trackPlaybackElement(el, "bob");
    await playElement(el);
    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it("answers a pause nobody asked for with a play", async () => {
    setAudioSelfHealForTests(true);
    const { el, pause } = element(() => false);
    trackPlaybackElement(el, "bob");
    await playElement(el);
    pause();
    await vi.waitFor(() => expect(el.play).toHaveBeenCalledTimes(2));
    expect(stuckPlaybackCount()).toBe(0);
  });

  it("replayAll reports whether anything is still stuck, and an untracked element is not counted", async () => {
    const { el } = element(() => false);
    const stop = trackPlaybackElement(el, "bob");
    expect(stuckPlaybackCount()).toBe(1);
    expect(await replayAllPlayback()).toBe(true);
    stop();
    expect(stuckPlaybackCount()).toBe(0);
  });

  it("puts every element back on the default output when the chosen one is gone, once", async () => {
    setAudioSelfHealForTests(true);
    const { el } = element(() => false);
    const setSinkId = vi.fn(async () => {});
    Object.assign(el, { setSinkId });
    trackPlaybackElement(el, "bob");
    let outputs = [
      { kind: "audiooutput", deviceId: "default" },
      { kind: "audiooutput", deviceId: "speakers-1" },
    ];
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: async () => outputs },
    });
    await checkOutputDevice("headset-1");
    await checkOutputDevice("headset-1");
    expect(setSinkId).toHaveBeenCalledTimes(1);
    expect(setSinkId).toHaveBeenCalledWith("");
    expect(takeOutputMissingEvents()).toBe(1);
    expect(takeOutputMissingEvents()).toBe(0);
    // Back, then gone again: a second event.
    outputs = [...outputs, { kind: "audiooutput", deviceId: "headset-1" }];
    await checkOutputDevice("headset-1");
    outputs = outputs.slice(0, 2);
    await checkOutputDevice("headset-1");
    expect(takeOutputMissingEvents()).toBe(1);
  });

  it("points every element back at the chosen output when it comes back", async () => {
    // A USB or wireless headset re-enumerating mid-call: gone, then listed
    // again. The elements were moved to the default output when it went;
    // nothing else moves them back (their own effect only runs when the
    // choice or the stream changes), so without this the call played on the
    // monitor until a leave and rejoin.
    setAudioSelfHealForTests(true);
    const { el } = element(() => false);
    const setSinkId = vi.fn(async (_id: string) => {});
    Object.assign(el, { setSinkId });
    trackPlaybackElement(el, "bob");
    const speakers = [
      { kind: "audiooutput", deviceId: "default" },
      { kind: "audiooutput", deviceId: "speakers-1" },
    ];
    let outputs = speakers;
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: async () => outputs },
    });
    await checkOutputDevice("headset-1");
    expect(setSinkId).toHaveBeenLastCalledWith("");

    outputs = [...speakers, { kind: "audiooutput", deviceId: "headset-1" }];
    await checkOutputDevice("headset-1");
    expect(setSinkId).toHaveBeenLastCalledWith("headset-1");
    expect(setSinkId).toHaveBeenCalledTimes(2);

    // Already back on it: another devicechange does nothing.
    await checkOutputDevice("headset-1");
    expect(setSinkId).toHaveBeenCalledTimes(2);
  });

  it("retries the way back on the next check when the returning device is not ready yet", async () => {
    setAudioSelfHealForTests(true);
    const { el } = element(() => false);
    let ready = false;
    const setSinkId = vi.fn(async (id: string) => {
      if (id === "headset-1" && !ready) {
        throw new Error("NotFoundError");
      }
    });
    Object.assign(el, { setSinkId });
    trackPlaybackElement(el, "bob");
    const speakers = [
      { kind: "audiooutput", deviceId: "default" },
      { kind: "audiooutput", deviceId: "speakers-1" },
    ];
    let outputs = speakers;
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: async () => outputs },
    });
    await checkOutputDevice("headset-1");
    outputs = [...speakers, { kind: "audiooutput", deviceId: "headset-1" }];
    await checkOutputDevice("headset-1");
    expect(setSinkId).toHaveBeenLastCalledWith("headset-1");
    ready = true;
    await checkOutputDevice("headset-1");
    expect(setSinkId).toHaveBeenCalledTimes(3);
    expect(setSinkId).toHaveBeenLastCalledWith("headset-1");
    // Now settled: no further calls, and the earlier loss is not re-counted.
    await checkOutputDevice("headset-1");
    expect(setSinkId).toHaveBeenCalledTimes(3);
    expect(takeOutputMissingEvents()).toBe(1);
  });

  it("does not move elements onto a device nobody chose", async () => {
    setAudioSelfHealForTests(true);
    const { el } = element(() => false);
    const setSinkId = vi.fn(async (_id: string) => {});
    Object.assign(el, { setSinkId });
    trackPlaybackElement(el, "bob");
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audiooutput", deviceId: "default" },
          { kind: "audiooutput", deviceId: "headset-1" },
        ],
      },
    });
    await checkOutputDevice("headset-1");
    expect(setSinkId).not.toHaveBeenCalled();
  });

  it("says nothing when outputs carry no ids, or only the default (no permission yet)", async () => {
    setAudioSelfHealForTests(true);
    for (const listed of [
      [{ kind: "audiooutput", deviceId: "" }],
      [{ kind: "audiooutput", deviceId: "default" }, { kind: "audiooutput", deviceId: "" }],
    ]) {
      vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => listed } });
      await checkOutputDevice("headset-1");
    }
    expect(takeOutputMissingEvents()).toBe(0);
  });
});
