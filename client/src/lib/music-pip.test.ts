import { describe, expect, it } from "vitest";
import {
  MUSIC_PIP_KEY,
  isMusicPipSeen,
  rememberMusicPip,
  shouldShowMusicPip,
} from "./music-pip";

function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("the NOVO pip on the Música tile", () => {
  const ready = { seen: false, automated: false, canSpeak: true, playing: false };

  it("marks the tile for somebody who could put something on", () => {
    expect(shouldShowMusicPip(ready)).toBe(true);
  });

  it("stays off once seen, for a listener, and while a track plays", () => {
    expect(shouldShowMusicPip({ ...ready, seen: true })).toBe(false);
    expect(shouldShowMusicPip({ ...ready, automated: true })).toBe(false);
    expect(shouldShowMusicPip({ ...ready, canSpeak: false })).toBe(false);
    expect(shouldShowMusicPip({ ...ready, playing: true })).toBe(false);
  });

  /*
   * Its own key, not the card's. The card records its impression on first
   * paint, and its gate is a superset of this one, so a shared key would be
   * stamped in the same frame the pip first drew and the pip would never
   * survive to be the thing somebody notices later.
   */
  it("keeps a key of its own, spent by opening the panel", () => {
    expect(MUSIC_PIP_KEY).toBe("pqp:music-pip-2026-09");
    const storage = memory();
    expect(isMusicPipSeen(storage, true)).toBe(false);
    rememberMusicPip(storage, true);
    expect(storage.getItem(MUSIC_PIP_KEY)).toBe("1");
    expect(isMusicPipSeen(storage, true)).toBe(true);
    // Private browsing: nothing is written, and nothing is remembered.
    expect(isMusicPipSeen(storage, false)).toBe(false);
  });
});
