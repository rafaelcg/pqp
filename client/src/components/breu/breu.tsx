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
}: {
  mood: BreuMood;
  size?: keyof typeof SIZE;
  className?: string;
  title?: string;
}) {
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
