import { describe, expect, it } from "vitest";
import {
  createReadinessGate,
  READINESS_GRACE_MS,
  READINESS_PATH,
  READINESS_PROBE_TTL_MS,
} from "./readiness.js";

/**
 * `GET /up` is one decision — "does this deserve a 503?" — and this is that
 * decision, on a fake clock and a fake dependency. The wiring in index.ts is
 * three lines around `checkReadiness()`; the judgement is all here.
 *
 * The bias under test is conservatism. A monitor that cries wolf gets muted,
 * so every case below asks "would this have paged somebody for nothing?".
 */

interface Harness {
  gate: ReturnType<typeof createReadinessGate>;
  /** Move the fake clock. */
  advance(ms: number): void;
  /** Flip what the dependency does. */
  setHealthy(healthy: boolean): void;
  /** How many times the probe actually ran. */
  probes(): number;
  /** Status only; the body is a constant. */
  status(): Promise<number>;
}

function harness(options: { hang?: boolean } = {}): Harness {
  let clock = 1_000_000;
  let healthy = true;
  let probes = 0;
  const gate = createReadinessGate({
    now: () => clock,
    probe: async () => {
      probes += 1;
      if (healthy) {
        return "ok";
      }
      if (options.hang) {
        // A database that accepted the connection and then said nothing. The
        // gate's own timeout has to be what ends this.
        return new Promise(() => {});
      }
      throw new Error("no route to host");
    },
    // Real timeouts would make the suite slow; the behaviour is the same.
    timeoutMs: 5,
  });
  return {
    gate,
    advance: (ms) => {
      clock += ms;
    },
    setHealthy: (value) => {
      healthy = value;
    },
    probes: () => probes,
    status: async () => (await gate.check()).status,
  };
}

describe("the /up path", () => {
  it("is not one of the endpoints something else already depends on", () => {
    // `/health` is Fly's release gate and `/status.json` is the public status
    // page. Neither may quietly acquire a new meaning, which is the entire
    // reason this is a third path.
    expect(READINESS_PATH).toBe("/up");
    expect(READINESS_PATH).not.toBe("/health");
    expect(READINESS_PATH).not.toBe("/status.json");
  });
});

describe("readiness gate", () => {
  it("serves 200 while the database answers", async () => {
    const h = harness();
    expect(await h.status()).toBe(200);
    h.advance(READINESS_PROBE_TTL_MS);
    expect(await h.status()).toBe(200);
  });

  it("stays 200 through a single failure — a blip is not an outage", async () => {
    const h = harness();
    expect(await h.status()).toBe(200);

    h.setHealthy(false);
    h.advance(READINESS_PROBE_TTL_MS);
    expect(await h.status()).toBe(200);

    // Still inside the grace window on the next monitor poll.
    h.advance(READINESS_GRACE_MS - 1);
    expect(await h.status()).toBe(200);
  });

  it("turns 503 once the failure has lasted the whole grace window", async () => {
    const h = harness();
    await h.status();

    h.setHealthy(false);
    h.advance(READINESS_PROBE_TTL_MS);
    expect(await h.status()).toBe(200);

    h.advance(READINESS_GRACE_MS);
    expect(await h.status()).toBe(503);
  });

  it("trips on the second consecutive failed check at a 60s poll interval", async () => {
    // The configuration this is actually deployed under, spelled out: a monitor
    // hitting it once a minute must see 503 on its second failed poll, never on
    // its first.
    const h = harness();
    expect(await h.status()).toBe(200);
    h.setHealthy(false);
    h.advance(60_000);
    expect(await h.status()).toBe(200);
    h.advance(60_000);
    expect(await h.status()).toBe(503);
  });

  it("recovers immediately, and a later failure starts a fresh window", async () => {
    const h = harness();
    h.setHealthy(false);
    h.advance(READINESS_PROBE_TTL_MS);
    await h.status();
    h.advance(READINESS_GRACE_MS);
    expect(await h.status()).toBe(503);

    // Back up: no grace period on the way out. An operator watching a recovery
    // should not have to wait for a timer.
    h.setHealthy(true);
    h.advance(READINESS_PROBE_TTL_MS);
    expect(await h.status()).toBe(200);

    // A new failure is measured from now, not from the old streak.
    h.setHealthy(false);
    h.advance(READINESS_PROBE_TTL_MS);
    expect(await h.status()).toBe(200);
    h.advance(READINESS_GRACE_MS);
    expect(await h.status()).toBe(503);
  });

  it("does not count an intermittent failure as continuous", async () => {
    // Flapping is a real condition, but it is not what this endpoint reports.
    // It stays 200 and the operator finds the flap on the dashboard's uptime
    // samples instead.
    const h = harness();
    for (let i = 0; i < 6; i++) {
      h.setHealthy(false);
      h.advance(READINESS_PROBE_TTL_MS);
      expect(await h.status()).toBe(200);
      h.setHealthy(true);
      h.advance(READINESS_PROBE_TTL_MS);
      expect(await h.status()).toBe(200);
    }
  });

  it("treats a database that never answers as a failure", async () => {
    const h = harness({ hang: true });
    await h.status();
    h.setHealthy(false);
    h.advance(READINESS_PROBE_TTL_MS);
    expect(await h.status()).toBe(200);
    h.advance(READINESS_GRACE_MS);
    expect(await h.status()).toBe(503);
  });

  it("costs one query per TTL however hard it is hit", async () => {
    // The reason there is no rate limiter on the route: a flood cannot reach
    // the database, so what is left is a constant response.
    const h = harness();
    await Promise.all(Array.from({ length: 50 }, () => h.status()));
    expect(h.probes()).toBe(1);

    for (let i = 0; i < 20; i++) {
      await h.status();
    }
    expect(h.probes()).toBe(1);

    h.advance(READINESS_PROBE_TTL_MS);
    await h.status();
    expect(h.probes()).toBe(2);
  });

  it("forgets everything on reset", async () => {
    const h = harness();
    h.setHealthy(false);
    h.advance(READINESS_PROBE_TTL_MS);
    await h.status();
    h.advance(READINESS_GRACE_MS);
    expect(await h.status()).toBe(503);

    h.gate.reset();
    h.setHealthy(true);
    expect(await h.status()).toBe(200);
  });
});
