import { useEffect, useState, type AnimationEvent } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { useNudgeShakeTick } from "@/lib/nudge";

/** Longer than either animation, so a missed `animationend` cannot pin the class. */
const SAFETY_MS = 1_200;

export type NudgeShakeKind = "shake" | "pulse";

/** Which effect the pane gets. Reduced motion never moves anything. */
export function nudgeShakeKind(reducedMotion: boolean): NudgeShakeKind {
  return reducedMotion ? "pulse" : "shake";
}

export interface NudgeShakeProps {
  className: string | undefined;
  "data-nudge": NudgeShakeKind | undefined;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
}

/**
 * Props to spread on the element that shows a conversation, so it shakes once
 * when a fresh nudge arrives for it (`triggerNudgeShake` in `lib/nudge.ts`).
 *
 * Only a shake asked for AFTER this mounted plays: opening a conversation, or
 * switching back to one, never replays an old one. Under
 * `prefers-reduced-motion` the pane gets `nudge-pulse` (a border that fades in
 * twice) instead of `nudge-shake`. The class comes off on `animationend`, with
 * a timer behind it in case the event never fires.
 */
export function useNudgeShake(channelId: string | null): NudgeShakeProps {
  const tick = useNudgeShakeTick(channelId);
  const reducedMotion = usePrefersReducedMotion();
  const [settled, setSettled] = useState(tick);
  const playing = tick > settled;

  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = window.setTimeout(() => setSettled(tick), SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [playing, tick]);

  // A different conversation starts from its own counter.
  const [forChannel, setForChannel] = useState(channelId);
  if (forChannel !== channelId) {
    setForChannel(channelId);
    setSettled(tick);
  }

  const kind = nudgeShakeKind(reducedMotion);
  return {
    className: playing ? (kind === "shake" ? "nudge-shake" : "nudge-pulse") : undefined,
    "data-nudge": playing ? kind : undefined,
    onAnimationEnd: (event) => {
      if (event.target === event.currentTarget && playing) {
        setSettled(tick);
      }
    },
  };
}
