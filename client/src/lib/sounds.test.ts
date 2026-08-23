import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptSoundPreferences,
  cueForActivity,
  getSoundState,
  isCueEnabled,
  playActivitySound,
  playCue,
  resetSoundStateForTests,
  setSoundCueEnabled,
  setSoundEnabled,
  startSoundLoop,
  stopSoundLoop,
  soundLoopIsRunningForTests,
  whenCueSettled,
  type SoundState,
} from "./sounds";

const enabled: SoundState = {
  enabled: true,
  message: true,
  mention: true,
  voiceJoin: true,
  voiceLeave: true,
  incomingCall: true,
  outgoingCall: true,
};

afterEach(() => {
  resetSoundStateForTests();
  vi.unstubAllGlobals();
});

describe("cueForActivity", () => {
  it("uses the mention cue when the burst named the reader", () => {
    expect(cueForActivity(0)).toBe("message");
    expect(cueForActivity(1)).toBe("mention");
  });
});

describe("isCueEnabled", () => {
  it("silences every cue when the master switch is off", () => {
    expect(isCueEnabled({ ...enabled, enabled: false }, "message")).toBe(false);
    expect(isCueEnabled({ ...enabled, enabled: false }, "incomingCall")).toBe(
      false,
    );
  });

  it("silences one cue without touching the others", () => {
    expect(isCueEnabled({ ...enabled, message: false }, "message")).toBe(false);
    expect(isCueEnabled({ ...enabled, message: false }, "mention")).toBe(true);
  });
});

describe("playActivitySound", () => {
  it("is a no-op when the master switch is off, even without an AudioContext", () => {
    setSoundEnabled(false);
    expect(() => playActivitySound(0)).not.toThrow();
    expect(() => playCue("incomingCall")).not.toThrow();
  });

  it("is a no-op when that cue is off", () => {
    setSoundCueEnabled("mention", false);
    expect(() => playActivitySound(2)).not.toThrow();
  });
});

describe("adoptSoundPreferences", () => {
  it("fills in cues the patch omitted rather than turning them off", () => {
    adoptSoundPreferences({ message: false });
    const next = getSoundState();
    expect(next.message).toBe(false);
    expect(next.mention).toBe(true);
    expect(next.enabled).toBe(true);
  });
});

describe("startSoundLoop", () => {
  it("does not start a loop when that cue is disabled", () => {
    setSoundCueEnabled("incomingCall", false);
    startSoundLoop("incomingCall");
    expect(soundLoopIsRunningForTests("incomingCall")).toBe(false);
  });

  it("stops a running loop when asked", () => {
    const gain = {
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const osc = {
      type: "sine",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        createGain() {
          return gain;
        }
        createOscillator() {
          return { ...osc };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    startSoundLoop("incomingCall");
    expect(soundLoopIsRunningForTests("incomingCall")).toBe(true);
    stopSoundLoop("incomingCall");
    expect(soundLoopIsRunningForTests("incomingCall")).toBe(false);
  });
});

function stubSampleAudio() {
  const sources: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    buffer: unknown;
    onended: (() => void) | null;
  }> = [];
  const gain = {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
  const osc = {
    type: "sine",
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })),
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain() {
        return gain;
      }
      createOscillator() {
        return { ...osc };
      }
      createBufferSource() {
        const source = {
          buffer: null as unknown,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      }
      decodeAudioData() {
        return Promise.resolve({ duration: 0.3 });
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        this.state = "running";
        return Promise.resolve();
      }
    },
  );
  return { sources };
}

describe("sample playback", () => {
  it("coalesces a second play of the same cue while the first is still going", async () => {
    const { sources } = stubSampleAudio();
    playCue("voiceJoin");
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    playCue("voiceJoin");
    await Promise.resolve();
    expect(sources).toHaveLength(1);
  });

  it("plays a different cue only after the current sample ends", async () => {
    const { sources } = stubSampleAudio();
    playCue("voiceJoin");
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    playCue("voiceLeave");
    await Promise.resolve();
    expect(sources).toHaveLength(1);
    sources[0]?.onended?.();
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[1]?.start).toHaveBeenCalled();
  });

  it("holds the outgoing ring until the join sample has finished", async () => {
    const { sources } = stubSampleAudio();
    playCue("voiceJoin");
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    startSoundLoop("outgoingCall");
    expect(soundLoopIsRunningForTests("outgoingCall")).toBe(false);
    sources[0]?.onended?.();
    await vi.waitFor(() =>
      expect(soundLoopIsRunningForTests("outgoingCall")).toBe(true),
    );
  });

  it("resolves whenCueSettled when the sample ends, and at the cap if it never does", async () => {
    const { sources } = stubSampleAudio();
    playCue("voiceJoin");
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    const ended = whenCueSettled();
    sources[0]?.onended?.();
    await ended;

    playCue("voiceLeave");
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    vi.useFakeTimers();
    const capped = whenCueSettled();
    await vi.advanceTimersByTimeAsync(750);
    await capped;
    vi.useRealTimers();
  });
});
