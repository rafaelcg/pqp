import { extractMentions } from "@pqp/shared";

export interface MentionCheckMessage {
  body: string;
  authorId?: string;
  mentionEveryone?: boolean;
  mentionHere?: boolean;
  replyTo?: { authorId?: string | null } | null;
}

function isOwnMessage(
  message: MentionCheckMessage,
  readerId: string | null | undefined,
): boolean {
  return Boolean(readerId && message.authorId && message.authorId === readerId);
}

/**
 * Whether this row should get the mention highlight: a fired @everyone/@here,
 * or an @username that is the reader's handle. Your own messages never light,
 * including when you tag yourself or fire a mass ping.
 *
 * Mass mentions that were typed but not allowed to ping stay chips in the
 * body (`pqp-mention-mass`) without lighting the whole row. Role mentions are
 * out of scope here.
 */
export function messageMentionsYou(
  message: MentionCheckMessage,
  username: string | null | undefined,
  readerId?: string | null,
): boolean {
  if (isOwnMessage(message, readerId)) {
    return false;
  }
  if (message.mentionEveryone || message.mentionHere) {
    return true;
  }
  if (!username) {
    return false;
  }
  return extractMentions(message.body).usernames.includes(username.toLowerCase());
}

/**
 * Whether an incoming message should play the mention cue. Same as the
 * highlight, plus a reply to the reader. Own messages never ping.
 */
export function messagePingsYou(
  message: MentionCheckMessage,
  username: string | null | undefined,
  readerId: string | null | undefined,
): boolean {
  if (isOwnMessage(message, readerId)) {
    return false;
  }
  if (readerId && message.replyTo?.authorId === readerId) {
    return true;
  }
  return messageMentionsYou(message, username, readerId);
}
