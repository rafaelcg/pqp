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
export const MAX_ROLL_COMMENT = 80;
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

const rollCommentSchema = z.string().trim().min(1).max(MAX_ROLL_COMMENT);

export const chanceRollGroupSchema = z.object({
  sides: z.number().int().positive(),
  faces: z.array(z.number().int().positive()).min(1).max(MAX_DICE_COUNT),
  sign: z.union([z.literal(1), z.literal(-1)]).default(1),
});

export type ChanceRollGroup = z.infer<typeof chanceRollGroupSchema>;

export const chanceRollResultSchema = z.object({
  type: z.literal("roll"),
  notation: z.string().min(1).max(64),
  faces: z.array(z.number().int().positive()).min(1).max(MAX_DICE_COUNT),
  groups: z.array(chanceRollGroupSchema).max(16).optional(),
  modifier: z.number().int(),
  total: z.number().int(),
  comment: rollCommentSchema.optional(),
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
  remaining: z.number().int().nonnegative().optional(),
  reshuffled: z.boolean().optional(),
});

export const chanceShuffleResultSchema = z.object({
  type: z.literal("shuffle"),
  remaining: z.number().int().nonnegative(),
});

export const chanceResultSchema = z.discriminatedUnion("type", [
  chanceRollResultSchema,
  chanceFlipResultSchema,
  chanceChooseResultSchema,
  chanceDrawResultSchema,
  chanceShuffleResultSchema,
]);

export type ChanceResult = z.infer<typeof chanceResultSchema>;

export const chanceRollRequestSchema = z.object({
  type: z.literal("roll"),
  notation: z.string().min(0).max(64).optional(),
  comment: rollCommentSchema.optional(),
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

export const chanceShuffleRequestSchema = z.object({
  type: z.literal("shuffle"),
});

export const chanceRequestSchema = z.discriminatedUnion("type", [
  chanceRollRequestSchema,
  chanceFlipRequestSchema,
  chanceChooseRequestSchema,
  chanceDrawRequestSchema,
  chanceShuffleRequestSchema,
]);

export type ChanceRequest = z.infer<typeof chanceRequestSchema>;

export type ChanceParseError =
  | "invalid-notation"
  | "bad-face"
  | "too-many-dice"
  | "comment-too-long"
  | "too-few-options"
  | "too-many-options"
  | "empty-option"
  | "option-too-long"
  | "bad-draw-count";

export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; error: ChanceParseError };
export type ParseResult<T> = ParseOk<T> | ParseErr;

export interface RollTerm {
  count: number;
  sides: RollFace;
  sign: 1 | -1;
}

export interface ParsedRoll {
  terms: RollTerm[];
  modifier: number;
  notation: string;
  comment?: string;
  /** First term, for callers that still think in NdM. */
  count: number;
  sides: RollFace;
}

export function isRollFace(value: number): value is RollFace {
  return (ROLL_FACES as readonly number[]).includes(value);
}

/**
 * Inclusive integer in [min, max]. Injected so tests can pin a face without
 * stubbing `crypto`, and so the browser and Node share one call shape.
 */
export type RandomInt = (min: number, max: number) => number;

/** Split `/roll 2d6+3 ! ataque` into notation and an optional comment. */
export function splitRollComment(raw: string): ParseResult<{
  notation: string;
  comment?: string;
}> {
  const cut = raw.indexOf("!");
  if (cut < 0) {
    return { ok: true, value: { notation: raw.trim() } };
  }
  const notation = raw.slice(0, cut).trim();
  const comment = raw.slice(cut + 1).replace(/\s+/g, " ").trim();
  if (!comment) {
    return { ok: true, value: { notation } };
  }
  if (comment.length > MAX_ROLL_COMMENT) {
    return { ok: false, error: "comment-too-long" };
  }
  return { ok: true, value: { notation, comment } };
}

export function parseRollNotation(raw: string | undefined): ParseResult<ParsedRoll> {
  const split = splitRollComment(raw ?? "");
  if (!split.ok) {
    return split;
  }
  const input = (split.value.notation || DEFAULT_ROLL_NOTATION).replace(/\s+/g, "");
  const terms: RollTerm[] = [];
  let modifier = 0;
  let i = 0;
  let sawTerm = false;

  while (i < input.length) {
    let sign: 1 | -1 = 1;
    const leading = input[i];
    if (leading === "+" || leading === "-") {
      // `2d6+3` lands here on the `+`, then the next token is a flat modifier.
      // A leading `-2d6` is refused: the first term has to be dice, not a
      // signed hole.
      if (!sawTerm && leading === "-") {
        return { ok: false, error: "invalid-notation" };
      }
      sign = leading === "-" ? -1 : 1;
      i += 1;
    } else if (sawTerm) {
      return { ok: false, error: "invalid-notation" };
    }

    const rest = input.slice(i);
    const dice = /^(\d{1,3})?d(\d{1,3})/i.exec(rest);
    if (dice) {
      const count = dice[1] ? Number(dice[1]) : 1;
      const sides = Number(dice[2]);
      if (!isRollFace(sides)) {
        return { ok: false, error: "bad-face" };
      }
      if (count < 1) {
        return { ok: false, error: "too-many-dice" };
      }
      terms.push({ count, sides, sign });
      i += dice[0].length;
      sawTerm = true;
      continue;
    }

    const flat = /^(\d{1,4})/.exec(rest);
    if (flat && sawTerm) {
      const value = Number(flat[1]);
      if (!Number.isInteger(value) || value > MAX_ROLL_MODIFIER) {
        return { ok: false, error: "invalid-notation" };
      }
      modifier += sign * value;
      i += flat[1].length;
      continue;
    }

    return { ok: false, error: "invalid-notation" };
  }

  if (terms.length === 0) {
    return { ok: false, error: "invalid-notation" };
  }

  const diceCount = terms.reduce((sum, term) => sum + term.count, 0);
  if (diceCount < 1 || diceCount > MAX_DICE_COUNT) {
    return { ok: false, error: "too-many-dice" };
  }
  if (Math.abs(modifier) > MAX_ROLL_MODIFIER) {
    return { ok: false, error: "invalid-notation" };
  }

  const first = terms[0]!;
  return {
    ok: true,
    value: {
      terms,
      modifier,
      notation: formatRollNotation(terms, modifier),
      comment: split.value.comment,
      count: first.count,
      sides: first.sides,
    },
  };
}

export function formatRollNotation(terms: RollTerm[], modifier: number): string {
  const dice = terms
    .map((term, index) => {
      const body = `${term.count}d${term.sides}`;
      if (index === 0) {
        return term.sign === -1 ? `-${body}` : body;
      }
      return term.sign === -1 ? `-${body}` : `+${body}`;
    })
    .join("");
  if (modifier > 0) {
    return `${dice}+${modifier}`;
  }
  if (modifier < 0) {
    return `${dice}${modifier}`;
  }
  return dice;
}

export function parseChooseOptions(raw: string): ParseResult<string[]> {
  const pieces = raw
    .split(/[,\n]/)
    .flatMap((part) => part.trim().split(/\s{2,}/))
    .map((part) => part.trim())
    .filter(Boolean);
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
  const groups: ChanceRollGroup[] = [];
  const faces: number[] = [];
  let total = parsed.modifier;
  for (const term of parsed.terms) {
    const termFaces = Array.from({ length: term.count }, () =>
      randomInt(1, term.sides),
    );
    faces.push(...termFaces);
    groups.push({ sides: term.sides, faces: termFaces, sign: term.sign });
    const sum = termFaces.reduce((acc, face) => acc + face, 0);
    total += term.sign * sum;
  }
  return {
    type: "roll",
    notation: parsed.notation,
    faces,
    groups,
    modifier: parsed.modifier,
    total,
    ...(parsed.comment ? { comment: parsed.comment } : {}),
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

export function shuffleDeck(randomInt: RandomInt): PlayingCard[] {
  const deck = [...STANDARD_DECK];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    const swap = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = swap;
  }
  return deck;
}

export function executeDraw(count: number, randomInt: RandomInt): ChanceResult {
  const deck = shuffleDeck(randomInt);
  return {
    type: "draw",
    cards: deck.slice(0, count),
    remaining: STANDARD_DECK.length - count,
    reshuffled: true,
  };
}

export function executeShuffle(): ChanceResult {
  return { type: "shuffle", remaining: STANDARD_DECK.length };
}

export function resolveChanceRequest(
  request: ChanceRequest,
  randomInt: RandomInt,
): ParseResult<ChanceResult> {
  switch (request.type) {
    case "roll": {
      const raw = request.comment
        ? `${request.notation ?? ""} ! ${request.comment}`
        : request.notation;
      const parsed = parseRollNotation(raw);
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
    case "shuffle":
      return { ok: true, value: executeShuffle() };
  }
}

/** Groups to render. Older stored rolls only have a flat `faces` list. */
export function rollGroups(
  result: Extract<ChanceResult, { type: "roll" }>,
): ChanceRollGroup[] {
  if (result.groups && result.groups.length > 0) {
    return result.groups;
  }
  const match = /d(\d+)/i.exec(result.notation);
  const sides = match ? Number(match[1]) : 20;
  return [{ sides, faces: result.faces, sign: 1 }];
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
      let line: string;
      if (result.modifier > 0) {
        line = `${result.notation} → ${faces} + ${result.modifier} = ${result.total}`;
      } else if (result.modifier < 0) {
        line = `${result.notation} → ${faces} - ${Math.abs(result.modifier)} = ${result.total}`;
      } else if (result.faces.length === 1) {
        line = `${result.notation} → ${result.total}`;
      } else {
        line = `${result.notation} → ${faces} = ${result.total}`;
      }
      return result.comment ? `${line} ! ${result.comment}` : line;
    }
    case "flip":
      return `flip → ${result.result}`;
    case "choose":
      return `choose → ${result.picked}`;
    case "draw": {
      const cards = `draw → ${result.cards.join(" ")}`;
      return result.remaining === undefined ? cards : `${cards} (${result.remaining} left)`;
    }
    case "shuffle":
      return `shuffle → ${result.remaining} left`;
  }
}

export function chanceCommandName(
  result: ChanceResult,
): "roll" | "flip" | "choose" | "draw" | "shuffle" {
  return result.type;
}
