/**
 * The composer field's line box under the redesign.
 *
 * The field draws the draft at the reader's chat size (`--chat-font-size`,
 * 12 to 24px), so typed and sent text match. A fixed 20px line box clips a
 * large size, so the wrapped line follows the chat list's own ratio, 22/15 of
 * the size (`--chat-line-height`), measured from the field's computed size so
 * the 16px floor on phones and coarse pointers is counted too.
 */

/** `--chat-line-height` is 22/15 of `--chat-font-size`. */
const CHAT_LINE_RATIO = 22 / 15;

export function fieldLineHeightPx(fontSizePx: number, fallback = 20): number {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) {
    return fallback;
  }
  return Math.round(fontSizePx * CHAT_LINE_RATIO);
}

/**
 * Whether a draft measured with `padY` above and below and `lineHeight` per
 * line is one line, so the field can rest at its one-line control height with
 * the text centred. Asked of the scroll height, which counts every wrapped
 * line, and only while the line still fits the control. One pixel of slack
 * for sub-pixel rounding.
 */
export function singleLineFits(
  scrollHeight: number,
  padY: number,
  lineHeight: number,
  controlPx: number,
): boolean {
  return lineHeight <= controlPx && scrollHeight <= padY * 2 + lineHeight + 1;
}
