import { useEffect, useRef } from "react";
import { useLgUp } from "@/hooks/use-lg-up";
import { isWatchPartyChannelType } from "@/lib/watch-party-channels";
import { sharePopoutApplies } from "@/lib/share-view-mode";
import { useSharePopout } from "@/lib/share-popout-flag";

/**
 * Turns opt-in watching on for the call when the share popout applies to it
 * (issue #1736): the `share_popout` answer for the call's server, a window at
 * least `lg` wide, and a room that is not a watch party.
 *
 * Also returns the call's channel name, latched the same way, for the popout's
 * badge.
 *
 * The call's channel type comes from `channels`, which only holds the SELECTED
 * server's channels, so walking off to another server would lose it. The last
 * type seen for the call's channel is kept instead, because a channel does not
 * change type during a call.
 */
export function useShareOptInSync(
  voice: { setShareOptIn: (on: boolean) => void },
  input: {
    callChannelId: string | null;
    /** The call's server, `null` for a DM call. */
    callServerId: string | null;
    channels: readonly { id: string; type: string; name?: string }[];
  },
): { applies: boolean; channelName: string | null } {
  const known = useRef<{
    channelId: string;
    watchParty: boolean;
    name: string | null;
  } | null>(null);
  const { callChannelId, channels } = input;
  const listed = callChannelId
    ? channels.find((channel) => channel.id === callChannelId)
    : undefined;
  if (listed && callChannelId) {
    known.current = {
      channelId: callChannelId,
      watchParty: isWatchPartyChannelType(listed.type),
      name: listed.name ?? null,
    };
  }
  const latched =
    known.current !== null && known.current.channelId === callChannelId
      ? known.current
      : null;
  const watchParty = latched?.watchParty ?? false;
  const flagOn = useSharePopout(input.callServerId);
  const wide = useLgUp();
  const applies =
    callChannelId !== null &&
    sharePopoutApplies({ flagOn, wide, isWatchPartyChannel: watchParty });
  useEffect(() => {
    voice.setShareOptIn(applies);
  }, [voice, applies]);
  return { applies, channelName: latched?.name ?? null };
}
