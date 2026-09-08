import { useEffect, useRef, useState } from "react";
import { liveReactionTotal, type LiveReactionCount } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { subscribeToLiveReactions } from "@/lib/live-reactions";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import {
  admitParticles,
  chipLabel,
  isBurst,
  spawnParticles,
  type LiveParticle,
} from "./live-reaction-particles";

/**
 * Floating reactions over a shared screen.
 *
 * MOUNT IT AS A SIBLING OF THE VIDEO, never as a wrapper of one: it takes no
 * layout props, fills its positioned parent with `absolute inset-0`, and is
 * `pointer-events-none` throughout, so it drops unchanged into
 * `ScreenTileFrame` in `call-stage.tsx` and into the HLS player when that
 * lands. Whatever contains it must be `relative`.
 *
 * CHEAP BY CONSTRUCTION. Nothing here runs per frame. Each particle is a `span`
 * carrying one CSS keyframe (`live-reaction-float`) whose duration, delay,
 * sideways drift and size are handed to it once as inline properties; the
 * compositor does the rest and JavaScript never touches the element again. The
 * only timer in the file is a lazy sweep that drops finished particles from
 * React state, and it stops itself when there is nothing left on screen.
 *
 * REDUCED MOTION IS NOT A DIMMER. With the preference set, no particle is built
 * at all: not built and hidden, not built and slowed. What renders instead is a
 * static chip naming the loudest emoji and the window total, which carries the
 * same thing a viewer actually reads off the confetti (the room is reacting,
 * and this much) with no moving pixel anywhere.
 */

/** How long the chip lingers after the last window, in milliseconds. */
const CHIP_LINGER_MS = 2_000;

/** How long the burst pulse runs. Matches `live-reaction-burst` in index.css. */
const BURST_PULSE_MS = 420;

const SWEEP_INTERVAL_MS = 700;

export interface LiveReactionsOverlayProps {
  /** Only windows for this channel are drawn. */
  channelId: string;
  /**
   * Test seam and nothing else. Left undefined in the app so the hook decides;
   * the client's tests render on the server, where a media query cannot be
   * asked.
   */
  reducedMotion?: boolean;
  className?: string;
}

export function LiveReactionsOverlay({
  channelId,
  reducedMotion,
  className,
}: LiveReactionsOverlayProps) {
  const preferenceSaysReduce = usePrefersReducedMotion();
  const reduce = reducedMotion ?? preferenceSaysReduce;

  const [particles, setParticles] = useState<LiveParticle[]>([]);
  const [chip, setChip] = useState<{ label: string; total: number } | null>(
    null,
  );
  const [bursting, setBursting] = useState(false);
  const seedRef = useRef(0);

  useEffect(() => {
    let burstTimer: ReturnType<typeof setTimeout> | undefined;
    let chipTimer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = subscribeToLiveReactions((incomingWindow) => {
      if (incomingWindow.channelId !== channelId) {
        return;
      }
      const items: LiveReactionCount[] = incomingWindow.items;
      if (items.length === 0) {
        return;
      }
      if (reduce) {
        setChip({ label: chipLabel(items), total: liveReactionTotal(items) });
        clearTimeout(chipTimer);
        chipTimer = setTimeout(() => setChip(null), CHIP_LINGER_MS);
        return;
      }
      const now = Date.now();
      seedRef.current += 1;
      const incoming = spawnParticles(items, {
        now,
        random: Math.random,
        seed: `w${seedRef.current}`,
      });
      setParticles((current) => admitParticles(current, incoming, now));
      if (isBurst(items)) {
        setBursting(true);
        clearTimeout(burstTimer);
        burstTimer = setTimeout(() => setBursting(false), BURST_PULSE_MS);
      }
    });

    return () => {
      unsubscribe();
      clearTimeout(burstTimer);
      clearTimeout(chipTimer);
    };
  }, [channelId, reduce]);

  // The sweep exists so `particles` cannot grow without bound in a room that
  // reacts steadily for an hour. It is deliberately lazy: a finished particle
  // is already invisible (its keyframe ends at `opacity: 0`), so removing it a
  // moment late costs nothing, and running only while something is on screen
  // means an idle stage holds no timer at all.
  const idle = particles.length === 0;
  useEffect(() => {
    if (idle) {
      return;
    }
    const timer = setInterval(() => {
      const now = Date.now();
      setParticles((current) => {
        const alive = current.filter((particle) => particle.expiresAt > now);
        return alive.length === current.length ? current : alive;
      });
    }, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [idle]);

  if (reduce) {
    return chip ? (
      <LiveReactionsChip
        label={chip.label}
        total={chip.total}
        className={className}
      />
    ) : null;
  }

  return (
    <LiveReactionParticleLayer
      particles={particles}
      bursting={bursting}
      className={className}
    />
  );
}

/**
 * The particles, as markup and nothing else.
 *
 * Split out from the stateful component above so this repo's client tests can
 * assert what a given set of particles renders as. Those tests render on the
 * server, where an effect never runs and a subscription therefore never fires,
 * so a component that only ever gets particles from a subscription is a
 * component whose markup nothing can check.
 */
export function LiveReactionParticleLayer({
  particles,
  bursting = false,
  className,
}: {
  particles: readonly LiveParticle[];
  bursting?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-20 overflow-hidden",
        bursting && "animate-live-reaction-burst",
        className,
      )}
      data-testid="live-reactions-overlay"
      data-burst={bursting ? "true" : undefined}
      aria-hidden="true"
    >
      {particles.map((particle) => (
        <span
          key={particle.id}
          className="animate-live-reaction-float absolute bottom-8 select-none"
          data-testid="live-reaction-particle"
          style={{
            left: `${particle.leftPercent}%`,
            fontSize: `${particle.scale.toFixed(2)}rem`,
            animationDuration: `${Math.round(particle.durationMs)}ms`,
            animationDelay: `${Math.round(particle.delayMs)}ms`,
            // Read by the one keyframe, which is how every particle drifts a
            // different distance without a keyframe of its own.
            ["--live-reaction-drift" as string]: `${particle.driftPx.toFixed(0)}px`,
          }}
        >
          {particle.emoji}
        </span>
      ))}
    </div>
  );
}

/** The whole of the reduced-motion treatment: one static chip, no animation. */
export function LiveReactionsChip({
  label,
  total,
  className,
}: {
  label: string;
  total: number;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-14 right-3 z-20",
        className,
      )}
      data-testid="live-reactions-chip"
    >
      <span
        className="rounded-full bg-ink/70 px-2 py-1 text-xs font-medium text-paper"
        aria-live="polite"
        aria-label={t("voice.liveReactions.chip", { count: total })}
      >
        {label}
      </span>
    </div>
  );
}
