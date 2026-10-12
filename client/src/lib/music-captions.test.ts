// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  CAPTIONS_READ_ATTEMPTS,
  getMusicCaptions,
  musicCaptionsChoices,
  resetMusicCaptionsForTests,
  resolveCaptionsTarget,
  setMusicCaptions,
  setMusicCaptionsApply,
  startMusicCaptionsSync,
  type CaptionTrack,
  type CaptionsPlayer,
} from "@/lib/music-captions";

const track = (languageCode: string, kind = ""): CaptionTrack => ({
  languageCode,
  displayName: languageCode,
  kind,
});

// The TED talk from the report: English, both Portuguese, and YouTube's
// translation list, which names Brazilian Portuguese plain `pt`.
const TED = [track("en"), track("pt-BR"), track("pt-PT")];
const TRANSLATIONS = ["en", "pt", "pt-PT", "es"];

beforeEach(() => {
  localStorage.clear();
  resetMusicCaptionsForTests();
});

describe("resolveCaptionsTarget", () => {
  it("takes the video's own track in the exact language", () => {
    expect(resolveCaptionsTarget(TED, TRANSLATIONS, "pt-BR")).toEqual({
      languageCode: "pt-BR",
    });
  });

  it("falls back to the same language in another region", () => {
    expect(resolveCaptionsTarget([track("en"), track("pt-PT")], [], "pt-BR")).toEqual({
      languageCode: "pt-PT",
    });
  });

  it("prefers a person's track over a generated one", () => {
    expect(
      resolveCaptionsTarget([track("en", "asr"), track("en")], [], "en-US"),
    ).toEqual({ languageCode: "en" });
  });

  it("translates when the video has no track in the language", () => {
    expect(resolveCaptionsTarget([track("en")], TRANSLATIONS, "pt-BR")).toEqual({
      languageCode: "en",
      translationLanguage: { languageCode: "pt" },
    });
  });

  it("shows the original rather than nothing when nothing matches", () => {
    expect(resolveCaptionsTarget([track("ja")], [], "pt-BR")).toEqual({
      languageCode: "ja",
    });
  });

  it("is nothing for a video with no tracks", () => {
    expect(resolveCaptionsTarget([], TRANSLATIONS, "pt-BR")).toBeNull();
  });
});

describe("the captions preference", () => {
  it("is off until the viewer turns it on", () => {
    expect(getMusicCaptions().on).toBe(false);
  });

  it("saves the choice and applies it", () => {
    let applied = 0;
    setMusicCaptionsApply(() => {
      applied += 1;
    });
    setMusicCaptions("pt-BR");
    expect(getMusicCaptions()).toMatchObject({ on: true, lang: "pt-BR" });
    expect(localStorage.getItem("pqp:music-captions")).toBe("1");
    expect(applied).toBe(1);
    resetMusicCaptionsForTests();
    expect(getMusicCaptions()).toMatchObject({ on: true, lang: "pt-BR" });
  });

  it("keeps the last language while captions are off", () => {
    setMusicCaptions("en");
    setMusicCaptions(null);
    expect(getMusicCaptions()).toMatchObject({ on: false, lang: "en" });
  });
});

function fakePlayer(tracklistAfter = 0) {
  const calls: unknown[] = [];
  let reads = 0;
  const player: CaptionsPlayer = {
    loadModule: () => {},
    getOption: (_module, option) => {
      if (option === "tracklist") {
        reads += 1;
        return reads > tracklistAfter ? TED : [];
      }
      if (option === "translationLanguages") {
        return TRANSLATIONS.map((languageCode) => ({ languageCode }));
      }
      return undefined;
    },
    setOption: (_module, _option, value) => {
      calls.push(value);
    },
  };
  return { player, calls };
}

function manualTimers() {
  const queue: Array<() => void> = [];
  return {
    timers: {
      set: (fn: () => void) => {
        queue.push(fn);
        return queue.length;
      },
      clear: () => {
        queue.length = 0;
      },
    },
    flush: () => {
      while (queue.length > 0) {
        queue.shift()!();
      }
    },
  };
}

describe("startMusicCaptionsSync", () => {
  it("hides YouTube's own default when the viewer has captions off", () => {
    const { player, calls } = fakePlayer();
    startMusicCaptionsSync(player, () => "pt-BR");
    expect(calls).toEqual([{}]);
    expect(getMusicCaptions().tracks).toEqual(TED);
  });

  it("puts the viewer's language on, every new track", () => {
    setMusicCaptions("pt-BR");
    const first = fakePlayer();
    startMusicCaptionsSync(first.player, () => "pt-BR");
    expect(first.calls).toEqual([{ languageCode: "pt-BR" }]);
    // The next room track is a new sync; YouTube's default does not leak in.
    const second = fakePlayer();
    startMusicCaptionsSync(second.player, () => "pt-BR");
    expect(second.calls).toEqual([{ languageCode: "pt-BR" }]);
  });

  it("waits for a track list that arrives late, keeping captions hidden meanwhile", () => {
    setMusicCaptions("pt-BR");
    const { player, calls } = fakePlayer(2);
    const { timers, flush } = manualTimers();
    startMusicCaptionsSync(player, () => "pt-BR", timers);
    expect(getMusicCaptions().tracks).toBeNull();
    flush();
    expect(calls).toEqual([{}, {}, { languageCode: "pt-BR" }]);
  });

  it("gives up on a video with no captions and says it has none", () => {
    const { player } = fakePlayer(Number.POSITIVE_INFINITY);
    const { timers, flush } = manualTimers();
    startMusicCaptionsSync(player, () => "pt-BR", timers);
    flush();
    expect(getMusicCaptions().tracks).toEqual([]);
    expect(CAPTIONS_READ_ATTEMPTS).toBeGreaterThan(1);
  });

  it("stops when cancelled", () => {
    const { player, calls } = fakePlayer(1);
    const { timers, flush } = manualTimers();
    const cancel = startMusicCaptionsSync(player, () => "pt-BR", timers);
    cancel();
    flush();
    expect(calls).toEqual([{}]);
  });

  it("survives a player without the captions module", () => {
    expect(() => startMusicCaptionsSync({}, () => "pt-BR")).not.toThrow();
  });
});

describe("musicCaptionsChoices", () => {
  const labels = {
    offLabel: "Desligadas",
    autoTranslatedLabel: (language: string) => `${language} (tradução automática)`,
    generatedLabel: (language: string) => `${language} (gerada automaticamente)`,
    languageName: (code: string) => code,
  };

  it("offers off, then the viewer's language first, then the rest", () => {
    const choices = musicCaptionsChoices({
      state: { on: true, lang: "pt-BR", tracks: TED, translations: TRANSLATIONS },
      uiLocale: "pt-BR",
      ...labels,
    });
    expect(choices.map((choice) => [choice.label, choice.checked])).toEqual([
      ["Desligadas", false],
      ["pt-BR", true],
      ["pt-PT", false],
      ["en", false],
    ]);
  });

  it("offers a translation into the viewer's language when the video has none", () => {
    const choices = musicCaptionsChoices({
      state: { on: true, lang: "pt-BR", tracks: [track("en")], translations: TRANSLATIONS },
      uiLocale: "pt-BR",
      ...labels,
    });
    expect(choices.map((choice) => [choice.label, choice.lang, choice.checked])).toEqual([
      ["Desligadas", null, false],
      ["pt-BR (tradução automática)", "pt-BR", true],
      ["en", "en", false],
    ]);
  });

  it("ticks off when captions are off", () => {
    const choices = musicCaptionsChoices({
      state: { on: false, lang: "pt-BR", tracks: TED, translations: [] },
      uiLocale: "pt-BR",
      ...labels,
    });
    expect(choices.filter((choice) => choice.checked).map((choice) => choice.id)).toEqual([
      "off",
    ]);
  });

  it("lists a generated track only when its language has no person's track", () => {
    const both = musicCaptionsChoices({
      state: {
        on: true,
        lang: "en",
        tracks: [track("en", "asr"), track("en")],
        translations: [],
      },
      uiLocale: "en",
      ...labels,
    });
    expect(both.map((choice) => [choice.label, choice.checked])).toEqual([
      ["Desligadas", false],
      ["en", true],
    ]);
    const generatedOnly = musicCaptionsChoices({
      state: { on: true, lang: "ja", tracks: [track("ja", "asr")], translations: [] },
      uiLocale: "pt-BR",
      ...labels,
    });
    expect(generatedOnly.map((choice) => [choice.label, choice.checked])).toEqual([
      ["Desligadas", false],
      ["ja (gerada automaticamente)", true],
    ]);
  });

  it("keeps two regional translations apart, and merges ones that resolve the same", () => {
    const apart = musicCaptionsChoices({
      state: { on: true, lang: "pt-PT", tracks: [track("en")], translations: TRANSLATIONS },
      uiLocale: "pt-BR",
      ...labels,
    });
    expect(apart.map((choice) => [choice.label, choice.checked])).toEqual([
      ["Desligadas", false],
      ["pt-BR (tradução automática)", false],
      ["pt-PT (tradução automática)", true],
      ["en", false],
    ]);
    const merged = musicCaptionsChoices({
      state: { on: true, lang: "pt", tracks: [track("en")], translations: TRANSLATIONS },
      uiLocale: "pt-BR",
      ...labels,
    });
    expect(merged.map((choice) => [choice.label, choice.checked])).toEqual([
      ["Desligadas", false],
      ["pt-BR (tradução automática)", true],
      ["en", false],
    ]);
  });

  it("offers and ticks the translation into a saved language that is not the UI's", () => {
    const choices = musicCaptionsChoices({
      state: { on: true, lang: "es", tracks: [track("en")], translations: TRANSLATIONS },
      uiLocale: "pt-BR",
      ...labels,
    });
    expect(choices.map((choice) => [choice.label, choice.lang, choice.checked])).toEqual([
      ["Desligadas", null, false],
      ["pt-BR (tradução automática)", "pt-BR", false],
      ["es (tradução automática)", "es", true],
      ["en", "en", false],
    ]);
  });

});
