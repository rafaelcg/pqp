import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * One burst of confetti, once, for the moment somebody arrives.
 *
 * WHY NOT A LIBRARY. `canvas-confetti` is 5–8 KB gzipped for one animation on
 * one screen, and it would land in the App chunk that every signed-in user
 * downloads. The whole effect is ninety rotating rectangles under gravity; that
 * is the eighty lines below, and this repo already refuses a 15–40 KB i18n
 * dependency for the same reason (see `lib/i18n/catalogue.ts`).
 *
 * WHY IT RESPECTS `prefers-reduced-motion`. A screenful of falling objects is
 * exactly the pattern that triggers vestibular symptoms, and the user has
 * already told the browser they do not want it. Under that query nothing moves:
 * the moment is carried by a still row of the same coloured marks instead, which
 * is the same idea told in one frame.
 *
 * WHY IT CANNOT GET IN THE WAY. The canvas is portalled to `document.body`,
 * `pointer-events-none`, `aria-hidden`, and never focused — the dialog's own
 * focus trap puts the caret in the name field on mount and this does not touch
 * it. Someone who wants to type their handle and leave can do it through the
 * confetti.
 */

/**
 * The palette, as literal hex rather than the oklch theme tokens.
 *
 * `ctx.fillStyle` goes through the CSS colour parser, so `oklch()` mostly works
 * — but "mostly" on a decorative animation is not worth a runtime probe and a
 * fallback path. These are the same five colours the tokens resolve to
 * (`--color-accent`, its hover, success, warning, and text), frozen. They read
 * as pqp in both themes because they sit on the modal scrim, which is dark in
 * both by design.
 */
const COLORS = ["#c4e848", "#9fc23c", "#4ec98a", "#e8b04a", "#e8e4d6"];

const PARTICLE_COUNT = 90;
const DURATION_MS = 2600;
const FADE_MS = 700;
/** Pixels per second per second. Tuned so the screen clears about when it ends. */
const GRAVITY = 420;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  rotation: number;
  spin: number;
  /** Desynchronises the horizontal sway so they do not flutter in formation. */
  phase: number;
  color: string;
}

function makeParticles(width: number, height: number): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: Math.random() * width,
      // Staggered above the fold rather than released together: one solid line
      // crossing the screen reads as a wipe, not as confetti.
      y: -Math.random() * height * 0.9 - 10,
      vx: (Math.random() - 0.5) * 90,
      vy: 120 + Math.random() * 220,
      width: 5 + Math.random() * 6,
      height: 8 + Math.random() * 8,
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 9,
      phase: Math.random() * Math.PI * 2,
      color: COLORS[i % COLORS.length]!,
    });
  }
  return particles;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function Confetti() {
  // Read once, in a state initialiser. Not a subscription: this fires on arrival
  // and is over in under three seconds, so re-reacting to a preference change
  // mid-animation would only ever produce a flicker.
  const [reduced] = useState(prefersReducedMotion);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (reduced) {
      return;
    }
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    // Re-bound after the guard: `draw` below is a hoisted function declaration,
    // and TypeScript does not carry a narrowing across one of those.
    const ctx: CanvasRenderingContext2D = context;

    // Sized once. The animation is shorter than the time it takes to rotate a
    // phone, and a resize listener for that is a listener that outlives its
    // purpose.
    const width = window.innerWidth;
    const height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.scale(ratio, ratio);

    const particles = makeParticles(width, height);
    const start = performance.now();
    let previous = start;
    let frameId = 0;

    function draw(now: number) {
      const elapsed = now - start;
      if (elapsed >= DURATION_MS) {
        ctx.clearRect(0, 0, width, height);
        return;
      }
      // Clamped: a backgrounded tab hands back one enormous delta on return,
      // which would teleport every particle off the bottom in a single frame.
      const delta = Math.min(now - previous, 50) / 1000;
      previous = now;

      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha =
        elapsed > DURATION_MS - FADE_MS
          ? Math.max(0, (DURATION_MS - elapsed) / FADE_MS)
          : 1;

      for (const particle of particles) {
        particle.vy += GRAVITY * delta;
        particle.x +=
          (particle.vx + Math.sin(elapsed / 400 + particle.phase) * 40) * delta;
        particle.y += particle.vy * delta;
        particle.rotation += particle.spin * delta;

        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.rotation);
        ctx.fillStyle = particle.color;
        ctx.fillRect(
          -particle.width / 2,
          -particle.height / 2,
          particle.width,
          particle.height,
        );
        ctx.restore();
      }

      frameId = requestAnimationFrame(draw);
    }

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [reduced]);

  if (reduced) {
    return (
      <div
        aria-hidden
        className="mb-3 flex justify-center gap-1.5"
        data-testid="confetti-still"
      >
        {COLORS.map((color, index) => (
          <span
            key={color}
            className="block h-2.5 w-2 rounded-[1px]"
            style={{
              backgroundColor: color,
              // Still, but not in a row like a progress bar.
              transform: `rotate(${(index - 2) * 14}deg)`,
            }}
          />
        ))}
      </div>
    );
  }

  return createPortal(
    <canvas
      ref={canvasRef}
      aria-hidden
      // Above the dialog's own z-[60] so it falls in front of the panel, and
      // inert so every click and tap lands on what is underneath.
      className="pointer-events-none fixed inset-0 z-[70]"
    />,
    document.body,
  );
}
