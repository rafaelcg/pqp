import type { TranslateResult, Translator } from "../speech/types.js";

/**
 * Brand and proper-name guard for the Baú's automatic translation (post text
 * and video subtitles alike).
 *
 * "pqp" is the product and also a pt-BR swear abbreviation, and a model told
 * to keep it will still, now and then, translate it ("o QG do pqp" came back
 * as "the QG of WTF"). A sentence in the system prompt is a request; this is
 * a guarantee. Every protected span is swapped for a numbered placeholder
 * (`<k1>`) before the text reaches the model and put back afterwards, so the
 * model never sees the word it could "help" with. The same trick the
 * `<#channel>` links use (`community-home-channel-refs.ts`).
 *
 * A string whose placeholders did not all come back exactly as many times as
 * they went out keeps the author's own words, the same rule as the channel
 * links: untranslated beats a mangled name.
 *
 * Protected, in this order (earlier wins where spans overlap):
 *   URLs, e-mail-free @handles, `#channel` tokens, the server's own name,
 *   "QG do pqp", "pqp.gg", "pqp" as a standalone word (any case), "Baú" and
 *   "QG" (exact case: lowercase "baú" is the ordinary word for a chest).
 */

const WORD = "\\p{L}\\p{N}_";

/** Longer, more specific spans first: the alternation takes the first that fits. */
function buildPattern(extraNames: string[]): RegExp {
  const parts: string[] = [
    // A literal `<k1>` in the source: protected like any other span, so it
    // can never be mistaken for one of ours.
    "<k\\d+>",
    // URLs, minus the punctuation that ends a sentence around them.
    "https?:\\/\\/[^\\s<>\"']*[^\\s<>\"'.,;:!?)\\]]",
    // @handles, not the tail of an e-mail address.
    `(?<![${WORD}])@[\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]*[\\p{L}\\p{N}_]|(?<![${WORD}])@[\\p{L}\\p{N}_]`,
    // `#channel`; `<#1>` (a channel-link placeholder) is excluded by the `<`.
    `(?<![${WORD}<&])#[\\p{L}\\p{N}_-]+`,
  ];
  const names = [...new Set(extraNames.map((n) => n.trim()).filter((n) => n.length >= 2))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (names.length > 0) {
    parts.push(`(?<![${WORD}])(?:${names.join("|")})(?![${WORD}])`);
  }
  parts.push(
    `(?<![${WORD}])QG\\s+do\\s+pqp(?![${WORD}])`,
    `(?<![${WORD}])pqp\\.gg(?![${WORD}])`,
    `(?<![${WORD}])pqp(?![${WORD}])`,
    `(?<![${WORD}])Baú(?![${WORD}])`,
    `(?<![${WORD}])QG(?![${WORD}])`,
  );
  return new RegExp(parts.map((p) => `(?:${p})`).join("|"), "giu");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Exact-case terms must not be matched case-insensitively. The one regex is
// case-insensitive (pqp, the URL scheme); these are re-checked on the span.
function spanAllowed(span: string, extraNames: string[]): boolean {
  if (/^baú$/i.test(span)) return span === "Baú";
  if (/^qg$/i.test(span)) return span === "QG";
  if (/^qg\s+do\s+pqp$/i.test(span)) return span.slice(0, 2) === "QG";
  if (/^[\p{L}\p{N}_]+$/u.test(span) && !/^pqp$/i.test(span)) {
    // A bare word that is neither pqp nor Baú nor QG can only be a server
    // name, which is matched in the exact case it has.
    return extraNames.some((n) => n.trim() === span);
  }
  return true;
}

const PLACEHOLDER = /<k(\d+)>/g;

function placeholderNumbers(text: string): number[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

export interface ProtectedBrandNames {
  texts: string[];
  /** The text with every placeholder replaced, or null when the answer lost or invented one. */
  restore: (translated: string[]) => Array<string | null>;
}

export function protectBrandNames(texts: string[], extraNames: string[] = []): ProtectedBrandNames {
  const pattern = buildPattern(extraNames);
  // One table per string: placeholder n of string i is spans[i][n - 1].
  const spans: string[][] = [];
  const expected: number[][] = [];
  const out = texts.map((text, i) => {
    const mine: string[] = [];
    spans[i] = mine;
    const protectedText = text.replace(new RegExp(pattern), (span) => {
      if (!spanAllowed(span, extraNames)) return span;
      mine.push(span);
      return `<k${mine.length}>`;
    });
    expected[i] = placeholderNumbers(protectedText);
    return protectedText;
  });

  return {
    texts: out,
    restore(translated) {
      return out.map((_, i) => {
        const answer = translated[i];
        if (answer === undefined) return null;
        const mine = spans[i]!;
        const found = placeholderNumbers(answer);
        const want = expected[i]!;
        if (found.length !== want.length || found.some((n, k) => n !== want[k])) {
          return null;
        }
        return answer.replace(new RegExp(PLACEHOLDER), (all, num: string) => mine[Number(num) - 1] ?? all);
      });
    },
  };
}

export interface BrandGuardStats {
  /** Strings whose placeholders did not all come back: the author's words were kept. */
  kept: number;
}

/**
 * A translator that cannot translate the brand. `names` are extra spans to
 * keep (the server's own name); `onKept` is told how many strings fell back.
 */
export function withBrandGuard(
  inner: Translator,
  options: { names?: string[]; onKept?: (count: number) => void } = {},
): Translator {
  return {
    id: inner.id,
    async translate(texts, from, to, signal): Promise<TranslateResult> {
      const guard = protectBrandNames(texts, options.names ?? []);
      const result = await inner.translate(guard.texts, from, to, signal);
      if (result.texts.length !== texts.length) {
        return result; // misaligned: the caller already treats this as a failure
      }
      const restored = guard.restore(result.texts);
      let kept = 0;
      const final = restored.map((value, i) => {
        if (value === null) {
          kept += 1;
          return texts[i]!;
        }
        return value;
      });
      if (kept > 0) options.onKept?.(kept);
      return { ...result, texts: final };
    },
  };
}
