import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import {
  MUSIC_PIP_KEY,
  musicPipSpent,
  resetMusicPipForTests,
  subscribeMusicPip,
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
  beforeEach(() => resetMusicPipForTests());

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

  /*
   * THE PANEL IS WHAT SPENDS IT, WHEREVER IT WAS OPENED FROM.
   *
   * The pip was spent by the dock tile's own click, so opening the queue
   * from the sidebar radio's start button or the bar's queue icon left the
   * mark standing: the person had plainly found the feature and the tile
   * went on telling them it was new. And the tile read storage once at
   * mount, so even a stamp written elsewhere did not reach it until the
   * strip remounted.
   */
  it("reports spent to whoever is drawing the pip, and says so once", () => {
    const seen: boolean[] = [];
    const stop = subscribeMusicPip(() => seen.push(musicPipSpent()));
    expect(musicPipSpent()).toBe(false);
    rememberMusicPip(memory(), true);
    expect(musicPipSpent()).toBe(true);
    // Opening the panel again is not a second event for the same fact.
    rememberMusicPip(memory(), true);
    expect(seen).toEqual([true]);
    stop();
  });
});
