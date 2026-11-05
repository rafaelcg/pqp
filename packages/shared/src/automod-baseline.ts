import { z } from "zod";
import {
  compileKeywords,
  findBlockedKeyword,
  normalizeForAutomod,
  type CompiledKeywords,
} from "./automod.js";

/**
 * The baseline text filter: what pqp refuses on every server, with no rule
 * written by anybody, unless the server's owner switches it off.
 *
 * WHY IT EXISTS. AutoMod (`automod.ts`) is a tool for an owner to write their
 * own list, and an owner who wrote none got no filtering at all. App Store
 * Guideline 1.2 asks for "a method for filtering objectionable content", and
 * "opt-in per server, empty by default" is not that. So there is now a short
 * list built into the product, in the same matcher AutoMod uses, applied on
 * the same surfaces (a message and its edit, a forum title, a story, a Baú
 * comment or post, a profile name), with the same answer on a hit: the text is
 * refused and the author is told why. It is NOT applied to direct or group
 * messages: a private conversation between people who chose each other is not
 * ours to read by default, and the reports, blocking and image scanning that
 * exist for it are unchanged.
 *
 * WHAT IS ON THE LIST, AND WHAT IS NOT. It is deliberately short and
 * deliberately about the worst of it. Two classes:
 *
 * - `slur`: racist, homophobic, transphobic and ableist slurs, in English,
 *   Portuguese and Spanish, plus the well-known hate slogans.
 * - `threat`: telling somebody to kill themselves, rape threats, calls to
 *   kill a group, and sexual content about children.
 *
 * Insults are NOT here, on purpose: banter between friends is not ours to
 * filter. `fuck you`, `fuck off`, `cunt`, `vai tomar no cu`, `chinga tu madre`,
 * `slut` and the like pass. Ordinary swearing passes too: shit, damn, merda,
 * porra, caralho, mierda, joder, "puta que pariu", "filho da puta", because
 * friends talk like that and a filter that fires on it is a filter people turn
 * off, or leave. A plain "I'll kill you" is not here either (it is how people
 * trash-talk in a game); a rape threat or "kill yourself" is.
 *
 * HOW IT MATCHES. Whole words and phrases only, never substrings, so
 * "Scunthorpe", "assassin", "viaduto" or "Niger" never trip it. The text is
 * folded first by `normalizeForAutomod`: lowercase, accents stripped (so
 * `você` and `voce`, `maricón` and `maricon` are one word), fullwidth and
 * Cyrillic or Greek lookalikes mapped to Latin, zero-width characters
 * dropped. Then, because people dodge a filter, the text is also read four
 * more ways and a hit in any of them counts:
 *
 * 1. leetspeak: `n1gg3r`, `f@ggot`, `sh!t` (digits 0 1 3 4 5 7 and `@ $ !`
 *    inside a word become the letter they stand for);
 * 2. stretching: a run of three or more of one letter shrinks to two, and
 *    separately to one (`niiiigger`, `kiiiill yourself`);
 * 3. spacing: single letters split by spaces, dots, dashes or stars are
 *    glued back (`k i l l  y o u r s e l f`, `n.i.g.g.e.r`);
 * 4. squashing: a phrase typed without its spaces (`killyourself`, `vaisematar`).
 *
 * What it does NOT catch, on purpose, is anything that needs judgement:
 * sarcasm, a quoted slur in a news link, a new coinage, a language not listed,
 * a word censored with `*` in place of a letter. This is a first line, not a
 * moderator; reports and blocking stay the answer for the rest.
 *
 * This module is pure so the server and the web client's settings preview run
 * the same code.
 */

export const BASELINE_TEXT_CLASSES = ["slur", "threat"] as const;
export type BaselineTextClass = (typeof BASELINE_TEXT_CLASSES)[number];

/** What the author is told when a message is refused. Shown as is on mobile. */
export const BASELINE_REJECTION_MESSAGE =
  "This message was not sent: it breaks pqp's rules on abusive language.";

/** The same, for a name or a status line that was not saved. */
export const BASELINE_PROFILE_REJECTION_MESSAGE =
  "This was not saved: it breaks pqp's rules on abusive language.";

/**
 * The entries, per class. Syntax is AutoMod's: no wildcard is a whole word or
 * phrase, `*` at an end opens that end. Spelled in plain letters; accents do
 * not matter (the matcher strips them from both sides).
 */
export const BASELINE_TEXT_LISTS: Record<BaselineTextClass, readonly string[]> = {
  slur: [
    // English: racial and ethnic
    "*nigger*",
    "*nigga*",
    "chink",
    "chinks",
    "gook",
    "gooks",
    "spic",
    "spics",
    "kike",
    "kikes",
    "wetback",
    "wetbacks",
    "beaner",
    "beaners",
    "paki",
    "pakis",
    "towelhead",
    "towelheads",
    "raghead",
    "ragheads",
    // English: sexuality, gender, disability
    "faggot*",
    "fag",
    "fags",
    "tranny",
    "trannies",
    "shemale",
    "shemales",
    "retard",
    "retards",
    "retarded",
    // Hate slogans
    "heil hitler",
    "sieg heil",
    "white power",
    // Portuguese
    "viado",
    "viados",
    "viadinho",
    "viadinhos",
    "viadao",
    "boiola",
    "boiolas",
    "baitola",
    "baitolas",
    "traveco",
    "travecos",
    "sapatao",
    "crioulo",
    "crioulos",
    "retardado",
    "retardada",
    "retardados",
    "retardadas",
    "mongoloide",
    "mongoloides",
    // Spanish
    "maricon",
    "maricones",
    "sudaca",
    "sudacas",
    "negrata",
    "negratas",
  ],
  threat: [
    // English
    "kys",
    "kill yourself",
    "kill urself",
    "go kill yourself",
    "rape you",
    "kill all jews",
    "kill all blacks",
    "kill all muslims",
    "kill all gays",
    "gas the jews",
    "child porn*",
    "kiddie porn*",
    // Portuguese
    "vai se matar",
    "vou te estuprar",
    "vou estuprar",
    // Spanish
    "te voy a violar",
    "matate",
  ],
};

/**
 * Phrases that contain a listed word and are ordinary. Every hit span covered
 * by one of these is dropped before matching.
 */
export const BASELINE_ALLOW_LIST: readonly string[] = [
  "spic and span",
  // `*nigger*` is a substring match, and "snigger" is the English word for a
  // smothered laugh.
  "snigger*",
];

type Compiled = Record<BaselineTextClass, CompiledKeywords>;

let compiled: Compiled | null = null;

/** A phrase typed solid: `kill yourself` also catches `killyourself`. */
function squashed(entry: string): string | null {
  if (entry.includes("*")) return null;
  const folded = normalizeForAutomod(entry).replace(/[^\p{L}\p{N}]+/gu, "");
  return folded.length < 6 ? null : folded;
}

function compile(): Compiled {
  if (compiled) return compiled;
  const out = {} as Compiled;
  for (const cls of BASELINE_TEXT_CLASSES) {
    const entries = BASELINE_TEXT_LISTS[cls];
    const extra = entries
      .filter((entry) => /\s/.test(entry))
      .map(squashed)
      .filter((entry): entry is string => entry !== null);
    out[cls] = compileKeywords([...entries, ...extra], BASELINE_ALLOW_LIST);
  }
  compiled = out;
  return out;
}

// ---------------------------------------------------------------------------
// The four extra readings of a text
// ---------------------------------------------------------------------------

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
};

/**
 * Digits become letters inside a word that already has a letter, so "1234"
 * and "2026" are left alone; `@ $ !` only inside a word, so "hello!" and a
 * mention's "@" are left alone.
 */
function leetFold(text: string): string {
  return text
    .replace(/[\p{L}\p{N}]+/gu, (run) =>
      /\p{L}/u.test(run) ? run.replace(/[013457]/g, (d) => LEET[d]!) : run,
    )
    .replace(
      /(?<=[\p{L}\p{N}@$!])[@$!](?=[\p{L}\p{N}@$!])/gu,
      (ch) => LEET[ch]!,
    );
}

/** A run of three or more of the same letter, shrunk to `keep` of them. */
function shrinkRuns(text: string, keep: 1 | 2): string {
  return text.replace(/(\p{L})\1{2,}/gu, (_m, ch: string) => ch.repeat(keep));
}

/**
 * Single letters separated by spaces, dots, dashes, stars or underscores,
 * three or more in a row, glued back into the word they spell.
 */
function glueSpelledOut(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{N}])\p{L}(?:[\s.\-*_,]+\p{L}(?![\p{L}\p{N}])){2,}/gu,
    (run) => run.replace(/[\s.\-*_,]+/g, ""),
  );
}

function readings(body: string): string[] {
  const base = normalizeForAutomod(body);
  const leet = leetFold(base);
  const out = [
    base,
    leet,
    shrinkRuns(leet, 2),
    shrinkRuns(leet, 1),
    glueSpelledOut(leet),
  ];
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export interface BaselineHit {
  class: BaselineTextClass;
  /** The matched words, as read after folding. Never stored: the class is. */
  matched: string;
}

/**
 * The first baseline violation in `text`, or null when it may land. Cheap on
 * the common path: five short strings and a handful of set lookups, and
 * nothing at all for an empty text.
 */
export function findBaselineViolation(text: string): BaselineHit | null {
  if (!text || !/\p{L}/u.test(text)) return null;
  const lists = compile();
  for (const reading of readings(text)) {
    for (const cls of BASELINE_TEXT_CLASSES) {
      const hit = findBlockedKeyword(reading, lists[cls]);
      if (hit) return { class: cls, matched: hit };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The owner's switch
// ---------------------------------------------------------------------------

/**
 * `GET` and `PUT /api/servers/:serverId/automod/baseline`.
 *
 * - `instanceEnabled`: the operator's `default_text_filter` flag. Off, the
 *   baseline is off everywhere and the switch below changes nothing.
 * - `ownerDisabled`: this server's owner switched it off.
 * - `enabled`: what actually applies here, `instanceEnabled && !ownerDisabled`.
 */
export const baselineStatusSchema = z.object({
  instanceEnabled: z.boolean(),
  ownerDisabled: z.boolean(),
  enabled: z.boolean(),
});
export type BaselineStatus = z.infer<typeof baselineStatusSchema>;

export const setBaselineSchema = z.object({ enabled: z.boolean() });
export type SetBaselineInput = z.infer<typeof setBaselineSchema>;
