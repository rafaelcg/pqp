/**
 * Turning a stored message into the 140-char preview line a conversation's
 * list row and arrival toast are allowed to carry.
 *
 * ONE FUNCTION, TWO CALLERS. `dms.ts`'s `listConversations` (the DM list's
 * `lastMessage`) and `ws/chat.ts`'s `notifyChannelActivity` (the
 * `channel-activity` frame behind the arrival toast) both redact through
 * here, so "what counts as an attachment-only message" and "how markdown is
 * stripped" cannot drift between the two surfaces that show the same fact.
 *
 * Mentions need no resolution here: `docs/plans/DM_NOTIFICATIONS_POLISH.md`
 * assumed the Discord `<@id>` shape, but this codebase stores a mention as the
 * literal `@username` the author typed (see `extractMentionUsernames`'s
 * pattern in `packages/shared/src/api.ts`) — already the readable form a
 * preview wants, nothing to substitute.
 *
 * Own-message ("você: ") and group-author prefixes are NOT added here. They
 * are the reader's own relationship to the message, not a fact about it, and
 * both wire consumers already carry `authorId`/`authorName` for their client
 * to prefix with.
 */

/** Server-redacted and client-rendered, never sent past this. */
export const PREVIEW_MAX_CHARS = 140;

export interface MessagePreview {
  /** Empty when the message is attachment/GIF-only — see `isAttachment`. */
  preview: string;
  /** True when the message carries no text of its own, only attachment(s). */
  isAttachment: boolean;
  /** True when the (sole) attachment is a GIF, refining `isAttachment`. */
  isGif: boolean;
}

// Applied in order. Link syntax first, so a bolded link's inner `[]` survives
// the bold pass rather than being eaten as literal asterisks.
const MARKDOWN_PASSES: ReadonlyArray<readonly [RegExp, string]> = [
  // `[label](url)` -> `label`. Keeps the human-readable half, drops the URL.
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  // Bold+italic, bold, italic — longest markers first so `**x**` is not left
  // half-stripped by the single-character pass running first.
  [/(\*\*\*|___)([^*_]+)\1/g, "$2"],
  [/(\*\*|__)([^*_]+)\1/g, "$2"],
  [/(\*|_)([^*_]+)\1/g, "$2"],
  // Strikethrough.
  [/~~([^~]+)~~/g, "$1"],
  // Inline code.
  [/`([^`]+)`/g, "$1"],
  // Blockquote marker at the start of a line.
  [/^>\s?/gm, ""],
];

/** Markdown syntax to plain text. Never touches `@username` — already plain. */
export function stripMarkdownForPreview(body: string): string {
  let text = body;
  for (const [pattern, replacement] of MARKDOWN_PASSES) {
    text = text.replace(pattern, replacement);
  }
  // Collapse newlines and runs of whitespace: a preview is one line.
  return text.replace(/\s+/g, " ").trim();
}

/** 140 chars with a trailing ellipsis, never a hard cut mid-surrogate-pair. */
export function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

export interface MessagePreviewInput {
  body: string;
  hasAttachments: boolean;
  /** Whether the (sole, relevant) attachment is a GIF (`content_type` `image/gif`). */
  isGifAttachment?: boolean;
}

/**
 * The redaction pass. An attachment-only message (stripped body is empty)
 * carries no preview text at all — `isAttachment`/`isGif` are the key-free
 * signal the client translates (`dm.preview.attachment` / `dm.preview.gif`),
 * rather than a label minted server-side with no i18next to draw it from.
 */
export function buildMessagePreview(
  input: MessagePreviewInput,
): MessagePreview {
  const stripped = stripMarkdownForPreview(input.body);
  if (stripped.length === 0 && input.hasAttachments) {
    return { preview: "", isAttachment: true, isGif: input.isGifAttachment === true };
  }
  return { preview: truncatePreview(stripped), isAttachment: false, isGif: false };
}
