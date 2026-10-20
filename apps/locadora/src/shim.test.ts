import { describe, expect, it } from "vitest";
import {
  inertWakeLock,
  installLocalStorageShim,
  installWakeLockStub,
  installWakeLockSwallow,
  isWakeLockRejection,
} from "./shim";

describe("the frame's storage shim", () => {
  it("answers null where the browser would throw", () => {
    const target = {};
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(() => (target as { localStorage: unknown }).localStorage).toThrow();
    installLocalStorageShim(target);
    expect((target as { localStorage: unknown }).localStorage).toBeNull();
  });

  it("does not throw when the property cannot be redefined", () => {
    const target = {};
    Object.defineProperty(target, "localStorage", { configurable: false, value: 1 });
    expect(() => installLocalStorageShim(target)).not.toThrow();
  });
});

describe("the wake lock the frame cannot have", () => {
  it("hands out a lock that holds nothing, and releases without a fuss", async () => {
    const target = {};
    installWakeLockStub(target);
    const sentinel = await (target as { wakeLock: { request(type: string): Promise<ReturnType<typeof inertWakeLock>> } }).wakeLock.request("screen");
    expect(sentinel.released).toBe(false);
    expect(sentinel.type).toBe("screen");
    sentinel.addEventListener("release", () => {});
    await sentinel.release();
    expect(sentinel.released).toBe(true);
  });

  it("recognises the refusal in each browser's words, and nothing else", () => {
    expect(isWakeLockRejection(new DOMException("A permissions policy does not allow screen-wake-lock for the requesting document.", "NotAllowedError"))).toBe(true);
    expect(isWakeLockRejection(new Error("Wake Lock request failed"))).toBe(true);
    expect(isWakeLockRejection("NotAllowedError: screen wake lock is not allowed")).toBe(true);
    expect(isWakeLockRejection(new Error("something else"))).toBe(false);
    expect(isWakeLockRejection(undefined)).toBe(false);
  });

  it("swallows only that rejection", () => {
    let handler: ((event: Event) => void) | undefined;
    installWakeLockSwallow({ addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => (handler = listener as (e: Event) => void) } as never);
    const make = (reason: unknown) => {
      let prevented = false;
      const event = { reason, preventDefault: () => (prevented = true) } as unknown as Event;
      handler!(event);
      return prevented;
    };
    expect(make(new Error("screen-wake-lock denied"))).toBe(true);
    expect(make(new Error("a real bug"))).toBe(false);
  });
});
