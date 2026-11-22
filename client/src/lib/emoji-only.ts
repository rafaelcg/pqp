/**
 * A message that is only emoji is drawn large under the redesign (the text
 * channels canvas, "Dado, moeda e emoji grande"). Up to six, so a short
 * burst reads as a reaction and a long row of them stays text.
 */
export const JUMBO_EMOJI_MAX = 6;

const ONE_EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}[️\p{Emoji_Modifier}]*(?:‍\p{Extended_Pictographic}[️\p{Emoji_Modifier}]*)*)$/u;

let segmenter: Intl.Segmenter | null = null;

/** True when `body` is one to six emoji, with nothing else but spaces. */
export function isJumboEmoji(body: string | null | undefined): boolean {
  if (!body) {
    return false;
  }
  const trimmed = body.replace(/\s+/g, "");
  if (trimmed.length === 0 || trimmed.length > 80) {
    return false;
  }
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const { segment } of segmenter.segment(trimmed)) {
    count += 1;
    if (count > JUMBO_EMOJI_MAX || !ONE_EMOJI.test(segment)) {
      return false;
    }
  }
  return count > 0;
}
