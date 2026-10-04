import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchShareConfig = vi.fn();
vi.mock("./api", () => ({ fetchShareConfig: (id?: string | null) => fetchShareConfig(id) }));

const {
  ensureShareGameCaptureHintFlag,
  ensureShareGuardFlag,
  prefetchShareGuardFlag,
  resetShareGuardFlagForTests,
} = await import("./share-guard-flag");

beforeEach(() => {
  fetchShareConfig.mockReset();
  resetShareGuardFlagForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureShareGuardFlag", () => {
  it("is off when the API does not know the flag (an older deployment)", async () => {
    fetchShareConfig.mockResolvedValue({ desktopShareAudioNative: false });
    expect(await ensureShareGuardFlag("s1")).toBe(false);
  });

  it("is on when the server says so, and asks with the call's server", async () => {
    fetchShareConfig.mockResolvedValue({ shareHighMotionGuard: true });
    expect(await ensureShareGuardFlag("s1")).toBe(true);
    expect(fetchShareConfig).toHaveBeenCalledWith("s1");
  });

  it("asks without a server for a DM call", async () => {
    fetchShareConfig.mockResolvedValue({ shareHighMotionGuard: true });
    await ensureShareGuardFlag(null);
    expect(fetchShareConfig).toHaveBeenCalledWith(null);
  });

  it("answers from the cache at once, per server", async () => {
    fetchShareConfig.mockResolvedValueOnce({ shareHighMotionGuard: true });
    fetchShareConfig.mockResolvedValueOnce({ shareHighMotionGuard: false });
    expect(await ensureShareGuardFlag("s1")).toBe(true);
    expect(await ensureShareGuardFlag("s2")).toBe(false);
    // Neither answer leaks into the other server, and neither asks twice.
    expect(await ensureShareGuardFlag("s1")).toBe(true);
    expect(await ensureShareGuardFlag("s2")).toBe(false);
    expect(fetchShareConfig).toHaveBeenCalledTimes(2);
  });

  it("is off, and does not hold the picker, when the API is slow or down", async () => {
    fetchShareConfig.mockReturnValue(new Promise(() => {}));
    const answer = ensureShareGuardFlag("s1");
    await vi.advanceTimersByTimeAsync(1_600);
    expect(await answer).toBe(false);

    fetchShareConfig.mockRejectedValue(new Error("offline"));
    resetShareGuardFlagForTests();
    expect(await ensureShareGuardFlag("s3")).toBe(false);
  });

  it("uses a stale answer and refreshes behind it", async () => {
    fetchShareConfig.mockResolvedValue({ shareHighMotionGuard: true });
    await ensureShareGuardFlag("s1");
    fetchShareConfig.mockResolvedValue({ shareHighMotionGuard: false });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    // The old answer is given now; the new one is there for the next share.
    expect(await ensureShareGuardFlag("s1")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await ensureShareGuardFlag("s1")).toBe(false);
  });
});

describe("prefetchShareGuardFlag", () => {
  it("warms the answer so the share does not wait on the API", async () => {
    fetchShareConfig.mockResolvedValue({ shareHighMotionGuard: true });
    prefetchShareGuardFlag("s1");
    await vi.advanceTimersByTimeAsync(0);
    fetchShareConfig.mockReset();
    expect(await ensureShareGuardFlag("s1")).toBe(true);
    expect(fetchShareConfig).not.toHaveBeenCalled();
  });
});

describe("ensureShareGameCaptureHintFlag (share_game_capture_hint)", () => {
  it("is off when the API does not know the flag, and off when unanswered", async () => {
    fetchShareConfig.mockResolvedValue({ shareHighMotionGuard: true });
    expect(await ensureShareGameCaptureHintFlag("s1")).toBe(false);
    fetchShareConfig.mockRejectedValue(new Error("offline"));
    resetShareGuardFlagForTests();
    expect(await ensureShareGameCaptureHintFlag("s2")).toBe(false);
  });

  it("rides on the same answer as the guard: one request per server", async () => {
    fetchShareConfig.mockResolvedValue({ shareHighMotionGuard: false, shareGameCaptureHint: true });
    expect(await ensureShareGuardFlag("s1")).toBe(false);
    expect(await ensureShareGameCaptureHintFlag("s1")).toBe(true);
    expect(fetchShareConfig).toHaveBeenCalledTimes(1);
  });
});
