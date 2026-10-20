import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MUSIC_VOLUME_DEFAULT,
  MUSIC_VOLUME_KEY,
  MUSIC_VOLUME_RESTORE_KEY,
  clampVolume,
  initialVolumeModel,
  nudgedVolume,
  readMusicVolume,
  readStoredVolumeModel,
  shownVolume,
  stepVolume,
  toggledMuted,
  volumeGlyph,
  wheelSteps,
  withMuted,
  withVolume,
  writeStoredVolumeModel,
} from "./music-volume";
import { applyYouTubeVolume } from "@/components/voice/music-player-embed";
import {
  getMusicLocalPlayback,
  resetMusicLocalPlaybackForTests,
  setMusicLocalMuted,
  setMusicLocalVolume,
  toggleMusicLocalMuted,
} from "@/components/voice/music-local-playback";

/** The lib suite runs under vitest's `node` environment: no real `localStorage`. */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("the level model", () => {
  it("clamps to 0..100 and rounds", () => {
    expect(clampVolume(-20)).toBe(0);
    expect(clampVolume(140)).toBe(100);
    expect(clampVolume(41.6)).toBe(42);
    expect(clampVolume(Number.NaN)).toBe(MUSIC_VOLUME_DEFAULT);
  });

  it("steps five percent and snaps an off-grid level to the grid first", () => {
    expect(stepVolume(40, 1)).toBe(45);
    expect(stepVolume(40, -1)).toBe(35);
    expect(stepVolume(42, 1)).toBe(45);
    expect(stepVolume(42, -1)).toBe(40);
    expect(stepVolume(100, 1)).toBe(100);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(3, -1)).toBe(0);
  });

  it("keeps the level while muted and unmutes back to it", () => {
    const loud = initialVolumeModel(65);
    const muted = withMuted(loud, true);
    expect(muted).toMatchObject({ volume: 65, muted: true, restoreVolume: 65 });
    expect(shownVolume(muted)).toBe(0);
    const back = toggledMuted(muted);
    expect(back).toMatchObject({ volume: 65, muted: false });
    expect(shownVolume(back)).toBe(65);
  });

  it("goes back to the last audible level when unmuted from zero", () => {
    let model = initialVolumeModel(70);
    model = withVolume(model, 0);
    expect(model).toMatchObject({ volume: 0, muted: false, restoreVolume: 70 });
    expect(shownVolume(model)).toBe(0);
    // The speaker reads as muted, so a click is an unmute and must be audible.
    model = toggledMuted(model);
    expect(model).toMatchObject({ volume: 70, muted: false });
  });

  it("unmutes at the restore level even after a mute at zero", () => {
    let model = withMuted(initialVolumeModel(30), true);
    model = { ...model, volume: 0 };
    expect(withMuted(model, false)).toMatchObject({ volume: 30, muted: false });
  });

  it("chooses a level on purpose: always unmutes and is remembered", () => {
    const muted = withMuted(initialVolumeModel(50), true);
    const next = withVolume(muted, 20);
    expect(next).toMatchObject({ volume: 20, muted: false, restoreVolume: 20 });
  });

  it("nudges by whole steps, from muted upward only", () => {
    const model = initialVolumeModel(40);
    expect(nudgedVolume(model, 1).volume).toBe(45);
    expect(nudgedVolume(model, -2).volume).toBe(30);
    expect(nudgedVolume(model, 30).volume).toBe(100);
    const muted = withMuted(model, true);
    expect(nudgedVolume(muted, -1)).toBe(muted);
    expect(nudgedVolume(muted, 1)).toMatchObject({ volume: 45, muted: false });
  });

  it("picks one of four glyphs", () => {
    expect(volumeGlyph(0)).toBe("muted");
    expect(volumeGlyph(1)).toBe("low");
    expect(volumeGlyph(33)).toBe("low");
    expect(volumeGlyph(34)).toBe("medium");
    expect(volumeGlyph(66)).toBe("medium");
    expect(volumeGlyph(67)).toBe("high");
    expect(volumeGlyph(100)).toBe("high");
  });

  it("turns a wheel into whole steps and carries the remainder", () => {
    // Up is negative deltaY and louder; a mouse notch is 100px.
    expect(wheelSteps(0, -100)).toEqual({ steps: 1, carry: 0 });
    expect(wheelSteps(0, 100)).toEqual({ steps: -1, carry: 0 });
    expect(wheelSteps(0, -900)).toEqual({ steps: 1, carry: 0 });
    expect(wheelSteps(0, -10)).toEqual({ steps: 0, carry: -10 });
    // A trackpad: small deltas add up before they move anything.
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      const moved = wheelSteps(carry, -10);
      carry = moved.carry;
      total += moved.steps;
    }
    expect(total).toBe(2);
    expect(wheelSteps(0, -3, 1).steps).toBe(1);
  });
});

describe("persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the default with nothing stored or junk stored", () => {
    expect(readMusicVolume()).toBe(MUSIC_VOLUME_DEFAULT);
    localStorage.setItem(MUSIC_VOLUME_KEY, "loud");
    expect(readMusicVolume()).toBe(MUSIC_VOLUME_DEFAULT);
    localStorage.setItem(MUSIC_VOLUME_KEY, "");
    expect(readMusicVolume()).toBe(MUSIC_VOLUME_DEFAULT);
  });

  it("clamps what is stored", () => {
    localStorage.setItem(MUSIC_VOLUME_KEY, "250");
    expect(readMusicVolume()).toBe(100);
  });

  it("round-trips the level and the restore level", () => {
    writeStoredVolumeModel({ volume: 0, muted: false, restoreVolume: 55 });
    expect(localStorage.getItem(MUSIC_VOLUME_KEY)).toBe("0");
    expect(localStorage.getItem(MUSIC_VOLUME_RESTORE_KEY)).toBe("55");
    expect(readStoredVolumeModel()).toEqual({
      volume: 0,
      muted: false,
      restoreVolume: 55,
    });
  });

  it("works with no storage at all: reads answer the default, writes do nothing", () => {
    const refuses = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", refuses);
    expect(readMusicVolume()).toBe(MUSIC_VOLUME_DEFAULT);
    expect(() =>
      writeStoredVolumeModel({ volume: 10, muted: false, restoreVolume: 10 }),
    ).not.toThrow();
    resetMusicLocalPlaybackForTests();
    setMusicLocalVolume(80);
    // The session still holds what the person chose.
    expect(getMusicLocalPlayback().volume).toBe(80);
  });
});

describe("the shared store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    resetMusicLocalPlaybackForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts from the stored level and persists every change", () => {
    localStorage.setItem(MUSIC_VOLUME_KEY, "25");
    resetMusicLocalPlaybackForTests();
    expect(getMusicLocalPlayback().volume).toBe(25);
    setMusicLocalVolume(60);
    expect(localStorage.getItem(MUSIC_VOLUME_KEY)).toBe("60");
    expect(getMusicLocalPlayback()).toMatchObject({ volume: 60, muted: false });
  });

  it("remembers the level across a mute and an unmute", () => {
    setMusicLocalVolume(60);
    toggleMusicLocalMuted();
    expect(getMusicLocalPlayback()).toMatchObject({ volume: 60, muted: true });
    toggleMusicLocalMuted();
    expect(getMusicLocalPlayback()).toMatchObject({ volume: 60, muted: false });
  });

  it("restores the last audible level when a slider left it at zero", () => {
    setMusicLocalVolume(60);
    setMusicLocalVolume(0);
    toggleMusicLocalMuted();
    expect(getMusicLocalPlayback()).toMatchObject({ volume: 60, muted: false });
    setMusicLocalMuted(false);
    expect(getMusicLocalPlayback().volume).toBe(60);
  });

  it("is what a new track is played at", () => {
    setMusicLocalVolume(35);
    const calls: string[] = [];
    const player = {
      setVolume: (value: number) => calls.push(`vol:${value}`),
      mute: () => calls.push("mute"),
      unMute: () => calls.push("unmute"),
    };
    // The embed applies the store's level on ready and again on every track.
    const { volume, muted } = getMusicLocalPlayback();
    applyYouTubeVolume(player, { volume, muted, duckGain: 1 });
    expect(calls).toEqual(["vol:35"]);
    toggleMusicLocalMuted();
    const after = getMusicLocalPlayback();
    applyYouTubeVolume(player, { volume: after.volume, muted: after.muted, duckGain: 1 });
    expect(calls).toEqual(["vol:35", "vol:35", "mute"]);
  });
});
