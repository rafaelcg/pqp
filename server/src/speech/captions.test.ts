import { describe, expect, it } from "vitest";
import {
  applyTranslatedCueTexts,
  batchCueTexts,
  buildCaptionCues,
  CAPTION_CUE_CHARS,
  CAPTION_CUE_MAX_SECONDS,
  captionCuesHash,
  CaptionTranslationMismatch,
  escapeCueText,
  parseStoredCues,
  splitCueText,
  toWebVtt,
  vttTimestamp,
  wrapCueText,
} from "./captions.js";
import { planWindows, stitchWindows } from "./chunker.js";
import { videoDemuxerFor } from "./transcode.js";

describe("videoDemuxerFor", () => {
  it("names the demuxer from the bytes, and refuses anything that is not MP4 or WebM", () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom")]);
    expect(videoDemuxerFor(mp4)).toBe("mov");
    expect(videoDemuxerFor(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).toBe("matroska");
    expect(videoDemuxerFor(Buffer.from("#EXTM3U\nhttp://169.254.169.254/latest\n"))).toBeNull();
    expect(videoDemuxerFor(Buffer.from("ffconcat version 1.0\n"))).toBeNull();
    expect(videoDemuxerFor(Buffer.alloc(0))).toBeNull();
  });
});

describe("buildCaptionCues", () => {
  it("keeps what was said, in order, on Whisper's timings", () => {
    const cues = buildCaptionCues([
      { start: 0.5, end: 2.5, text: " Fala, galera! " },
      { start: 3, end: 5, text: "Hoje é o lançamento do pqp." },
    ]);
    expect(cues).toEqual([
      { start: 0.5, end: 2.5, text: "Fala, galera!" },
      { start: 3, end: 5, text: "Hoje é o lançamento do pqp." },
    ]);
  });

  it("drops what Whisper rated as silence, empty segments and the invented Amara line", () => {
    const cues = buildCaptionCues([
      { start: 0, end: 2, text: "música", noSpeechProb: 0.9 },
      { start: 2, end: 3, text: "   " },
      { start: 3, end: 6, text: "Legendas pela comunidade Amara.org" },
      { start: 6, end: 8, text: "obrigado", noSpeechProb: 0.1 },
    ]);
    expect(cues.map((c) => c.text)).toEqual(["obrigado"]);
  });

  it("collapses a repetition loop", () => {
    const [cue] = buildCaptionCues([{ start: 0, end: 4, text: "valeu valeu valeu valeu valeu valeu" }]);
    expect(cue!.text).toBe("valeu");
  });

  it("splits a long segment into two-line cues and shares its time by length", () => {
    const words = Array.from({ length: 40 }, (_, i) => `palavra${i}`).join(" ");
    const cues = buildCaptionCues([{ start: 10, end: 20, text: words }]);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(CAPTION_CUE_CHARS);
    }
    expect(cues[0]!.start).toBe(10);
    expect(cues.at(-1)!.end).toBeCloseTo(20, 2);
    expect(cues.map((c) => c.text).join(" ")).toBe(words);
  });

  it("splits a short text that stays on screen too long", () => {
    const cues = buildCaptionCues([{ start: 0, end: 20, text: "uma frase curta mas falada devagar demais" }]);
    expect(cues.length).toBeGreaterThanOrEqual(Math.ceil(20 / CAPTION_CUE_MAX_SECONDS));
  });

  it("never lets a cue start before the previous one ends, and holds a flash for a second", () => {
    const cues = buildCaptionCues([
      { start: 1, end: 1.2, text: "oi" },
      { start: 1.1, end: 3, text: "tudo bem?" },
      { start: 10, end: 10.1, text: "tchau" },
    ]);
    expect(cues[1]!.start).toBeGreaterThanOrEqual(cues[0]!.end);
    // Held up to a second, but never into the next cue.
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start);
    expect(cues[2]!.end - cues[2]!.start).toBeCloseTo(1, 3);
  });

  it("works on windows stitched from a long video", () => {
    const windows = planWindows(65_000, { windowMs: 30_000, overlapMs: 1_000 });
    expect(windows.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 30_000],
      [29_000, 59_000],
      [58_000, 65_000],
    ]);
    const segments = stitchWindows([
      { window: windows[0]!, segments: [{ start: 1, end: 4, text: "primeiro" }] },
      { window: windows[1]!, segments: [{ start: 1, end: 4, text: "segundo" }] },
      { window: windows[2]!, segments: [{ start: 1, end: 4, text: "terceiro" }] },
    ]);
    expect(buildCaptionCues(segments).map((c) => [c.start, c.text])).toEqual([
      [1, "primeiro"],
      [30, "segundo"],
      [59, "terceiro"],
    ]);
  });
});

describe("WebVTT", () => {
  it("formats timestamps as HH:MM:SS.mmm", () => {
    expect(vttTimestamp(0)).toBe("00:00:00.000");
    expect(vttTimestamp(61.5)).toBe("00:01:01.500");
    expect(vttTimestamp(3_723.0456)).toBe("01:02:03.046");
  });

  it("wraps at the space nearest the middle, two lines at most", () => {
    expect(wrapCueText("curto")).toBe("curto");
    const wrapped = wrapCueText("isso aqui é uma legenda comprida que precisa de duas linhas");
    expect(wrapped.split("\n")).toHaveLength(2);
  });

  it("escapes markup so a speaker's words are always text", () => {
    expect(escapeCueText("a <b>c</b> & d --> e")).toBe("a &lt;b&gt;c&lt;/b&gt; &amp; d --&gt; e");
  });

  it("renders a file a browser accepts", () => {
    const vtt = toWebVtt([
      { start: 0.5, end: 2, text: "Fala, galera!" },
      { start: 2, end: 2, text: "zero length is dropped" },
      { start: 3, end: 4.25, text: "<script>" },
    ]);
    expect(vtt).toBe(
      "WEBVTT\n\n1\n00:00:00.500 --> 00:00:02.000\nFala, galera!\n\n2\n00:00:03.000 --> 00:00:04.250\n&lt;script&gt;\n",
    );
  });

  it("an empty track is still a valid file", () => {
    expect(toWebVtt([])).toBe("WEBVTT\n\n");
  });
});

describe("translated cues", () => {
  const source = [
    { start: 0, end: 2, text: "Fala, galera!" },
    { start: 2, end: 5, text: "Hoje é o lançamento." },
  ];

  it("swaps only the words and keeps every timing", () => {
    expect(applyTranslatedCueTexts(source, [" Hey, everyone! ", "Today is the launch."])).toEqual([
      { start: 0, end: 2, text: "Hey, everyone!" },
      { start: 2, end: 5, text: "Today is the launch." },
    ]);
  });

  it("refuses an answer of the wrong length: a shifted cue shows the wrong line", () => {
    expect(() => applyTranslatedCueTexts(source, ["Hey, everyone! Today is the launch."])).toThrow(
      CaptionTranslationMismatch,
    );
  });

  it("refuses an empty translation of a cue that had words", () => {
    expect(() => applyTranslatedCueTexts(source, ["Hey", "  "])).toThrow(CaptionTranslationMismatch);
  });

  it("cuts a cue the model answered with an essay", () => {
    const [cue] = applyTranslatedCueTexts([{ start: 0, end: 1, text: "oi" }], ["x".repeat(500)]);
    expect(cue!.text.length).toBeLessThanOrEqual(2 * 3 + 40);
  });

  it("batches cue texts by count and by characters, in order", () => {
    const texts = Array.from({ length: 130 }, (_, i) => `cue ${i}`);
    const batches = batchCueTexts(texts, 60, 3_000);
    expect(batches.map((b) => b.length)).toEqual([60, 60, 10]);
    expect(batches.flat()).toEqual(texts);
    const long = batchCueTexts(["a".repeat(2_000), "b".repeat(2_000), "c"], 60, 3_000);
    expect(long.map((b) => b.length)).toEqual([1, 2]);
  });

  it("the source hash moves with any change to a cue", () => {
    const moved = [{ ...source[0]!, end: 2.1 }, source[1]!];
    expect(captionCuesHash(source)).toBe(captionCuesHash([...source]));
    expect(captionCuesHash(moved)).not.toBe(captionCuesHash(source));
  });

  it("reads stored cues defensively", () => {
    expect(parseStoredCues([{ start: 1, end: 2, text: "ok" }, { start: "x" }, null])).toEqual([
      { start: 1, end: 2, text: "ok" },
    ]);
    expect(parseStoredCues("nope")).toEqual([]);
  });

  it("splitCueText never returns an empty piece", () => {
    expect(splitCueText("  ")).toEqual([]);
    expect(splitCueText("a ".repeat(100), 10).every((p) => p.length > 0 && p.length <= 10)).toBe(true);
  });
});
