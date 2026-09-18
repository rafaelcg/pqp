import { describe, expect, it } from "vitest";
import {
  CALL_STRIPPED_SNR_DB,
  GAME_PRESENT_SNR_DB,
  LEAK_SNR_DB,
  analyseToneFrame,
  goertzelMagnitude,
  judgeShareAudioRow,
  sineFrame,
  summariseToneFrames,
} from "./share-audio-probe";

const SAMPLE_RATE = 48_000;

describe("goertzelMagnitude", () => {
  it("peaks at the tone that is actually in the frame", () => {
    const samples = sineFrame(440, SAMPLE_RATE);
    const at440 = goertzelMagnitude(samples, SAMPLE_RATE, 440);
    const at880 = goertzelMagnitude(samples, SAMPLE_RATE, 880);
    expect(at440).toBeGreaterThan(at880 * 8);
  });

  it("is near zero on silence", () => {
    expect(goertzelMagnitude(new Float32Array(2048), SAMPLE_RATE, 440)).toBe(0);
  });
});

describe("analyseToneFrame", () => {
  it("reports a high SNR at 440 for a call-stand-in tone", () => {
    const levels = analyseToneFrame(sineFrame(440, SAMPLE_RATE), SAMPLE_RATE);
    expect(levels.snr440).toBeGreaterThan(LEAK_SNR_DB);
    expect(levels.snr880).toBeLessThan(CALL_STRIPPED_SNR_DB);
  });

  it("reports a high SNR at 880 for a game-stand-in tone", () => {
    const levels = analyseToneFrame(sineFrame(880, SAMPLE_RATE), SAMPLE_RATE);
    expect(levels.snr880).toBeGreaterThan(GAME_PRESENT_SNR_DB);
    expect(levels.snr440).toBeLessThan(CALL_STRIPPED_SNR_DB);
  });
});

describe("summariseToneFrames", () => {
  it("takes the median so one loud frame cannot fake a leak", () => {
    const quiet = analyseToneFrame(new Float32Array(2048), SAMPLE_RATE);
    const loud = analyseToneFrame(sineFrame(440, SAMPLE_RATE), SAMPLE_RATE);
    const mixed = summariseToneFrames([quiet, quiet, loud]);
    expect(mixed.snr440).toBeLessThan(loud.snr440);
  });
});

describe("judgeShareAudioRow", () => {
  it("PASSes when the game is in the track and the call is at the floor", () => {
    const judged = judgeShareAudioRow(
      {
        floor: -50,
        call440: -48,
        game880: -20,
        hiss1320: -50,
        snr440: 2,
        snr880: 30,
        snr1320: 0,
      },
      { hasTrack: true },
    );
    expect(judged.verdict).toBe("PASS");
  });

  it("FAILs a leak when 440 is still in a published track", () => {
    const judged = judgeShareAudioRow(
      {
        floor: -50,
        call440: -30,
        game880: -20,
        hiss1320: -50,
        snr440: 20,
        snr880: 30,
        snr1320: 0,
      },
      { hasTrack: true },
    );
    expect(judged.verdict).toBe("FAIL_LEAK");
  });

  it("FAILs the control when 440 never appears", () => {
    const judged = judgeShareAudioRow(
      {
        floor: -50,
        call440: -49,
        game880: -50,
        hiss1320: -50,
        snr440: 1,
        snr880: 0,
        snr1320: 0,
      },
      { control: true, hasTrack: true },
    );
    expect(judged.verdict).toBe("CONTROL_DEAF");
  });

  it("treats a missing track as fail-closed, not as a stripped call", () => {
    const judged = judgeShareAudioRow(
      {
        floor: Number.NEGATIVE_INFINITY,
        call440: Number.NEGATIVE_INFINITY,
        game880: Number.NEGATIVE_INFINITY,
        hiss1320: Number.NEGATIVE_INFINITY,
        snr440: 0,
        snr880: 0,
        snr1320: 0,
      },
      { hasTrack: false },
    );
    expect(judged.verdict).toBe("NO_TRACK");
  });
});
