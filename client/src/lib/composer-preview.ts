/**
 * Whether the format preview above the composer tells the writer anything.
 *
 * Under the redesign the field already draws the draft at the reader's chat
 * size, so a preview of plain text is the same words twice. The preview earns
 * its place only when the draft has markup the bubble draws differently from
 * the raw text: emphasis, strike, code, a fence, a quote, a list, a link or a
 * backslash escape.
 *
 * This is a scan, not a parse. The client cannot import the remark parser on
 * its own (it is only a dependency of react-markdown), and the cost of a wrong
 * answer is small and one-sided: a false yes shows the preview the old look
 * always showed. So every rule leans towards yes. Headings, rules and HTML are
 * disabled in chat (`remarkDisableChatBlocks`), so they stay plain text here
 * too. Mentions, custom emoji and bare links keep their words, so they do not
 * count.
 */

const RULES: readonly RegExp[] = [
  // A fence, ``` or ~~~, at the start of a line.
  /^ {0,3}(```|~~~)/m,
  // Inline code: a pair of backticks with something between them.
  /`[^`\n]+`/,
  // `*x*`, `**x**`: an opener followed by a non-space, a closer after one.
  // Intraword `*` is emphasis in CommonMark, so `2*3*4` counts.
  /\*{1,3}[^\s*](?:[^\n]*?[^\s*\\])?\*{1,3}/,
  // `_x_`, `__x__`: only at word edges, so snake_case_names stay plain.
  /(?:^|[^\p{L}\p{N}_])_{1,3}[^\s_](?:[^\n]*?[^\s_\\])?_{1,3}(?![\p{L}\p{N}_])/mu,
  // `~x~`, `~~x~~` (GFM accepts a single tilde).
  /~{1,2}[^\s~](?:[^\n]*?[^\s~\\])?~{1,2}/,
  // A quote.
  /^ {0,3}>/m,
  // A bullet or a numbered list item.
  /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/m,
  // A link, `[words](url)`, or an autolink, `<https://…>`.
  /\[[^\]\n]+\]\([^)\n]*\)/,
  /<[a-z][a-z0-9+.-]*:[^\s<>]+>/i,
  // A backslash escape: the backslash disappears in the bubble.
  /\\[!-/:-@[-`{-~]/,
];

export function draftNeedsPreview(body: string): boolean {
  if (!body.trim()) {
    return false;
  }
  return RULES.some((rule) => rule.test(body));
}
