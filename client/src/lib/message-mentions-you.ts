import { extractMentions } from "@pqp/shared";

/**
 * Whether this row should get the mention highlight: a fired @everyone/@here,
 * or an @username that is the reader's handle.
 *
 * Mass mentions that were typed but not allowed to ping stay chips in the
 * body (`pqp-mention-mass`) without lighting the whole row. Role mentions are
 * out of scope here.
 */
export function messageMentionsYou(
  message: {
    body: string;
    mentionEveryone?: boolean;
    mentionHere?: boolean;
  },
  username: string | null | undefined,
): boolean {
  if (message.mentionEveryone || message.mentionHere) {
    return true;
  }
  if (!username) {
    return false;
  }
  return extractMentions(message.body).usernames.includes(username.toLowerCase());
}
