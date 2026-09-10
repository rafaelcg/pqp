import { isWatchPartyChannelType } from "@pqp/shared";

/**
 * Whether a seat in a watch party should be released.
 *
 * Watching is select plus HLS. A seat is the host's LiveKit pipe (or a
 * mic the party bar handed out), not "I opened the channel". Encerrar
 * always `voice.leave()`s on the host path; this is the backstop for
 * audience seats when the stream dies, and for anybody still seated
 * when the party is over (so leave-voice chrome does not linger).
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
  if (input.partyState === "ended" || input.partyState === "cancelled") {
    return true;
  }
  if (!input.isAudienceSeat) {
    return false;
  }
  if (input.hasLiveStream) {
    return false;
  }
  if (input.isSharingScreen) {
    return false;
  }
  return true;
}
