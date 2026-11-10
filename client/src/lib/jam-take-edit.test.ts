import { describe, expect, it } from "vitest";
import {
  MIN_AUDIBLE_MS,
  NUDGE_LIMIT_MS,
  asRecorded,
  audibleMs,
  isEdited,
  placed,
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
