import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSpeakingTracker,
  parseVadThreshold,
  SPEAKING_HANGOVER_MS,
  SPEAKING_THRESHOLD,
} from "./voice-audio";

describe("parseVadThreshold", () => {
  it("keeps a finite value in 0..1 and falls back otherwise", () => {
    expect(parseVadThreshold(0.2)).toBe(0.2);
    expect(parseVadThreshold(0)).toBe(0);
    expect(parseVadThreshold(4)).toBe(1);
    expect(parseVadThreshold(-1)).toBe(0);
    expect(parseVadThreshold(undefined)).toBe(SPEAKING_THRESHOLD);
    expect(parseVadThreshold("loud")).toBe(SPEAKING_THRESHOLD);
    expect(parseVadThreshold(Number.NaN)).toBe(SPEAKING_THRESHOLD);
  });
});

describe("createSpeakingTracker hangover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays open for the tail after the level drops, then closes", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const tracker = createSpeakingTracker({
      threshold: 0.1,
      hangoverMs: SPEAKING_HANGOVER_MS,
    });

    expect(tracker.update("a", 0.02, true)).toBe(false);
    expect(tracker.update("a", 0.2, true)).toBe(true);

    now += SPEAKING_HANGOVER_MS - 10;
    expect(tracker.update("a", 0, true)).toBe(true);

    now += 20;
    expect(tracker.update("a", 0, true)).toBe(false);
  });
});
