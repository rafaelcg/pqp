import type { ChannelKind, VoiceRoomTransport } from "@pqp/shared";

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

/**
 * M5's mesh guard, the pure half. `ws/voice.ts` consults it only with the
 * registry on, only for a room NOBODY has pinned yet (a room pinned by
 * another instance is adopted whatever its transport, since mesh signaling
 * crosses on `voice.signal`), and only when the decision was mesh. With a
 * second instance live and an SFU configured, a fresh room opens on the SFU:
 * the transport built for a room that spans machines, and a fresh room is
 * free to take it. Without an SFU the room opens on mesh, relayed across the
 * bus. It used to refuse that case, and a refusal is a hangup for a client
 * holding media, which is what the 2026-09-07 window paid for four times.
 *
 * `otherLiveInstances` is the count of leases other than this instance's,
 * from `listLiveVoiceInstances()`. Zero means single-machine, and the guard
 * keeps out of the way.
 */
export interface ClusterMeshGuardInput {
  liveKitConfigured: boolean;
  otherLiveInstances: number;
}

export type ClusterMeshGuardVerdict =
  /** One machine, or two without an SFU: the room opens on mesh. */
  | { kind: "keep" }
  /** Two or more machines and an SFU to open the room on instead. */
  | { kind: "force-livekit" };

export function guardMeshAcrossInstances(
  input: ClusterMeshGuardInput,
): ClusterMeshGuardVerdict {
  if (input.otherLiveInstances <= 0) {
    return { kind: "keep" };
  }
  if (input.liveKitConfigured) {
    return { kind: "force-livekit" };
  }
  return { kind: "keep" };
}
