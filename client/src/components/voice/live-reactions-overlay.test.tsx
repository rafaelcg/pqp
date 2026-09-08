import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIVE_REACTION_EMOJIS, type LiveReactionCount } from "@pqp/shared";
import {
  LIVE_PARTICLE_CAP,
  admitParticles,
  spawnParticles,
  type LiveParticle,
} from "./live-reaction-particles";
import {
  LiveReactionParticleLayer,
  LiveReactionsChip,
  LiveReactionsOverlay,
} from "./live-reactions-overlay";
import { LiveReactionsBar } from "./live-reactions-bar";

/**
 * Markup, rendered the way this client's component tests render: on the
 * server, as an HTML string. Effects never run there, so the stateful overlay
 * is exercised through the pure layer it delegates to, and the pieces that DO
 * have to be checked on the stateful component (which of the two treatments it
 * picks) are checked by what it renders with no particles at all.
 */

function counterRandom(): () => number {
  let n = 0;
  return () => {
    n = (n + 1) % 10;
    return n / 10;
  };
}

function particlesFor(items: LiveReactionCount[], now = 1_000): LiveParticle[] {
  return spawnParticles(items, { now, random: counterRandom(), seed: "w1" });
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("the particle layer", () => {
  it("renders one element per particle, carrying the window's counts", () => {
    const html = renderToStaticMarkup(
      <LiveReactionParticleLayer
        particles={particlesFor([
          { emoji: "🔥", count: 3 },
          { emoji: "😂", count: 1 },
        ])}
      />,
    );
    expect(countOf(html, 'data-testid="live-reaction-particle"')).toBe(4);
    expect(countOf(html, "🔥")).toBe(3);
    expect(countOf(html, "😂")).toBe(1);
  });

  it("hands each particle its own duration, drift and size", () => {
    const html = renderToStaticMarkup(
      <LiveReactionParticleLayer particles={particlesFor([{ emoji: "🎉", count: 4 }])} />,
    );
    expect(html).toContain("--live-reaction-drift");
    expect(html).toContain("animation-duration");
    expect(html).toContain("animation-delay");
    // One shared keyframe class, never a per-particle animation name.
    expect(countOf(html, "animate-live-reaction-float")).toBe(4);
  });

  it("holds at the cap when a burst overruns it, keeping the newest", () => {
    const old = particlesFor([{ emoji: "👍", count: 18 }], 1_000);
    let live: LiveParticle[] = old;
    // Five windows of eighteen is ninety particles offered against a cap of 60.
    for (let i = 0; i < 5; i += 1) {
      live = admitParticles(live, particlesFor([{ emoji: "🔥", count: 18 }], 2_000), 1_500);
    }
    const html = renderToStaticMarkup(<LiveReactionParticleLayer particles={live} />);
    expect(live.length).toBe(LIVE_PARTICLE_CAP);
    expect(countOf(html, 'data-testid="live-reaction-particle"')).toBe(
      LIVE_PARTICLE_CAP,
    );
    // Dropped from the front, so the oldest window is the one that went.
    expect(countOf(html, "👍")).toBeLessThan(old.length);
  });

  it("pulses the container only in burst mode", () => {
    const particles = particlesFor([{ emoji: "🔥", count: 2 }]);
    const quiet = renderToStaticMarkup(
      <LiveReactionParticleLayer particles={particles} />,
    );
    const loud = renderToStaticMarkup(
      <LiveReactionParticleLayer particles={particles} bursting />,
    );
    expect(quiet).not.toContain("animate-live-reaction-burst");
    expect(quiet).not.toContain('data-burst="true"');
    expect(loud).toContain("animate-live-reaction-burst");
    expect(loud).toContain('data-burst="true"');
  });

  it("never takes a pointer event away from the video under it", () => {
    const html = renderToStaticMarkup(
      <LiveReactionParticleLayer particles={particlesFor([{ emoji: "❤️", count: 1 }])} />,
    );
    expect(html).toContain("pointer-events-none");
  });
});

describe("prefers-reduced-motion", () => {
  it("renders no particle container at all", () => {
    const html = renderToStaticMarkup(
      <LiveReactionsOverlay channelId="room-1" reducedMotion />,
    );
    expect(html).not.toContain('data-testid="live-reactions-overlay"');
    expect(html).not.toContain("animate-live-reaction-float");
    expect(html).not.toContain("animate-live-reaction-burst");
  });

  it("is the only mode that renders nothing before a window arrives", () => {
    // The contrast is the point: with motion allowed the container is mounted
    // and waiting, so the assertion above is about the MODE and not merely
    // about there being no particles yet.
    const moving = renderToStaticMarkup(
      <LiveReactionsOverlay channelId="room-1" reducedMotion={false} />,
    );
    expect(moving).toContain('data-testid="live-reactions-overlay"');
    expect(countOf(moving, 'data-testid="live-reaction-particle"')).toBe(0);
  });

  it("says the count as a static chip instead", () => {
    const html = renderToStaticMarkup(
      <LiveReactionsChip label="😂 12" total={12} />,
    );
    expect(html).toContain("😂 12");
    expect(html).toContain('aria-label="12 reactions right now"');
    expect(html).not.toContain("animate-live-reaction-float");
  });
});

describe("the reaction bar", () => {
  it("offers exactly the allowed set, each with a label", () => {
    const html = renderToStaticMarkup(
      <LiveReactionsBar channelId="room-1" onReact={() => {}} />,
    );
    expect(countOf(html, "<button")).toBe(LIVE_REACTION_EMOJIS.length);
    for (const emoji of LIVE_REACTION_EMOJIS) {
      expect(html).toContain(`aria-label="Send ${emoji}"`);
    }
    expect(html).toContain('aria-label="Live reactions"');
  });
});
