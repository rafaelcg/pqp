import type { Channel } from "@pqp/shared";
import { isCommunityHomeChannelId } from "@/lib/community-home/id";

/**
 * Where to go after a refetched channel list no longer holds the open
 * channel: somebody deleted it, or it went private and this viewer is not on
 * the list. `null` means stay put: nothing was open, the open channel is
 * still there, or it is Baú, which is a client-only surface and never in the
 * list. Otherwise the first text channel, then the first thing that is not a
 * category, the same pick the delete dialog makes for its own actor. `null`
 * too when the server has nothing left to open; the caller clears the
 * selection then.
 */
export function vanishedChannelFallback(
  list: readonly Channel[],
  currentId: string | null,
): { vanished: false } | { vanished: true; nextId: string | null } {
  if (
    !currentId ||
    isCommunityHomeChannelId(currentId) ||
    list.some((channel) => channel.id === currentId)
  ) {
    return { vanished: false };
  }
  const next =
    list.find((channel) => channel.type === "text") ??
    list.find((channel) => channel.type !== "category");
  return { vanished: true, nextId: next?.id ?? null };
}
