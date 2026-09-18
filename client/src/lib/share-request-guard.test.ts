import { describe, expect, it } from "vitest";
import { createShareRequestGuard } from "./share-request-guard";

describe("createShareRequestGuard", () => {
  it("refuses a second begin until the first ends", () => {
    const guard = createShareRequestGuard();
    const first = guard.tryBegin();
    expect(first).toBe(0);
    expect(guard.tryBegin()).toBeNull();
    guard.end(first!);
    expect(guard.tryBegin()).toBe(0);
  });

  it("drops a stale continuation after invalidate", () => {
    const guard = createShareRequestGuard();
    const token = guard.tryBegin();
    expect(token).not.toBeNull();
    guard.invalidate();
    expect(guard.isCurrent(token!)).toBe(false);
    expect(guard.tryBegin()).toBe(1);
  });

  it("does not clear a newer flight when an old token ends", () => {
    const guard = createShareRequestGuard();
    const stale = guard.tryBegin();
    guard.invalidate();
    const next = guard.tryBegin();
    guard.end(stale!);
    expect(guard.tryBegin()).toBeNull();
    guard.end(next!);
    expect(guard.tryBegin()).toBe(1);
  });
});
