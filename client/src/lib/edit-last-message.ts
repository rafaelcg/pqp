/**
 * The newest of the reader's own messages that the composer ArrowUp may edit.
 *
 * Pending/failed bubbles have no stored id to PATCH. Webhook rows are not the
 * reader's, even when the pseudo-user id happens to collide in tests.
 */
export function findLastOwnEditableMessage<
  T extends {
    id: string;
    authorId: string;
    pending?: boolean;
    failed?: boolean;
    isWebhook?: boolean;
  },
>(messages: readonly T[], userId: string | null | undefined): T | null {
  if (!userId) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.authorId !== userId) {
      continue;
    }
    if (message.pending || message.failed || message.isWebhook) {
      continue;
    }
    return message;
  }
  return null;
}
