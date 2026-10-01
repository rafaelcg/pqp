/**
 * Word and character error rate for the bench. Normalisation is deliberately
 * the usual ASR one: case, punctuation and number formatting do not count as
 * errors, accents do (in Portuguese "e" and "é" are different words).
 */

const UNITS = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

/** Brazilian Portuguese cardinal for 0..999999, so "3" and "três" compare equal. */
export function numberToPt(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n < 20) return UNITS[n] as string;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` e ${UNITS[n % 10]}` : ""}`;
  if (n === 100) return "cem";
  if (n < 1000) return `${HUNDREDS[Math.floor(n / 100)]}${n % 100 ? ` e ${numberToPt(n % 100)}` : ""}`;
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 1 ? "mil" : `${numberToPt(thousands)} mil`;
  return rest ? `${head}${rest < 100 || rest % 100 === 0 ? " e" : ""} ${numberToPt(rest)}` : head;
}

export function normalizeForScoring(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/(\d)[.,](?=\d{3}\b)/g, "$1") // 1.500 / 1,500 -> 1500
    .replace(/\d+/g, (m) => ` ${numberToPt(parseInt(m, 10))} `)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

export interface ErrorRate {
  rate: number;
  edits: number;
  refLength: number;
}

export function wer(reference: string, hypothesis: string): ErrorRate {
  const r = normalizeForScoring(reference).split(" ").filter(Boolean);
  const h = normalizeForScoring(hypothesis).split(" ").filter(Boolean);
  const edits = levenshtein(r, h);
  return { rate: r.length ? edits / r.length : h.length ? 1 : 0, edits, refLength: r.length };
}

export function cer(reference: string, hypothesis: string): ErrorRate {
  const r = [...normalizeForScoring(reference)];
  const h = [...normalizeForScoring(hypothesis)];
  const edits = levenshtein(r, h);
  return { rate: r.length ? edits / r.length : h.length ? 1 : 0, edits, refLength: r.length };
}

/**
 * Whisper-family models sometimes fall into a loop on silence and repeat one
 * phrase dozens of times ("tchau, tchau, ..."). Collapse any 1 to 8 word phrase
 * repeated `minRepeats` or more times in a row into one copy and count the loops,
 * so a single runaway does not swamp a WER that is otherwise about accuracy.
 */
export function collapseLoops(text: string, minRepeats = 4): { text: string; loops: number } {
  const words = text.split(/\s+/).filter(Boolean);
  const norm = words.map((w) => normalizeForScoring(w));
  const out: string[] = [];
  let loops = 0;
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    for (let n = 1; n <= 8 && !collapsed; n++) {
      if (i + n * minRepeats > words.length) break;
      const unit = norm.slice(i, i + n).join(" ");
      if (!unit) continue;
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && norm.slice(i + reps * n, i + (reps + 1) * n).join(" ") === unit) reps++;
      if (reps >= minRepeats) {
        out.push(...words.slice(i, i + n));
        i += reps * n;
        loops += 1;
        collapsed = true;
      }
    }
    if (!collapsed) {
      out.push(words[i] as string);
      i += 1;
    }
  }
  return { text: out.join(" "), loops };
}

/**
 * Align a hypothesis to a reference token by token (edit-distance backtrace).
 * Returns, for each reference token, the hypothesis tokens that landed on it:
 * one for a match or substitution, none for a deletion. Insertions attach to the
 * preceding reference token (to the first one when they lead). The bench uses it
 * to cut every provider's output into the same reference segments.
 */
export function alignTokens(ref: readonly string[], hyp: readonly string[]): string[][] {
  const n = ref.length;
  const m = hyp.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) (d[i] as number[])[0] = i;
  for (let j = 0; j <= m; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      (d[i] as number[])[j] = Math.min(
        ((d[i - 1] as number[])[j] as number) + 1,
        ((d[i] as number[])[j - 1] as number) + 1,
        ((d[i - 1] as number[])[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
  }
  if (n === 0) return [];
  const out: string[][] = Array.from({ length: n }, () => []);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = (d[i] as number[])[j] as number;
    if (i > 0 && j > 0 && here === ((d[i - 1] as number[])[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      (out[i - 1] as string[]).unshift(hyp[j - 1] as string);
      i--;
      j--;
    } else if (i > 0 && here === ((d[i - 1] as number[])[j] as number) + 1) {
      i--;
    } else {
      // insertion: attach to the previous reference token, or the first one
      (out[Math.max(0, i - 1)] as string[]).unshift(hyp[j - 1] as string);
      j--;
    }
  }
  return out;
}

/**
 * ROVER-style vote. Every hypothesis is aligned to the skeleton, and for each
 * skeleton token the most common rendering (including "nothing") wins; a tie
 * goes to the skeleton's own token. Returns one token list per skeleton token
 * (empty when the vote deleted it) so callers can keep their segment structure,
 * plus how many hypotheses agreed with the winner at each position.
 */
export function roverVote(
  skeleton: readonly string[],
  hypotheses: ReadonlyArray<readonly string[]>,
): Array<{ tokens: string[]; agree: number; voters: number }> {
  const aligned = hypotheses.map((h) => alignTokens(skeleton, h));
  return skeleton.map((tok, i) => {
    const votes = new Map<string, number>();
    const bump = (k: string) => votes.set(k, (votes.get(k) ?? 0) + 1);
    bump(tok);
    for (const a of aligned) bump((a[i] ?? []).join(" "));
    let best = tok;
    let bestN = votes.get(tok) ?? 0;
    for (const [k, n] of votes) {
      if (n > bestN) {
        best = k;
        bestN = n;
      }
    }
    return { tokens: best ? best.split(" ") : [], agree: bestN, voters: hypotheses.length + 1 };
  });
}

/**
 * The hypothesis closest to all the others (smallest summed WER against them).
 * Used to seed a consensus reference when there is no human transcript.
 */
export function medoid(hypotheses: Array<{ id: string; text: string }>): { id: string; text: string } | undefined {
  let best: { id: string; text: string } | undefined;
  let bestScore = Infinity;
  for (const a of hypotheses) {
    let score = 0;
    for (const b of hypotheses) if (a !== b) score += wer(b.text, a.text).rate;
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}
