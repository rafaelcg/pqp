import { track } from "@/lib/track";

/**
 * Conversas: which doors people actually use to reach a conversation. Two
 * events on the hosted site's Umami (`lib/track.ts`), a no-op on any
 * self-host where the tag was not injected:
 *
 * - `dm_open` `{ source }`: a conversation was opened from that door.
 * - `dm_start` `{ source, kind }`: somebody asked for a conversation with a
 *   person or a group (it may already exist; the server reuses a 1:1).
 *
 * They fire with the flag on or off, on purpose: the doors that exist today
 * (list, toast, profile card, friends) are the baseline the new ones are read
 * against. No names, no ids, nothing about who.
 */

export type DmDoor =
  | "list"
  | "rail-unread"
  | "rail-pinned"
  | "switcher"
  | "profile"
  | "member-row"
  | "friends"
  | "friend-accepted"
  | "suggestion"
  | "new-conversation"
  | "toast";

export function trackDmOpen(source: DmDoor): void {
  track("dm_open", { source });
}

export function trackDmStart(source: DmDoor, kind: "dm" | "group" = "dm"): void {
  track("dm_start", { source, kind });
}
