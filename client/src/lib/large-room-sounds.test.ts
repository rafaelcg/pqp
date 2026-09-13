import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  joinLeaveAutoMuteEnabled,
  LARGE_ROOM_SOUND_THRESHOLD,
  resetJoinLeaveAutoMuteForTests,
  setJoinLeaveAutoMuteEnabled,
  shouldSuppressJoinLeaveSound,
  subscribeJoinLeaveAutoMute,
} from "./large-room-sounds";

/** The suite runs under vitest's `node` environment: no real `localStorage`. */
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

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
  resetJoinLeaveAutoMuteForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetJoinLeaveAutoMuteForTests();
});

describe("shouldSuppressJoinLeaveSound", () => {
  it("stays quiet only once the room passes the threshold", () => {
    expect(shouldSuppressJoinLeaveSound(LARGE_ROOM_SOUND_THRESHOLD, true)).toBe(
      false,
    );
    expect(
      shouldSuppressJoinLeaveSound(LARGE_ROOM_SOUND_THRESHOLD + 1, true),
    ).toBe(true);
  });

  it("never suppresses with the toggle off, no matter the size", () => {
    expect(shouldSuppressJoinLeaveSound(500, false)).toBe(false);
  });

  it("never suppresses a small room even with the toggle on", () => {
    expect(shouldSuppressJoinLeaveSound(2, true)).toBe(false);
  });
});

describe("the persisted auto-mute toggle", () => {
  it("is on before anybody touches it", () => {
    expect(joinLeaveAutoMuteEnabled()).toBe(true);
  });

  it("survives a reload", () => {
    setJoinLeaveAutoMuteEnabled(false);
    resetJoinLeaveAutoMuteForTests();
    expect(joinLeaveAutoMuteEnabled()).toBe(false);
  });

  it("stores under a key the rest of the app will recognise", () => {
    setJoinLeaveAutoMuteEnabled(false);
    expect(localStorage.getItem("pqp:auto-mute-join-leave-large-rooms")).toBe(
      "0",
    );
    setJoinLeaveAutoMuteEnabled(true);
    expect(localStorage.getItem("pqp:auto-mute-join-leave-large-rooms")).toBe(
      "1",
    );
  });

  it("ignores junk in storage and defaults on", () => {
    localStorage.setItem("pqp:auto-mute-join-leave-large-rooms", "sometimes");
    expect(joinLeaveAutoMuteEnabled()).toBe(true);
  });

  it("tells subscribers when it changes, and only when it changes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeJoinLeaveAutoMute((value) => seen.push(value));
    setJoinLeaveAutoMuteEnabled(false);
    setJoinLeaveAutoMuteEnabled(false);
    setJoinLeaveAutoMuteEnabled(true);
    unsubscribe();
    setJoinLeaveAutoMuteEnabled(false);
    expect(seen).toEqual([false, true]);
  });
});
