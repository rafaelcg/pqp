import {
  LIVE_REACTION_BURST_THRESHOLD,
  liveReactionTotal,
  type LiveReactionCount,
  type LiveReactionEmoji,
} from "@pqp/shared";

/**
 * The overlay's arithmetic, kept out of the component so it can be tested
 * without a browser (this repo's client tests run in `node` and render with
 * `renderToStaticMarkup`, so anything that needs a layout cannot be asserted).
 *
 * Everything here is deterministic given a `random` and a `now`. The component
 * passes `Math.random` and `Date.now`; the tests pass counters.
 */

/**
 * The ceiling on live particles.
 *
 * Sixty animated elements is comfortably inside what a mid-range phone can
 * composite when each one is a `transform` + `opacity` keyframe on its own
 * layer, and it is roughly what fits on a stage before the video underneath
 * stops being watchable. Past it the OLDEST go, not the newest: a particle that
 * has been rising for a second is most of the way through its fade, so dropping
 * it is the least visible thing that can be dropped, while dropping the new
 * ones would make a burst look like it stopped.
 */
export const LIVE_PARTICLE_CAP = 60;

/** How long one particle rises and fades, in milliseconds. */
export const PARTICLE_MIN_DURATION_MS = 1_400;
export const PARTICLE_MAX_DURATION_MS = 2_600;

export interface LiveParticle {
  /** Unique per particle. React key, and nothing else reads it. */
  id: string;
  emoji: LiveReactionEmoji;
  /** Horizontal start, as a percentage of the stage width. */
  leftPercent: number;
  /** How far it drifts sideways on the way up, in pixels, signed. */
  driftPx: number;
  /** Font size multiplier. */
  scale: number;
  durationMs: number;
  /** Spawn stagger inside the window, so a count of twelve is not a wall. */
  delayMs: number;
  /** When it may be swept, in `Date.now()` terms. */
  expiresAt: number;
}

/** Whether a window is crowded enough to earn the denser, bigger treatment. */
export function isBurst(items: readonly LiveReactionCount[]): boolean {
  return liveReactionTotal(items) > LIVE_REACTION_BURST_THRESHOLD;
}

/**
 * How many particles a window is actually allowed to draw.
 *
 * A window is counts, not taps, so `count` can be any number a room can
 * produce in 250ms. Drawing one particle per tap would let a big room set the
 * particle budget on its own, so a window is capped at a third of the total
 * ceiling: a burst still visibly floods the stage, and three consecutive
 * bursts still leave room for the next one.
 */
export function particlesForWindow(items: readonly LiveReactionCount[]): number {
  return Math.min(liveReactionTotal(items), Math.ceil(LIVE_PARTICLE_CAP / 3));
}

interface SpawnOptions {
  now: number;
  random: () => number;
  /** Distinguishes particles from two windows that share a millisecond. */
  seed: string;
}

/**
 * Turn one coalesced window into particles.
 *
 * Proportional across emoji: a window of ten 🔥 and two 😂 that is trimmed to
 * nine draws mostly fire, because "what the room is mostly saying" is the only
 * information the overlay carries. Every emoji present gets at least one
 * particle, so a lone 🎉 inside a wall of 🔥 is not silently rounded away.
 */
export function spawnParticles(
  items: readonly LiveReactionCount[],
  { now, random, seed }: SpawnOptions,
): LiveParticle[] {
  const total = liveReactionTotal(items);
  if (total === 0) {
    return [];
  }
  const budget = particlesForWindow(items);
  const burst = isBurst(items);
  const particles: LiveParticle[] = [];

  let spent = 0;
  items.forEach((item, index) => {
    // One slot is reserved for every emoji still to come, which is what makes
    // the "at least one particle each" promise hold in the case that actually
    // breaks it: a window whose first emoji rounds up to the entire budget.
    const reserved = items.length - index - 1;
    const share =
      index === items.length - 1
        ? budget - spent
        : Math.max(1, Math.round((item.count / total) * budget));
    const draw = Math.max(
      0,
      Math.min(share, Math.max(0, budget - spent - reserved)),
    );
    spent += draw;
    for (let i = 0; i < draw; i += 1) {
      const durationMs =
        PARTICLE_MIN_DURATION_MS +
        random() * (PARTICLE_MAX_DURATION_MS - PARTICLE_MIN_DURATION_MS);
      // A burst spreads wider and starts bigger; a quiet window hugs the
      // right-hand side where the bar is, the way Twitch's does.
      const spread = burst ? 78 : 34;
      const delayMs = burst ? random() * 260 : random() * 120;
      particles.push({
        id: `${seed}-${particles.length}`,
        emoji: item.emoji,
        leftPercent: 100 - 6 - random() * spread,
        driftPx: (random() - 0.5) * (burst ? 90 : 44),
        scale: (burst ? 1.05 : 0.85) + random() * 0.45,
        durationMs,
        delayMs,
        expiresAt: now + delayMs + durationMs,
      });
    }
  });

  return particles;
}

/**
 * Fold new particles into the live set under the cap.
 *
 * Expired ones go first, which is free; only if that is not enough does the
 * cap bite, and then it takes from the FRONT, which is the oldest because the
 * list is only ever appended to. A window bigger than the whole cap keeps its
 * own tail rather than pushing everything out and rendering nothing.
 */
export function admitParticles(
  existing: readonly LiveParticle[],
  incoming: readonly LiveParticle[],
  now: number,
  cap = LIVE_PARTICLE_CAP,
): LiveParticle[] {
  const alive = existing.filter((particle) => particle.expiresAt > now);
  const merged = [...alive, ...incoming];
  if (merged.length <= cap) {
    return merged;
  }
  return merged.slice(merged.length - cap);
}

/** The static chip's text under `prefers-reduced-motion`: "😂 12". */
export function chipLabel(items: readonly LiveReactionCount[]): string {
  const top = [...items].sort((a, b) => b.count - a.count)[0];
  if (!top) {
    return "";
  }
  return `${top.emoji} ${liveReactionTotal(items)}`;
}
