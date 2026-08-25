import { describe, expect, it } from "vitest";
import {
  UPDATE_SNOOZE_MS,
  isSnoozeExpired,
  snoozeRemainingMs,
} from "./update-snooze";

describe("update snooze", () => {
  it("shows a notice that has never been dismissed", () => {
    expect(isSnoozeExpired(null, 1_000_000)).toBe(true);
    expect(snoozeRemainingMs(null, 1_000_000)).toBe(0);
  });

  it("hides a notice dismissed a moment ago", () => {
    const now = 1_000_000;
    expect(isSnoozeExpired(now, now)).toBe(false);
    expect(snoozeRemainingMs(now, now)).toBe(UPDATE_SNOOZE_MS);
  });

  it("shows it again once the snooze elapses", () => {
    const dismissedAt = 1_000_000;
    const due = dismissedAt + UPDATE_SNOOZE_MS;
    expect(isSnoozeExpired(dismissedAt, due - 1)).toBe(false);
    expect(isSnoozeExpired(dismissedAt, due)).toBe(true);
    expect(isSnoozeExpired(dismissedAt, due + 60_000)).toBe(true);
  });

  it("counts down towards the re-show", () => {
    const dismissedAt = 1_000_000;
    expect(snoozeRemainingMs(dismissedAt, dismissedAt + 5 * 60_000)).toBe(
      UPDATE_SNOOZE_MS - 5 * 60_000,
    );
    expect(snoozeRemainingMs(dismissedAt, dismissedAt + UPDATE_SNOOZE_MS)).toBe(
      0,
    );
  });

  /**
   * A laptop waking from sleep or an NTP correction can move the clock
   * backwards. That must not produce a negative delay handed to setTimeout.
   */
  it("clamps to zero when the clock jumps backwards", () => {
    const dismissedAt = 1_000_000;
    expect(snoozeRemainingMs(dismissedAt, dismissedAt - 60_000)).toBe(
      UPDATE_SNOOZE_MS + 60_000,
    );
    expect(snoozeRemainingMs(dismissedAt, dismissedAt + UPDATE_SNOOZE_MS * 3)).toBe(
      0,
    );
  });

  it("honours a caller-supplied window", () => {
    const dismissedAt = 500;
    expect(isSnoozeExpired(dismissedAt, 600, 200)).toBe(false);
    expect(isSnoozeExpired(dismissedAt, 700, 200)).toBe(true);
    expect(snoozeRemainingMs(dismissedAt, 600, 200)).toBe(100);
  });
});
