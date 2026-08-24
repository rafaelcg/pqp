import { describe, expect, it, vi } from "vitest";
import { attemptElementFullscreen } from "./element-fullscreen";

/** A promise that never settles, which is Electron's refusal. */
function pending(): Promise<void> {
  return new Promise<void>(() => {});
}

describe("attemptElementFullscreen", () => {
  it("reports success when the platform honours the request", async () => {
    const wait = vi.fn(() => Promise.resolve());
    await expect(
      attemptElementFullscreen({
        request: () => Promise.resolve(),
        isActive: () => true,
        wait,
      }),
    ).resolves.toBe(true);
  });

  it("does not wait out the grace period on a platform that answers", async () => {
    // The browser path must stay instant: a resolved request is checked as
    // soon as it resolves, never after a timer.
    const wait = vi.fn(() => pending());
    await expect(
      attemptElementFullscreen({
        request: () => Promise.resolve(),
        isActive: () => true,
        wait,
      }),
    ).resolves.toBe(true);
  });

  it("reports failure when the request is refused out loud", async () => {
    const onRefusal = vi.fn();
    const error = new Error("permissions check failed");
    await expect(
      attemptElementFullscreen({
        request: () => Promise.reject(error),
        isActive: () => false,
        onRefusal,
        wait: () => pending(),
      }),
    ).resolves.toBe(false);
    expect(onRefusal).toHaveBeenCalledWith(error);
  });

  it("reports failure when the platform never answers at all", async () => {
    // Electron's shape exactly: the embedder denies the `fullscreen`
    // permission and the renderer's promise stays pending forever. Nothing
    // rejects, nothing resolves, no event fires, so only the grace period and
    // a direct look at the document can tell us the button did nothing.
    const onRefusal = vi.fn();
    await expect(
      attemptElementFullscreen({
        request: pending,
        isActive: () => false,
        onRefusal,
        wait: () => Promise.resolve(),
      }),
    ).resolves.toBe(false);
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it("believes the document over the promise", async () => {
    // A resolved request that did not actually make this element fullscreen is
    // still a failure: the document is the authority, not the return value.
    await expect(
      attemptElementFullscreen({
        request: () => Promise.resolve(),
        isActive: () => false,
        wait: () => pending(),
      }),
    ).resolves.toBe(false);
  });

  it("waits for the real timer when none is injected", async () => {
    // Guards the default: a caller that passes no `wait` must still come back
    // rather than hang with the promise that never settles.
    await expect(
      attemptElementFullscreen({
        request: pending,
        isActive: () => false,
        graceMs: 1,
      }),
    ).resolves.toBe(false);
  });
});
