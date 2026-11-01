import { BotFace } from "@/components/bots/bot-face";
import { cn } from "@/lib/utils";

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
   */
  motion?: "working";
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
