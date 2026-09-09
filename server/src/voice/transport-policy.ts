import {
  isWatchPartyChannelType,
  type ChannelKind,
  type VoiceRoomTransport,
} from "@pqp/shared";

/**
 * Which transport a voice room gets when its first peer opens it.
 *
 * LiveKit Cloud bills participant-minutes, and a call between three friends
 * gains nothing from an SFU: the mesh is free, has one hop less, and its
 * ceiling (`MESH_VOICE_LIMIT`, eight) is far above what a small server or a
 * DM ever fills. So the SFU is reserved for the rooms that can outgrow the
 * mesh: voice channels in servers of at least `LARGE_SERVER_MEMBER_THRESHOLD`
 * members, and any PUBLIC community — one with an address at `pqp.gg/c/<slug>`,
 * whether or not it is also in the directory — whose membership is open and can
 * jump from three to thirty in an evening. The address is the switch that opens
 * the door, so it is the switch that predicts the crowd.
 *
 * Pure: no database, no env. `ws/voice.ts` gathers the inputs (one cheap query,
 * `getServerVoiceProfile`) and applies the result under the existing rule that
 * a room's transport is pinned from first join until the room empties. This
 * function therefore runs once per call, never per join.
 */

/** Servers with at least this many members get the SFU. The owner picked it. */
export const LARGE_SERVER_MEMBER_THRESHOLD = 10;

export type VoiceTransportReason =
  /** LiveKit is not configured on this deployment; nothing else was consulted. */
  | "unconfigured"
  /** A DM or group conversation call. */
  | "dm"
  /** Voice channel in a server below the member threshold. */
  | "small"
  /** Voice channel in a server at or above the member threshold. */
  | "large"
  /** Voice channel in a public community (one with an address), any size. */
  | "community"
  /** The channel's `voice_transport` column. */
  | "override"
  /**
   * A `watch_party` channel on a deployment with live HLS on: Track Composite
   * needs the SFU, even in a small server. ONLY that channel type. See
   * `liveHlsForcesSfu`.
   */
  | "hls"
  /** A server channel whose server row could not be read: configured default. */
  | "default";

export interface VoiceTransportDecision {
  transport: VoiceRoomTransport;
  reason: VoiceTransportReason;
}

export interface VoiceTransportPolicyInput {
  /** `getServerVoiceBackend() === "livekit" && isLiveKitConfigured()`. */
  liveKitConfigured: boolean;
  /**
   * `isLiveHlsEnabledForServer(server_id)`: the flag, the dedicated bucket
   * and the allowlist. A transcode only exists on LiveKit, so a watch party
   * in a two-person hall cannot stay on mesh or the share misses the track.
   * On its own it promotes nothing: it is read through `liveHlsForcesSfu`,
   * which also requires the channel to be a `watch_party`.
   */
  liveHlsEnabled?: boolean;
  channel: {
    kind: ChannelKind;
    /**
     * `channels.type`, as a string rather than `ChannelType` for the same
     * reason `canStartWatchPartyStream` takes one: the column is wider than
     * the enum the create API accepts (`thread`), and nothing here compares
     * it to anything but one name. Read for exactly one question,
     * `liveHlsForcesSfu`: a live transcode only ever runs in a `watch_party`
     * channel, so only that type is promoted for HLS. Every other rule below
     * still looks at `kind`.
     */
    type: string;
    /** The per-channel override column; null is automatic. */
    voiceTransport: VoiceRoomTransport | null;
  };
  /** The channel's server, or null for a conversation or an unreadable row. */
  server: { isCommunity: boolean; memberCount: number } | null;
}

/**
 * Whether live HLS is the reason this channel must be on the SFU.
 *
 * NARROW ON PURPOSE, and the narrowing is the point of this function
 * existing rather than the condition being inlined once. `LIVE_HLS_ENABLED`
 * used to promote EVERY server voice channel to LiveKit, so turning the flag
 * on for a watch party moved every unrelated peer-to-peer call in that server
 * onto the media box, which pays for those bytes (`docs/CAPACITY.md` §6b: the
 * monthly transfer allowance binds long before the cores do).
 *
 * An egress only ever attaches to a `watch_party` channel: that is the one
 * room `findOrCreateWatchPartyRoom` opens a party in, and `pickHlsSharer`
 * refuses to feed a transcode from anywhere else. So this is the exact set
 * that needs the SFU for HLS, and every other channel goes back to being
 * decided by size, community and the override alone.
 *
 * Two callers read it and neither may drift from the other:
 * `resolveVoiceTransport` below, and `decideRoomTransport` in `ws/voice.ts`,
 * which uses it to decide whether the member-count query can be skipped. When
 * it was one inline condition, skipping that query in the wide case is what
 * made an ordinary voice channel come back `livekit` with reason `default`.
 */
export function liveHlsForcesSfu(input: {
  liveHlsEnabled?: boolean;
  channelType: string;
}): boolean {
  return (
    Boolean(input.liveHlsEnabled) && isWatchPartyChannelType(input.channelType)
  );
}

export function resolveVoiceTransport(
  input: VoiceTransportPolicyInput,
): VoiceTransportDecision {
  if (!input.liveKitConfigured) {
    // Exactly today's behaviour on a self-host: the override column is kept
    // but cannot ask for a transport the deployment does not have.
    return { transport: "mesh", reason: "unconfigured" };
  }
  if (input.channel.kind !== "server") {
    return { transport: "mesh", reason: "dm" };
  }
  if (input.channel.voiceTransport) {
    return { transport: input.channel.voiceTransport, reason: "override" };
  }
  if (
    liveHlsForcesSfu({
      liveHlsEnabled: input.liveHlsEnabled,
      channelType: input.channel.type,
    })
  ) {
    return { transport: "livekit", reason: "hls" };
  }
  if (!input.server) {
    return { transport: "livekit", reason: "default" };
  }
  if (input.server.isCommunity) {
    return { transport: "livekit", reason: "community" };
  }
  if (input.server.memberCount >= LARGE_SERVER_MEMBER_THRESHOLD) {
    return { transport: "livekit", reason: "large" };
  }
  return { transport: "mesh", reason: "small" };
}
