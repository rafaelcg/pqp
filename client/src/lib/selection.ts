/**
 * What the sidebar is showing: one server, or the conversations that belong to
 * no server at all.
 *
 * This replaced a bare `selectedServerId: string | null`, where null meant "no
 * server yet" and every navigation path bailed out on it — `syncRoute` returned
 * without writing a URL, and both `loadChannels` and `applyChannelRoute` took a
 * server id they could not do without. Conversations need all three of those to
 * work with no server in hand, and a nullable id cannot tell "nothing selected"
 * apart from "the conversation view", so the two states are named instead.
 *
 * Deliberately carries no channel id. Which channel is open is one question with
 * one answer for both kinds, and it already has a home in `selectedChannelId`;
 * a copy here would be a second answer free to disagree with it.
 */

import { channelRoutePath, conversationRoutePath } from "@/lib/app-route";

export type Selection =
  | { kind: "server"; serverId: string }
  | { kind: "dm" };

/** The view with no server in it, which is where conversations live. */
export const HOME_SELECTION: Selection = { kind: "dm" };

/**
 * The server this selection is inside, or null in the conversation view.
 *
 * Everything scoped to a server — the member list an `@` completes against,
 * invites, message permalinks — reads this rather than the selection itself, so
 * each of them keeps working unchanged and correctly offers nothing when there
 * is no server to scope by.
 */
export function selectionServerId(selection: Selection): string | null {
  return selection.kind === "server" ? selection.serverId : null;
}

/** Where the address bar should point for this selection and open channel. */
export function selectionRoutePath(
  selection: Selection,
  channelId: string | null,
): string {
  return selection.kind === "server"
    ? channelRoutePath(selection.serverId, channelId)
    : conversationRoutePath(channelId);
}
