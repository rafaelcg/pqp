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

import { formatNoteDuration } from "@pqp/shared";

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
  /**
   * Set when the message is a voice note. Only its length reaches the push,
   * formatted the way the card shows it; never the audio or a transcript, so
   * the push never waits on one.
   */
  voiceDurationMs?: number | null;
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

  // A voice note, DM or group alike: the sender is the title, the body says
  // what it is and how long. Without `dmDetails` the generic copy above stands,
  // which already says nothing about the message.
  if (typeof input.voiceDurationMs === "number") {
    const duration = formatNoteDuration(input.voiceDurationMs);
    return locale === "pt-BR"
      ? { title: author, body: `Mensagem de voz · ${duration}` }
      : { title: author, body: `Voice message · ${duration}` };
  }

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

// ------------------------------------------------------ stream started notice

/**
 * The start-of-stream notice ("Alberto começou a transmitir em #filminho") is
 * the one push in three languages, because the client ships three and this
 * notice is a single sentence read on a lock screen. Anything that is not
 * Spanish or English is the instance default, as `resolvePushLocale` has it.
 */
export type StreamAlertLocale = PushLocale | "es";

export function resolveStreamAlertLocale(value: unknown): StreamAlertLocale {
  if (value === "en") {
    return "en";
  }
  if (typeof value === "string" && (value === "es" || value.startsWith("es-"))) {
    return "es";
  }
  return DEFAULT_PUSH_LOCALE;
}

export interface StreamStartedCopyInput {
  locale: StreamAlertLocale;
  /** A name the recipient can already see on the sidebar. */
  sharerName: string;
  /** `#filminho` for a voice channel, the party's own name for a party. */
  channelLabel: string;
  serverName: string;
}

/**
 * Fixed pairs, never a template that grows a word in one language only. Names
 * only: nothing about what is on the screen.
 */
export function buildStreamStartedPushCopy(
  input: StreamStartedCopyInput,
): PushCopy {
  const { sharerName, channelLabel, serverName } = input;
  switch (input.locale) {
    case "en":
      return {
        title: `${sharerName} started streaming in ${channelLabel}`,
        body: `${serverName} · Watch`,
      };
    case "es":
      return {
        title: `${sharerName} empezó a transmitir en ${channelLabel}`,
        body: `${serverName} · Ver`,
      };
    default:
      return {
        title: `${sharerName} começou a transmitir em ${channelLabel}`,
        body: `${serverName} · Assistir`,
      };
  }
}
