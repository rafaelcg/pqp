import type { MessageSearchResult } from "@pqp/shared";

/**
 * Append a page of results, dropping any message already on screen.
 *
 * The keyset cursor should make this a no-op. It is here because the failure it
 * guards against is silent and expensive: a duplicated row means two list
 * entries pointing at one message, and the second one moves under the cursor as
 * the user arrows down.
 */
export function appendUniqueResults(
  existing: MessageSearchResult[],
  incoming: MessageSearchResult[],
): MessageSearchResult[] {
  const seen = new Set(existing.map((result) => result.messageId));
  return [
    ...existing,
    ...incoming.filter((result) => {
      if (seen.has(result.messageId)) {
        return false;
      }
      seen.add(result.messageId);
      return true;
    }),
  ];
}

/** Move a list selection by `delta`, stopping at either end. */
export function clampSelection(
  current: number,
  delta: number,
  length: number,
): number {
  if (length === 0) {
    return 0;
  }
  return Math.min(Math.max(current + delta, 0), length - 1);
}
