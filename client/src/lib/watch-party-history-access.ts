import { isWatchPartyChannelType } from "@pqp/shared";

/**
 * Which of a server's `watch_party` channels a "Transmissões anteriores"
 * entry point may target for this viewer, and the reachability problem this
 * exists to fix.
 *
 * A `watch_party` channel is filtered out of the channel sidebar entirely
 * whenever there is no live or pending party on it (see the big comment on
 * `listed` in `channel-list.tsx`) -- the row simply does not exist to click,
 * right-click, or open settings on. That is fine for an ordinary member, who
 * has nothing to do there anyway, but it also hides the owner's own past
 * broadcasts the moment the show ends and nobody has the channel open: the
 * header icon that shipped in pull request 543 only renders inside the chat
 * pane, and the chat pane only mounts for a channel that is currently
 * *selected* -- which an idle watch_party channel can never be from the
 * sidebar.
 *
 * `watchPartyHistoryCandidates` answers the permission half of "does this
 * entry point make sense for this viewer": the same rule the server enforces
 * (`requireWatchPartyHistoryAccess` in `server/src/api/index.ts`) and the
 * existing header icon already uses (`canViewWatchPartyHistory` in
 * `App.tsx`) -- START_WATCH_PARTY or MANAGE_CHANNELS, checked per channel
 * because both are ordinary permission bits with per-channel overwrites.
 * It says nothing about whether that channel actually HAS a past broadcast
 * to show; pair it with `useWatchPartyHistoryAvailability` for that.
 */
export interface WatchPartyHistoryChannel {
  id: string;
  name: string;
}

export function watchPartyHistoryCandidates(
  channels: readonly { id: string; name: string; type: string }[],
  canViewHistory: (channelId: string) => boolean,
): WatchPartyHistoryChannel[] {
  return channels
    .filter((channel) => isWatchPartyChannelType(channel.type))
    .filter((channel) => canViewHistory(channel.id))
    .map((channel) => ({ id: channel.id, name: channel.name }));
}
