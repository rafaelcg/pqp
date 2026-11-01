import { BotFace } from "@/components/bots/bot-face";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Breu, the pqp mascot, outside a bot: on the rare, human moments of the app
 * (something broke, nothing here yet, still loading). The drawing and its
 * motion are the bots' own (`BotFace`, `variant="full"`), always lime.
 *
 * Kept OUT of dense or serious surfaces on purpose: a live call, moderation
 * and bans, reports, legal pages, compact lists and frequent error toasts. The
 * list and why: the comment on each caller, and `docs/DESIGN.md` §Breu.
 *
 * Decorative by default (the text next to it says what happened); pass `title`
 * only where Breu is the whole message.
 */

export type BreuMood =
  | "hello"
  | "curious"
  | "laughing"
  | "focused"
  | "sad"
  | "asleep"
  | "panic";

const FACE = {
  hello: "oi",
  curious: "curioso",
  laughing: "kkkk",
  focused: "focado",
  sad: "triste",
  asleep: "dormindo",
  panic: "panico",
} as const;

const SIZE = {
  sm: "h-14 w-14",
  md: "h-20 w-20",
  lg: "h-28 w-28",
  /** The API failure page's Breu, three times `md`. */
  xl: "h-60 w-60",
} as const;

export function Breu({
  mood,
  size = "md",
  className,
  title,
  motion,
}: {
  mood: BreuMood;
  size?: keyof typeof SIZE;
  className?: string;
  title?: string;
  /**
   * `working` is a steady hop and lean for the loading screen. It moves two
   * HTML wrappers with `transform` only, so the compositor keeps it going while
   * the main thread parses chunks, and `motion-reduce` holds it still. Without
   * it Breu keeps the bots' own motion.
   *
   * `oops` is the API failure page's: Breu drops in once with a small squash,
   * then sways slowly. Same two-wrapper arrangement as `working`; under
   * `motion-reduce` he is simply there, still.
   */
  motion?: "working" | "oops";
}) {
  if (motion === "working") {
    // The wrappers carry the loop, so the face inside is held still (`live`
    // off): its own SVG breathing would only fight the hop.
    return (
      <span
        data-breu-motion="working"
        className={cn(
          "inline-block shrink-0 origin-bottom will-change-transform animate-[breu-work-bob_2s_ease-in-out_infinite] motion-reduce:animate-none",
          SIZE[size],
          className,
        )}
      >
        <span className="block h-full w-full origin-bottom will-change-transform animate-[breu-work-lean_2s_ease-in-out_infinite] motion-reduce:animate-none">
          <BotFace
            color="lime"
            face={FACE[mood]}
            variant="full"
            title={title}
            live={false}
            className="h-full w-full"
          />
        </span>
      </span>
    );
  }
  if (motion === "oops") {
    return (
      <span
        data-breu-motion="oops"
        className={cn(
          "inline-block shrink-0 origin-bottom will-change-transform animate-[breu-oops-drop_0.7s_ease-out_both] motion-reduce:animate-none",
          SIZE[size],
          className,
        )}
      >
        {/* The sway waits for the drop to land, and starts from upright. */}
        <span className="block h-full w-full origin-bottom will-change-transform animate-[breu-oops-sway_3s_ease-in-out_0.7s_infinite] motion-reduce:animate-none">
          <BotFace
            color="lime"
            face={FACE[mood]}
            variant="full"
            title={title}
            live={false}
            className="h-full w-full"
          />
        </span>
      </span>
    );
  }
  return (
    <BotFace
      color="lime"
      face={FACE[mood]}
      variant="full"
      title={title}
      className={cn(SIZE[size], className)}
    />
  );
}

/**
 * A small speech bubble for Breu, its tail on the bottom right so it points at
 * a Breu drawn below and to the right of it. It pops in once, after `oops`
 * has landed, and stays; under `motion-reduce` it is shown at once.
 * Decorative: the text beside Breu says what happened.
 */
export function BreuSpeechBubble({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-breu-bubble=""
      className={cn(
        "relative inline-block origin-bottom-right rounded-2xl border border-border bg-surface-1 px-3.5 py-1.5 text-lg font-bold leading-tight text-text will-change-transform animate-[breu-bubble-pop_0.32s_ease-out_0.8s_both] motion-reduce:animate-none",
        className,
      )}
    >
      {children}
      <span className="absolute -bottom-[7px] right-4 h-3 w-3 rotate-45 border-r border-b border-border bg-surface-1" />
    </span>
  );
}
