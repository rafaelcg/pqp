import type { DmSummary } from "@pqp/shared";
import { PINNED_CONVERSATIONS_MAX } from "@pqp/shared";

export { PINNED_CONVERSATIONS_MAX };

/**
 * Stored order, minus ids that are no longer in the conversation list.
 *
 * Unknown ids are skipped rather than rewritten: a paint must not persist a
 * cleaned list, or a lagging `/api/dms` would wipe a pin the user still has.
 */
export function visiblePinnedConversations(
  conversations: readonly DmSummary[],
  ids: readonly string[] | undefined,
): DmSummary[] {
  if (!ids || ids.length === 0) {
    return [];
  }
  const byId = new Map(
    conversations.map((conversation) => [conversation.channelId, conversation]),
  );
  const seen = new Set<string>();
  const visible: DmSummary[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const conversation = byId.get(id);
    if (conversation) {
      visible.push(conversation);
    }
  }
  return visible;
}

export function isPinnedConversation(
  ids: readonly string[] | undefined,
  channelId: string,
): boolean {
  return ids?.includes(channelId) ?? false;
}

/**
 * Drop ids that are not in the live conversation list.
 *
 * Only call this on a user-initiated write, with a loaded list. A paint must
 * not persist this, or a lagging `/api/dms` would wipe a pin the user still has.
 */
export function prunePinnedConversations(
  ids: readonly string[] | undefined,
  conversations: readonly DmSummary[],
): string[] {
  const live = new Set(
    conversations.map((conversation) => conversation.channelId),
  );
  return (ids ?? []).filter((id) => live.has(id));
}

/**
 * Append, or no-op if already pinned or the cap is full. A new id past the
 * cap is ignored rather than bumping the oldest: pinning is a choice, not a
 * queue.
 */
export function addPinnedConversation(
  ids: readonly string[] | undefined,
  channelId: string,
): string[] {
  const current = ids ?? [];
  if (current.includes(channelId)) {
    return [...current];
  }
  if (current.length >= PINNED_CONVERSATIONS_MAX) {
    return [...current];
  }
  return [...current, channelId];
}

export function removePinnedConversation(
  ids: readonly string[] | undefined,
  channelId: string,
): string[] {
  return (ids ?? []).filter((id) => id !== channelId);
}
