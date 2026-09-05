import type { ChannelKind, VoiceRoomTransport } from "@pqp/shared";

/**
 * Which transport a voice room gets when its first peer opens it.
 *
 * LiveKit Cloud bills participant-minutes, and a call between three friends
 * gains nothing from an SFU: the mesh is free, has one hop less, and its
 * ceiling (`MESH_VOICE_LIMIT`, eight) is far above what a small server or a
 * DM ever fills. So the SFU is reserved for the rooms that can outgrow the
 * mesh: voice channels in servers of at least `LARGE_SERVER_MEMBER_THRESHOLD`
 * members, and any listed community, whose membership is open and can jump
 * from three to thirty in an evening.
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
  /** Voice channel in a listed community, regardless of size. */
  | "community"
  /** The channel's `voice_transport` column. */
  | "override"
  /** A server channel whose server row could not be read: configured default. */
  | "default";

export interface VoiceTransportDecision {
  transport: VoiceRoomTransport;
  reason: VoiceTransportReason;
}

export interface VoiceTransportPolicyInput {
  /** `getServerVoiceBackend() === "livekit" && isLiveKitConfigured()`. */
  liveKitConfigured: boolean;
  channel: {
    kind: ChannelKind;
    /** The per-channel override column; null is automatic. */
    voiceTransport: VoiceRoomTransport | null;
  };
  /** The channel's server, or null for a conversation or an unreadable row. */
  server: { isCommunity: boolean; memberCount: number } | null;
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
