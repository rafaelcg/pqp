import { describe, expect, it } from "vitest";
import { clientAddress, createRateLimiter, limitFromEnv } from "./rate-limit.js";

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

  it("holds one send per interval when capacity is 1", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1 / 5,
      now: clock.now,
    });

    expect(limiter.take("channel:user")).toBe(true);
    expect(limiter.take("channel:user")).toBe(false);
    expect(limiter.retryAfter("channel:user")).toBe(5);

    clock.advance(4_999);
    expect(limiter.take("channel:user")).toBe(false);
    clock.advance(1);
    expect(limiter.take("channel:user")).toBe(true);
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

  /** Run `body` with TRUST_PROXY set, then put the environment back. */
  function withTrustProxy(value: string, body: () => void) {
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = value;
    try {
      body();
    } finally {
      if (previous === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = previous;
      }
    }
  }

  /**
   * The entry our own edge appended, not the one the caller typed.
   *
   * This test previously asserted the opposite — that the *first* hop wins —
   * which reads naturally and is exactly backwards. Proxies append, so the left
   * end of the chain is attacker-supplied: anyone could send a made-up
   * `X-Forwarded-For` and be handed a fresh rate-limit bucket per request.
   */
  it("uses the hop our own proxy appended, not the caller's claim", () => {
    withTrustProxy("true", () => {
      expect(
        clientAddress({
          headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
          socket,
        }),
      ).toBe("5.6.7.8");
    });
  });

  it("cannot be moved by a forged leading entry", () => {
    withTrustProxy("true", () => {
      const forged = clientAddress({
        headers: { "x-forwarded-for": "9.9.9.9, 5.6.7.8" },
        socket,
      });
      const plain = clientAddress({
        headers: { "x-forwarded-for": "5.6.7.8" },
        socket,
      });
      // Same real client, so the same bucket, whatever they prepend.
      expect(forged).toBe(plain);
    });
  });

  it("counts in from the right when more than one proxy is trusted", () => {
    withTrustProxy("2", () => {
      expect(
        clientAddress({
          headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 10.0.0.9" },
          socket,
        }),
      ).toBe("5.6.7.8");
    });
  });

  it("reads a repeated header as one ordered chain", () => {
    withTrustProxy("true", () => {
      expect(
        clientAddress({
          headers: { "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] },
          socket,
        }),
      ).toBe("5.6.7.8");
    });
  });

  it("falls back to the socket when the chain is shorter than the trusted depth", () => {
    withTrustProxy("3", () => {
      expect(
        clientAddress({
          headers: { "x-forwarded-for": "1.2.3.4" },
          socket,
        }),
      ).toBe("10.0.0.1");
    });
  });
});

describe("limitFromEnv", () => {
  it("uses the fallback when the variable is missing or not a positive number", () => {
    const previous = process.env.RATE_LIMIT_WS_MESSAGE_CAPACITY;
    delete process.env.RATE_LIMIT_WS_MESSAGE_CAPACITY;
    expect(limitFromEnv("RATE_LIMIT_WS_MESSAGE_CAPACITY", 10)).toBe(10);
    process.env.RATE_LIMIT_WS_MESSAGE_CAPACITY = "0";
    expect(limitFromEnv("RATE_LIMIT_WS_MESSAGE_CAPACITY", 10)).toBe(10);
    process.env.RATE_LIMIT_WS_MESSAGE_CAPACITY = "10000";
    expect(limitFromEnv("RATE_LIMIT_WS_MESSAGE_CAPACITY", 10)).toBe(10000);
    if (previous === undefined) {
      delete process.env.RATE_LIMIT_WS_MESSAGE_CAPACITY;
    } else {
      process.env.RATE_LIMIT_WS_MESSAGE_CAPACITY = previous;
    }
  });
});
