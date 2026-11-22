import { buildReplyExcerpt } from "@pqp/shared";
import { plainPreviewText } from "@/lib/forward";
import type { Translator } from "@/lib/i18n";

/** Bold, italic, strike, spoiler and code marks that wrap text. */
const WRAPPING_MARKS = /(\*\*\*|\*\*|\*|~~|\|\||`)(\S(?:.*?\S)?)\1/g;
/** Underscore emphasis, only around a whole word: `snake_case_name` stays. */
const UNDERSCORE_MARKS = /(?<![\p{L}\p{N}_])(__|_)(\S(?:.*?\S)?)\1(?![\p{L}\p{N}_])/gu;

/**
 * The body as a person would read it aloud: mention markup dropped and the
 * marks around formatted text removed. The sheet's header is plain text, so
 * `***20h***` would otherwise show its asterisks.
 */
function readableBody(body: string): string {
  return plainPreviewText(body).replace(WRAPPING_MARKS, "$2").replace(UNDERSCORE_MARKS, "$2");
}

/**
 * What the message menu's phone sheet says about the message it acts on, in
 * one line of text. A body reads as its reply excerpt, without formatting
 * marks; a message with no text names its file, so an image-only message
 * still says which one it is (the pins panel's rule, `describeBody` in
 * `components/chat/pinned-messages-panel.tsx`).
 */
export function describeMessageForMenu(
  message: { body: string; attachments?: readonly { filename: string }[] },
  t: Translator["t"],
): string {
  if (message.body.trim()) {
    // Marks come off before the cut, so a long body cannot end on half a
    // pair. A body that is nothing but markup keeps its own text.
    return buildReplyExcerpt(readableBody(message.body) || message.body);
  }
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    const first = attachments[0]!;
    return attachments.length > 1
      ? t("pins.moreAttachments", { filename: first.filename, count: attachments.length - 1 })
      : first.filename;
  }
  return t("pins.emptyMessage");
}
