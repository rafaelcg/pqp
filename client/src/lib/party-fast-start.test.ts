import { afterEach, describe, expect, it } from "vitest";
import {
  BUBBLES_FILM_DEFER_MS,
  bubblesFilmAllowed,
  partyFastStartActive,
  resetPartyFastStartForTests,
  setPartyFastStart,
  shouldPreloadHlsEngine,
  startingSoonLineKeys,
  startupCaption,
} from "./party-fast-start";
import { STARTING_SOON_LINE_KEYS } from "./stream-starting-soon";

afterEach(resetPartyFastStartForTests);

describe("party_fast_start state", () => {
  it("is off until the app shell writes the server's answer", () => {
    expect(partyFastStartActive()).toBe(false);
    setPartyFastStart(true);
    expect(partyFastStartActive()).toBe(true);
    setPartyFastStart(false);
    expect(partyFastStartActive()).toBe(false);
  });
});

describe("shouldPreloadHlsEngine", () => {
  it("preloads only with the flag on AND a watch party channel open", () => {
    expect(shouldPreloadHlsEngine(true, true)).toBe(true);
    expect(shouldPreloadHlsEngine(true, false)).toBe(false);
    expect(shouldPreloadHlsEngine(false, true)).toBe(false);
    expect(shouldPreloadHlsEngine(false, false)).toBe(false);
  });
});

describe("the holding screen", () => {
  it("keeps every line with the flag off, and drops the censored ones with it on", () => {
    expect(startingSoonLineKeys(STARTING_SOON_LINE_KEYS, false)).toEqual(
      STARTING_SOON_LINE_KEYS,
    );
    const kept = startingSoonLineKeys(STARTING_SOON_LINE_KEYS, true);
    expect(kept).toHaveLength(STARTING_SOON_LINE_KEYS.length - 2);
    expect(kept).not.toContain("voice.watchParty.startingSoon.line4");
    expect(kept).not.toContain("voice.watchParty.startingSoon.line5");
  });

  it("never fetches the film on a link the browser calls slow", () => {
    expect(bubblesFilmAllowed(null)).toBe(true);
    expect(bubblesFilmAllowed({ effectiveType: "4g" })).toBe(true);
    expect(bubblesFilmAllowed({ effectiveType: "3g" })).toBe(false);
    expect(bubblesFilmAllowed({ effectiveType: "4g", saveData: true })).toBe(false);
  });

  it("holds the film back longer than a healthy start takes", () => {
    expect(BUBBLES_FILM_DEFER_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe("startupCaption", () => {
  it("names the stage while it is short, then counts out loud", () => {
    expect(startupCaption("connecting", 1).key).toBe("voice.hls.startup.connecting");
    expect(startupCaption("media", 3).key).toBe("voice.hls.startup.media");
    expect(startupCaption("media", 5.4)).toEqual({
      key: "voice.hls.startup.slow",
      seconds: 5,
    });
    expect(startupCaption("connecting", 27.9).seconds).toBe(27);
  });
});
