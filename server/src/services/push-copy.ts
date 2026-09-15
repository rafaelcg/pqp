/**
 * The conversation half of a push notification's title and body, in the two
 * languages the product ships, keyed off `user_preferences.settings.locale`.
 *
 * NO I18NEXT ON THE SERVER. Five strings times two languages does not earn
 * the dependency `docs/I18N.md` describes for the client, so this is a plain
 * lookup table rather than a `t()` call. Server-channel mention/reply copy is
 * untouched and stays inline in `push.ts` — it was already English-only
 * before this file existed and nothing in this change moves it.
 *
 * `MESSAGE BODIES ARE NEVER IN A PUSH` still holds here exactly as it does in
 * `push.ts`: every string below is fixed copy, never message content.
 */

export type PushLocale = "pt-BR" | "en";

/** The instance's own default when a recipient's `settings.locale` is unset. */
export const DEFAULT_PUSH_LOCALE: PushLocale = "pt-BR";

export function resolvePushLocale(value: unknown): PushLocale {
  return value === "en" ? "en" : DEFAULT_PUSH_LOCALE;
}

export interface PushCopy {
  title: string;
  body: string;
}

const AUTHOR_FALLBACK: Record<PushLocale, string> = {
  "pt-BR": "Alguém",
  en: "Someone",
};

export interface ConversationPushCopyInput {
  locale: PushLocale;
  channelKind: "dm" | "group";
  /** `push.dmDetails` — whether the sender's name may appear at all. */
  dmDetails: boolean;
  /** An @-mention or a reply, as opposed to a plain message. DM only. */
  mentionOrReply: boolean;
  /** Already truncated by the caller (`truncateLabel`), same as before. */
  authorName: string | null;
}

/**
 * The §4.3 copy table. Every branch is a fixed pair — nothing here is string
 * concatenation past the author's name, on purpose: a template that grew a
 * word wrong would grow it wrong in only one of the two languages and nobody
 * would notice reading the other.
 */
export function buildConversationPushCopy(
  input: ConversationPushCopyInput,
): PushCopy {
  const { locale, channelKind, dmDetails, mentionOrReply } = input;

  if (!dmDetails) {
    if (channelKind === "group") {
      return locale === "pt-BR"
        ? { title: "pqp", body: "Mensagem nova em um grupo" }
        : { title: "pqp", body: "New group message" };
    }
    return locale === "pt-BR"
      ? { title: "pqp", body: "Mensagem nova" }
      : { title: "pqp", body: "New direct message" };
  }

  const author = input.authorName ?? AUTHOR_FALLBACK[locale];

  if (channelKind === "group") {
    return locale === "pt-BR"
      ? { title: author, body: "Mensagem nova em um grupo" }
      : { title: author, body: "New message in a group chat" };
  }

  if (mentionOrReply) {
    return locale === "pt-BR"
      ? { title: author, body: "Te citou em uma mensagem" }
      : { title: author, body: "Mentioned you in a direct message" };
  }

  return locale === "pt-BR"
    ? { title: author, body: "Te mandou uma mensagem" }
    : { title: author, body: "Sent you a direct message" };
}
