import { describe, expect, it } from "vitest";

/**
 * Opening a song never starts sound (launch screenshots, problem 1). The wish used to travel in
 * places that work only once the audio context is running, that is, after a first listen: a
 * `history.state` flag from the site's home, `setOpenAutoplay(true)` from a card and from a take
 * just posted, and a panel whose `autoplay` defaulted to true. These read the sources, because the
 * regression is a caller putting one back.
 */
describe("opening a song never plays it", () => {
  it("the site's home carries no play wish to the song page, and the song page reads none", async () => {
    const home = (await import("../jam-site/home.tsx?raw")).default;
    const song = (await import("../jam-site/song.tsx?raw")).default;
    const player = (await import("../jam-site/player.ts?raw")).default;
    for (const source of [home, song, player]) {
      expect(source).not.toMatch(/autoplay|unlockAudioInGesture/i);
    }
  });

  it("the app's wall opens a card paused, and only the round play button asks to play", async () => {
    const pane = (await import("../components/jam/jam-pane.tsx?raw")).default;
    expect(pane).not.toMatch(/setOpenAutoplay\(true\)/);
    expect(pane).toMatch(/setOpenAutoplay\(via === "play"\)/);
  });

  it("the song panel does not play by default, and counts a play only for a person's start", async () => {
    const panel = (await import("../components/jam/jam-song-panel.tsx?raw")).default;
    expect(panel).toMatch(/autoplay = false,/);
    expect(panel).toMatch(/publicView && playing && personStarted\.current/);
  });
});
