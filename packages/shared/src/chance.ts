import { z } from "zod";

/**
 * Shared randomizers posted into chat: dice, coin, pick-one, playing cards.
 *
 * The client sends a *request* (notation, options, a draw count). The server
 * is the only place that rolls, so two people looking at the same message
 * cannot disagree about the number, and a client cannot pick its own total.
 */

export const ROLL_FACES = [4, 6, 8, 10, 12, 20, 100] as const;
export type RollFace = (typeof ROLL_FACES)[number];

export const MAX_DICE_COUNT = 100;
export const MAX_ROLL_MODIFIER = 9999;
export const MAX_CHOOSE_OPTIONS = 20;
export const MIN_CHOOSE_OPTIONS = 2;
export const MAX_CHOOSE_OPTION_LENGTH = 80;
export const MAX_DRAW_COUNT = 13;
export const DEFAULT_DRAW_COUNT = 1;
export const DEFAULT_ROLL_NOTATION = "1d20";

export const CARD_RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;
export const CARD_SUITS = ["S", "H", "D", "C"] as const;
export type CardRank = (typeof CARD_RANKS)[number];
export type CardSuit = (typeof CARD_SUITS)[number];
export type PlayingCard = `${CardRank}${CardSuit}`;

export const STANDARD_DECK: PlayingCard[] = CARD_SUITS.flatMap((suit) =>
  CARD_RANKS.map((rank) => `${rank}${suit}` as PlayingCard),
);

const ROLL_NOTATION_RE = /^\s*(\d{1,3})?d(\d{1,3})([+-]\d{1,4})?\s*$/i;

export const chanceRollResultSchema = z.object({
  type: z.literal("roll"),
  notation: z.string().min(1).max(32),
  faces: z.array(z.number().int().positive()).min(1).max(MAX_DICE_COUNT),
  modifier: z.number().int(),
  total: z.number().int(),
});

export const chanceFlipResultSchema = z.object({
  type: z.literal("flip"),
  result: z.enum(["heads", "tails"]),
});

export const chanceChooseResultSchema = z.object({
  type: z.literal("choose"),
  options: z.array(z.string().min(1).max(MAX_CHOOSE_OPTION_LENGTH)).min(
    MIN_CHOOSE_OPTIONS,
  ).max(MAX_CHOOSE_OPTIONS),
  picked: z.string().min(1).max(MAX_CHOOSE_OPTION_LENGTH),
});

export const chanceDrawResultSchema = z.object({
  type: z.literal("draw"),
  cards: z.array(z.string().min(2).max(3)).min(1).max(MAX_DRAW_COUNT),
});

export const chanceResultSchema = z.discriminatedUnion("type", [
  chanceRollResultSchema,
  chanceFlipResultSchema,
  chanceChooseResultSchema,
  chanceDrawResultSchema,
]);

export type ChanceResult = z.infer<typeof chanceResultSchema>;

export const chanceRollRequestSchema = z.object({
  type: z.literal("roll"),
  notation: z.string().min(0).max(32).optional(),
});

export const chanceFlipRequestSchema = z.object({
  type: z.literal("flip"),
});

export const chanceChooseRequestSchema = z.object({
  type: z.literal("choose"),
  options: z.array(z.string().min(1).max(MAX_CHOOSE_OPTION_LENGTH)).min(
    MIN_CHOOSE_OPTIONS,
  ).max(MAX_CHOOSE_OPTIONS),
});

export const chanceDrawRequestSchema = z.object({
  type: z.literal("draw"),
  count: z.number().int().min(1).max(MAX_DRAW_COUNT).optional(),
});

export const chanceRequestSchema = z.discriminatedUnion("type", [
  chanceRollRequestSchema,
  chanceFlipRequestSchema,
  chanceChooseRequestSchema,
  chanceDrawRequestSchema,
]);

export type ChanceRequest = z.infer<typeof chanceRequestSchema>;

export type ChanceParseError =
  | "invalid-notation"
  | "bad-face"
  | "too-many-dice"
  | "too-few-options"
  | "too-many-options"
  | "empty-option"
  | "option-too-long"
  | "bad-draw-count";

export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; error: ChanceParseError };
export type ParseResult<T> = ParseOk<T> | ParseErr;

export interface ParsedRoll {
  count: number;
  sides: RollFace;
  modifier: number;
  notation: string;
}

export function isRollFace(value: number): value is RollFace {
  return (ROLL_FACES as readonly number[]).includes(value);
}

/**
 * Inclusive integer in [min, max]. Injected so tests can pin a face without
 * stubbing `crypto`, and so the browser and Node share one call shape.
 */
export type RandomInt = (min: number, max: number) => number;

export function parseRollNotation(raw: string | undefined): ParseResult<ParsedRoll> {
  const input = (raw ?? "").trim() || DEFAULT_ROLL_NOTATION;
  const match = ROLL_NOTATION_RE.exec(input);
  if (!match) {
    return { ok: false, error: "invalid-notation" };
  }
  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;
  if (!isRollFace(sides)) {
    return { ok: false, error: "bad-face" };
  }
  if (count < 1 || count > MAX_DICE_COUNT) {
    return { ok: false, error: "too-many-dice" };
  }
  if (!Number.isInteger(modifier) || Math.abs(modifier) > MAX_ROLL_MODIFIER) {
    return { ok: false, error: "invalid-notation" };
  }
  const notation = formatRollNotation(count, sides, modifier);
  return { ok: true, value: { count, sides, modifier, notation } };
}

export function formatRollNotation(
  count: number,
  sides: number,
  modifier: number,
): string {
  const base = `${count}d${sides}`;
  if (modifier > 0) {
    return `${base}+${modifier}`;
  }
  if (modifier < 0) {
    return `${base}${modifier}`;
  }
  return base;
}

export function parseChooseOptions(raw: string): ParseResult<string[]> {
  const pieces = raw
    .split(/[,\n]/)
    .flatMap((part) => part.trim().split(/\s{2,}/))
    .map((part) => part.trim())
    .filter(Boolean);
  // A single line of space-separated words is the common `/choose a b c` form.
  const options =
    pieces.length >= MIN_CHOOSE_OPTIONS
      ? pieces
      : raw.trim().split(/\s+/).map((part) => part.trim()).filter(Boolean);
  if (options.length < MIN_CHOOSE_OPTIONS) {
    return { ok: false, error: "too-few-options" };
  }
  if (options.length > MAX_CHOOSE_OPTIONS) {
    return { ok: false, error: "too-many-options" };
  }
  for (const option of options) {
    if (!option) {
      return { ok: false, error: "empty-option" };
    }
    if (option.length > MAX_CHOOSE_OPTION_LENGTH) {
      return { ok: false, error: "option-too-long" };
    }
  }
  return { ok: true, value: options };
}

export function parseDrawCount(raw: string | undefined): ParseResult<number> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, value: DEFAULT_DRAW_COUNT };
  }
  if (!/^\d{1,2}$/.test(trimmed)) {
    return { ok: false, error: "bad-draw-count" };
  }
  const count = Number(trimmed);
  if (count < 1 || count > MAX_DRAW_COUNT) {
    return { ok: false, error: "bad-draw-count" };
  }
  return { ok: true, value: count };
}

export function executeRoll(parsed: ParsedRoll, randomInt: RandomInt): ChanceResult {
  const faces = Array.from({ length: parsed.count }, () =>
    randomInt(1, parsed.sides),
  );
  const total = faces.reduce((sum, face) => sum + face, 0) + parsed.modifier;
  return {
    type: "roll",
    notation: parsed.notation,
    faces,
    modifier: parsed.modifier,
    total,
  };
}

export function executeFlip(randomInt: RandomInt): ChanceResult {
  return {
    type: "flip",
    result: randomInt(0, 1) === 0 ? "heads" : "tails",
  };
}

export function executeChoose(options: string[], randomInt: RandomInt): ChanceResult {
  const picked = options[randomInt(0, options.length - 1)]!;
  return { type: "choose", options, picked };
}

export function executeDraw(count: number, randomInt: RandomInt): ChanceResult {
  const deck = [...STANDARD_DECK];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    const swap = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = swap;
  }
  return { type: "draw", cards: deck.slice(0, count) };
}

export function resolveChanceRequest(
  request: ChanceRequest,
  randomInt: RandomInt,
): ParseResult<ChanceResult> {
  switch (request.type) {
    case "roll": {
      const parsed = parseRollNotation(request.notation);
      if (!parsed.ok) {
        return parsed;
      }
      return { ok: true, value: executeRoll(parsed.value, randomInt) };
    }
    case "flip":
      return { ok: true, value: executeFlip(randomInt) };
    case "choose": {
      if (request.options.length < MIN_CHOOSE_OPTIONS) {
        return { ok: false, error: "too-few-options" };
      }
      return { ok: true, value: executeChoose(request.options, randomInt) };
    }
    case "draw": {
      const count = request.count ?? DEFAULT_DRAW_COUNT;
      if (count < 1 || count > MAX_DRAW_COUNT) {
        return { ok: false, error: "bad-draw-count" };
      }
      return { ok: true, value: executeDraw(count, randomInt) };
    }
  }
}

/**
 * One-line fallback stored in `messages.body` so search, notifications, and
 * clients that do not render a card still have something readable. English
 * and notation-heavy on purpose: this is a machine string, not UI copy.
 */
export function formatChanceBody(result: ChanceResult): string {
  switch (result.type) {
    case "roll": {
      const faces = result.faces.join(", ");
      if (result.modifier > 0) {
        return `${result.notation} → ${faces} + ${result.modifier} = ${result.total}`;
      }
      if (result.modifier < 0) {
        return `${result.notation} → ${faces} - ${Math.abs(result.modifier)} = ${result.total}`;
      }
      if (result.faces.length === 1) {
        return `${result.notation} → ${result.total}`;
      }
      return `${result.notation} → ${faces} = ${result.total}`;
    }
    case "flip":
      return `flip → ${result.result}`;
    case "choose":
      return `choose → ${result.picked}`;
    case "draw":
      return `draw → ${result.cards.join(" ")}`;
  }
}

export function chanceCommandName(result: ChanceResult): "roll" | "flip" | "choose" | "draw" {
  return result.type;
}
