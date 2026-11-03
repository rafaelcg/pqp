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
  resetJoinGateForReload,
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
      autoJoin: false,
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
    expect(localStorage.getItem("pqp:music-auto-join-v2")).toBe("0");
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

  it("keeps whoever opens the Rádio in it", () => {
    expect(applyMusicJoinGate(CHANNEL, null, false, { listening: true })).toBe(false);
    expect(
      applyMusicJoinGate(CHANNEL, "t1", false, { listening: true, openedHere: true }),
    ).toBe(false);
  });

  it("keeps a joined seat in the Rádio when the queue runs dry and refills", () => {
    applyMusicJoinGate(CHANNEL, null, false, { listening: true });
    // Somebody else starts the Rádio: this seat gets the invite.
    expect(applyMusicJoinGate(CHANNEL, "t1", false, { listening: true })).toBe(true);
    // Entrar na Rádio.
    expect(applyMusicJoinGate(CHANNEL, "t1", false, { listening: true })).toBe(false);
    // The queue ends, then somebody adds a song.
    expect(applyMusicJoinGate(CHANNEL, null, false, { listening: true })).toBe(false);
    expect(applyMusicJoinGate(CHANNEL, "t2", false, { listening: true })).toBe(false);
  });

  it("gives a new seat the invite again", () => {
    applyMusicJoinGate(CHANNEL, null, false, { listening: true });
    applyMusicJoinGate(CHANNEL, "t1", false, { listening: true });
    applyMusicJoinGate(CHANNEL, "t1", false, { listening: true });
    const other = "22222222-2222-4222-8222-222222222222";
    expect(applyMusicJoinGate(other, "t9", false, { listening: true })).toBe(true);
  });

  it("keeps a joined tab in the Rádio across a reload", () => {
    vi.stubGlobal("sessionStorage", fakeLocalStorage());
    try {
      applyMusicJoinGate(CHANNEL, null, false, { listening: true });
      applyMusicJoinGate(CHANNEL, "t1", false, { listening: true });
      applyMusicJoinGate(CHANNEL, "t1", false, { listening: true });
      // A reload: the page forgets everything but the tab's storage.
      resetJoinGateForReload();
      expect(applyMusicJoinGate(CHANNEL, "t1", false, { listening: true })).toBe(false);
      // Sair da Rádio is remembered the same way.
      applyMusicJoinGate(CHANNEL, "t1", false, { listening: false });
      resetJoinGateForReload();
      expect(applyMusicJoinGate(CHANNEL, "t1", false, { listening: true })).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("counts an open once, so a reconnect does not undo Sair da Rádio", () => {
    applyMusicJoinGate(CHANNEL, null, false, { listening: true });
    expect(applyMusicJoinGate(CHANNEL, "t1", false, { listening: true, openedHere: true })).toBe(false);
    // Sair da Rádio.
    applyMusicJoinGate(CHANNEL, "t1", false, { listening: false });
    // A reconnect: the state drops to nothing and comes back.
    applyMusicJoinGate(CHANNEL, null, false, { listening: false });
    expect(applyMusicJoinGate(CHANNEL, "t1", false, { listening: false, openedHere: true })).toBe(true);
  });

  it("gives the invite to somebody sitting down where their own earlier pick plays", () => {
    expect(applyMusicJoinGate(CHANNEL, "t1", false, { listening: true, openedHere: false })).toBe(true);
  });
});
