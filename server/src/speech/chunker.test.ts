import { describe, expect, it } from "vitest";
import {
  dedupeOverlap,
  normalizeWords,
  planWindows,
  stitchWindows,
  transcribeChunked,
  type AudioWindow,
} from "./chunker.js";
import { createReplayProvider } from "./providers/replay.js";

describe("planWindows", () => {
  it("plans 8 s windows with 1 s overlap and covers the whole timeline", () => {
    const w = planWindows(20_000);
    expect(w.map((x) => [x.startMs, x.endMs])).toEqual([
      [0, 8000],
      [7000, 15000],
      [14000, 20000],
    ]);
  });

  it("does not add a window that would be only overlap", () => {
    // 15 s: second window ends at 15 s, a third would start at 14 s with 1 s of audio, all already heard.
    expect(planWindows(15_000).map((x) => x.endMs)).toEqual([8000, 15000]);
  });

  it("handles audio shorter than a window and empty audio", () => {
    expect(planWindows(3000)).toEqual([{ index: 0, startMs: 0, endMs: 3000 }]);
    expect(planWindows(0)).toEqual([]);
  });

  it("rejects an overlap that is not smaller than the window", () => {
    expect(() => planWindows(10_000, { windowMs: 1000, overlapMs: 1000 })).toThrow();
  });
});

describe("normalizeWords", () => {
  it("folds case, accents and punctuation", () => {
    expect(normalizeWords("Olá, Baú! Não é?")).toEqual(["ola", "bau", "nao", "e"]);
  });
});

describe("dedupeOverlap", () => {
  it("drops the words the next segment repeats from the previous one", () => {
    expect(dedupeOverlap("eu acho que a gente vai", "a gente vai ganhar essa")).toBe("ganhar essa");
  });

  it("ignores case, accents and punctuation when matching", () => {
    expect(dedupeOverlap("isso é muito bom, né?", "Né? então bora")).toBe("então bora");
  });

  it("leaves unrelated text alone", () => {
    expect(dedupeOverlap("primeira frase", "segunda frase diferente")).toBe("segunda frase diferente");
  });

  it("returns empty when the next segment is entirely a repeat", () => {
    expect(dedupeOverlap("vamos nessa", "vamos nessa")).toBe("");
  });
});

// One long recording, as a single absolute timeline.
const CUES = [
  { start: 0.5, end: 3.0, text: "Fala galera tudo bem" },
  { start: 4.0, end: 7.5, text: "hoje o filme é um clássico" },
  { start: 7.6, end: 8.4, text: "olha só essa cena" },
  { start: 10.0, end: 13.5, text: "vocês viram o que ele fez" },
  { start: 14.2, end: 17.0, text: "eu não acredito nisso" },
];

function windowsFor(totalMs: number) {
  return planWindows(totalMs);
}

describe("stitchWindows", () => {
  it("rebuilds the timeline with no duplicated words across the overlaps", async () => {
    const provider = createReplayProvider({
      cues: CUES,
      windowStartMs: (audio) => Number(audio),
      windowMs: 8000,
    });
    const wins = windowsFor(18_000);
    const results = [];
    for (const w of wins) {
      const r = await provider.transcribe(String(w.startMs), {});
      results.push({ window: w, segments: r.segments });
    }
    const stitched = stitchWindows(results);
    const text = stitched.map((s) => s.text).join(" ");
    // Every cue is present once.
    for (const c of CUES) expect(text.split(c.text).length - 1).toBe(1);
    // Timestamps are absolute and ordered.
    expect(stitched[0]?.start).toBeCloseTo(0.5, 1);
    for (let i = 1; i < stitched.length; i++) {
      expect(stitched[i]?.start).toBeGreaterThanOrEqual((stitched[i - 1]?.start ?? 0) - 0.01);
    }
  });

  it("trims a repeated tail when two windows both heard the same boundary words", () => {
    const w0: AudioWindow = { index: 0, startMs: 0, endMs: 8000 };
    const w1: AudioWindow = { index: 1, startMs: 7000, endMs: 15000 };
    const out = stitchWindows([
      { window: w0, segments: [{ start: 5.0, end: 7.9, text: "e aí a gente foi pra casa" }] },
      // Window 1 re-heard the end ("pra casa") at its start (absolute 7.0 to 8.0).
      { window: w1, segments: [{ start: 0.0, end: 2.0, text: "pra casa e dormiu" }] },
    ]);
    expect(out.map((s) => s.text).join(" ")).toBe("e aí a gente foi pra casa e dormiu");
  });

  it("does not collapse genuine repetition when the segments do not overlap in time", () => {
    const w0: AudioWindow = { index: 0, startMs: 0, endMs: 8000 };
    const out = stitchWindows([
      {
        window: w0,
        segments: [
          { start: 1, end: 2, text: "não" },
          { start: 3, end: 4, text: "não" },
        ],
      },
    ]);
    expect(out.map((s) => s.text)).toEqual(["não", "não"]);
  });

  it("is stable when results arrive out of order", () => {
    const w0: AudioWindow = { index: 0, startMs: 0, endMs: 8000 };
    const w1: AudioWindow = { index: 1, startMs: 7000, endMs: 12000 };
    const a = { window: w0, segments: [{ start: 1, end: 2, text: "um" }] };
    const b = { window: w1, segments: [{ start: 2, end: 3, text: "dois" }] };
    expect(stitchWindows([b, a])).toEqual(stitchWindows([a, b]));
  });
});

describe("transcribeChunked", () => {
  it("skips gated windows without calling the provider, and counts requests and cost", async () => {
    const calls: number[] = [];
    const provider = createReplayProvider({
      cues: CUES,
      windowStartMs: (audio) => Number(audio),
      windowMs: 8000,
      onCall: ({ audio }) => calls.push(Number(audio)),
    });
    const wins = windowsFor(18_000);
    const res = await transcribeChunked({
      provider,
      windows: wins,
      readWindow: async (w) => String(w.startMs),
      gate: (w) => w.index !== 1,
    });
    expect(calls).toEqual([0, 14_000]);
    expect(res.requests).toBe(2);
    expect(res.windows.filter((w) => w.skipped).map((w) => w.window.index)).toEqual([1]);
  });

  it("carries the tail of what was heard as the next prompt, after the glossary", async () => {
    const prompts: Array<string | undefined> = [];
    const provider = createReplayProvider({
      cues: CUES,
      windowStartMs: (audio) => Number(audio),
      windowMs: 8000,
      onCall: ({ opts }) => prompts.push(opts.prompt),
    });
    await transcribeChunked({
      provider,
      windows: windowsFor(18_000),
      readWindow: async (w) => String(w.startMs),
      glossary: "pqp, QG",
      carryPromptChars: 20,
    });
    expect(prompts[0]).toBe("pqp, QG");
    expect(prompts[1]?.startsWith("pqp, QG ")).toBe(true);
    expect(prompts[1]?.length).toBeGreaterThan("pqp, QG ".length);
  });
});
