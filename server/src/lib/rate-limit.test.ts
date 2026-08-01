import { describe, expect, it } from "vitest";
import { clientAddress, createRateLimiter } from "./rate-limit.js";

function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("allows a burst up to capacity then refuses", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 3,
      refillPerSecond: 1,
      now: clock.now,
    });

    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("keeps buckets independent per key", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: clock.now,
    });

    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
  });

  it("refills over time and never exceeds capacity", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: clock.now,
    });

    limiter.take("a");
    limiter.take("a");
    expect(limiter.take("a")).toBe(false);

    clock.advance(1_000);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);

    // Idle far longer than it takes to fill: still only `capacity` tokens.
    clock.advance(60_000);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("reports a retry delay only when exhausted", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 0.5,
      now: clock.now,
    });

    expect(limiter.retryAfter("a")).toBe(0);
    limiter.take("a");
    expect(limiter.retryAfter("a")).toBe(2);
  });

  it("drops idle buckets so the map cannot grow without bound", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      idleTtlMs: 1_000,
      now: clock.now,
    });

    limiter.take("a");
    limiter.take("b");
    expect(limiter.size()).toBe(2);

    clock.advance(5_000);
    limiter.take("c");
    expect(limiter.size()).toBe(1);
  });
});

describe("clientAddress", () => {
  const socket = { remoteAddress: "10.0.0.1" };

  it("ignores x-forwarded-for unless the proxy is trusted", () => {
    const previous = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      expect(
        clientAddress({ headers: { "x-forwarded-for": "1.2.3.4" }, socket }),
      ).toBe("10.0.0.1");
    } finally {
      if (previous === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = previous;
      }
    }
  });

  it("uses the first forwarded hop when the proxy is trusted", () => {
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "true";
    try {
      expect(
        clientAddress({
          headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
          socket,
        }),
      ).toBe("1.2.3.4");
    } finally {
      if (previous === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = previous;
      }
    }
  });
});
