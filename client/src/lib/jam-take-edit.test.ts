import { describe, expect, it } from "vitest";
import {
  MIN_AUDIBLE_MS,
  NUDGE_LIMIT_MS,
  asRecorded,
  audibleMs,
  editsFromTrack,
  isEdited,
  patchFor,
  placed,
  signedSeconds,
  withGain,
  withNudge,
  withTrimEnd,
  withTrimStart,
} from "./jam-take-edit";

const take = { offsetMs: -2400, trimStartMs: 2400, trimEndMs: 0, durationMs: 62400 };

describe("a take posted with no edits", () => {
  it("is exactly what the engine placed", () => {
    const edits = asRecorded(take);
    expect(isEdited(take, edits)).toBe(false);
    expect(placed(take, edits)).toEqual({ offsetMs: -2400, trimStartMs: 2400, trimEndMs: 0, gain: 1 });
    expect(audibleMs(take, edits)).toBe(60000);
  });
});

describe("trimming", () => {
  it("never reveals the count-in the engine hid", () => {
    const edits = withTrimStart(take, asRecorded(take), 0);
    expect(edits.trimStartMs).toBe(2400);
  });

  it("moves the start later and keeps the audio where it is", () => {
    const edits = withTrimStart(take, asRecorded(take), 5000);
    expect(edits.trimStartMs).toBe(5000);
    expect(placed(take, edits).offsetMs).toBe(-2400);
    expect(isEdited(take, edits)).toBe(true);
  });

  it("keeps something audible whichever end is pulled in", () => {
    const start = withTrimStart(take, asRecorded(take), 10_000_000);
    expect(audibleMs(take, start)).toBe(MIN_AUDIBLE_MS);
    const end = withTrimEnd(take, asRecorded(take), 10_000_000);
    expect(audibleMs(take, end)).toBe(MIN_AUDIBLE_MS);
  });

  it("counts both trims against each other", () => {
    const first = withTrimEnd(take, asRecorded(take), 50_000);
    const both = withTrimStart(take, first, 50_000);
    expect(audibleMs(take, both)).toBeGreaterThanOrEqual(MIN_AUDIBLE_MS);
    expect(both.trimStartMs + both.trimEndMs).toBeLessThan(take.durationMs);
  });

  it("does not let the end trim go negative", () => {
    expect(withTrimEnd(take, asRecorded(take), -5).trimEndMs).toBe(0);
  });
});

describe("nudge and volume", () => {
  it("moves the whole take", () => {
    const edits = withNudge(asRecorded(take), 12);
    expect(placed(take, edits).offsetMs).toBe(-2388);
    expect(placed(take, edits).trimStartMs).toBe(2400);
  });

  it("stays within half a second either way, whole milliseconds", () => {
    expect(withNudge(asRecorded(take), 9999).nudgeMs).toBe(NUDGE_LIMIT_MS);
    expect(withNudge(asRecorded(take), -9999).nudgeMs).toBe(-NUDGE_LIMIT_MS);
    expect(withNudge(asRecorded(take), 3.6).nudgeMs).toBe(4);
  });

  it("keeps the volume between silence and double", () => {
    expect(withGain(asRecorded(take), 5).gain).toBe(2);
    expect(withGain(asRecorded(take), -1).gain).toBe(0);
    expect(withGain(asRecorded(take), 0.5).gain).toBe(0.5);
  });
});

describe("adjusting a posted track", () => {
  const posted = { offsetMs: -2440, trimStartMs: 2440, trimEndMs: 0, gain: 1 };

  it("sends nothing when nothing moved", () => {
    expect(patchFor(posted, editsFromTrack(posted))).toEqual({});
  });

  it("sends only what changed, in whole milliseconds", () => {
    const edits = { ...editsFromTrack(posted), nudgeMs: 12, trimEndMs: 1500.4, gain: 0.8 };
    expect(patchFor(posted, edits)).toEqual({ offsetMs: -2428, trimEndMs: 1500, gain: 0.8 });
  });

  it("lets the start trim go back to the recording's head", () => {
    const edits = withTrimStart({ ...posted, offsetMs: -2440, trimStartMs: 0, durationMs: 60000 }, editsFromTrack(posted), 0);
    expect(patchFor(posted, edits)).toEqual({ trimStartMs: 0 });
  });
});

describe("the trim readouts", () => {
  it("never print a signed zero", () => {
    expect(signedSeconds(0)).toBe("0 s");
    expect(signedSeconds(40)).toBe("0 s");
    expect(signedSeconds(-40)).toBe("0 s");
  });

  it("print tenths with their sign", () => {
    expect(signedSeconds(1500)).toBe("+1.5 s");
    expect(signedSeconds(-300)).toBe("-0.3 s");
  });
});
