import { describe, expect, it } from "vitest";
import {
  INITIAL_OUTPUT_SILENCE_STATE,
  isOutputSilenceWarning,
  nextOutputSilenceState,
  OUTPUT_SILENCE_FLOOR_DBFS,
  OUTPUT_SILENCE_WARN_MS,
  type OutputSilenceState,
} from "./watch-party-output-silence";

describe("nextOutputSilenceState", () => {
  it("stays reset while the level is above the floor", () => {
    const state = nextOutputSilenceState(INITIAL_OUTPUT_SILENCE_STATE, -20, 0);
    expect(state.silentSince).toBeNull();
  });

  it("starts the streak the first time the level hits the floor", () => {
    const state = nextOutputSilenceState(
      INITIAL_OUTPUT_SILENCE_STATE,
      OUTPUT_SILENCE_FLOOR_DBFS,
      1000,
    );
    expect(state.silentSince).toBe(1000);
  });

  it("treats true digital silence (-Infinity) as silent", () => {
    const state = nextOutputSilenceState(
      INITIAL_OUTPUT_SILENCE_STATE,
      Number.NEGATIVE_INFINITY,
      1000,
    );
    expect(state.silentSince).toBe(1000);
  });

  it("holds the original start time across further silent readings", () => {
    const started: OutputSilenceState = { silentSince: 1000 };
    const state = nextOutputSilenceState(started, -90, 5000);
    expect(state.silentSince).toBe(1000);
  });

  it("resets the moment the level recovers", () => {
    const started: OutputSilenceState = { silentSince: 1000 };
    const state = nextOutputSilenceState(started, -20, 5000);
    expect(state.silentSince).toBeNull();
  });

  it("does NOT hold the streak on a null reading (unmeasurable, not silent)", () => {
    // A browser that never built an analyser, or nothing sampled yet, must
    // not be treated as a known-silent stream.
    const started: OutputSilenceState = { silentSince: 1000 };
    const state = nextOutputSilenceState(started, null, 5000);
    expect(state.silentSince).toBeNull();
  });

  it("is a no-op object-wise when already reset and still not silent", () => {
    // Not load-bearing behaviour, just documents that a reset state is
    // returned as-is rather than reconstructed every tick.
    const state = nextOutputSilenceState(INITIAL_OUTPUT_SILENCE_STATE, -20, 0);
    expect(state).toBe(INITIAL_OUTPUT_SILENCE_STATE);
  });
});

describe("isOutputSilenceWarning", () => {
  it("is false before the floor has held for the full window", () => {
    const state: OutputSilenceState = { silentSince: 0 };
    expect(isOutputSilenceWarning(state, OUTPUT_SILENCE_WARN_MS - 1)).toBe(
      false,
    );
  });

  it("is true once the floor has held for the full window", () => {
    const state: OutputSilenceState = { silentSince: 0 };
    expect(isOutputSilenceWarning(state, OUTPUT_SILENCE_WARN_MS)).toBe(true);
  });

  it("is false while never silent", () => {
    expect(isOutputSilenceWarning(INITIAL_OUTPUT_SILENCE_STATE, 999_999)).toBe(
      false,
    );
  });
});
