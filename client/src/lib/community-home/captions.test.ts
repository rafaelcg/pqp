// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  captionLanguageName,
  captionsOnByDefault,
  COMMUNITY_HOME_CAPTIONS_PREF_KEY,
  pickCaptionTrack,
  readCaptionsPreference,
  resetCaptionsPreferenceForTests,
  writeCaptionsPreference,
} from "./captions";

afterEach(() => {
  window.localStorage.clear();
  resetCaptionsPreferenceForTests();
});

describe("captions on by default", () => {
  it("on when the video is in another language than the reader's", () => {
    expect(captionsOnByDefault("pt", "en", null)).toBe(true);
    expect(captionsOnByDefault("pt", "es", null)).toBe(true);
  });

  it("off when it is the reader's own (pt-BR is pt)", () => {
    expect(captionsOnByDefault("pt", "pt-BR", null)).toBe(false);
    expect(captionsOnByDefault("en", "en", null)).toBe(false);
  });

  it("on when Whisper could not tell the language", () => {
    expect(captionsOnByDefault("und", "pt-BR", null)).toBe(true);
  });

  it("a choice made with the CC button wins, and is remembered", () => {
    writeCaptionsPreference("off");
    expect(window.localStorage.getItem(COMMUNITY_HOME_CAPTIONS_PREF_KEY)).toBe("off");
    expect(readCaptionsPreference()).toBe("off");
    expect(captionsOnByDefault("pt", "en")).toBe(false);
    writeCaptionsPreference("on");
    expect(captionsOnByDefault("pt", "pt-BR")).toBe(true);
  });
});

describe("which track", () => {
  const tracks = [
    { lang: "pt", source: true },
    { lang: "en", source: false },
  ];

  it("the reader's language when there is a track in it", () => {
    expect(pickCaptionTrack(tracks, "en")?.lang).toBe("en");
    expect(pickCaptionTrack(tracks, "pt-BR")?.lang).toBe("pt");
  });

  it("otherwise what was said", () => {
    expect(pickCaptionTrack(tracks, "es")?.lang).toBe("pt");
    expect(pickCaptionTrack([], "es")).toBeNull();
  });
});

describe("track names", () => {
  it("names the language in the reader's UI language", () => {
    expect(captionLanguageName("pt", "en")).toBe("Portuguese");
    expect(captionLanguageName("en", "pt-BR")).toBe("Inglês");
    expect(captionLanguageName("und", "en")).toBeNull();
  });
});
