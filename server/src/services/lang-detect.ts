/**
 * A cheap, offline guess at which of English, Portuguese and Spanish a piece
 * of text is written in. It exists for one decision: whether a Baú post needs
 * a translation into a reader's language at all. Getting it wrong costs
 * little in either direction (a needless translation of text that already is
 * in the target language comes back unchanged; a skipped one leaves the reader
 * with the original), which is why this is a word count and not a model call.
 *
 * Returns null when the text is too short or too mixed to say, and for any
 * other language; the caller then translates from "whatever this is".
 */

export type DetectedLang = "en" | "pt" | "es";

/**
 * Languages the product does not translate into but that share enough words
 * with the three that a French or German post would otherwise be called
 * Spanish. They only exist to win the count and turn the answer into null.
 */
type Competitor = DetectedLang | "other";

const WORDS: Record<Competitor, ReadonlySet<string>> = {
  en: new Set(
    "the and is are was were to of in for with that this you we it on be have has our your from will can not but as at by new just they their what when how about all more".split(
      " ",
    ),
  ),
  pt: new Set(
    "o a os as de do da dos das que e é em para pra com não nao uma um você voce vocês voces no na nos nas se por mais como foi são sao está esta isso aqui já ja também tambem muito mas pro tá né nós nosso nossa ao às ainda quando só".split(
      " ",
    ),
  ),
  es: new Set(
    "el la los las de del que y es en para con no una un usted ustedes se por más mas como fue son está esto aquí aqui ya también tambien muy pero nuestro nuestra al hay cómo qué si sí".split(
      " ",
    ),
  ),
  other: new Set(
    "le la les des du est sont pour dans avec pas une nous vous ce cette qui sur mais tout très bonjour der die das und ist nicht ein eine mit für auf den dem von zu wir sie ich es aber auch".split(
      " ",
    ),
  ),
};

/** Characters that belong to one of the three and not the others. */
const MARKERS: Array<[DetectedLang, RegExp, number]> = [
  ["pt", /[ãõç]/g, 3],
  ["es", /[ñ¿¡]/g, 3],
];

export function detectLanguage(text: string): DetectedLang | null {
  // A link says nothing about the language around it.
  const lower = text.toLowerCase().replace(/https?:\/\/\S+/gu, " ");
  const tokens = lower.match(/\p{L}+/gu) ?? [];
  if (tokens.length < 4) {
    return null;
  }
  const score: Record<Competitor, number> = { en: 0, pt: 0, es: 0, other: 0 };
  for (const token of tokens) {
    for (const lang of Object.keys(WORDS) as Competitor[]) {
      if (WORDS[lang].has(token)) {
        score[lang] += 1;
      }
    }
  }
  for (const [lang, pattern, weight] of MARKERS) {
    const hits = lower.match(pattern)?.length ?? 0;
    score[lang] += Math.min(hits, 4) * weight;
  }
  const ranked = (Object.keys(score) as Competitor[])
    .map((lang) => ({ lang, value: score[lang] / tokens.length }))
    .sort((a, b) => b.value - a.value);
  const best = ranked[0]!;
  const second = ranked[1]!;
  if (best.value < 0.12 || best.value - second.value < 0.04) {
    return null;
  }
  return best.lang === "other" ? null : best.lang;
}
