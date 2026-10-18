import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { botFaceSvg, type BotColor, type BotFace as BotFaceName } from "./bot-face-art";
import { cn } from "@/lib/utils";
import "./breu.css";

/**
 * Vendored from PR#1188 (`feat/custom-bots`) for the homepage's mascot, with
 * its import pointed at the local copy of the drawing. Delete this folder's
 * `bot-face*` files and `breu.css` once PR#1188 is on main and import
 * `components/bots/bot-face` instead. On that day also drop `home-bot-face`
 * (the class below and its tokens in breu.css), and carry the path z of
 * `bot-face-art.ts` over (fim.css, migration note). The page's own motion
 * (`breu-*` in hero.css, perch.css, tile.css and fim.css) stays.
 *
 * Breu, drawn inline from the shared drawing (`packages/shared/src/bot-face.ts`)
 * so it can move: it blinks, breathes and waves. The phone apps get the same
 * drawing as a PNG; this is the web's live copy.
 *
 * Motion is CSS only (`.bot-face-live` in breu.css), off under reduced
 * motion. A chat full of bot messages must not become a page of animations,
 * so at most `MAX_LIVE_AVATARS` avatar-size faces move at once, the first
 * ones on screen; the character drawing (`variant="full"`) moves whenever
 * `live` is true.
 *
 * `home-bot-face` carries the page's bot tokens (breu.css). It is a class
 * only this copy sets, so the tokens never reach a face the app draws once
 * PR#1188's own `.bot-face` shares the document with this one.
 */

export const MAX_LIVE_AVATARS = 3;

interface BotFaceProps {
  color: BotColor;
  face: BotFaceName;
  variant?: "full" | "avatar";
  /** Size and placement. The SVG fills the box. */
  className?: string;
  /** Accessible name; without it the face is decorative. The homepage never passes one. */
  title?: string;
  /** False holds it still (a list of faces to pick from). */
  live?: boolean;
}

export function BotFace({
  color,
  face,
  variant = "avatar",
  className,
  title,
  live = true,
}: BotFaceProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const slot = useLiveAvatarSlot(ref, live && variant === "avatar");
  const moving = live && (variant === "full" || slot);
  const svg = useMemo(
    () => botFaceSvg({ color, face, variant, ...(title ? { title } : {}) }),
    [color, face, variant, title],
  );
  return (
    <span
      ref={ref}
      data-variant={variant}
      data-face={face}
      className={cn("bot-face home-bot-face inline-block shrink-0", moving && "bot-face-live", className)}
      // Built from constants only (no user text reaches it; the title is
      // stripped of markup), which is what makes inlining it safe.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/* ---------------------------------------------------------------- slots */

const visible: Element[] = [];
const listeners = new Set<() => void>();
let observer: IntersectionObserver | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function observe(element: Element): void {
  if (typeof IntersectionObserver === "undefined") {
    return;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = visible.indexOf(entry.target);
      if (entry.isIntersecting && index === -1) visible.push(entry.target);
      if (!entry.isIntersecting && index !== -1) visible.splice(index, 1);
    }
    notify();
  });
  observer.observe(element);
}

function unobserve(element: Element): void {
  observer?.unobserve(element);
  const index = visible.indexOf(element);
  if (index !== -1) {
    visible.splice(index, 1);
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while this face is one of the first few on screen. */
function useLiveAvatarSlot(ref: React.RefObject<HTMLElement | null>, wanted: boolean): boolean {
  useEffect(() => {
    const element = ref.current;
    if (!wanted || !element) return;
    observe(element);
    return () => unobserve(element);
  }, [ref, wanted]);
  return useSyncExternalStore(
    subscribe,
    () => {
      const element = ref.current;
      if (!wanted || !element) return false;
      const index = visible.indexOf(element);
      return index !== -1 && index < MAX_LIVE_AVATARS;
    },
    () => false,
  );
}
