import { describe, expect, it } from "vitest";
import { holdJamSong, isJamSongOpen } from "./jam-hint-context";

describe("holdJamSong: a counter, so the last panel to close is the one that clears it (Farol, PR 1778)", () => {
  it("stays held while any panel is open, whichever closes first", () => {
    expect(isJamSongOpen()).toBe(false);
    const channelPanel = holdJamSong();
    const publicView = holdJamSong();
    expect(isJamSongOpen()).toBe(true);
    // the public view closes over the channel song that is still open: the controls stay protected
    publicView();
    expect(isJamSongOpen()).toBe(true);
    channelPanel();
    expect(isJamSongOpen()).toBe(false);
  });

  it("works in the other order too", () => {
    const a = holdJamSong();
    const b = holdJamSong();
    a();
    expect(isJamSongOpen()).toBe(true);
    b();
    expect(isJamSongOpen()).toBe(false);
  });

  it("a release is idempotent: a second call does not eat another panel's hold", () => {
    const a = holdJamSong();
    const b = holdJamSong();
    a();
    a();
    expect(isJamSongOpen()).toBe(true);
    b();
    expect(isJamSongOpen()).toBe(false);
  });
});
