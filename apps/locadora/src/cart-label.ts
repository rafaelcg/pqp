/**
 * The label of a cartridge on the shelf: which sprite a console's cartridge is drawn with, and how its title is set
 * on the label (the lines, and the biggest letter size that keeps every line inside it).
 *
 * The cartridge is a picture (`src/art/cart-blank.webp`, `cart-gb.webp`); the title is real text over its empty
 * label, in Dela Gothic One, upper case. The sizes here are in LABEL UNITS: the title area is `TITLE_AREA[kind].w`
 * units wide for a label 100 units wide, and the CSS sets the letters at `size` hundredths of the label's width
 * (`cqw`), so the fit is the same at any size the cartridge is drawn. Pure: what the tests pin.
 */
import type { RomPlatform } from "./rom-header";

/** The two cartridge sprites: the big console one (NES, SNES) and the handheld one (the Game Boys). */
export type CartKind = "console" | "handheld";

export function cartKind(platform: RomPlatform): CartKind {
  return platform === "gb" || platform === "gbc" || platform === "gba" ? "handheld" : "console";
}

/** The console's name as the cartridge prints it: on the label's ribbon (NES, SNES) or pressed into the top (Game Boys). */
export const CART_BRAND: Readonly<Record<RomPlatform, string>> = {
  nes: "NES",
  snes: "SNES",
  gb: "GAME BOY",
  gbc: "GB COLOR",
  gba: "GB ADVANCE",
};

/**
 * The label is the cream window inside the printed frame, measured on the sprites (shelf.css, `.loc-cart-label`):
 * 291 by 117 sprite pixels on the console cartridge, 293 by 251 on the handheld one. In label units (the label is
 * 100 wide) that is 100 by `LABEL_H[kind]`.
 */
export const LABEL_H: Readonly<Record<CartKind, number>> = {
  console: (117 / 291) * 100,
  handheld: (251 / 293) * 100,
};

/**
 * Where the title may go on each label, in label units: `w` by `h`, centred, the same margin left and right and the
 * same top and bottom (`PAD`), so a title of any length sits in the middle of the window and never touches its edge.
 */
const PAD: Readonly<Record<CartKind, { x: number; y: number }>> = {
  console: { x: 5, y: 3.5 },
  handheld: { x: 6, y: 5 },
};
export const TITLE_AREA: Readonly<Record<CartKind, { w: number; h: number }>> = {
  console: { w: 100 - PAD.console.x * 2, h: LABEL_H.console - PAD.console.y * 2 },
  handheld: { w: 100 - PAD.handheld.x * 2, h: LABEL_H.handheld - PAD.handheld.y * 2 },
};

/** The most lines a title takes on each label, and the smallest letters it is set in (label units) before it is cut. */
export const TITLE_LINES: Readonly<Record<CartKind, number>> = { console: 3, handheld: 4 };
export const MIN_SIZE: Readonly<Record<CartKind, number>> = { console: 8.5, handheld: 10.5 };
export const MAX_SIZE: Readonly<Record<CartKind, number>> = { console: 20, handheld: 24 };
/** Line height and letter spacing of the title, in em (shelf.css `.loc-cart-title`). */
export const LINE_HEIGHT = 1.02;
export const TRACKING = 0.02;

/**
 * Advance widths of Dela Gothic One, in em, measured from the bundled face (`src/fonts/`). Anything not listed is
 * taken as wider than any letter, so a guess errs towards smaller letters and never towards a line that spills.
 */
const GLYPH_EM: Readonly<Record<string, number>> = {
  A: 0.943, B: 0.894, C: 0.943, D: 0.893, E: 0.867, F: 0.86, G: 0.919, H: 0.918, I: 0.661, J: 0.884, K: 0.916,
  L: 0.804, M: 1.093, N: 0.919, O: 0.971, P: 0.889, Q: 0.971, R: 0.883, S: 0.924, T: 0.939, U: 0.92, V: 0.903,
  W: 1.096, X: 0.88, Y: 0.943, Z: 0.865,
  "0": 0.917, "1": 0.588, "2": 0.835, "3": 0.881, "4": 0.924, "5": 0.884, "6": 0.856, "7": 0.777, "8": 0.876, "9": 0.856,
  " ": 0.2, ".": 0.272, ",": 0.272, "!": 0.309, "?": 0.764, "-": 0.49, "'": 0.294, ":": 0.272, "&": 0.771, "/": 0.499,
  "(": 0.358, ")": 0.358, "+": 0.572,
};
const WIDE_EM = 1.1;
/** A CJK letter is a square: one em, in the bundled face or the system's. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]/u;
const CJK_EM = 1;
const ELLIPSIS = "…";

/** The upper-case text the label prints. */
export function labelText(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLocaleUpperCase("pt-BR");
}

/** Width of `text` in em, accents read as their letter (an A with an acute is as wide as an A). */
export function textEm(text: string): number {
  let em = 0;
  let count = 0;
  for (const ch of text) {
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
    em += GLYPH_EM[base] ?? (ch === ELLIPSIS ? 0.8 : CJK.test(ch) ? CJK_EM : WIDE_EM);
    count += 1;
  }
  return em + TRACKING * Math.max(0, count - 1);
}

const isCjkRun = (word: string) => word.length > 0 && [...word].every((ch) => CJK.test(ch));

/** Two pieces on one line: a space between words, nothing between two pieces of one CJK run. */
function joinWords(left: string, right: string): string {
  const a = [...left].pop() ?? "";
  const b = [...right][0] ?? "";
  return CJK.test(a) && CJK.test(b) ? left + right : `${left} ${right}`;
}

/** Greedy wrap of `words` at `limit` em per line. */
function wrapAt(words: readonly string[], limit: number): string[] {
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && textEm(joinWords(last, word)) <= limit + 1e-9) lines[lines.length - 1] = joinWords(last, word);
    else lines.push(word);
  }
  return lines;
}

/** A CJK run cut into `pieces` of even length (as even as its letters allow). */
function evenPieces(word: string, pieces: number): string[] {
  const chars = [...word];
  const size = Math.ceil(chars.length / pieces);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

/**
 * A word too wide for the label even at the smallest size is cut into pieces that fit, each but the last ending in a
 * hyphen. A run of CJK letters has no spaces and takes no hyphen: it is cut into pieces of even length instead.
 */
function splitLongWords(words: readonly string[], maxEm: number): string[] {
  const out: string[] = [];
  for (const word of words) {
    if (textEm(word) <= maxEm) {
      out.push(word);
      continue;
    }
    const chars = [...word];
    if (isCjkRun(word)) {
      out.push(...evenPieces(word, Math.ceil(textEm(word) / maxEm)));
      continue;
    }
    let piece = "";
    chars.forEach((ch, i) => {
      const rest = chars.slice(i).join("");
      // the piece goes out when one more letter and its hyphen would not fit, unless the rest fits whole
      if (piece && textEm(`${piece}${ch}-`) > maxEm && textEm(piece + rest) > maxEm) {
        out.push(`${piece}-`);
        piece = ch;
      } else piece += ch;
    });
    if (piece) out.push(piece);
  }
  return out;
}

export interface LabelFit {
  lines: string[];
  /** Letter size in label units (hundredths of the label's width). */
  size: number;
  /** Lines were dropped and the last one ends in an ellipsis: the whole title is in the box's name and its Ficha. */
  cut: boolean;
}

/**
 * The biggest title that stays inside the label: every wrap of the words is tried and the one with the biggest
 * letters wins (a tie goes to fewer lines). Past the smallest size, the lines that do not fit are dropped and the
 * last one ends in an ellipsis.
 */
export function fitLabel(title: string, kind: CartKind): LabelFit {
  const area = TITLE_AREA[kind];
  const maxLines = TITLE_LINES[kind];
  const min = MIN_SIZE[kind];
  const max = MAX_SIZE[kind];
  const text = labelText(title);
  if (text === "") return { lines: [""], size: max, cut: false };
  const words = splitLongWords(text.split(" "), area.w / min);

  const sizeFor = (lines: readonly string[]) => {
    const widest = Math.max(...lines.map(textEm));
    return Math.min(max, area.w / widest, area.h / (lines.length * LINE_HEIGHT));
  };

  // a CJK run may break between any two letters: it is also tried in 2, 3... even pieces, where that sets it bigger
  const choices: string[][] = [words];
  if (words.some(isCjkRun)) {
    for (let pieces = 2; pieces <= maxLines; pieces++) {
      choices.push(words.flatMap((w) => (isCjkRun(w) && [...w].length >= pieces ? evenPieces(w, pieces) : [w])));
    }
  }

  const step = 0.05;
  const bests = choices.map((choice) => {
    let found: { lines: string[]; size: number } | null = null;
    const seen = new Set<string>();
    // every distinct greedy wrap, from one word per line to the whole title on one line
    const total = textEm(choice.join(" "));
    for (let limit = Math.max(...choice.map(textEm)); limit <= total + step; limit += step) {
      const lines = wrapAt(choice, limit);
      const key = lines.join("\n");
      if (seen.has(key)) continue;
      seen.add(key);
      if (lines.length > maxLines) continue;
      const size = sizeFor(lines);
      if (!found || size > found.size + 1e-6 || (Math.abs(size - found.size) <= 1e-6 && lines.length < found.lines.length)) found = { lines, size };
    }
    return found;
  });
  // the fewest cuts in a CJK run whose letters are within a tenth of the biggest: a break inside a word costs more
  // than a little size
  const top = Math.max(0, ...bests.map((b) => b?.size ?? 0));
  const best = bests.find((b) => b !== null && b.size >= top * 0.9 - 1e-6) ?? null;
  // rounded DOWN, so the rounding can never push a line past the label's edge
  if (best && best.size >= min - 1e-6) return { lines: best.lines, size: Math.max(min, Math.floor(best.size * 100) / 100), cut: false };

  // too long for the label at the smallest letters: as many lines as fit, the last one cut short
  const lines = wrapAt(words, area.w / min);
  const kept = lines.slice(0, maxLines);
  let last = kept[kept.length - 1] ?? "";
  while (last.length > 1 && textEm(last + ELLIPSIS) > area.w / min) last = last.slice(0, -1).trimEnd();
  kept[kept.length - 1] = last + ELLIPSIS;
  return { lines: kept, size: min, cut: true };
}
