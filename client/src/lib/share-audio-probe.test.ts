import { afterEach, describe, expect, it } from "vitest";
import {
  CALL_STRIPPED_SNR_DB,
  GAME_PRESENT_SNR_DB,
  LEAK_SNR_DB,
  analyseToneFrame,
  goertzelMagnitude,
  installShareAudioProbe,
  judgeShareAudioRow,
  sineFrame,
  summariseToneFrames,
} from "./share-audio-probe";
import { createShareRequestGuard } from "./share-request-guard";

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

/**
 * (c) RE-LAND GUARDRAIL: the runtime echo backstop is present and wired.
 *
 * #724 deleted `share-audio-probe.ts` and `share-request-guard.ts` whole,
 * leaving desktop with a single layer of protection. The re-land restores
 * both. This is the browser-independent proof that they are here and do their
 * job: the diagnostic handle installs on `window`, and its judgement still
 * flags a track that carries the call. If either module were removed again,
 * this file would not import and this suite would fail outright.
 */
describe("runtime echo backstop is wired", () => {
  const g = globalThis as { window?: unknown };
  const hadWindow = "window" in g;
  const priorWindow = g.window;

  afterEach(() => {
    if (hadWindow) {
      g.window = priorWindow;
    } else {
      delete g.window;
    }
  });

  it("installs the console probe handle and is idempotent", () => {
    // A bare stand-in for `window`: `installShareAudioProbe` only reads/writes
    // `window.pqpShareAudioProbe`, so no jsdom is needed to prove the wiring.
    const win: Record<string, unknown> = {};
    g.window = win;

    installShareAudioProbe();
    const handle = win.pqpShareAudioProbe as
      | Record<string, unknown>
      | undefined;
    expect(handle).toBeDefined();
    for (const method of [
      "playCallTone",
      "stopCallTone",
      "measure",
      "controlCapture",
      "help",
    ]) {
      expect(typeof handle?.[method]).toBe("function");
    }

    // Idempotent: a second install does not replace a live handle, so the
    // console reference a probing operator holds does not go stale.
    installShareAudioProbe();
    expect(win.pqpShareAudioProbe).toBe(handle);
  });

  it("still calls a leaked track a leak", () => {
    // The backstop's whole reason to exist: 440 (the call) above the leak gate
    // in a published track is FAIL_LEAK, not a pass.
    const judged = judgeShareAudioRow(
      {
        floor: -50,
        call440: -30,
        game880: -20,
        hiss1320: -50,
        snr440: LEAK_SNR_DB + 8,
        snr880: 30,
        snr1320: 0,
      },
      { hasTrack: true },
    );
    expect(judged.verdict).toBe("FAIL_LEAK");
  });

  it("provides the in-flight share guard the re-land re-adds", () => {
    // `share-request-guard.ts` is the other module #724 removed. Its unit
    // behaviour is pinned in its own suite; this asserts only that it is here
    // and usable from the same feature, so a second removal fails to import.
    const guard = createShareRequestGuard();
    const token = guard.tryBegin();
    expect(token).not.toBeNull();
    expect(guard.tryBegin()).toBeNull();
  });
});
