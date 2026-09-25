import { z } from "zod";
import type { LiveHlsStream } from "./live-hls.js";
import { hasPermission, Permission } from "./permissions.js";
import { voiceParticipantSchema } from "./signaling.js";

/**
 * Watch party channels.
 *
 * A `watch_party` channel is a voice room with a stage that only some people
 * may take. Joining it is governed by VIEW_CHANNEL and CONNECT like any voice
 * room; putting a stream on the stage needs START_WATCH_PARTY. In a plain
 * voice channel that same action is governed by STREAM, so the server and the
 * client both ask ONE question, `canStartWatchPartyStream`, rather than each
 * comparing `type` strings.
 *
 * LIVE STATE SEAM. The sidebar wants to know whether a channel is live, who
 * is presenting and how many people are watching. On main that is derived from
 * the voice roster (`liveStateFromRoster`): a peer with `sharingScreen` is the
 * presenter. The HLS branch (`fix/hls-watch-mode-loading`) carries a richer
 * `LiveHlsStream` (`hlsUrl`, `startedAt`, `presenterPeerId`, `delaySeconds`)
 * on a `voice-stream` message; the field names here match it on purpose so
 * that branch can build a `ChannelLiveState` from its stream without renaming.
 *
 * With `channel-live` on main, `liveStateFromStream` is that richer answer:
 * the sidebar prefers it whenever the server has told this socket about a
 * stream, and falls back to `liveStateFromRoster` otherwise.
 */

/** Channel types that open a voice room. */
export function isVoiceRoomChannelType(type: string): boolean {
  return type === "voice" || type === "watch_party";
}

export function isWatchPartyChannelType(type: string): boolean {
  return type === "watch_party";
}

/**
 * Whether these effective permissions may put a screen on this channel's
 * stage. STREAM still rules a plain voice channel; a watch party ignores it
 * and asks for START_WATCH_PARTY instead, so an audience member with the
 * everyday STREAM default is still refused there.
 */
export function canStartWatchPartyStream(input: {
  channelType: string;
  permissions: bigint;
}): boolean {
  if (isWatchPartyChannelType(input.channelType)) {
    return hasPermission(input.permissions, Permission.START_WATCH_PARTY);
  }
  return hasPermission(input.permissions, Permission.STREAM);
}

export const channelLiveStateSchema = z.object({
  live: z.boolean(),
  /** Voice peer id of the presenter, null when nobody is on the stage. */
  presenterPeerId: z.string().nullable(),
  /** People in the room besides the presenter. */
  viewerCount: z.number().int().nonnegative(),
  /** Unix ms when the stream started; null until the HLS seam fills it. */
  startedAt: z.number().int().nonnegative().nullable(),
  /** HLS playlist URL; null on main, filled by the HLS branch. */
  hlsUrl: z.string().nullable(),
});

export type ChannelLiveState = z.infer<typeof channelLiveStateSchema>;

export const CHANNEL_NOT_LIVE: ChannelLiveState = Object.freeze({
  live: false,
  presenterPeerId: null,
  viewerCount: 0,
  startedAt: null,
  hlsUrl: null,
});

type RosterPeer = Pick<
  z.infer<typeof voiceParticipantSchema>,
  "peerId" | "sharingScreen"
> & {
  /**
   * Optional in this type only so callers that hold a narrower roster shape
   * still compile; every real roster entry carries it, and it is what lets
   * `liveStateFromStream` recognise a presenter who came back under a new
   * peer id (`LiveHlsStream.presenterUserId`).
   */
  userId?: string;
};

/** Live state as the roster tells it: a sharing peer is the presenter. */
export function liveStateFromRoster(
  participants: readonly RosterPeer[] | undefined,
): ChannelLiveState {
  if (!participants || participants.length === 0) {
    return CHANNEL_NOT_LIVE;
  }
  const presenter = participants.find((peer) => peer.sharingScreen);
  if (!presenter) {
    return CHANNEL_NOT_LIVE;
  }
  return {
    live: true,
    presenterPeerId: presenter.peerId,
    viewerCount: participants.length - 1,
    startedAt: null,
    hlsUrl: null,
  };
}

/**
 * Live state as a `channel-live` frame tells it. The stream is the truth about
 * whether the channel is live and who is presenting; the audience is everyone
 * in the room besides the presenter (the roster) plus everyone watching the
 * HLS playlist without a seat (`watching`, counted by the server).
 *
 * `stream: null` is "nothing live", whatever the roster says: the egress is
 * gone, and a peer still flagged `sharingScreen` for a moment is the WebRTC
 * share winding down, not a watch party.
 *
 * THE PRESENTER IS A PERSON, NOT A SOCKET. A seat is the presenter's when it
 * is the peer the stream names, or when it belongs to the user the stream
 * names (`presenterUserId`): a presenter who reloaded is seated under a new
 * peer id while the session, and this frame, still name the old one, and
 * counting them as their own audience put a phantom viewer on the count and
 * "+1 assistindo" lines in the host's feed (rehearsal C, 2026-09-25).
 */
export function liveStateFromStream(
  stream: LiveHlsStream | null,
  participants: readonly RosterPeer[] | undefined,
  watching: number,
): ChannelLiveState {
  if (!stream) {
    return CHANNEL_NOT_LIVE;
  }
  const seated = participants ?? [];
  const presenterUserId = stream.presenterUserId ?? null;
  const presenterSeats = seated.filter(
    (peer) =>
      peer.peerId === stream.presenterPeerId ||
      (presenterUserId !== null && peer.userId === presenterUserId),
  ).length;
  const roomViewers = Math.max(0, seated.length - presenterSeats);
  return {
    live: true,
    presenterPeerId: stream.presenterPeerId,
    viewerCount: roomViewers + Math.max(0, Math.floor(watching)),
    startedAt: stream.startedAt,
    hlsUrl: stream.hlsUrl,
  };
}
