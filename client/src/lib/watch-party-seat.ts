import { isWatchPartyChannelType } from "@pqp/shared";

/**
 * Whether an audience seat in a watch party should be released.
 *
 * Watching is select plus HLS. A seat is the host's LiveKit pipe (or a
 * mic the party bar handed out), not "I opened the channel". This helper
 * is the audience backstop: the stream died, or the party ended, and the
 * person in the room is not presenting. Host Encerrar always `voice.leave()`s
 * on its own path and is not gated on this.
 */
export function shouldReleaseAudienceWatchSeat(input: {
  channelType: string | null | undefined;
  isAudienceSeat: boolean;
  isSharingScreen: boolean;
  voiceStatus: string;
  partyState: "draft" | "live" | "ended" | "cancelled" | null | undefined;
  hasLiveStream: boolean;
}): boolean {
  if (!input.channelType || !isWatchPartyChannelType(input.channelType)) {
    return false;
  }
  if (input.voiceStatus === "idle") {
    return false;
  }
  if (!input.isAudienceSeat) {
    return false;
  }
  if (input.partyState === "ended" || input.partyState === "cancelled") {
    return true;
  }
  if (input.hasLiveStream) {
    return false;
  }
  if (input.isSharingScreen) {
    return false;
  }
  return true;
}
