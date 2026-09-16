import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptSoundPreferences,
  cueForActivity,
  getIncomingRing,
  getSoundState,
  isCueEnabled,
  isPttBeepAllowed,
  applyPttHeldChange,
  playActivitySound,
  playCue,
  playPttBeep,
  playPttHeldChange,
  PTT_BEEP,
  pttHeldCue,
  resetPttHeld,
  resetSoundStateForTests,
  setIncomingRing,
  setPttBeepEnabled,
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

describe("pttHeldCue", () => {
  it("plays on press, ignores a repeat, and plays off on release", () => {
    expect(pttHeldCue(false, true)).toBe("on");
    expect(pttHeldCue(true, true)).toBe(null);
    expect(pttHeldCue(true, false)).toBe("off");
  });
});

describe("isPttBeepAllowed", () => {
  it("silences the PTT tones when the master switch is off", () => {
    expect(isPttBeepAllowed({ ...enabled, enabled: false }, true)).toBe(false);
  });

  it("silences the PTT tones when the device toggle is off", () => {
    expect(isPttBeepAllowed(enabled, false)).toBe(false);
    expect(isPttBeepAllowed(enabled, true)).toBe(true);
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

  it("does not reset a locally picked incoming ring", () => {
    setIncomingRing("glass");
    adoptSoundPreferences({ mention: false });
    expect(getIncomingRing()).toBe("glass");
    expect(getSoundState().mention).toBe(false);
  });
});

describe("incoming ring", () => {
  it("keeps the pick when other cues change", () => {
    setIncomingRing("chime");
    expect(getIncomingRing()).toBe("chime");
    setSoundCueEnabled("mention", false);
    expect(getIncomingRing()).toBe("chime");
    expect(getSoundState().mention).toBe(false);
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

function stubPttAudio() {
  const oscillators: Array<{
    type: string;
    frequency: { value: number };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }> = [];
  const gain = {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain() {
        return { ...gain, gain: { ...gain.gain } };
      }
      createOscillator() {
        const osc = {
          type: "sine",
          frequency: { value: 0 },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as (() => void) | null,
        };
        oscillators.push(osc);
        return osc;
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
  return { oscillators };
}

describe("playPttBeep", () => {
  it("is a no-op when the master switch is off, even without an AudioContext", () => {
    setSoundEnabled(false);
    expect(() => playPttBeep("on")).not.toThrow();
    expect(() => playPttBeep("off")).not.toThrow();
  });

  it("is a no-op when the PTT toggle is off", () => {
    const { oscillators } = stubPttAudio();
    setPttBeepEnabled(false);
    playPttBeep("on");
    playPttBeep("off");
    expect(oscillators).toHaveLength(0);
  });

  it("plays a higher tone on press and a lower tone on release", () => {
    const { oscillators } = stubPttAudio();
    playPttBeep("on");
    playPttBeep("off");
    expect(oscillators).toHaveLength(2);
    expect(oscillators[0]?.frequency.value).toBe(PTT_BEEP.on.freq);
    expect(oscillators[1]?.frequency.value).toBe(PTT_BEEP.off.freq);
    expect(oscillators[0]?.start).toHaveBeenCalled();
    expect(oscillators[1]?.start).toHaveBeenCalled();
  });

  it("does not stack a second press or a second release while that tone is still going", () => {
    const { oscillators } = stubPttAudio();
    playPttBeep("on");
    playPttBeep("on");
    playPttBeep("off");
    playPttBeep("off");
    expect(oscillators).toHaveLength(2);
  });
});

describe("playPttHeldChange", () => {
  it("fires on, nothing, off across press, repeat, and release", () => {
    const { oscillators } = stubPttAudio();
    playPttHeldChange(true);
    playPttHeldChange(true);
    playPttHeldChange(false);
    expect(oscillators).toHaveLength(2);
    expect(oscillators[0]?.frequency.value).toBe(PTT_BEEP.on.freq);
    expect(oscillators[1]?.frequency.value).toBe(PTT_BEEP.off.freq);
  });

  it("plays on again after resetPttHeld clears a leftover hold", () => {
    vi.useFakeTimers();
    try {
      const { oscillators } = stubPttAudio();
      playPttHeldChange(true);
      expect(oscillators).toHaveLength(1);
      vi.advanceTimersByTime(200);
      playPttHeldChange(true);
      expect(oscillators).toHaveLength(1);
      resetPttHeld();
      playPttHeldChange(true);
      expect(oscillators).toHaveLength(2);
      expect(oscillators[1]?.frequency.value).toBe(PTT_BEEP.on.freq);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("applyPttHeldChange", () => {
  it("still fires the held callback when createOscillator throws, then plays later", () => {
    let failOscillator = true;
    const oscillators: Array<{ frequency: { value: number } }> = [];
    const gain = {
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        createGain() {
          return { ...gain, gain: { ...gain.gain } };
        }
        createOscillator() {
          if (failOscillator) {
            throw new Error("oscillator unavailable");
          }
          const osc = {
            type: "sine",
            frequency: { value: 0 },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            onended: null as (() => void) | null,
          };
          oscillators.push(osc);
          return osc;
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

    const apply = vi.fn();
    expect(() => applyPttHeldChange(true, apply)).not.toThrow();
    expect(apply).toHaveBeenCalledWith(true);
    expect(oscillators).toHaveLength(0);

    failOscillator = false;
    playPttBeep("on");
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0]?.frequency.value).toBe(PTT_BEEP.on.freq);
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
