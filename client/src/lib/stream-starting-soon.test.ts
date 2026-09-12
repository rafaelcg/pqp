import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STARTING_SOON_LINE_INTERVAL_MS,
  createLineRotator,
  type LineRotatorController,
} from "@/lib/stream-starting-soon";

describe("createLineRotator", () => {
  let seen: number[];
  let rotator: LineRotatorController;

  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
  });
  afterEach(() => {
    rotator?.dispose();
    vi.useRealTimers();
  });

  it("stays on line 0 and starts no timer with fewer than two lines", () => {
    rotator = createLineRotator(1, (index) => seen.push(index));
    vi.advanceTimersByTime(STARTING_SOON_LINE_INTERVAL_MS * 5);
    expect(rotator.index).toBe(0);
    expect(seen).toEqual([]);
  });

  it("starts no timer with zero lines either", () => {
    rotator = createLineRotator(0, (index) => seen.push(index));
    vi.advanceTimersByTime(STARTING_SOON_LINE_INTERVAL_MS * 5);
    expect(rotator.index).toBe(0);
    expect(seen).toEqual([]);
  });

  it("advances one line per interval", () => {
    rotator = createLineRotator(3, (index) => seen.push(index));
    expect(rotator.index).toBe(0);
    vi.advanceTimersByTime(STARTING_SOON_LINE_INTERVAL_MS);
    expect(rotator.index).toBe(1);
    vi.advanceTimersByTime(STARTING_SOON_LINE_INTERVAL_MS);
    expect(rotator.index).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it("wraps back to the first line after the last one", () => {
    rotator = createLineRotator(3, (index) => seen.push(index));
    vi.advanceTimersByTime(STARTING_SOON_LINE_INTERVAL_MS * 3);
    expect(rotator.index).toBe(0);
    expect(seen).toEqual([1, 2, 0]);
  });

  it("respects a custom interval", () => {
    rotator = createLineRotator(2, (index) => seen.push(index), 1_000);
    vi.advanceTimersByTime(999);
    expect(rotator.index).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rotator.index).toBe(1);
  });

  it("dispose stops further advances", () => {
    rotator = createLineRotator(3, (index) => seen.push(index));
    rotator.dispose();
    vi.advanceTimersByTime(STARTING_SOON_LINE_INTERVAL_MS * 10);
    expect(seen).toEqual([]);
    expect(rotator.index).toBe(0);
  });
});
