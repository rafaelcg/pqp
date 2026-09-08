import { describe, expect, it } from "vitest";
import { LIVE_REACTION_BURST_THRESHOLD } from "@pqp/shared";
import {
  admitParticles,
  chipLabel,
  isBurst,
  LIVE_PARTICLE_CAP,
  particlesForWindow,
  spawnParticles,
  type LiveParticle,
} from "./live-reaction-particles";

/**
 * The overlay's arithmetic. Deterministic: `random` is a counter, so the only
 * thing under test is the decision, never the jitter.
 */

/** A `random` that walks 0, 0.1, 0.2 … and wraps, so runs are reproducible. */
function counterRandom(): () => number {
  let n = 0;
  return () => {
    n = (n + 1) % 10;
    return n / 10;
  };
}

function spawn(items: { emoji: string; count: number }[], now = 1_000) {
  return spawnParticles(items as never, {
    now,
    random: counterRandom(),
    seed: "w1",
  });
}

describe("coalesced counts become particles", () => {
  it("draws one particle per reaction in a small window", () => {
    const particles = spawn([
      { emoji: "🔥", count: 2 },
      { emoji: "😂", count: 1 },
    ]);
    expect(particles).toHaveLength(3);
    expect(particles.filter((p) => p.emoji === "🔥")).toHaveLength(2);
    expect(particles.filter((p) => p.emoji === "😂")).toHaveLength(1);
  });

  it("keeps every emoji that was in the window, even a lone one", () => {
    const particles = spawn([
      { emoji: "🔥", count: 60 },
      { emoji: "🎉", count: 1 },
    ]);
    expect(particles.some((p) => p.emoji === "🎉")).toBe(true);
    // Proportional, so the crowd's emoji still dominates.
    expect(particles.filter((p) => p.emoji === "🔥").length).toBeGreaterThan(
      particles.filter((p) => p.emoji === "🎉").length,
    );
  });

  it("never lets one window claim the whole particle budget", () => {
    const particles = spawn([{ emoji: "👍", count: 500 }]);
    expect(particles).toHaveLength(particlesForWindow([{ emoji: "👍", count: 500 }] as never));
    expect(particles.length).toBeLessThanOrEqual(Math.ceil(LIVE_PARTICLE_CAP / 3));
  });

  it("gives every particle a unique key and a future expiry", () => {
    const particles = spawn([{ emoji: "❤️", count: 8 }], 5_000);
    expect(new Set(particles.map((p) => p.id)).size).toBe(particles.length);
    for (const particle of particles) {
      expect(particle.expiresAt).toBeGreaterThan(5_000);
    }
  });
});

describe("burst mode", () => {
  it("is off at the threshold and on past it", () => {
    expect(
      isBurst([{ emoji: "🔥", count: LIVE_REACTION_BURST_THRESHOLD }] as never),
    ).toBe(false);
    expect(
      isBurst([
        { emoji: "🔥", count: LIVE_REACTION_BURST_THRESHOLD + 1 },
      ] as never),
    ).toBe(true);
  });

  it("counts across emoji, not per emoji", () => {
    const spread = Array.from({ length: LIVE_REACTION_BURST_THRESHOLD + 1 }, () => ({
      emoji: "🔥",
      count: 1,
    }));
    expect(isBurst(spread as never)).toBe(true);
  });

  it("spreads wider than a quiet window", () => {
    const quiet = spawn([{ emoji: "🔥", count: 2 }]);
    const loud = spawn([{ emoji: "🔥", count: 40 }]);
    const width = (particles: LiveParticle[]) =>
      Math.max(...particles.map((p) => p.leftPercent)) -
      Math.min(...particles.map((p) => p.leftPercent));
    expect(width(loud)).toBeGreaterThan(width(quiet));
  });
});

describe("the particle cap", () => {
  function fakeParticles(count: number, expiresAt: number): LiveParticle[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `p${expiresAt}-${i}`,
      emoji: "🔥",
      leftPercent: 50,
      driftPx: 0,
      scale: 1,
      durationMs: 1_500,
      delayMs: 0,
      expiresAt,
    })) as LiveParticle[];
  }

  it("holds at the cap and drops the oldest first", () => {
    const existing = fakeParticles(LIVE_PARTICLE_CAP, 9_000);
    const incoming = fakeParticles(10, 12_000);
    const merged = admitParticles(existing, incoming, 1_000);

    expect(merged).toHaveLength(LIVE_PARTICLE_CAP);
    // The ten newest survived in full.
    for (const particle of incoming) {
      expect(merged).toContain(particle);
    }
    // The ten oldest went.
    for (const particle of existing.slice(0, 10)) {
      expect(merged).not.toContain(particle);
    }
  });

  it("sweeps finished particles before the cap has to bite", () => {
    const finished = fakeParticles(50, 500);
    const incoming = fakeParticles(5, 12_000);
    const merged = admitParticles(finished, incoming, 1_000);
    expect(merged).toEqual(incoming);
  });

  it("keeps the tail of a window bigger than the cap on its own", () => {
    const merged = admitParticles([], fakeParticles(LIVE_PARTICLE_CAP + 20, 9_000), 1_000);
    expect(merged).toHaveLength(LIVE_PARTICLE_CAP);
  });

  it("adds nothing when nothing arrives", () => {
    const existing = fakeParticles(3, 9_000);
    expect(admitParticles(existing, [], 1_000)).toEqual(existing);
  });
});

describe("the reduced-motion chip", () => {
  it("names the loudest emoji and the window total", () => {
    expect(
      chipLabel([
        { emoji: "🔥", count: 3 },
        { emoji: "😂", count: 9 },
      ] as never),
    ).toBe("😂 12");
  });

  it("is empty for an empty window", () => {
    expect(chipLabel([])).toBe("");
  });
});
