/**
 * A hanging rope, as forty lines of arithmetic.
 *
 * WHY NOT A PHYSICS ENGINE. Every draggable-lanyard demo on the internet pulls
 * in `@react-three/rapier`, which is a WASM rigid-body engine with joints and a
 * solver, to simulate one piece of string. That is roughly a quarter of a
 * megabyte to answer a question Verlet integration answered in 1967: where is
 * the next point, given where this one was and where it is now.
 *
 * The trade is real and worth stating. A solver would give us collisions,
 * stacking and torque for free. We need none of those. We need a strap that
 * hangs, swings when pulled and settles, and a tuned approximation of that
 * looks better than a simulation of it, because we can pick the damping.
 *
 * PURE, AND FRAMEWORK FREE. No three.js types cross this file, so the whole
 * thing runs in a Node test. `step` is the only function with behaviour and it
 * takes its own timestep, which is what makes a frame-rate-independent result
 * testable without a browser.
 */

export interface RopePoint {
  x: number;
  y: number;
  /** Where it was last step. Verlet stores velocity as history, not as a vector. */
  px: number;
  py: number;
  /** A pinned point ignores gravity and constraints; the top of the strap is one. */
  pinned: boolean;
}

export interface RopeOptions {
  /** How many points. More is smoother and slower; 10 looks like a lanyard. */
  segments: number;
  /** Distance between neighbouring points, in world units. */
  spacing: number;
  originX: number;
  originY: number;
}

export function createRope({
  segments,
  spacing,
  originX,
  originY,
}: RopeOptions): RopePoint[] {
  const points: RopePoint[] = [];
  for (let i = 0; i < segments; i += 1) {
    const y = originY - i * spacing;
    points.push({ x: originX, y, px: originX, py: y, pinned: i === 0 });
  }
  return points;
}

export interface StepOptions {
  gravity: number;
  /** Fraction of velocity kept each step. Below 1 or it never settles. */
  damping: number;
  spacing: number;
  /** Constraint passes. More is stiffer; 6 stops a heavy badge stretching it. */
  iterations: number;
  /** Seconds. Clamped by the caller so a backgrounded tab cannot explode it. */
  dt: number;
}

/**
 * Advance the rope one step, in place.
 *
 * Two halves, and the order matters: integrate everything first, then repair
 * the distances. Repairing as you go biases the rope toward whichever end you
 * started from, which shows up as a strap that visibly stretches at the top.
 */
export function stepRope(points: RopePoint[], options: StepOptions): void {
  const { gravity, damping, spacing, iterations, dt } = options;

  for (const point of points) {
    if (point.pinned) {
      continue;
    }
    const vx = (point.x - point.px) * damping;
    const vy = (point.y - point.py) * damping;
    point.px = point.x;
    point.py = point.y;
    point.x += vx;
    point.y += vy - gravity * dt * dt;
  }

  for (let pass = 0; pass < iterations; pass += 1) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.0001;
      // Half the error each, unless one end is pinned, in which case the free
      // end takes all of it. Splitting it evenly against a pin is what makes a
      // rope crawl off its anchor over time.
      const error = (distance - spacing) / distance;
      const ax = a.pinned ? 0 : b.pinned ? error : error * 0.5;
      const bx = b.pinned ? 0 : a.pinned ? error : error * 0.5;
      a.x += dx * ax;
      a.y += dy * ax;
      b.x -= dx * bx;
      b.y -= dy * bx;
    }
  }
}

/**
 * Drag the free end to a point, killing its stored velocity.
 *
 * Without the velocity reset the rope remembers the throw across the whole
 * drag, so letting go launches the badge at whatever speed the pointer happened
 * to be moving twenty frames ago.
 */
export function grabEnd(points: RopePoint[], x: number, y: number): void {
  const end = points[points.length - 1];
  if (!end) {
    return;
  }
  end.x = x;
  end.y = y;
  end.px = x;
  end.py = y;
}

/**
 * Run the rope forward until it hangs still.
 *
 * Called once before the first frame is drawn. Without it the strap starts as
 * the straight line `createRope` built and visibly falls into shape on load,
 * which looks like a bug rather than an entrance. It also means a tab that is
 * throttled or hidden shows a correctly hanging badge on its very first
 * rendered frame instead of whatever half-integrated pose it woke up in.
 */
export function settleRope(
  points: RopePoint[],
  options: StepOptions,
  steps = 400,
): void {
  for (let i = 0; i < steps; i += 1) {
    stepRope(points, options);
  }
}

/** The angle of the last segment, for orienting whatever hangs off it. */
export function endAngle(points: RopePoint[]): number {
  const end = points[points.length - 1];
  const before = points[points.length - 2];
  if (!end || !before) {
    return 0;
  }
  return Math.atan2(end.x - before.x, before.y - end.y);
}
