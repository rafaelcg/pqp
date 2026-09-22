import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTrack,
  getMusicSnapshot,
  resetMusicStoreForTests,
  setListening,
  setMusicSession,
} from "./music-store";
import {
  applyMusicJoinGate,
  getMusicPrefs,
  musicPictureMode,
  musicStagePictureActive,
  resetMusicPrefsForTests,
  setMusicAutoJoin,
  setMusicDucking,
  setMusicPlacement,
  shouldAutoDeclineListen,
} from "./music-prefs";

const CHANNEL = "11111111-1111-4111-8111-111111111111";

/** The lib suite runs under vitest's `node` environment: no real `localStorage`. */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

describe("shouldAutoDeclineListen", () => {
  it("stays on when auto-join is on", () => {
    expect(
      shouldAutoDeclineListen({
        autoJoin: true,
        previousTrackId: null,
        nextTrackId: "a",
        seatChanged: true,
      }),
    ).toBe(false);
  });

  it("declines a room that already has music, and nothing turning into a track", () => {
    expect(
      shouldAutoDeclineListen({
        autoJoin: false,
        previousTrackId: null,
        nextTrackId: "a",
        seatChanged: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoDeclineListen({
        autoJoin: false,
        previousTrackId: null,
        nextTrackId: "a",
        seatChanged: false,
      }),
    ).toBe(true);
  });

  it("does not kick someone who is already on a track", () => {
    expect(
      shouldAutoDeclineListen({
        autoJoin: false,
        previousTrackId: "a",
        nextTrackId: "b",
        seatChanged: false,
      }),
    ).toBe(false);
  });
});

describe("music prefs store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    resetMusicPrefsForTests();
    resetMusicStoreForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetMusicPrefsForTests();
  });

  it("defaults hidden and remembers each switch", () => {
    expect(getMusicPrefs()).toEqual({
      placement: "hidden",
      ducking: true,
      autoJoin: true,
    });
    setMusicPlacement("stage");
    setMusicDucking(false);
    setMusicAutoJoin(false);
    expect(getMusicPrefs()).toEqual({
      placement: "stage",
      ducking: false,
      autoJoin: false,
    });
    expect(localStorage.getItem("pqp:music-placement")).toBe("stage");
    expect(localStorage.getItem("pqp:music-duck")).toBe("0");
    expect(localStorage.getItem("pqp:music-auto-join")).toBe("0");
    setMusicPlacement("hidden");
    expect(getMusicPrefs().placement).toBe("hidden");
    expect(localStorage.getItem("pqp:music-placement")).toBe("hidden");
  });

  it("treats the stage as the only picture", () => {
    expect(musicPictureMode({ placement: "hidden" })).toBe("hidden");
    expect(musicPictureMode({ placement: "stage" })).toBe("stage");
    expect(
      musicStagePictureActive({
        hasCurrent: true,
        listening: true,
        onStage: false,
      }),
    ).toBe(false);
    expect(
      musicStagePictureActive({
        hasCurrent: true,
        listening: true,
        onStage: true,
      }),
    ).toBe(true);
  });

  it("turns listening off when auto-join is off and a track appears", () => {
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-a",
      userId: "u1",
      displayName: "Ana",
      send: () => {},
    });
    setListening(true);
    applyMusicJoinGate(CHANNEL, null, false);
    expect(getMusicSnapshot().listening).toBe(true);
    addTrack({
      provider: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "Now",
      sourceUrl: null,
      thumbnailUrl: null,
      durationMs: 1,
    });
    const id = getMusicSnapshot().state?.current?.id ?? null;
    applyMusicJoinGate(CHANNEL, id, false);
    expect(getMusicSnapshot().listening).toBe(false);
  });
});
