import { type Ref, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { BotFace } from "./bot-face";
import "./hero.css";

/**
 * How fast the greeting fades while pinned: its opacity is `1 - --p-frame * N`,
 * so it is clear at `--p-frame` 1 / N. The hero reads this to know when the
 * greeting is gone (`HERO_BREU_GONE_AT` in index.tsx).
 */
export const HERO_BREU_FADE = 3;

/**
 * The hero's greeting: Breu, the mascot, rises from behind the app window's
 * top bar and waves (the `oi` face carries the floating hand). No copy, no
 * name, no claim, and never inside the footage: it sits outside the window,
 * on the frame's top edge, and the opaque window paints over its lower body.
 * Decorative: aria-hidden and no pointer events.
 *
 * The hero renders it at lg and up only; below that there is no room above
 * the window without covering the copy. At lg and up, pinned means motion is
 * allowed and unpinned means reduced motion, so `live` is simply `pinned`.
 *
 * Pinned, it sinks and fades as the window grows and is gone by `--p-frame`
 * 1/3, long before the window settles. The hero sets `data-gone` from its own
 * progress callback at the scroll position where the opacity reaches 0, which
 * hides it and pauses its loops without a React render per scroll frame.
 * Unpinned (reduced motion), it rests in its peek pose, still, and the scene's
 * values rest at 1, so it carries no fade.
 *
 * It mounts one commit after the hero (the gate below): the static first
 * screen (`lib/prerender-hero.ts`) has no Breu, a static render of the live
 * hero has none either, and React's takeover of the static block lands
 * without it. Breu then peeks in (hero.css). It is absolutely placed, so its
 * arrival moves no layout box.
 */
export function HeroBreu({ pinned, ref }: { pinned: boolean; ref?: Ref<HTMLSpanElement> }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Greeting pinned={pinned} ref={ref} /> : null;
}

function Greeting({ pinned, ref }: { pinned: boolean; ref?: Ref<HTMLSpanElement> }) {
  return (
    <span
      ref={ref}
      aria-hidden
      data-pinned={pinned ? "" : undefined}
      className={cn(
        "breu-hero pointer-events-none absolute bottom-full right-[9%]",
        pinned ? "h-28 w-28" : "h-20 w-20",
      )}
      // Unpinned, the scene's values rest at 1, and this would hide it.
      style={
        pinned
          ? { opacity: `calc(1 - var(--p-frame) * ${HERO_BREU_FADE})`, translate: "0 calc(var(--p-frame) * 40%)" }
          : undefined
      }
    >
      <span className="breu-hero-peek block h-full w-full">
        <BotFace color="lime" face="oi" variant="full" live={pinned} className="breu-glance-cta h-full w-full" />
      </span>
    </span>
  );
}
