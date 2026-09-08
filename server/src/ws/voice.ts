import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  markChannelSessionEnded,
  markChannelSessionLive,
} from "../services/channel-sessions.js";
import { z } from "zod";
import {
  clientRelayMessageSchema,
  isClientRelayMessage,
  CAMERA_LIMIT,
  MESH_VOICE_LIMIT,
  SCREEN_SHARE_LIMIT,
  canStartWatchPartyStream,
  hasPermission,
  isVoiceRoomChannelType,
  Permission,
  callDeclinedMessageSchema,
  callIncomingMessageSchema,
  callRingCancelledMessageSchema,
  voiceClientMessageSchema,
  voiceModerationMessageSchema,
  voiceParticipantSchema,
  voiceRoomTransportSchema,
  watchPartyStateSchema,
  liveReactionCountSchema,
  type VoiceParticipant,
  type VoiceRoomTransport,
  type LiveHlsStream,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import {
  INSTANCE_ID,
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { logEvent } from "../lib/log.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { listBlockersOf } from "../services/blocks.js";
import {
  isDmSendBlocked,
  resolveRingableConversation,
} from "../services/dms.js";
import { createMessage, mapMessage } from "../services/messages.js";
import { pushChannelActivity, pushIncomingCall } from "../services/push.js";
import { findTimeoutForChannel } from "../services/sanctions.js";
import {
  getChannel,
  getChannelAudience,
  getServerVoiceProfile,
  type ChannelRow,
} from "../services/servers.js";
import { resolveMemberChannelPermissions } from "../services/permissions.js";
import { canAccessChannel, resolveMemberName } from "../services/users.js";
import { broadcastToChannel, onPermissionsUpdate } from "./chat.js";
import { resolveStatus } from "./status.js";
import {
  evictSfuRoom,
  evictSfuUser,
  evictSfuUsersExcept,
  setSfuUserCanPublish,
  tickSfuResweeps,
} from "../voice/admin.js";
import { resolveVoicePublish } from "../voice/speak.js";
import {
  getServerVoiceBackend,
  isLiveKitConfigured,
} from "../voice/backends.js";
import {
  isLiveHlsEnabledForServer,
  liveHlsStreamFor,
  reconcileLiveHls,
  setLiveHlsChangeListener,
  setLiveHlsSfuLoadReader,
} from "../voice/hls-egress.js";
import {
  resolveVoiceTransport,
  type VoiceTransportDecision,
} from "../voice/transport-policy.js";
import {
  decidePromotion,
  estimateSfuLoadMbps,
  promotionBudgetMbps,
  type SfuRoomLoad,
} from "../voice/promotion.js";
import { readSfuStats } from "../voice/sfu-stats.js";
import {
  adoptVoicePeer,
  clearWatchPartyIfEmpty,
  deleteVoicePeer,
  getVoicePeerRow,
  isVoicePeerRetired,
  isVoiceRegistryEnabled,
  isVoiceServerMuted as isVoiceServerMutedInRegistry,
  listVoicePeersForUser,
  listVoicePeersInRoom,
  listVoiceRoomOccupancy,
  listVoiceRoster,
  listVoiceRosters,
  markVoicePeerOrphaned,
  persistWatchParty,
  claimVoiceRoomTransport,
  promoteVoiceRoomTransport,
  readWatchParty,
  reconcileVoiceRegistry,
  retireVoicePeerId,
  setVoiceServerMute,
  unpinVoiceRoomIfEmpty,
  upsertVoicePeer,
  type VoicePeerRow,
  type VoiceRosterPeerRow,
} from "../voice/registry.js";
import {
  countAuthenticatedSockets,
  forEachAuthenticatedSocket,
  socketHasCap,
  SOCKET_CAPS,
} from "./sockets.js";
import {
  coalesceWindowFor,
  createCoalescer,
  encodeFrame,
  sendEncoded,
  sendEncodedDroppable,
} from "./fanout.js";
import { createHlsAudience, pickHlsSharer } from "./hls-audience.js";
import { stampViewerStream } from "../voice/hls-viewer-token.js";
import {
  adoptWatchPartyState,
  applyWatchPartyWrite,
  endWatchParty,
  getWatchPartyState,
  resetWatchPartyLimits,
} from "./watch-party.js";
import {
  offerLiveReaction,
  resetLiveReactionLimits,
  resetLiveReactions,
  setLiveReactionSink,
} from "./live-reactions.js";
import {
  mintVoiceResumeToken,
  verifyVoiceResumeToken,
  VOICE_RESUME_TTL_MS,
  VOICE_RESUME_TOKEN_TTL_MS,
} from "./voice-resume-token.js";

/** Re-exported so tests can fake the orphan window without importing the token module. */
export { VOICE_RESUME_TTL_MS };

interface VoicePeer {
  id: string;
  socket: WebSocket;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  voiceChannelId: string;
  sharingScreen: boolean;
  /** Sender-side camera MediaStream id, or null while the camera is off.
   *  See `voiceParticipantSchema.cameraStreamId` for why the id travels. */
  cameraStreamId: string | null;
  /** Sender-side MediaStream id of the screen capture when it carries audio,
   *  null otherwise. See `voiceParticipantSchema.screenAudioStreamId`. */
  screenAudioStreamId: string | null;
  // --- voice state ---
  // Self-reported over `set-voice-state`, carried on every roster so the
  // channel list can badge occupants for people outside the call. Display
  // state only: enforcement of anything never hangs off these flags.
  muted: boolean;
  deafened: boolean;
  /**
   * `Permission.SPEAK` as resolved at join (and re-resolved by
   * `reevaluateVoiceSpeak` when the server's permissions change). Unlike
   * `muted` this IS enforcement: it gates the unmute declaration here, and
   * on the SFU it is the microphone publish grant.
   */
  canSpeak: boolean;
  /**
   * `Permission.STREAM`: camera and screen share. Independent of SPEAK.
   */
  canStream: boolean;
  /** Set when the socket closed; cleared on resume. Absent = live. */
  orphanedAt?: number;
  orphanTimer?: ReturnType<typeof setTimeout>;
  /**
   * The join that created this peer sent `resume: true`. Only those peers
   * stay in the room after the socket closes. Phones and old tabs omit the
   * flag and are removed immediately, so they do not occupy a mesh seat.
   */
  canResume: boolean;
}

/**
 * VOICE IS DELIBERATELY NOT ON THE CLUSTER BUS (`lib/bus.ts`), AND MESH VOICE
 * THEREFORE PINS THE DEPLOYMENT TO ONE INSTANCE.
 *
 * Relaying offer/answer/ICE through pub/sub is the obvious idea and it is not
 * enough, because a mesh room is shared *state*, not a stream of point-to-point
 * messages. Four things in this file read `peers` as if it were the whole room:
 *
 * 1. `relayToTarget` resolves `message.to` in the local map. A target on
 *    another instance is simply absent, and the frame is dropped.
 * 2. `welcome` and `broadcastToRoom` build the joiner's peer list from
 *    `getRoomPeers`, which filters the local map — so two instances would form
 *    two sub-meshes that each believe they are the room. The client rebuilds
 *    its signaling allowlist from that roster (`knownPeerIds` in
 *    client/src/hooks/use-voice.ts), so a partitioned roster is also a
 *    partitioned trust boundary, not merely a cosmetic one.
 * 3. `MESH_VOICE_LIMIT` counts local peers. Made global over a bus it would
 *    still be a read-then-write race between instances: two simultaneous joins
 *    each see room < limit and both admit, which is exactly the mesh quality
 *    collapse the ceiling exists to prevent. Enforcing it properly needs an
 *    atomic counter, not a broadcast.
 * 4. `peer-left` is the only thing that removes a tile. A bus frame lost to a
 *    reconnect leaves a ghost participant in a live call — visible, permanent
 *    until rejoin, and impossible for the user to clear.
 *
 * A distributed peer registry solving all four is a real subsystem with its own
 * failure modes. Until it exists, the constraint is: **mesh voice requires one
 * instance.** Session affinity is not a workaround — two people who need to
 * hear each other open their sockets independently and long before they pick a
 * channel, so no routing rule can promise they land together.
 *
 * With LiveKit configured the picture changes: media and its signaling go
 * straight to the SFU (the client leaves `manager` null and never relays
 * through here), so a call spans instances fine. What stays per-instance is the
 * *roster* — `voice-roster` occupancy badges and participant labels — which
 * degrades to "you only see the people who happen to share your instance".
 * That is a display bug, not an audio one, and it is the piece to put on the
 * bus first if multi-instance voice is ever wanted.
 *
 * THE WAY OUT IS THE VOICE REGISTRY (`voice/registry.ts`,
 * `docs/plans/MULTI_INSTANCE_VOICE.md`), behind `VOICE_REGISTRY=postgres`.
 * M1 made it write-through: every change to this map is copied to
 * `voice_peers`, the transport pin goes through an atomic insert on
 * `voice_rooms` so two instances cannot disagree, and the three places that
 * must answer for the whole cluster from one HTTP request (the SFU token
 * mint, moderation targeting, the operator snapshot) read the rows after the
 * map. M2 put the roster on the rows and the room on the bus: with the flag
 * on, `broadcastRoster` and `sendAllVoiceRosters` read `voice_peers` (this
 * map only supplies the sockets), the watch party lives in `voice_rooms`,
 * and every state change publishes a `voice.room` / `voice.identity` /
 * `voice.watch` frame when `CLUSTER_BUS` is also on. FRAMES ARE HINTS, ROWS
 * ARE TRUTH: the receiving instance forwards the `peer-*` frame to its local
 * room and rebuilds the roster from the rows, so a lost frame costs latency,
 * not a ghost (point 4 above). M3 made a seat outlive its instance: a
 * resume that lands here for a row another instance holds ADOPTS it (one
 * conditional update, then the reattach path, and a `voice.room adopted`
 * frame so the old owner forgets the entry without a `peer-left`); the
 * instance lease has consequences (`runVoiceReconcile`, after every
 * heartbeat: a dead instance's rows are orphaned, deleted after the resume
 * window with `peer-left` fanned out by whoever is alive, and room rows
 * nobody is in are swept); the retired-id store is `voice_retired_peers`
 * alone; and the tab-close beacon retires a seat whichever machine holds
 * it. M4 put the two remaining per-process things on the bus: a ring is
 * owned by the instance holding the caller's socket (its timers stay
 * local) and only its fan-out crosses (`voice.call`), and a moderation
 * action publishes `voice.moderation` so the instance holding the target's
 * socket says the notice and drops the peer before the row goes; the SFU
 * re-sweeps are `voice_resweeps` rows claimed by whoever ticks. M5 added
 * a guard that refused a mesh join while a second instance was live, then
 * one that sent a fresh mesh room to the SFU instead; on 2026-09-07 the
 * refusal hung up four resumes in one afternoon, and the SFU detour would
 * have put every small room on one media box, so both are gone and mesh
 * crosses like everything else (the transport is the policy's, pinned once):
 * offer, answer and ICE for a peer this instance does not hold ride
 * `voice.signal` to the instance that does (point 1 above), the joiner's
 * peer list and the `peer-*` frames already come from the rows and the bus
 * (point 2), the ceiling counts the rows (point 3, with the documented
 * read-then-write window between two simultaneous joins), and `peer-left`
 * is a hint over a row (point 4). A moderator's mute is a `voice_server_
 * mutes` row and a `voice.serverMute` frame. Every frame a voice topic
 * publishes or applies here is counted (`clusterFrames`, in the operator
 * snapshot), so "the bus carries voice" is a number, not a log line. With
 * the flag off (the default) `registryOn()` is false on every path below
 * and this file behaves exactly as it did before the registry.
 */
const peers = new Map<string, VoicePeer>();

function registryOn(): boolean {
  return isVoiceRegistryEnabled();
}

/**
 * Both switches: rows to read (the registry) and a wire to send the hint on
 * (the bus). Checked before building any frame, so a deployment with either
 * off allocates nothing for the other instance that is not there.
 */
function clusterOn(): boolean {
  return registryOn() && isBusEnabled();
}

/**
 * Registry writes in flight, per channel. The handler never waits for a row
 * (a database blip must not hold up a frame), but a roster built from the
 * rows must not run ahead of the write it is reporting, or the joiner's own
 * audience would see a roster without them. `broadcastRoster` awaits this
 * before reading, which is also what puts the bus hint after the commit.
 */
const pendingRowWrites = new Map<string, Promise<void>>();

function trackRowWrite(channelId: string, write: Promise<unknown>): void {
  const previous = pendingRowWrites.get(channelId) ?? Promise.resolve();
  // Registry promises never reject (`track` swallows into a log), so this
  // chain cannot break; `catch` is belt and braces against a future caller.
  const next = Promise.all([previous, write]).then(
    () => undefined,
    () => undefined,
  );
  pendingRowWrites.set(channelId, next);
  void next.then(() => {
    if (pendingRowWrites.get(channelId) === next) {
      pendingRowWrites.delete(channelId);
    }
  });
}

function settledRowWrites(channelId: string): Promise<void> {
  return pendingRowWrites.get(channelId) ?? Promise.resolve();
}

/**
 * Copy a peer to its registry row. Fire-and-forget: the map is the source of
 * truth for this instance and has already been updated; a failed write is
 * logged inside the registry and costs the cluster one stale row, not the
 * caller a frame.
 */
function writePeerRow(peer: VoicePeer): void {
  if (!registryOn()) {
    return;
  }
  trackRowWrite(
    peer.voiceChannelId,
    upsertVoicePeer({
      peerId: peer.id,
      channelId: peer.voiceChannelId,
      userId: peer.userId,
      displayName: peer.displayName,
      avatarUrl: peer.avatarUrl,
      muted: peer.muted,
      deafened: peer.deafened,
      sharingScreen: peer.sharingScreen,
      cameraStreamId: peer.cameraStreamId,
      screenAudioStreamId: peer.screenAudioStreamId,
      canSpeak: peer.canSpeak,
      canStream: peer.canStream,
      canResume: peer.canResume,
      orphanedAt:
        peer.orphanedAt === undefined ? null : new Date(peer.orphanedAt),
      transport: getRoomTransport(peer.voiceChannelId),
    }),
  );
}

/** A registry row as the wire shape: what a roster carries for a peer held elsewhere. */
function rowToParticipant(row: VoiceRosterPeerRow): VoiceParticipant {
  return {
    peerId: row.peerId,
    userId: row.userId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    sharingScreen: row.sharingScreen,
    cameraStreamId: row.cameraStreamId,
    screenAudioStreamId: row.screenAudioStreamId,
    muted: row.muted,
    deafened: row.deafened,
    canSpeak: row.canSpeak,
    // The row's flag is the cluster's (`voice_server_mutes`); the map is
    // this process's copy and may be a write ahead of it.
    serverMuted:
      row.serverMuted || isVoiceUserServerMuted(row.channelId, row.userId),
    canStream: row.canStream,
  };
}

/**
 * The room as the cluster sees it: the rows, with this instance's own peers
 * laid over them by id (the map is exact for a socket held here and may be a
 * write ahead of its row). Returns null when the rows say there is no room,
 * which after `settledRowWrites` means nobody is in it anywhere.
 */
async function readClusterRoom(
  voiceChannelId: string,
): Promise<{ participants: VoiceParticipant[]; transport: VoiceRoomTransport } | null> {
  const room = await listVoiceRoster(voiceChannelId);
  const byId = new Map<string, VoiceParticipant>();
  for (const row of room?.peers ?? []) {
    byId.set(row.peerId, rowToParticipant(row));
  }
  for (const peer of getRoomPeers(voiceChannelId)) {
    byId.set(peer.id, toParticipant(peer));
  }
  noteRemoteTransport(voiceChannelId, room?.transport ?? null);
  if (!room && byId.size === 0) {
    return null;
  }
  return {
    participants: [...byId.values()],
    transport:
      roomTransports.get(voiceChannelId) ??
      room?.transport ??
      configuredTransport(),
  };
}
const socketToPeerId = new Map<WebSocket, string>();
/**
 * Peer ids removed in this process (leave / kick / TTL). Blocks reconstruct
 * for the token's life so a hangup cannot resurrect the id. With the
 * registry on this map is never written: `voice_retired_peers` is the one
 * store, and it answers for every instance and across a restart.
 */
const retiredPeerIds = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A VOICE ROOM HAS ONE TRANSPORT, THIS PROCESS PICKS IT, AND IT DOES NOT CHANGE
 * WHILE THE ROOM IS OCCUPIED.
 *
 * Clients used to resolve mesh-vs-SFU independently, once per join, and tell
 * nobody. Two people in the same channel could land on different transports and
 * neither would be told: the mesh side's offers are dropped by an SFU client
 * that has no peer-connection manager, and the mesh client is not a LiveKit
 * participant, so it never even appears in the SFU client's peer list. Both
 * sides see the other in the sidebar, silent, exactly like someone muted.
 *
 * So the room owns the decision:
 *
 * - It is decided when the room's **first** peer joins and pinned here for as
 *   long as the room has anyone in it. The decision is `configuredTransport()`
 *   narrowed by `voice/transport-policy.ts`: with LiveKit configured, a DM call
 *   or a voice channel in a small server still opens on mesh (free, one hop
 *   less), and only a large server, a listed community or a channel override
 *   goes to the SFU. Without LiveKit everything is mesh. A live call never
 *   changes transport under the people in it — there is no correct way to move
 *   an in-progress mesh onto an SFU (or back) without dropping everyone's audio
 *   mid-sentence, and "it stays as it started" is a rule clients can rely on
 *   without any migration protocol.
 * - The pin is dropped when the room empties, so a config change (LiveKit
 *   added, removed, or repaired) takes effect on the next call in that channel
 *   rather than needing a restart.
 * - It is stated in `welcome` and in `voice-roster`, so no client has to guess.
 *
 * Scope: this map is per-process, like `peers` above. On a multi-instance
 * deployment two instances with *different* LiveKit config would pin the same
 * channel differently and split the call again — which is one more item on the
 * list of reasons voice wants a single instance (see the note above `peers`).
 */
const roomTransports = new Map<string, VoiceRoomTransport>();

/**
 * The read-through cache of `voice_rooms.transport` for rooms this process
 * has nobody in (with the registry on, and only then). Filled by every row
 * read that carries the room (`readClusterRoom`, `sendAllVoiceRosters`,
 * `welcomeVoicePeer`), dropped for a channel on every `voice.room` frame
 * about it and whenever a read says the room is gone, so `getRoomTransport`
 * stays synchronous for the hot paths and still answers for a room pinned
 * elsewhere. Never authoritative over `roomTransports`: a room this process
 * has a peer in is pinned here and the pin wins.
 */
const remoteTransports = new Map<string, VoiceRoomTransport>();

function noteRemoteTransport(
  voiceChannelId: string,
  transport: VoiceRoomTransport | null,
): void {
  if (transport === null) {
    remoteTransports.delete(voiceChannelId);
  } else {
    remoteTransports.set(voiceChannelId, transport);
  }
}

function configuredTransport(): VoiceRoomTransport {
  return getServerVoiceBackend() === "livekit" && isLiveKitConfigured()
    ? "livekit"
    : "mesh";
}

/**
 * The transport a room is running on, or the configured ceiling if it is empty.
 *
 * Every room with a peer in it is pinned, so for a live room this is exact.
 * For an empty room it answers what the deployment *can* run, not what the
 * policy would pick: that needs the channel row and is `decideRoomTransport`.
 */
export function getRoomTransport(voiceChannelId: string): VoiceRoomTransport {
  return (
    roomTransports.get(voiceChannelId) ??
    remoteTransports.get(voiceChannelId) ??
    configuredTransport()
  );
}

/**
 * Whether *this process* holds the room's pin. When it does not and the
 * registry is on, the room may still be live on another instance, and the
 * caller (the token mint) should consult `voice_rooms` before assuming the
 * configured ceiling.
 */
export function isRoomPinnedLocally(voiceChannelId: string): boolean {
  return roomTransports.has(voiceChannelId);
}

/**
 * What an empty room would open on. One query at most (the server's member
 * count and community flag), and none at all when LiveKit is off, the channel
 * is a conversation, or the channel carries an override. Called once per pin.
 */
async function decideRoomTransport(
  channel: ChannelRow,
): Promise<VoiceTransportDecision> {
  const liveKitConfigured = configuredTransport() === "livekit";
  const liveHlsEnabled = isLiveHlsEnabledForServer(channel.server_id);
  const voiceTransport = channel.voice_transport ?? null;
  let server: { isCommunity: boolean; memberCount: number } | null = null;
  if (
    liveKitConfigured &&
    !liveHlsEnabled &&
    channel.kind === "server" &&
    channel.server_id &&
    !voiceTransport
  ) {
    try {
      server = await getServerVoiceProfile(channel.server_id);
    } catch (error) {
      // A failed read must not refuse the join. Null falls through to the
      // configured default, which is what every room got before the policy.
      console.error("[voice] transport policy lookup failed:", error);
    }
  }
  return resolveVoiceTransport({
    liveKitConfigured,
    liveHlsEnabled,
    channel: { kind: channel.kind, voiceTransport },
    server,
  });
}

/**
 * The decision for a channel nobody has pinned yet, shared by every join
 * racing to be the one that opens the room.
 *
 * `decideRoomTransport` says it runs "once per room pin, never per join", and
 * that was true of a room people trickle into and false of the only shape that
 * matters: 150 people tapping the channel in the same second all reach the
 * unpinned check before any of them reaches the pin, so all 150 ran the
 * member-count query. Measured on the harness at exactly that: 150 joins, 150
 * `getServerVoiceProfile` calls, on the one path where the pool was already
 * the constraint. Sharing the promise makes the stampede cost one query, which
 * is what the comment always claimed.
 *
 * Held only while the room is unpinned, and dropped wherever `roomTransports`
 * is written or cleared, so the answer can never outlive the config it was
 * computed from.
 */
const pendingTransportDecisions = new Map<
  string,
  Promise<VoiceTransportDecision>
>();

function decideRoomTransportOnce(
  voiceChannelId: string,
  channel: ChannelRow,
): Promise<VoiceTransportDecision> {
  const existing = pendingTransportDecisions.get(voiceChannelId);
  if (existing) {
    return existing;
  }
  const decision = decideRoomTransport(channel);
  pendingTransportDecisions.set(voiceChannelId, decision);
  return decision;
}

/** The room is pinned, or empty: the shared decision has no more readers. */
function forgetTransportDecision(voiceChannelId: string): void {
  pendingTransportDecisions.delete(voiceChannelId);
}

/** Test hook: forget every pinned room transport. */
export function resetVoiceRoomTransports(): void {
  roomTransports.clear();
  remoteTransports.clear();
  roomServerMutes.clear();
  pendingTransportDecisions.clear();
}

/**
 * SERVER MUTES: room id -> user ids a moderator has muted for everyone.
 *
 * Keyed on the (room, user) pair and NOT stored on the `VoicePeer`, because a
 * peer is a seat and the mute is a sanction on the person. A peer is minted on
 * every join, so a mute that lived on it would be undone by hanging up and
 * rejoining, which turns "leave" into an unmute button that only the target
 * knows about. Here the flag outlives the peer: a server-muted person who
 * rejoins comes back with `serverMuted: true` and `muted: true` in the same
 * `welcome` that seats them.
 *
 * WHY THIS WORKS ON MESH AT ALL. The server never touches media on a mesh
 * room, so for a long time a server mute there was refused as unenforceable.
 * But eviction has always worked on mesh, and it works because the server
 * changes the ROSTER and every other client enforces the roster: a peer that
 * is not listed is not played. The mute uses the same trick and the same
 * trust boundary. The flag rides the roster, every receiving client forces
 * that peer's playback to zero, and the sender's own client stops publishing
 * and refuses to unmute. A modified sender gains nothing (nobody plays it); a
 * modified receiver can hear one muted person, which is exactly the power a
 * modified receiver already has over an evicted peer's last packets. On
 * LiveKit the SFU additionally mutes the publication, and the flag still
 * travels so both transports look identical on every tile.
 *
 * Lifetime is the room's, like `roomTransports`: cleared when the last peer
 * (orphans included) leaves, so a sanction never survives into a call that
 * starts hours later. Per-process, for the same reasons as everything above.
 */
const roomServerMutes = new Map<string, Set<string>>();

/** Whether a moderator has muted this user in this room. */
export function isVoiceUserServerMuted(
  voiceChannelId: string,
  userId: string,
): boolean {
  return roomServerMutes.get(voiceChannelId)?.has(userId) ?? false;
}

/**
 * Set or clear a moderator's mute on one user in one room, then tell the
 * room. The route has already checked permission, rank and that the target
 * is in this room; this is the state change and the fan-out.
 *
 * Muting also forces the target's self-reported `muted` on every seat they
 * hold, so the very next roster is consistent (a receiver that only reads
 * `muted` still draws the right badge). Clearing does NOT unmute them: the
 * person decides when their mic comes back, the same as after any self-mute.
 */
export async function setVoiceUserServerMuted(
  voiceChannelId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  // The row first, then the wire, then the local half: an instance that
  // re-reads the roster on the hint below must find the flag already there,
  // and a seat minted on any instance after this reads the row on its way in.
  if (registryOn()) {
    await setVoiceServerMute(voiceChannelId, userId, muted);
  }
  if (clusterOn()) {
    publishVoice(VOICE_SERVER_MUTE_TOPIC, {
      channelId: voiceChannelId,
      userId,
      muted,
    } satisfies VoiceServerMuteFrame);
  }
  return applyServerMuteLocally(voiceChannelId, userId, muted);
}

/**
 * The per-process half of a moderator's mute: the map, this instance's own
 * seats for the person (forced `muted`, row rewritten), and the fan-out.
 * Run by the instance the request landed on and by every instance that
 * receives the `voice.serverMute` frame, each for the sockets it holds.
 */
function applyServerMuteLocally(
  voiceChannelId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  let set = roomServerMutes.get(voiceChannelId);
  // The map's lifetime is the LOCAL room's (cleared when this process's
  // last peer leaves), so a process with nobody in the room must not cache
  // the sanction: nothing here would ever clear it, and with the registry
  // on the rows answer for that process anyway (a join reads them on its
  // way in, a roster reads them per row). With the registry off the mute
  // route only reaches a room this process holds.
  const holdsRoom = getRoomPeers(voiceChannelId).length > 0;
  if (muted && (holdsRoom || !registryOn())) {
    if (!set) {
      set = new Set();
      roomServerMutes.set(voiceChannelId, set);
    }
    set.add(userId);
    for (const peer of getRoomPeers(voiceChannelId)) {
      if (peer.userId === userId) {
        peer.muted = true;
        writePeerRow(peer);
      }
    }
  } else if (set) {
    set.delete(userId);
    if (set.size === 0) {
      roomServerMutes.delete(voiceChannelId);
    }
  }
  // Named peers rather than a bare "something changed": `serverMuted` is
  // computed by `toParticipant` from the map above, so every seat this person
  // holds in this room now reads differently and nothing else does. Announcing
  // them by name is what lets the fan-out describe this as a delta instead of
  // re-sending the whole room.
  const changed = getRoomPeers(voiceChannelId).filter(
    (peer) => peer.userId === userId,
  );
  if (changed.length === 0) {
    return broadcastRoster(voiceChannelId);
  }
  let last: Promise<void> = Promise.resolve();
  for (const peer of changed) {
    last = broadcastRoster(voiceChannelId, {
      kind: "updated",
      peer: toParticipant(peer),
    });
  }
  return last;
}

/**
 * Joining fans a query plus a broadcast out to a whole server, so the churn is
 * worth bounding — but generously. A client re-joins on every reconnect, so a
 * flappy network legitimately produces bursts, and throttling those would eject
 * people from calls exactly when the reconnect logic is trying to keep them in.
 */
const roomLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 2 });

/**
 * `set-voice-state` fans a roster out to everyone who can see the channel, so
 * a client toggling mute in a loop would be spending the whole audience's
 * bandwidth. The budget is far above what a human can click; past it the frame
 * is dropped, which at worst leaves a stale badge until the next honest toggle
 * — display state, never enforcement, so stale is safe.
 */
const stateLimiter = createRateLimiter({ capacity: 15, refillPerSecond: 3 });

export function resetVoiceRateLimits(): void {
  roomLimiter.reset();
  stateLimiter.reset();
  resetWatchPartyLimits();
  resetLiveReactionLimits();
  resetLiveReactions();
}

function getRoomPeers(voiceChannelId: string): VoicePeer[] {
  return [...peers.values()].filter((p) => p.voiceChannelId === voiceChannelId);
}

function getLiveRoomPeers(voiceChannelId: string): VoicePeer[] {
  return getRoomPeers(voiceChannelId).filter((p) => p.orphanedAt === undefined);
}

function cancelOrphan(peer: VoicePeer): void {
  if (peer.orphanTimer) {
    clearTimeout(peer.orphanTimer);
    peer.orphanTimer = undefined;
  }
  peer.orphanedAt = undefined;
}

function retirePeerId(peerId: string, voiceChannelId: string): void {
  if (registryOn()) {
    // Tracked on the channel so a resume for this id that arrives right
    // behind the hangup waits for the row before it asks whether the id is
    // retired (`settledRowWrites` in the join handler).
    trackRowWrite(voiceChannelId, retireVoicePeerId(peerId));
    return;
  }
  const existing = retiredPeerIds.get(peerId);
  if (existing) {
    clearTimeout(existing);
  }
  retiredPeerIds.set(
    peerId,
    setTimeout(() => {
      retiredPeerIds.delete(peerId);
    }, VOICE_RESUME_TOKEN_TTL_MS),
  );
}

/**
 * Watch party and unanswered rings follow *live* occupancy. Orphans are still
 * in the call (media may be flowing). A lone watcher who only blips the socket
 * keeps the film until they resume or the orphan TTL fires. Conversation rings
 * start their empty-room grace when live occupancy hits zero; the timer's
 * expiry check still sees orphans, so a blip that resumes in time does not
 * kill the ring.
 *
 * The transport pin stays until the map is empty, including orphans, so a
 * resume in the same process cannot flip mesh ↔ LiveKit under held media.
 */
function onLiveRoomMaybeEmpty(
  voiceChannelId: string,
  notifySocket?: WebSocket,
): void {
  if (getLiveRoomPeers(voiceChannelId).length > 0) {
    return;
  }
  // Conversation rings: start the empty-room grace once nobody live is in
  // the call. An orphan still counts as "in" for the timer's expiry check,
  // so a blip that resumes in time does not kill the ring.
  noteVoiceRoomEmptied(voiceChannelId);
  // Watch party has no extra grace for the *next* arrival, but a lone
  // watcher who only blipped the socket must keep the film until they
  // resume or the orphan TTL fires.
  if (getRoomPeers(voiceChannelId).length > 0) {
    return;
  }
  if (endWatchParty(voiceChannelId) && notifySocket) {
    send(notifySocket, {
      type: "watch-party",
      channelId: voiceChannelId,
      state: null,
    });
  }
}

/**
 * Somebody's name or picture changed while they were in a call.
 *
 * A peer's label is copied into the room when they join and was never touched
 * again, so a rename showed up everywhere in the app except the one place
 * people were actually looking at each other. Both the in-call tiles
 * (`peer-updated`) and the sidebar occupancy (`voice-roster`) are refreshed.
 *
 * Best effort by design: a call is live and a stale label is not worth an
 * exception on the profile route that triggered this.
 */
export async function refreshVoiceIdentity(
  userId: string,
  profile: { display_name: string; avatar_url: string | null },
): Promise<void> {
  // The profile route ran here; the person's sockets may be anywhere. The
  // hint goes out whether or not this instance holds a peer for them, since
  // "none here" says nothing about the other machine. Published before the
  // local half so the other instance's re-read is not waiting on this one's
  // name resolution; its own rows are its own to write.
  if (clusterOn()) {
    publishVoice(VOICE_IDENTITY_TOPIC, {
      userId,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
    } satisfies VoiceIdentityFrame);
  }
  await applyVoiceIdentity(userId, profile);
}

/**
 * The local half of `refreshVoiceIdentity`: relabel the peers this instance
 * holds for the user, copy them to their rows, tell their rooms, rebuild the
 * rosters. Also what a `voice.identity` frame runs, so it never publishes.
 */
async function applyVoiceIdentity(
  userId: string,
  profile: { display_name: string; avatar_url: string | null },
): Promise<void> {
  const mine = [...peers.values()].filter((peer) => peer.userId === userId);
  if (mine.length === 0) {
    return;
  }
  const rooms = new Map<string, VoicePeer>();
  for (const peer of mine) {
    try {
      const channel = await getChannel(peer.voiceChannelId);
      peer.displayName = await resolveMemberName(
        channel?.kind === "server" ? (channel.server_id ?? null) : null,
        { id: userId, display_name: profile.display_name },
      );
      peer.avatarUrl = profile.avatar_url;
      writePeerRow(peer);
      rooms.set(peer.voiceChannelId, peer);
      broadcastToRoom(peer.voiceChannelId, {
        type: "peer-updated",
        peer: toParticipant(peer),
      });
    } catch (error) {
      logEvent("voice.refreshIdentityFailed", {
        userId,
        peerId: peer.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Awaited rather than fired off: the roster send is queued per room, and a
  // caller that wants to know the room has caught up (a test, or a future
  // caller that cares) can only find out if this waits. Every caller today
  // starts it with `void`, so nothing blocks a request either way. The room
  // event carries the relabelled peer, so the other instance's tiles update
  // too (one peer per room is enough: a second seat is a curiosity).
  await Promise.all(
    [...rooms].map(([room, peer]) =>
      broadcastRoster(room, { kind: "updated", peer: toParticipant(peer) }),
    ),
  );
}

// --- operator metrics ---------------------------------------------------
//
// Read by `GET /api/admin/metrics` and nothing else. Process-local like
// `peers` itself: a deploy restarts the machine and the peak starts over, which
// the payload states (`peakTrackedSince`) so the dashboard never presents a
// post-deploy zero as "nobody called today". "Today" is the operator's day,
// America/Sao_Paulo, not UTC.

let peakRoomSizeToday = 0;
let peakDay = "";
let peakTrackedSince = new Date().toISOString();

const SAO_PAULO_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function rollPeakDay(): void {
  const today = SAO_PAULO_DAY.format(new Date());
  if (today !== peakDay) {
    peakDay = today;
    peakRoomSizeToday = 0;
    peakTrackedSince = new Date().toISOString();
  }
}

function noteRoomSizeForPeak(size: number): void {
  rollPeakDay();
  if (size > peakRoomSizeToday) {
    peakRoomSizeToday = size;
  }
}

export interface VoiceActivitySnapshot {
  /** Rooms with at least one peer right now (server channels and DM calls alike). */
  activeRooms: number;
  /** Peers across every room right now. */
  participants: number;
  largestRoomNow: number;
  /** Largest room seen since `peakTrackedSince`. */
  peakRoomSizeToday: number;
  /** ISO. Process start or the last São Paulo midnight, whichever is later. */
  peakTrackedSince: string;
  /** The transport the deployment can run. Small rooms may still open on mesh (voice/transport-policy.ts). */
  backend: VoiceRoomTransport;
  /**
   * Voice frames over the cluster bus since boot, this instance: published
   * for sockets held elsewhere, and received from the bus for sockets held
   * here. Zero and zero on one machine. See `clusterFrames`.
   */
  cluster: {
    framesRelayed: number;
    framesReceived: number;
  };
  /**
   * What the roster fan-out is actually doing, since boot.
   *
   * `deltas` versus `snapshots` says whether rooms are being described
   * incrementally or whole; `socketsOnDeltas` out of `sockets` says whether
   * clients are asking for it at all. Both are needed: a deploy where every
   * frame is a snapshot because no client negotiated the capability is a
   * silent no-op, and it is indistinguishable from a healthy one without the
   * denominator.
   */
  roster: {
    deltas: number;
    snapshots: number;
    /**
     * How many of `snapshots` went to somebody who is NOT in the call.
     *
     * The one number that says whether the remaining whole-roster cost belongs
     * to the room or to the sidebar, which is the difference between "make the
     * roster smaller" and "stop sending the roster to the audience" as the
     * next thing to do. Measured rather than assumed, because the ratio
     * depends entirely on how big the server is around the call.
     */
    audienceSnapshots: number;
    sockets: number;
    socketsOnDeltas: number;
  };
  /** The channel-level live HLS path (`channel-live` / `watch-live`). */
  liveHls: {
    /** `channel-live` frames written since boot, per socket. */
    audienceFrames: number;
    /** Watch-mode viewers without a seat, every channel, right now. */
    watching: number;
    /** Channels with a live stream this instance last announced. */
    liveChannels: number;
  };
  /**
   * One entry per room that has somebody in it, largest first.
   *
   * Channel *ids* only. Resolving them to a channel and server name is the
   * caller's job (services/metrics.ts does it against the database), because
   * this module holds sockets, not rows, and a name it cached here would go
   * stale the moment somebody renamed the channel mid-call.
   */
  rooms: {
    voiceChannelId: string;
    participants: number;
    /** Peers in this room with a screen capture live right now. */
    sharingScreen: number;
  }[];
}

function localRoomOccupancy(): VoiceActivitySnapshot["rooms"] {
  const sizes = new Map<string, { participants: number; sharingScreen: number }>();
  for (const peer of peers.values()) {
    let room = sizes.get(peer.voiceChannelId);
    if (!room) {
      room = { participants: 0, sharingScreen: 0 };
      sizes.set(peer.voiceChannelId, room);
    }
    room.participants += 1;
    if (peer.sharingScreen) {
      room.sharingScreen += 1;
    }
  }
  return [...sizes.entries()]
    .map(([voiceChannelId, room]) => ({ voiceChannelId, ...room }))
    .sort((a, b) => b.participants - a.participants);
}

/**
 * Async only for the registry: with it on, rooms and participants come from
 * `voice_peers`, so the operator dashboard counts the whole cluster rather
 * than the instance that happened to serve the request. The peak stays
 * per-process, as the payload states. A failed read falls back to the map.
 */
export async function getVoiceActivitySnapshot(): Promise<VoiceActivitySnapshot> {
  rollPeakDay();
  const rosterSocketCensus = countAuthenticatedSockets(
    SOCKET_CAPS.voiceRosterDelta,
  );
  let rooms = localRoomOccupancy();
  if (registryOn()) {
    try {
      rooms = await listVoiceRoomOccupancy();
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "occupancy",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let largestRoomNow = 0;
  let participants = 0;
  for (const room of rooms) {
    participants += room.participants;
    if (room.participants > largestRoomNow) {
      largestRoomNow = room.participants;
    }
  }
  return {
    activeRooms: rooms.length,
    participants,
    largestRoomNow,
    peakRoomSizeToday: Math.max(peakRoomSizeToday, largestRoomNow),
    peakTrackedSince,
    backend: configuredTransport(),
    cluster: {
      framesRelayed: clusterFrames.relayed,
      framesReceived: clusterFrames.received,
    },
    roster: {
      deltas: rosterFramesSent.deltas,
      snapshots: rosterFramesSent.snapshots,
      audienceSnapshots: rosterFramesSent.audienceSnapshots,
      sockets: rosterSocketCensus.sockets,
      socketsOnDeltas: rosterSocketCensus.withCap,
    },
    liveHls: {
      audienceFrames: hlsAudienceFramesSent.frames,
      watching: hlsAudience
        .liveChannels()
        .reduce((sum, id) => sum + hlsAudience.count(id), 0),
      liveChannels: hlsAudience.liveChannels().length,
    },
    rooms,
  };
}

function toParticipant(peer: VoicePeer): VoiceParticipant {
  return {
    peerId: peer.id,
    userId: peer.userId,
    displayName: peer.displayName,
    avatarUrl: peer.avatarUrl,
    sharingScreen: peer.sharingScreen,
    cameraStreamId: peer.cameraStreamId,
    screenAudioStreamId: peer.screenAudioStreamId,
    muted: peer.muted,
    deafened: peer.deafened,
    canSpeak: peer.canSpeak,
    serverMuted: isVoiceUserServerMuted(peer.voiceChannelId, peer.userId),
    canStream: peer.canStream,
  };
}

function send(socket: WebSocket, message: VoiceSignalingMessage) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToRoom(
  voiceChannelId: string,
  message: VoiceSignalingMessage,
  excludePeerId?: string,
) {
  const encoded = encodeFrame(message);
  for (const peer of getRoomPeers(voiceChannelId)) {
    if (peer.id !== excludePeerId) {
      sendEncoded(peer.socket, encoded);
    }
  }
}

/**
 * The server a voice channel belongs to, for the egress allowlist. The
 * audience cache already holds it for every channel with a roster, so this
 * is a map read on the hot path; the row is only fetched when the cache has
 * nothing (a channel deleted mid-share), and never at all for a stop.
 */
async function hlsServerIdFor(voiceChannelId: string): Promise<string | null> {
  const audience = await getChannelAudience(voiceChannelId).catch(() => null);
  if (audience) {
    return audience.serverId;
  }
  const channel = await getChannel(voiceChannelId).catch(() => null);
  return channel?.kind === "server" ? (channel.server_id ?? null) : null;
}

/**
 * First sharer in the room gets a Track Composite HLS egress. Nobody
 * sharing stops it. Failures stay in the log: a missed transcode must
 * not refuse the share itself.
 *
 * The sharer is read through `pickHlsSharer`, so only a peer that holds the
 * stage bit (`canStream`, which in a watch party is START_WATCH_PARTY) can
 * feed the egress. `set-sharing-screen` refuses the claim without it and
 * `reevaluateVoiceSpeak` clears the share when it is revoked; this is the
 * same gate read at the one place a transcode actually starts.
 */
async function pushLiveHls(voiceChannelId: string): Promise<void> {
  if (getRoomTransport(voiceChannelId) !== "livekit") {
    return;
  }
  const sharer = pickHlsSharer(getRoomPeers(voiceChannelId));
  const prev = liveHlsStreamFor(voiceChannelId);
  try {
    const serverId = sharer ? await hlsServerIdFor(voiceChannelId) : null;
    const next = await reconcileLiveHls(
      voiceChannelId,
      sharer?.id ?? null,
      serverId,
    );
    const changed =
      (prev?.hlsUrl ?? null) !== (next?.hlsUrl ?? null) ||
      (prev?.presenterPeerId ?? null) !== (next?.presenterPeerId ?? null);
    if (!changed) {
      return;
    }
    // Per peer rather than `broadcastToRoom`: the playlist URL carries a
    // token bound to the recipient, so there is no one frame for the room.
    for (const peer of getRoomPeers(voiceChannelId)) {
      send(peer.socket, {
        type: "voice-stream",
        channelId: voiceChannelId,
        stream: next ? stampViewerStream(next, peer.userId) : null,
      });
    }
    hlsAudience.setStream(voiceChannelId, next);
    await broadcastChannelLive(voiceChannelId);
  } catch (error) {
    logEvent("voice.hlsReconcileFailed", {
      channelId: voiceChannelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// The egress monitor (`hls-egress.ts`) found a dead egress, or gave up on
// one: reconcile again so a still-live share gets a fresh session and every
// viewer gets the new URL (or `null` after the cap).
setLiveHlsChangeListener((channelId, reason) => {
  logEvent("voice.hlsChangeHeard", { channelId, reason });
  void pushLiveHls(channelId);
});

// The HLS ladder and the promotion guard price the same media box. This is
// what lets a rung be refused because of the cameras already on it, rather
// than each side spending the box independently.
setLiveHlsSfuLoadReader(async () =>
  estimateSfuLoadMbps(await readRoomLoads()),
);

function channelLiveFrame(
  channelId: string,
  userId: string,
): VoiceSignalingMessage {
  const stream = liveHlsStreamFor(channelId);
  return {
    type: "channel-live",
    channelId,
    stream: stream ? stampViewerStream(stream, userId) : null,
    watching: hlsAudience.count(channelId),
  };
}

/**
 * The stream and the count to every authenticated socket of every user who
 * may view the channel. Encoded per socket: the token in `hlsUrl` names the
 * recipient. A socket in the room gets it too, so a tab that is both in the
 * call and drawing the sidebar needs no second source for the pill.
 */
async function broadcastChannelLive(channelId: string): Promise<void> {
  const audience = await getChannelAudience(channelId).catch(
    (error: unknown) => {
      console.error("[voice] failed to load audience for channel-live:", error);
      return null;
    },
  );
  if (!audience) {
    return;
  }
  forEachAuthenticatedSocket((socket, user) => {
    if (!audience.has(user.id)) {
      return;
    }
    send(socket, channelLiveFrame(channelId, user.id));
    hlsAudienceFramesSent.frames += 1;
  });
}

/**
 * What `GET /api/channels/:channelId/live` answers: the unstamped stream (the
 * route stamps it for the caller), watchers without a seat, and seats. For a
 * client that opened the channel before its socket was up.
 */
export function getChannelLiveState(channelId: string): {
  stream: LiveHlsStream | null;
  watching: number;
  participants: number;
} {
  return {
    stream: liveHlsStreamFor(channelId),
    watching: hlsAudience.count(channelId),
    participants: getRoomPeers(channelId).length,
  };
}

/** Test hook: forget every watcher and stream, stop every keyframe clock. */
export function resetHlsAudience(): void {
  hlsAudience.reset();
}

/**
 * What changed in the room. Two jobs, and they line up exactly:
 *
 *  - it rides the roster's bus hint, so another instance can forward the
 *    matching `peer-*` frame to its local room before it rebuilds its roster;
 *  - with the registry OFF it IS the roster delta (`voice-roster-delta`) for
 *    every socket that negotiated one, which is what stops a 130-person room
 *    from sending 130 participants to every member of a 508-member community
 *    twice a second. With the registry on the delta is a diff of the rows
 *    against what this process last sent (`diffSentRoster`), because a
 *    change made on another instance never enters this queue.
 *
 * `roster` is the escape hatch: "something changed and this queue cannot say
 * what". A window that contains one degrades to a full snapshot for everybody,
 * which is always correct and never silently wrong. Every other kind is an
 * ABSOLUTE statement about one peer (present with this state, or absent), and
 * that is what makes applying a delta twice the same as applying it once —
 * the property the client's convergence rule leans on.
 */
type VoiceRoomEvent =
  | { kind: "joined"; peer: VoiceParticipant }
  | { kind: "left"; peerId: string }
  | { kind: "updated"; peer: VoiceParticipant }
  | { kind: "roster" };

/**
 * Events waiting for the coalesced roster run of their channel. Published
 * after that run, so a hint never reaches the other instance before the row
 * write it will re-read has settled, and never before the local roster that
 * reported it. Consecutive `roster` hints fold into one: the other side
 * rebuilds from rows either way.
 */
const pendingRoomEvents = new Map<string, VoiceRoomEvent[]>();

/**
 * Where each room is in its roster sequence: the number carried by the last
 * frame this process sent about it, full or delta alike.
 *
 * Deleted the moment a room is announced empty, so the next occupied room in
 * that channel starts again at 1. That is not tidiness: a client holds 0 for a
 * channel it has never heard about, so restarting at 1 is what lets the first
 * delta of a new call be applied by somebody who was not watching the last
 * one, with no extra round trip and no special case in the rule.
 */
const rosterSeq = new Map<string, number>();

/** When this process last sent a channel's whole roster to the people in it. */
const lastRosterKeyframeAt = new Map<string, number>();

/**
 * When it last sent one to the people merely watching the channel.
 *
 * A separate clock rather than a divisor on the first, because the two move
 * independently: a window that cannot be described incrementally is a snapshot
 * for everybody and resets both, and after that each falls due on its own
 * interval. Sharing one clock would either drag the room down to the
 * audience's rate or drag the audience up to the room's, and the entire point
 * is that they are not the same promise.
 */
const lastAudienceKeyframeAt = new Map<string, number>();

/**
 * With the registry on: the participants this process last DESCRIBED for
 * each channel, by peer id, whichever frame carried them (whole or delta).
 * The next roster run diffs the freshly read rows against this and sends
 * `joined` / `updated` / `left`, which is how a change made on the OTHER
 * instance becomes a delta here: it is in the rows and not in this entry.
 *
 * It is exactly "what the receivers hold", not "what the room is": a run
 * that writes nothing (no audience) leaves it alone, and a run that wrote a
 * snapshot replaces it with that snapshot. The coalescer serialises runs per
 * channel and the read-diff-replace happens in one synchronous stretch, so
 * two runs cannot diff against the same base.
 *
 * Absent means "send the whole roster": the first frame of a room, the run
 * after a registry read failed (the fallback is this instance's own peers,
 * a picture the diff must not be built on or half the room reads as `left`),
 * a process restart, and a channel forgotten through `forgetSentRoster`.
 * Dropped when the room is announced empty, so it is bounded by the rooms
 * this process is currently describing. Never written with the registry
 * off, where the event queue is the delta and this map stays empty.
 */
const sentRosters = new Map<string, Map<string, VoiceParticipant>>();

/**
 * How long a room may be described only by deltas before its whole roster
 * goes out again.
 *
 * THIS IS THE CONVERGENCE GUARANTEE, and it is deliberately the server's job
 * rather than the client's. A client that detects a gap could ask for a
 * resync, but then a wrong or hostile client decides when the server does
 * expensive work, and the interesting failure — a socket that entered the
 * audience mid-call and never had a baseline at all — is one the client cannot
 * even detect as a gap, because it has nothing to compare against.
 *
 * A periodic snapshot answers every case with one mechanism: whatever went
 * wrong, and whether or not anyone noticed, the next keyframe replaces the
 * receiver's state wholesale. So the worst staleness any roster bug can
 * produce is bounded by this constant, by construction.
 *
 * Ten seconds is picked against the thing it costs. A 130-person roster to 200
 * sockets is ~9 MB; at the old rate (twice a second above 100 people) that was
 * ~18 MB/s, and once every ten seconds it is 0.9 MB/s, while the deltas
 * carrying the actual news are three orders of magnitude smaller. Halving it
 * would double the only remaining cost to buy staleness nobody can perceive in
 * a badge.
 */
export const ROSTER_KEYFRAME_MS = 10_000;

/**
 * The same guarantee, for people who are NOT in the call.
 *
 * A roster goes to everyone who can *see* the channel, because occupancy is
 * drawn in the sidebar for people standing outside it. That audience is
 * frequently several times the size of the room, so it is the audience — not
 * the room — that most of the keyframe cost belongs to: measured at 800
 * sockets with 600 in one call, whole-roster snapshots were 384.6 MB of the
 * 922.2 MB this server wrote, and every socket paid the same 160 KB every ten
 * seconds whether it was in the call or looking at a badge.
 *
 * The two are not owed the same thing, and that is the whole of this split:
 *
 *  - A PARTICIPANT's roster is a trust boundary. It rebuilds `knownPeerIds`,
 *    the allowlist that decides whose offer may open a microphone, and it is
 *    what prunes a dead peer connection. Ten seconds is how long a signalling
 *    bug may last, and it stays ten seconds.
 *  - The AUDIENCE's roster is a badge. The worst a stale one produces is a
 *    mic-off icon that is a few seconds out of date next to a channel nobody
 *    in this browser is in.
 *
 * Thirty seconds rather than a minute, deliberately. The saving is a ratio, so
 * most of it is already had at 3x and doubling again buys little; what doubles
 * linearly is the one case a keyframe is the only answer to — a socket that
 * gained audience membership mid-session and holds no baseline at all, which
 * cannot detect its own gap and so cannot ask. Thirty seconds keeps that
 * inside "you would notice it fix itself"; sixty does not.
 *
 * Neither clock is the delta rate. Both audiences keep receiving every change
 * as it happens; this only governs how often the whole list is restated.
 */
export const ROSTER_AUDIENCE_KEYFRAME_MS = 30_000;

/**
 * Roster frames written since boot, split by which kind.
 *
 * Counted per SOCKET, not per fan-out round, because the whole change is about
 * what each socket is made to read. Read by `GET /api/admin/metrics` and
 * nothing else, and process-local like every other counter in this file.
 *
 * The ratio is the only thing that says the optimisation is actually running
 * in production rather than merely deployed. A wire feature no client asks for
 * looks identical to a working one from the server's side, which is exactly
 * how Cloudflare TURN sat unused for weeks (CLAUDE.md pitfall 9), so the
 * denominator ships with the numerator.
 */
const rosterFramesSent = { deltas: 0, snapshots: 0, audienceSnapshots: 0 };

/**
 * `channel-live` frames written since boot, per socket. The number that says
 * the channel-level path is carrying the watch party rather than the roster:
 * a viewer outside the room costs one of these every keyframe instead of one
 * roster per change.
 */
const hlsAudienceFramesSent = { frames: 0 };

/**
 * Watch mode without a seat. `voice-stream` only reaches the room, so until
 * this path a viewer learned a stream was live by joining, and the sidebar
 * pill saw nothing but the roster. `channel-live` goes to everyone who may
 * view the channel (the same audience as the roster), when the stream
 * changes and on the audience keyframe cadence while it is live or watched.
 * Never per subscribe: see `createHlsAudience`.
 */
const hlsAudience = createHlsAudience({
  keyframeMs: ROSTER_AUDIENCE_KEYFRAME_MS,
  broadcast: (channelId) => {
    void broadcastChannelLive(channelId);
  },
});

/**
 * What the cluster bus is carrying for voice, since boot, on this instance.
 *
 * `relayed` is every voice frame this instance published for sockets held
 * elsewhere (room hints, a mesh offer for a peer on the other machine, a
 * ring, a moderation notice, a mute). `received` is every voice frame from
 * the bus this instance applied to a socket it holds. Both zero on one
 * machine, both non-zero within a minute of two machines sharing a room; a
 * flip where they stay at zero is a bus that is not delivering, which is
 * what the 2026-09-07 window could only tell from the logs.
 */
const clusterFrames = { relayed: 0, received: 0 };

function publishVoice(topic: string, frame: unknown): void {
  clusterFrames.relayed += 1;
  publishToCluster(topic, frame);
}

/** A frame from the bus reached a socket this instance holds. */
function noteClusterFrameReceived(): void {
  clusterFrames.received += 1;
}

/**
 * Whether this socket is IN the call it is about to be told about, as opposed
 * to merely allowed to see the channel.
 *
 * Read from the socket rather than from the user, because the same account can
 * hold a tab in the call and a phone looking at the sidebar, and the whole
 * split below is about giving each what it is actually owed. `socketToPeerId`
 * is the process's own map, so this is two hash lookups on a path that already
 * walks every socket.
 *
 * An orphaned peer (a refresh mid-call, holding its seat for 90s) still counts
 * as in the room: its socket is gone, so it receives nothing either way, and
 * the socket that resumes it re-enters through the join path.
 */
function socketIsInRoom(socket: WebSocket, voiceChannelId: string): boolean {
  const peerId = socketToPeerId.get(socket);
  if (peerId === undefined) {
    return false;
  }
  return peers.get(peerId)?.voiceChannelId === voiceChannelId;
}

/** Test seam: forget every sequence, keyframe clock and described roster. */
export function resetRosterSequences(): void {
  rosterSeq.clear();
  lastRosterKeyframeAt.clear();
  lastAudienceKeyframeAt.clear();
  sentRosters.clear();
  rosterFramesSent.deltas = 0;
  rosterFramesSent.snapshots = 0;
  rosterFramesSent.audienceSnapshots = 0;
  hlsAudienceFramesSent.frames = 0;
  clusterFrames.relayed = 0;
  clusterFrames.received = 0;
}

/** The sequence a socket should adopt from a full roster of this channel. */
function currentRosterSeq(voiceChannelId: string): number {
  return rosterSeq.get(voiceChannelId) ?? 0;
}

/** The three lists a `voice-roster-delta` carries, before the empty ones are omitted. */
interface RosterDelta {
  joined: VoiceParticipant[];
  updated: VoiceParticipant[];
  left: string[];
}

/**
 * Fold a window's events into the three lists the wire carries, or null when
 * the window cannot be described incrementally.
 *
 * Null for three reasons, each of which falls back to a whole roster:
 *
 *  - a `roster` event is present, which is the caller saying "something
 *    changed and I cannot name the peer";
 *  - the window is empty, which no local request produces (each queues an
 *    event) and is answered with a whole roster rather than an assumption;
 *  - nothing at all changed, in which case there is nothing to send either
 *    way and the caller decides.
 *
 * Registry off only. With the rows as the truth the delta is `diffSentRoster`.
 */
function foldRoomEvents(events: readonly VoiceRoomEvent[]): RosterDelta | null {
  if (events.length === 0 || events.some((event) => event.kind === "roster")) {
    return null;
  }
  const joined: VoiceParticipant[] = [];
  const updated: VoiceParticipant[] = [];
  const left: string[] = [];
  for (const event of events) {
    if (event.kind === "joined") {
      joined.push(event.peer);
    } else if (event.kind === "updated") {
      updated.push(event.peer);
    } else if (event.kind === "left") {
      left.push(event.peerId);
    }
  }
  return { joined, updated, left };
}

/**
 * Whether two projections of the same peer would draw the same tile.
 *
 * Every field of a participant is a primitive (strings, booleans, null), so
 * a shallow compare over the union of keys is exact, and a field added to
 * `voiceParticipantSchema` later is compared without anyone remembering to
 * list it here. Absent and `undefined` read as equal, which is what the wire
 * does with them too.
 */
function sameParticipant(a: VoiceParticipant, b: VoiceParticipant): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

/**
 * The registry's delta: what changed between the roster this process last
 * sent for the channel and the rows it has just read, and, in the same
 * synchronous step, the replacement of that memory with what is about to go
 * out. Null when there is nothing to diff against, which is a whole roster.
 *
 * `rowsRead` false means the read failed and `participants` is this
 * instance's own peers: sent whole, exactly as before, and the memory is
 * dropped so the next successful read is also sent whole. An empty room
 * drops it too, so a channel costs nothing once its call is over.
 *
 * The lists are ABSOLUTE statements about one peer each, the same contract
 * `foldRoomEvents` produces, so a receiver cannot tell which path built its
 * frame. A peer whose row and local copy disagree only in a field the tile
 * does not draw still lands in `updated`; that is a few bytes, and it is the
 * price of never having to name here which fields matter.
 */
function diffSentRoster(
  voiceChannelId: string,
  participants: readonly VoiceParticipant[],
  rowsRead: boolean,
): RosterDelta | null {
  const previous = rowsRead ? sentRosters.get(voiceChannelId) : undefined;
  const current = new Map(participants.map((peer) => [peer.peerId, peer]));
  if (current.size === 0 || !rowsRead) {
    sentRosters.delete(voiceChannelId);
  } else {
    sentRosters.set(voiceChannelId, current);
  }
  if (!previous) {
    return null;
  }
  const joined: VoiceParticipant[] = [];
  const updated: VoiceParticipant[] = [];
  const left: string[] = [];
  for (const peer of current.values()) {
    const before = previous.get(peer.peerId);
    if (!before) {
      joined.push(peer);
    } else if (!sameParticipant(before, peer)) {
      updated.push(peer);
    }
  }
  for (const peerId of previous.keys()) {
    if (!current.has(peerId)) {
      left.push(peerId);
    }
  }
  return { joined, updated, left };
}

/**
 * Forget what this process last sent for a channel, so its next roster is a
 * whole one. Called when a channel is deleted or made private (the room is
 * being emptied under it and a later frame for it may never be written), and
 * a test seam for "the process lost its memory mid-call".
 */
export function forgetSentRoster(voiceChannelId: string): void {
  sentRosters.delete(voiceChannelId);
}

/**
 * Roster fan-out. Occupancy drives the channel-list badges, so it goes to
 * everyone who can *see* the channel — sending it to every socket on the
 * instance would leak cross-server presence and, worse, hand out the peer IDs
 * used for signaling.
 *
 * Coalesced per channel (`coalesceWindowFor`) and serialized per channel: the
 * audience lookup is async, and two overlapping broadcasts could otherwise
 * deliver an older snapshot last, leaving a departed peer visible in
 * everyone's sidebar. The coalescer guarantees both.
 *
 * WHAT GOES OUT. #260 bounded how OFTEN this fires; it left the frame the size
 * of the room, and size times audience is the product that broke on
 * 2026-09-05. So a socket that negotiated `voice-roster-delta` gets only what
 * changed, and every other socket keeps receiving exactly the frame it has
 * always received. Both carry the same sequence number, so a client can move
 * between them (a keyframe interrupts a delta stream) without a handshake.
 *
 * ORDERING. The room snapshot and the event queue are read in one synchronous
 * stretch with no await between them, which is what makes `size` describe
 * exactly the events in the same frame. Reading the room after the audience
 * await (as this did before deltas) would let a join land in the snapshot
 * while its event was still queued for the next window, and every receiver
 * would then compute a size one short and declare itself out of sync.
 * Ordering is not lost by moving the read earlier: a change that lands during
 * the await queues its own request, which the coalescer serialises behind this
 * one.
 *
 * The snapshot is encoded once as a Buffer and sent droppable: a whole roster
 * is superseded by the next one, and a socket holding a megabyte of unsent
 * frames is better served by the next snapshot than by a late copy of this
 * one. A DELTA IS NOT DROPPABLE, and that is the one asymmetry here worth
 * stating: deltas compose rather than supersede, so dropping one silently
 * corrupts every later one. It is safe to insist on sending them because they
 * are small by construction (what changed in one window), and because a socket
 * far enough behind to worry about is reaped by the heartbeat inside a minute,
 * during which the deltas it accumulates are a rounding error against the
 * megabyte it is already holding.
 *
 * With the registry on, the snapshot comes from `voice_peers` (this
 * instance's own peers laid over by id), read after this instance's pending
 * row writes have settled so the roster cannot run ahead of the write it
 * reports. There the ROWS are the truth and the local event queue is only
 * half the story (a join on the other machine never enters it), so the delta
 * is not the queue folded but the rows DIFFED against what this process last
 * sent (`diffSentRoster`). Until 2026-09-07 this path sent no deltas at all,
 * and since production runs with the registry on, `voice.roster.deltas` read
 * 0 there while every test of the delta path was green: the two paths must
 * be measured separately. Never awaited with the flag off: no writes exist.
 */
async function sendRoster(voiceChannelId: string): Promise<void> {
  let events: VoiceRoomEvent[] = [];
  {
    let room: {
      participants: VoiceParticipant[];
      transport: VoiceRoomTransport;
    } | null = null;
    // Whether the rows were consulted at all. A failed read falls back to
    // this instance's own peers below, and that picture must be sent whole.
    let rowsRead = false;
    if (registryOn()) {
      await settledRowWrites(voiceChannelId);
      try {
        room = await readClusterRoom(voiceChannelId);
        rowsRead = true;
      } catch (error) {
        logEvent("voice.registryReadFailed", {
          op: "roster",
          error: error instanceof Error ? error.message : String(error),
        });
        room = null;
      }
    }

    // Caught here rather than around the whole body: everything below this
    // line is synchronous and cannot throw, so the queue is never drained by
    // a run that then fails to describe it, and the bus hint at the end is
    // reached on every path.
    const audience = await getChannelAudience(voiceChannelId).catch(
      (error: unknown) => {
        console.error("[voice] failed to load audience for roster:", error);
        return null;
      },
    );

    // --- one synchronous stretch: snapshot, queue, sequence ---------------
    const participants =
      room?.participants ?? getRoomPeers(voiceChannelId).map(toParticipant);
    events = pendingRoomEvents.get(voiceChannelId) ?? [];
    pendingRoomEvents.delete(voiceChannelId);
    const transport = room?.transport ?? getRoomTransport(voiceChannelId);

    // Whether this window CAN be described incrementally at all, decided
    // before and independently of who is owed a keyframe. It used to be the
    // same question; splitting the clocks makes it two, because the room may
    // be due a snapshot while the audience is still happily patching, and
    // then the delta is still needed.
    //
    // Two sources, one shape. With the registry off the delta is this
    // process's own event queue; with it on, the rows diffed against what
    // this process last sent. The diff also REPLACES that memory, which is
    // why it runs only when there is an audience to send to: a run that
    // writes nothing must leave "what the receivers hold" untouched. With
    // no audience the memory is dropped instead, so a channel deleted while
    // its room emptied on another machine does not keep its last roster
    // here forever; the cost is one whole roster if the lookup merely blipped.
    let delta: RosterDelta | null = null;
    if (!audience) {
      sentRosters.delete(voiceChannelId);
    } else if (registryOn()) {
      delta = diffSentRoster(voiceChannelId, participants, rowsRead);
    } else {
      delta = foldRoomEvents(events);
    }
    // Registry only, by construction: a folded queue is never empty-handed.
    // A diff that is means the rows say what the last frame said (a bus hint
    // about a change this process had already read and sent), and there is
    // nothing to write: no frame, no sequence number, no keyframe clock. The
    // sockets are exactly as caught up as they were.
    const unchanged =
      delta !== null &&
      delta.joined.length === 0 &&
      delta.updated.length === 0 &&
      delta.left.length === 0;

    if (audience && !unchanged) {
      // The sequence and the keyframe clock only move when something is
      // actually written. A channel whose audience could not be read (it was
      // deleted, or the query failed) must not silently burn a number that
      // every receiver would then be missing.
      const seq = currentRosterSeq(voiceChannelId) + 1;
      if (participants.length === 0) {
        rosterSeq.delete(voiceChannelId);
      } else {
        rosterSeq.set(voiceChannelId, seq);
      }
      const now = Date.now();
      const roomSnapshot =
        !delta ||
        now - (lastRosterKeyframeAt.get(voiceChannelId) ?? 0) >=
          ROSTER_KEYFRAME_MS;
      const audienceSnapshot =
        !delta ||
        now - (lastAudienceKeyframeAt.get(voiceChannelId) ?? 0) >=
          ROSTER_AUDIENCE_KEYFRAME_MS;
      if (roomSnapshot) {
        lastRosterKeyframeAt.set(voiceChannelId, now);
      }
      if (audienceSnapshot) {
        lastAudienceKeyframeAt.set(voiceChannelId, now);
      }
      // --- end synchronous stretch -----------------------------------------

      let snapshot: Buffer | null = null;
      const fullFrame = () => {
        snapshot ??= encodeFrame({
          type: "voice-roster",
          voiceChannelId,
          participants,
          transport,
          seq,
        } satisfies VoiceSignalingMessage);
        return snapshot;
      };
      const deltaFrame = delta
        ? encodeFrame({
            type: "voice-roster-delta",
            voiceChannelId,
            seq,
            size: participants.length,
            transport,
            ...(delta.joined.length > 0 ? { joined: delta.joined } : {}),
            ...(delta.updated.length > 0 ? { updated: delta.updated } : {}),
            ...(delta.left.length > 0 ? { left: delta.left } : {}),
          } satisfies VoiceSignalingMessage)
        : null;

      forEachAuthenticatedSocket((socket, user, caps) => {
        if (!audience.has(user.id)) {
          return;
        }
        // Which promise this socket is owed, decided per socket because the
        // same account can hold a tab in the call and a phone looking at the
        // sidebar, and they are not owed the same thing.
        const inRoom = socketIsInRoom(socket, voiceChannelId);
        const owedSnapshot = inRoom ? roomSnapshot : audienceSnapshot;
        if (deltaFrame && !owedSnapshot && caps.has(SOCKET_CAPS.voiceRosterDelta)) {
          sendEncoded(socket, deltaFrame);
          rosterFramesSent.deltas += 1;
          return;
        }
        if (sendEncodedDroppable(socket, fullFrame())) {
          rosterFramesSent.snapshots += 1;
          if (!inRoom) {
            rosterFramesSent.audienceSnapshots += 1;
          }
        }
      });
    }
  }
  // After the local pass, whatever the audience lookup did: a `left` that
  // never crossed is the ghost the banner warns about.
  if (events.length > 0 && clusterOn()) {
    for (const event of events) {
      publishVoice(VOICE_ROOM_TOPIC, {
        channelId: voiceChannelId,
        ...event,
      } satisfies VoiceRoomFrame);
    }
  }
}

/**
 * A 100-person room where people toggle mute, join and leave produces dozens
 * of roster requests a second, each a frame of the whole room to every member
 * of the server. The window grows with the room (`coalesceWindowFor`), so a
 * two-person call is instant and a big room is bounded.
 */
const rosterCoalescer = createCoalescer<string>(
  (voiceChannelId) => coalesceWindowFor(getRoomPeers(voiceChannelId).length),
  sendRoster,
);

/**
 * `event` is what to tell the cluster; `null` is the local half alone, which
 * is what a frame arriving from the bus runs, and it must never publish, or
 * two instances would rebuild each other's rosters forever.
 */
function broadcastRoster(
  voiceChannelId: string,
  event: VoiceRoomEvent | null = { kind: "roster" },
): Promise<void> {
  if (event) {
    const queue = pendingRoomEvents.get(voiceChannelId) ?? [];
    const last = queue[queue.length - 1];
    if (!(event.kind === "roster" && last?.kind === "roster")) {
      pushRoomEvent(queue, event);
    }
    pendingRoomEvents.set(voiceChannelId, queue);
  }
  return rosterCoalescer.request(voiceChannelId);
}

/**
 * Append an event, collapsing repeats about the same peer.
 *
 * Somebody who mutes and unmutes twice inside one coalescing window is one
 * line on the wire, not four, and the one that survives is the newest — which
 * matters beyond bytes, because the bus republishes this same queue and a
 * stale duplicate crossing to another instance would be a tile flickering back
 * to a state nobody is in.
 *
 * The scan runs backwards and stops at the first entry about this peer,
 * because `left` is the one kind that must not be collapsed into: a peer that
 * left and rejoined inside one window is genuinely two operations, and merging
 * the second into the first would put the departure last and lose them.
 */
function pushRoomEvent(queue: VoiceRoomEvent[], event: VoiceRoomEvent): void {
  const peerId =
    event.kind === "left"
      ? event.peerId
      : event.kind === "roster"
        ? null
        : event.peer.peerId;
  if (peerId !== null) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const held = queue[i]!;
      if (held.kind === "roster") {
        continue;
      }
      const heldPeerId = held.kind === "left" ? held.peerId : held.peer.peerId;
      if (heldPeerId !== peerId) {
        continue;
      }
      // `joined` and `updated` are the same operation on the wire (replace by
      // id), so a newer one may take the older one's place and keep its
      // position — including keeping a `joined` a `joined`, so the receiver
      // still plays the arrival cue exactly once.
      if (
        held.kind !== "left" &&
        (event.kind === "joined" || event.kind === "updated")
      ) {
        held.peer = event.peer;
        return;
      }
      break;
    }
  }
  queue.push(event);
}

function relayToTarget(message: VoiceSignalingMessage & { to: string }) {
  const target = peers.get(message.to);
  if (target) {
    send(target.socket, message);
  }
}

function removePeer(peerId: string) {
  const peer = peers.get(peerId);
  if (!peer) {
    return;
  }
  cancelOrphan(peer);
  const { voiceChannelId } = peer;
  peers.delete(peerId);
  if (socketToPeerId.get(peer.socket) === peerId) {
    socketToPeerId.delete(peer.socket);
  }
  // Empty room (no orphans either): forget the pin, so the next call in this
  // channel picks up the current config instead of a decision taken before
  // LiveKit was added, removed or fixed. Nobody is mid-call, so nobody's audio
  // moves. Orphans keep the pin so a resume cannot flip transport.
  if (getRoomPeers(voiceChannelId).length === 0) {
    roomTransports.delete(voiceChannelId);
    forgetTransportDecision(voiceChannelId);
    // Same lifetime for the moderator mutes: a sanction on a call that is
    // over must not be waiting for the next call in this channel.
    roomServerMutes.delete(voiceChannelId);
  }
  if (registryOn()) {
    // One statement: the row goes, and the room row with it if this was the
    // last peer anywhere in the cluster (not only on this instance). Then the
    // party, for the one race that can leave a room row behind.
    trackRowWrite(
      voiceChannelId,
      deleteVoicePeer(peerId).then(() => clearWatchPartyIfEmpty(voiceChannelId)),
    );
  }
  retirePeerId(peerId, voiceChannelId);
  onLiveRoomMaybeEmpty(voiceChannelId, peer.socket);
  logEvent("voice.leave", {
    peerId,
    userId: peer.userId,
    voiceChannelId,
    roomSize: getLiveRoomPeers(voiceChannelId).length,
  });
  broadcastToRoom(voiceChannelId, { type: "peer-left", peerId });
  void broadcastRoster(voiceChannelId, { kind: "left", peerId });
  void pushLiveHls(voiceChannelId);
}

/**
 * EVERY EVICTION BELOW HAS TWO HALVES, AND BOTH ARE MANDATORY.
 *
 * The mesh half drops the peer from `peers`, which makes the other clients tear
 * down their RTCPeerConnections to it. That is the whole story only while media
 * is peer-to-peer. With LiveKit configured the audio never passes through this
 * process, so the mesh half is a no-op on the actual call: the evicted account
 * stays in the SFU room and keeps talking. `voice/admin.ts` is the other half.
 *
 * The SFU half is fired unconditionally — not "if we found local peers". A
 * LiveKit call legitimately spans instances (see the note above `peers`), and a
 * client that lost its WebSocket keeps its LiveKit connection, so an empty
 * local roster is not evidence that the room is empty. It is also
 * fire-and-forget and cannot reject, because these helpers run *after* the
 * moderation action has already been committed: an SFU outage must not unwind
 * a ban. See `voice/admin.ts` for the failure-mode contract.
 */

/** Drop every peer of a channel — used when a channel is deleted or made private. */
export function evictVoiceChannel(voiceChannelId: string) {
  // A deleted channel has no audience, so no later roster run will drop this
  // for it; a channel merely made private gets one whole roster next, which
  // is always correct.
  forgetSentRoster(voiceChannelId);
  for (const peer of getRoomPeers(voiceChannelId)) {
    removePeer(peer.id);
  }
  if (registryOn()) {
    void evictForeign(
      { kind: "channel", channelId: voiceChannelId },
      listVoicePeersInRoom(voiceChannelId),
      () => true,
      "channel",
      () => evictSfuRoom(voiceChannelId),
    );
    return;
  }
  void evictSfuRoom(voiceChannelId);
}

/** Drop everyone from a channel's voice room except the given users. */
export function evictVoiceUsersExcept(
  voiceChannelId: string,
  allowedUserIds: Set<string>,
) {
  // Snapshotted before any removal: this is what lets the SFU sweep identify a
  // participant whose token predates `participantMetadataFor` (a session that
  // survived a rolling deploy), and `removePeer` destroys the mapping.
  const knownIdentities = identityMapFor(getRoomPeers(voiceChannelId));

  for (const peer of getRoomPeers(voiceChannelId)) {
    if (!allowedUserIds.has(peer.userId)) {
      removePeer(peer.id);
    }
  }
  if (registryOn()) {
    void evictForeign(
      {
        kind: "except",
        channelId: voiceChannelId,
        allowedUserIds: [...allowedUserIds],
      },
      listVoicePeersInRoom(voiceChannelId),
      (row) => !allowedUserIds.has(row.userId),
      "channel-private",
      (known) => evictSfuUsersExcept(voiceChannelId, allowedUserIds, known),
      knownIdentities,
    );
    return;
  }
  void evictSfuUsersExcept(voiceChannelId, allowedUserIds, knownIdentities);
}

/** Drop a specific user from a channel's voice room (kick / access revoked). */
export function evictVoiceUser(userId: string, serverChannelIds?: Set<string>) {
  const knownIdentities = identityMapFor(
    [...peers.values()].filter((peer) => peer.userId === userId),
  );

  for (const peer of [...peers.values()]) {
    if (peer.userId !== userId) {
      continue;
    }
    if (serverChannelIds && !serverChannelIds.has(peer.voiceChannelId)) {
      continue;
    }
    removePeer(peer.id);
  }

  // `undefined` scope means "every room they are in", which is what the SFU
  // side has to be told explicitly — it cannot infer the scope from a local map
  // that may not contain the participant at all.
  const scope = serverChannelIds ? [...serverChannelIds] : null;
  if (registryOn()) {
    void evictForeign(
      { kind: "user", userId, channelIds: scope },
      listVoicePeersForUser(userId),
      (row) => !serverChannelIds || serverChannelIds.has(row.channelId),
      "user",
      (known) => evictSfuUser(userId, scope, known),
      knownIdentities,
    );
    return;
  }
  void evictSfuUser(userId, scope, knownIdentities);
}

/** LiveKit identity (peer id) → user id, for peers this instance can see. */
function identityMapFor(roster: VoicePeer[]): Map<string, string> {
  return new Map(roster.map((peer) => [peer.id, peer.userId]));
}

/**
 * The cluster half of an eviction, registry on (M4, plan section 5.8). Three
 * steps, in this order, because the order is the contract:
 *
 * 1. `voice.moderation` on the bus, so the instance holding the target's
 *    socket says the notice (if there is one) and forgets its local entry
 *    *before* the row goes. It drops the peer silently: the departure is
 *    announced once, by step 2.
 * 2. Every matching row held by another instance is released here, the way
 *    the beacon releases a foreign seat (`releaseForeignPeer`): the row and
 *    the retired id are this instance's to write, so a lost bus frame or a
 *    dead owner still costs the room nothing but a frame. `adopted` then
 *    `left` go out from there, and the owner, having already forgotten the
 *    seat, forwards `peer-left` to its room like anybody else.
 * 3. The SFU half runs once, here, with the rows' peer ids merged into the
 *    identity hint, so a participant on a pre-metadata token whose socket
 *    is on the other machine is still resolvable.
 *
 * Fire-and-forget like the flag-off path; a registry read that fails logs
 * and still runs the SFU half with what this instance knew.
 */
async function evictForeign(
  frame: VoiceModerationFrame,
  rows: Promise<VoicePeerRow[]>,
  selects: (row: VoicePeerRow) => boolean,
  reason: string,
  sfu: (knownIdentities: Map<string, string>) => Promise<void>,
  knownIdentities: Map<string, string> = new Map(),
): Promise<void> {
  if (clusterOn()) {
    publishVoice(VOICE_MODERATION_TOPIC, frame);
  }
  try {
    for (const row of await rows) {
      if (!selects(row)) {
        continue;
      }
      knownIdentities.set(row.peerId, row.userId);
      if (row.instanceId === INSTANCE_ID || peers.has(row.peerId)) {
        // Ours: `removePeer` already took it (the delete is in flight).
        continue;
      }
      releaseForeignPeer(row, reason);
    }
  } catch (error) {
    logEvent("voice.registryReadFailed", {
      op: "evict",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await sfu(knownIdentities);
}

/**
 * Look up a live voice peer. Used by the SFU token endpoint to prove the
 * requested peer id really belongs to the requesting user and channel.
 */
export function getVoicePeer(peerId: string): {
  userId: string;
  voiceChannelId: string;
  displayName: string;
  muted: boolean;
} | null {
  const peer = peers.get(peerId);
  if (!peer) {
    return null;
  }
  return {
    userId: peer.userId,
    voiceChannelId: peer.voiceChannelId,
    displayName: peer.displayName,
    muted: peer.muted,
  };
}

/**
 * Tab close / hangup after `/ws` is already gone. The HMAC is the proof; the
 * peer id is on every roster, so a bare id must not be enough to retire a seat.
 * Returns whether a peer was removed.
 *
 * The local map is answered synchronously, before the first await, so the
 * beacon route's fire-and-forget call still removes a local peer in the
 * same tick as before. With the registry on, a seat this process does not
 * hold is looked up by row: the beacon is an HTTP request, load-balanced
 * per request, so it lands on whichever machine, and the row is what makes
 * the answer the same on both.
 */
export async function leaveVoiceByResumeToken(
  resumePeerId: string,
  resumeToken: string,
): Promise<boolean> {
  const peer = peers.get(resumePeerId);
  if (peer) {
    if (
      !verifyVoiceResumeToken(resumeToken, {
        userId: peer.userId,
        peerId: resumePeerId,
        voiceChannelId: peer.voiceChannelId,
      })
    ) {
      return false;
    }
    removePeer(resumePeerId);
    return true;
  }
  if (!registryOn()) {
    return false;
  }
  let row: VoicePeerRow | null = null;
  try {
    row = await getVoicePeerRow(resumePeerId);
  } catch (error) {
    logEvent("voice.registryReadFailed", {
      op: "leaveByToken",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!row) {
    return false;
  }
  if (
    !verifyVoiceResumeToken(resumeToken, {
      userId: row.userId,
      peerId: resumePeerId,
      voiceChannelId: row.channelId,
    })
  ) {
    return false;
  }
  // The row may have come home while the read was out (a resume landed
  // here); the map is exact for what this process holds.
  if (peers.has(resumePeerId)) {
    removePeer(resumePeerId);
    return true;
  }
  releaseForeignPeer(row, "beacon");
  return true;
}

/**
 * Retire a seat another instance holds: the row goes (and the room row with
 * it if it was the last), the id is retired, this instance's room hears
 * `peer-left`, and the cluster hears two things in order: `adopted`, so the
 * owner forgets its local entry without announcing anything, then `left`
 * from inside the roster queue, so every instance (the owner included, now
 * that it no longer holds the peer) forwards `peer-left` to its room and
 * rebuilds its roster from the rows. Without the first frame the owner's
 * orphan timer would fire later and announce a departure the room already
 * saw.
 */
function releaseForeignPeer(row: VoicePeerRow, reason: string): void {
  const { peerId, channelId } = row;
  trackRowWrite(
    channelId,
    deleteVoicePeer(peerId).then(() => clearWatchPartyIfEmpty(channelId)),
  );
  retirePeerId(peerId, channelId);
  logEvent("voice.leave", {
    peerId,
    userId: row.userId,
    voiceChannelId: channelId,
    roomSize: getLiveRoomPeers(channelId).length,
    foreign: true,
    reason,
  });
  if (clusterOn()) {
    publishVoice(VOICE_ROOM_TOPIC, {
      channelId,
      kind: "adopted",
      peerId,
    } satisfies VoiceRoomFrame);
  }
  broadcastToRoom(channelId, { type: "peer-left", peerId });
  void broadcastRoster(channelId, { kind: "left", peerId });
}

/**
 * Another instance now answers for this peer id (it adopted the seat on
 * resume, or retired it on the owner's behalf). Forget the entry without a
 * `peer-left`: the room is told by the frames that follow, if it needs to
 * be. The socket, if it is still open, is a half-open one the client has
 * already replaced; its eventual close finds no peer and does nothing.
 */
function dropVoicePeerSilently(peerId: string): void {
  const peer = peers.get(peerId);
  if (!peer) {
    return;
  }
  cancelOrphan(peer);
  peers.delete(peerId);
  if (socketToPeerId.get(peer.socket) === peerId) {
    socketToPeerId.delete(peer.socket);
  }
  if (getRoomPeers(peer.voiceChannelId).length === 0) {
    roomTransports.delete(peer.voiceChannelId);
    forgetTransportDecision(peer.voiceChannelId);
    roomServerMutes.delete(peer.voiceChannelId);
  }
  logEvent("voice.seatReleased", {
    peerId,
    userId: peer.userId,
    voiceChannelId: peer.voiceChannelId,
  });
}

/**
 * The instance lease's consequences, run after every heartbeat while the
 * registry is on (`startVoiceInstanceHeartbeat` in `index.ts`). The rows
 * are the registry's to sweep (`reconcileVoiceRegistry`); the fan-out is
 * this file's: every seat the sweep removed gets `peer-left` in this
 * instance's room and a `left` hint on the bus, and the roster is rebuilt
 * for every room it touched. Idempotent across instances: the sweep names
 * exactly the rows this call deleted, so two instances racing it announce
 * each departure once between them. A no-op with the flag off.
 */
export async function runVoiceReconcile(): Promise<{
  orphaned: number;
  removed: number;
  roomsSwept: number;
}> {
  if (!registryOn()) {
    return { orphaned: 0, removed: 0, roomsSwept: 0 };
  }
  const result = await reconcileVoiceRegistry();
  // The SFU re-sweep claims ride on the same beat (plan section 5.4): every
  // instance ticks, and only the rows this tick won are swept.
  await tickSfuResweeps();
  const touched = new Set<string>();
  for (const { peerId, channelId } of result.removed) {
    broadcastToRoom(channelId, { type: "peer-left", peerId });
    void broadcastRoster(channelId, { kind: "left", peerId });
    touched.add(channelId);
  }
  for (const { channelId } of result.orphaned) {
    if (!touched.has(channelId)) {
      // Orphans stay on the roster (the sidebar still shows them); the
      // rebuild is for the instances that will read the row's new state.
      void broadcastRoster(channelId, { kind: "roster" });
      touched.add(channelId);
    }
  }
  if (
    result.orphaned.length > 0 ||
    result.removed.length > 0 ||
    result.roomsSwept > 0 ||
    result.instancesSwept > 0
  ) {
    logEvent("voice.reconcile", {
      orphaned: result.orphaned.length,
      removed: result.removed.length,
      roomsSwept: result.roomsSwept,
      instancesSwept: result.instancesSwept,
    });
  }
  return {
    orphaned: result.orphaned.length,
    removed: result.removed.length,
    roomsSwept: result.roomsSwept,
  };
}

/**
 * Socket closed. Peers that declared `resume: true` stay in the room for
 * `VOICE_RESUME_TTL_MS` so a brief signaling outage can reattach the same
 * id without broadcasting `peer-left`. Everyone else (phones, old tabs)
 * is removed now. Intentional hangup is `leave-voice-room`.
 */
export function removeVoicePeerBySocket(socket: WebSocket) {
  // Before the peer lookup: a watcher never had a peer, and its close must
  // still leave the count.
  hlsAudience.dropSocket(socket);
  const peerId = socketToPeerId.get(socket);
  if (!peerId) {
    return;
  }
  const peer = peers.get(peerId);
  if (!peer) {
    socketToPeerId.delete(socket);
    return;
  }
  socketToPeerId.delete(socket);
  if (!peer.canResume) {
    removePeer(peerId);
    return;
  }
  cancelOrphan(peer);
  peer.orphanedAt = Date.now();
  peer.orphanTimer = setTimeout(() => {
    peer.orphanTimer = undefined;
    if (peers.get(peerId)?.orphanedAt !== undefined) {
      removePeer(peerId);
    }
  }, VOICE_RESUME_TTL_MS);
  if (registryOn()) {
    trackRowWrite(
      peer.voiceChannelId,
      markVoicePeerOrphaned(peerId, new Date(peer.orphanedAt)),
    );
  }
  onLiveRoomMaybeEmpty(peer.voiceChannelId, socket);
  logEvent("voice.orphan", {
    peerId,
    userId: peer.userId,
    voiceChannelId: peer.voiceChannelId,
  });
}

/** Test hook: drop every peer, orphan timer, and retired-id window. */
export function resetVoicePeers(): void {
  resetRosterSequences();
  hlsAudience.reset();
  for (const peer of peers.values()) {
    cancelOrphan(peer);
  }
  for (const timer of retiredPeerIds.values()) {
    clearTimeout(timer);
  }
  peers.clear();
  socketToPeerId.clear();
  retiredPeerIds.clear();
  roomTransports.clear();
  pendingTransportDecisions.clear();
  rosterCoalescer.reset();
  pendingRoomEvents.clear();
  remoteTransports.clear();
  roomServerMutes.clear();
}

/** Whether a socket currently holds a voice peer (for disconnect diagnostics). */
export function isSocketInVoice(socket: WebSocket): boolean {
  return socketToPeerId.has(socket);
}

/**
 * Send current voice occupancy to a newly authenticated socket — but only for
 * the rooms this user is allowed to see.
 */
export async function sendAllVoiceRosters(socket: WebSocket, user: DbUser) {
  const rooms = new Map<
    string,
    { participants: Map<string, VoiceParticipant>; transport?: VoiceRoomTransport }
  >();
  const roomOf = (voiceChannelId: string) => {
    let room = rooms.get(voiceChannelId);
    if (!room) {
      room = { participants: new Map() };
      rooms.set(voiceChannelId, room);
    }
    return room;
  };

  // The cluster's rooms first, then this instance's own peers laid over them
  // by id, exactly as `readClusterRoom` does per room. One query for every
  // room at once: a fresh socket is the one moment the whole map is wanted.
  if (registryOn()) {
    try {
      await Promise.all([...pendingRowWrites.values()]);
      for (const row of await listVoiceRosters()) {
        const room = roomOf(row.channelId);
        room.transport = row.transport;
        noteRemoteTransport(row.channelId, row.transport);
        for (const peer of row.peers) {
          room.participants.set(peer.peerId, rowToParticipant(peer));
        }
      }
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "rosters",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const peer of peers.values()) {
    roomOf(peer.voiceChannelId).participants.set(peer.id, toParticipant(peer));
  }

  await Promise.all(
    [...rooms].map(async ([voiceChannelId, room]) => {
      try {
        if (!(await canAccessChannel(voiceChannelId, user.id))) {
          return;
        }
      } catch (error) {
        console.error("[voice] roster membership check failed:", error);
        return;
      }
      send(socket, {
        type: "voice-roster",
        voiceChannelId,
        participants: [...room.participants.values()],
        transport:
          roomTransports.get(voiceChannelId) ??
          room.transport ??
          configuredTransport(),
        // The sequence this socket is now caught up to. Deliberately the last
        // sequence SENT, not a new one: a change already folded into this
        // snapshot may still be sitting in the coalescer's queue, and the
        // delta that reports it will therefore be `seq + 1` and accepted.
        // Re-applying it is a no-op, because every delta entry is an absolute
        // statement about one peer.
        seq: currentRosterSeq(voiceChannelId),
      });
    }),
  );

  // Every live stream this user may view, so the sidebar pill and a viewer
  // opening a channel without a seat know before anything changes. The
  // access check is the same one the roster above ran; a room with a stream
  // always has a roster, so this is usually a repeat of a query just made.
  await Promise.all(
    hlsAudience.liveChannels().map(async (channelId) => {
      try {
        if (!(await canAccessChannel(channelId, user.id))) {
          return;
        }
      } catch (error) {
        console.error("[voice] channel-live membership check failed:", error);
        return;
      }
      send(socket, channelLiveFrame(channelId, user.id));
      hlsAudienceFramesSent.frames += 1;
    }),
  );
}

type VoiceResumePlan =
  | { kind: "reattach"; peer: VoicePeer }
  | { kind: "reconstruct"; peerId: string; transport: VoiceRoomTransport }
  /**
   * The row exists and another instance holds it: taken over by
   * `adoptVoicePeer` once the transport is settled. Decided in the join
   * handler (it needs a row read), never here.
   */
  | {
      kind: "adopt";
      peerId: string;
      transport: VoiceRoomTransport;
      row: VoicePeerRow;
    }
  | { kind: "cold" };

function planVoiceResume(
  userId: string,
  payload: {
    voiceChannelId: string;
    resumePeerId?: string;
    resumeToken?: string;
  },
  capabilities: VoiceRoomTransport[],
): VoiceResumePlan {
  const claimed = payload.resumePeerId;
  if (!claimed || !payload.resumeToken) {
    return { kind: "cold" };
  }
  const verified = verifyVoiceResumeToken(payload.resumeToken, {
    userId,
    peerId: claimed,
    voiceChannelId: payload.voiceChannelId,
  });
  if (!verified) {
    return { kind: "cold" };
  }
  if (!capabilities.includes(verified.transport)) {
    return { kind: "cold" };
  }

  const existing = peers.get(claimed);
  if (existing) {
    if (
      existing.userId !== userId ||
      existing.voiceChannelId !== payload.voiceChannelId
    ) {
      return { kind: "cold" };
    }
    // The token already proves this user owns the peer. A Wi-Fi blip can
    // reconnect before the heartbeat notices the old socket died, so the
    // peer is still marked live. Adopt the new socket rather than cold-
    // joining into a second seat.
    return { kind: "reattach", peer: existing };
  }

  if (!registryOn() && retiredPeerIds.has(claimed)) {
    return { kind: "cold" };
  }
  const pinned = roomTransports.get(payload.voiceChannelId);
  if (pinned && pinned !== verified.transport) {
    return { kind: "cold" };
  }
  return {
    kind: "reconstruct",
    peerId: claimed,
    transport: verified.transport,
  };
}

async function welcomeVoicePeer(
  peer: VoicePeer,
  resumed: boolean,
): Promise<void> {
  const transport = getRoomTransport(peer.voiceChannelId);
  const resumeToken = mintVoiceResumeToken({
    userId: peer.userId,
    peerId: peer.id,
    voiceChannelId: peer.voiceChannelId,
    transport,
  });
  const self = toParticipant(peer);
  // Orphans stay on the roster (sidebar still shows them) but must not be
  // in `welcome.peers`. A joiner that offered to a closed socket would sit
  // in `have-local-offer` forever; on resume `connectToPeer` is a no-op.
  const byId = new Map<string, VoiceParticipant>();
  let party = getWatchPartyState(peer.voiceChannelId);
  if (registryOn()) {
    // The room's other instances' peers, and the party the room holds. One
    // read each, both best effort: a failed read leaves the local view,
    // which is what a single machine would have shown.
    try {
      const [room, held] = await Promise.all([
        listVoiceRoster(peer.voiceChannelId),
        readWatchParty(peer.voiceChannelId),
      ]);
      noteRemoteTransport(peer.voiceChannelId, room?.transport ?? null);
      for (const row of room?.peers ?? []) {
        if (row.orphanedAt === null) {
          byId.set(row.peerId, rowToParticipant(row));
        }
      }
      if (held !== undefined) {
        adoptWatchPartyState(peer.voiceChannelId, held);
        party = getWatchPartyState(peer.voiceChannelId);
      }
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "welcome",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The await may have outlived the socket. `send` drops the frame on a
    // closed socket anyway; the room broadcast below is still owed.
  }
  for (const live of getLiveRoomPeers(peer.voiceChannelId)) {
    byId.set(live.id, toParticipant(live));
  }
  byId.delete(peer.id);
  const existingPeers = [...byId.values()];

  send(peer.socket, {
    type: "welcome",
    peerId: peer.id,
    peers: existingPeers,
    voiceChannelId: peer.voiceChannelId,
    self,
    transport,
    resumed: resumed || undefined,
    resumeToken: resumeToken ?? undefined,
    canSpeak: peer.canSpeak,
    canStream: peer.canStream,
  });

  // What the room is watching, to this socket alone and only if there is a
  // party. A joiner cannot ask for it: there is no request frame in the
  // contract and adding one would be a second way to learn the same fact.
  // Sent after `welcome` so the client already knows which room it is in,
  // and before the room hears about the joiner, so the state is in hand
  // before anything else can arrive about it.
  if (party) {
    send(peer.socket, {
      type: "watch-party",
      channelId: peer.voiceChannelId,
      state: party,
    });
  }
  const liveStream = liveHlsStreamFor(peer.voiceChannelId);
  if (liveStream) {
    send(peer.socket, {
      type: "voice-stream",
      channelId: peer.voiceChannelId,
      stream: stampViewerStream(liveStream, peer.userId),
    });
  }

  broadcastToRoom(
    peer.voiceChannelId,
    { type: "peer-joined", peer: self },
    peer.id,
  );
  noteConversationCallJoin(peer.voiceChannelId, peer.userId);
  await broadcastRoster(peer.voiceChannelId, { kind: "joined", peer: self });
}

async function reattachVoicePeer(
  peer: VoicePeer,
  socket: WebSocket,
  user: DbUser,
): Promise<void> {
  const previous = socketToPeerId.get(socket);
  if (previous && previous !== peer.id) {
    removePeer(previous);
  }
  const previousSocket = peer.socket;
  if (previousSocket !== socket) {
    // Drop the old mapping *before* overwriting `peer.socket`. Otherwise the
    // old socket's later `close` looks up this peer id and orphans the seat
    // we just resumed onto.
    socketToPeerId.delete(previousSocket);
  }
  cancelOrphan(peer);
  peer.socket = socket;
  socketToPeerId.set(socket, peer.id);
  hlsAudience.dropSocket(socket);
  const channel = await getChannel(peer.voiceChannelId);
  peer.displayName = await resolveMemberName(
    channel?.kind === "server" ? (channel.server_id ?? null) : null,
    user,
  );
  peer.avatarUrl = user.avatar_url;
  // Clears `orphaned_at` and re-stamps this instance on the row.
  writePeerRow(peer);
  logEvent("voice.resume", {
    peerId: peer.id,
    userId: peer.userId,
    voiceChannelId: peer.voiceChannelId,
  });
  await welcomeVoicePeer(peer, true);
}

export async function handleVoiceMessage(
  session: { socket: WebSocket; user: DbUser },
  raw: unknown,
): Promise<void> {
  const message = voiceClientMessageSchema.safeParse(raw);
  if (!message.success) {
    return;
  }

  const payload = message.data;
  const { socket, user } = session;
  const existingPeerId = socketToPeerId.get(socket);

  if (payload.type === "join-voice-room") {
    if (!roomLimiter.take(user.id)) {
      return;
    }
    const refuseResume = () => {
      if (payload.resumePeerId) {
        send(socket, {
          type: "voice-join-refused",
          voiceChannelId: payload.voiceChannelId,
        });
      }
    };
    // A CHARACTER NEVER JOINS VOICE. The house cast is a frame that works in a
    // public text room and nowhere else — a fictional stranger in your ear is
    // something no disclosure setting makes comfortable, and there is no
    // plausible audio for one to send.
    //
    // Enforced at the same chokepoint as timeouts, and for the same reason
    // stated there: `join-voice-room` is the only way into a room, so refusing
    // it here is the whole enforcement. The flag rides on the session user, so
    // this costs no query. `handleVoiceMessage`'s other branches all require a
    // peer that this refusal prevents from ever existing — including the one
    // that mints an SFU token.
    if (user.is_character) {
      refuseResume();
      return;
    }
    if (!(await canAccessChannel(payload.voiceChannelId, user.id))) {
      refuseResume();
      return;
    }
    // `type` says which kind of *server* channel this is, and a conversation is
    // neither: it has one room that is text and voice at once, the way a DM
    // call works everywhere else. Gating on `type` alone rejected every
    // conversation, since they are all stored as text.
    //
    // READ BEFORE THE TWO GUARDS BELOW, because it is what says which of them
    // can possibly apply. Both used to run on every join and each is provably
    // a no-op on half of them: `isDmSendBlocked` builds its participant set
    // `WHERE c.kind <> 'server'` and from `dm_pairs`, so on a server channel it
    // asks an empty set whether anybody blocked you and always answers no;
    // `findTimeoutForChannel` joins `channels ON c.server_id = t.server_id`,
    // which cannot match a conversation because its `server_id` is NULL (the
    // comment below already said so, and ran the query anyway). That was one
    // dead round trip per join either way, on the one path a watch party
    // hammers: the 2026-09-05 party put about ten sequential queries per join
    // against a database answering in 80 to 240 ms with the pool pinned at 25
    // of 25. All four refusals here are the same `refuseResume()`, so which one
    // fires first is not observable by any client.
    const channel = await getChannel(payload.voiceChannelId);
    if (!channel) {
      refuseResume();
      return;
    }
    if (channel.kind === "server" && !isVoiceRoomChannelType(channel.type)) {
      refuseResume();
      return;
    }

    // Ringing somebody is the loudest thing one account can do to another, so a
    // block closes a 1:1's call the same way it closes its messages. Without
    // this, a blocked person keeps a working phone line to the person who
    // blocked them.
    if (
      channel.kind !== "server" &&
      (await isDmSendBlocked(payload.voiceChannelId, user.id))
    ) {
      refuseResume();
      return;
    }
    // THE VOICE CHOKEPOINT for timeouts. `join-voice-room` is the only way into
    // a room, so refusing it here is the whole enforcement — plus the eviction
    // the issuing route performs for anybody already inside one.
    //
    // WHY REFUSING THE JOIN AND NOT A SERVER-SIDE MUTE. A mute is the more
    // surgical sanction, and since `roomServerMutes` it does exist on mesh
    // too, enforced by every receiver the way an eviction is. But it is
    // scoped to one room for the room's lifetime, and a timeout is a
    // sanction on the person across the whole server for a set time. Refusing
    // the room is the one shape that means the same thing in every channel
    // and on both transports. The same join reaches a conversation's call,
    // and `findTimeoutForChannel` returns nothing for those — a server's
    // moderators do not get to hang up their members' DM calls.
    if (
      channel.kind === "server" &&
      (await findTimeoutForChannel(user.id, payload.voiceChannelId))
    ) {
      refuseResume();
      return;
    }

    // SPEAK and STREAM ride on the same resolution as CONNECT.
    // A conversation has neither roles nor overwrites, so both stay true there.
    //
    // Split into its two halves rather than `computeMemberPermissions`, to
    // pay for this member's row once. The context carries the nickname, which
    // is the name this call will show and was a query of its own further down;
    // and the channel row is handed to the overwrite pass, which otherwise
    // asks the database whether this channel is a thread — a question the row
    // in hand already answers. Two fewer round trips per join, on the path a
    // watch party runs several hundred times in an evening.
    let canSpeak = true;
    let canStream = true;
    let nickname: string | null = null;
    if (channel.kind === "server" && channel.server_id) {
      const resolved = await resolveMemberChannelPermissions(
        channel.server_id,
        user.id,
        channel,
      );
      if (!hasPermission(resolved.permissions, Permission.CONNECT)) {
        refuseResume();
        return;
      }
      canSpeak = hasPermission(resolved.permissions, Permission.SPEAK);
      // THE ONE GATE for the stage. A watch party asks for START_WATCH_PARTY
      // instead of STREAM, so the audience keeps its everyday bits and still
      // cannot present. `set-sharing-screen` reads `peer.canStream`; the HLS
      // egress start must read the same flag (see docs/WATCH_PARTY.md).
      canStream = canStartWatchPartyStream({
        channelType: channel.type,
        permissions: resolved.permissions,
      });
      nickname = resolved.nickname;
    }

    // What this room would open on, if this join is the one that opens it. A
    // pinned room never re-decides, so the (at most one) query behind this is
    // skipped for every join after the first.
    const opening = roomTransports.has(payload.voiceChannelId)
      ? null
      : await decideRoomTransportOnce(payload.voiceChannelId, channel);

    // The awaits above mean the socket may have closed, or the client may have
    // sent a second join, while this one was in flight. Registering a peer for a
    // dead socket leaves a ghost in the roster that nothing ever removes.
    if (socket.readyState !== 1) {
      return;
    }

    const capabilities: VoiceRoomTransport[] = payload.transports ?? [
      "mesh",
      "livekit",
    ];
    let resume = planVoiceResume(user.id, payload, capabilities);
    // With the registry on the retired store is the table, not the map: a
    // hangup on another instance (or on this one, before a restart emptied
    // the map) must not be resurrected here. Then the row: a seat another
    // instance still holds for this user in this room is adopted rather
    // than rebuilt, so the roster never shows two of them and no instance
    // ever announces a `peer-left` for a person who never left. Two reads,
    // both after this channel's pending writes, so a hangup or an orphan
    // stamp that is still in flight is seen.
    if (resume.kind === "reconstruct" && registryOn()) {
      const claimed = resume.peerId;
      let retired = false;
      let row: VoicePeerRow | null = null;
      try {
        await settledRowWrites(payload.voiceChannelId);
        retired = await isVoicePeerRetired(claimed);
        if (!retired) {
          row = await getVoicePeerRow(claimed);
        }
      } catch (error) {
        logEvent("voice.registryReadFailed", {
          op: "resume",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (retired) {
        resume = { kind: "cold" };
      } else if (
        row &&
        row.userId === user.id &&
        row.channelId === payload.voiceChannelId
      ) {
        resume = { kind: "adopt", peerId: claimed, transport: resume.transport, row };
      } else if (row) {
        // Somebody else's seat under this id, or this person's seat in
        // another room: the token proved neither. Cold, like a local
        // mismatch in `planVoiceResume`.
        resume = { kind: "cold" };
      }
      if (socket.readyState !== 1) {
        return;
      }
    }
    let transport: VoiceRoomTransport =
      roomTransports.get(payload.voiceChannelId) ??
      (resume.kind === "reconstruct" || resume.kind === "adopt"
        ? resume.transport
        : (opening?.transport ?? configuredTransport()));

    // NO MESH GUARD ANY MORE. Until 2026-09-08 a second live instance made
    // a room that would open on mesh open on the SFU instead (and, before
    // that, refused the join outright: four hung-up calls in the 2026-09-07
    // window). Both were a stand-in for the mesh not crossing machines. It
    // does now: the joiner's peer list comes from the rows, `peer-*` frames
    // cross on `voice.room`, a signaling frame for a peer held elsewhere
    // crosses on `voice.signal` (`relayToTarget` and its subscriber), and
    // the ceiling counts the rows. So the transport a room opens on is the
    // policy's answer (`transport-policy.ts`: DMs and small servers mesh,
    // communities and large servers the SFU, the per-channel override
    // first) on one machine and on two alike; the only cluster step is the
    // atomic pin below, which makes two machines opening the same channel in
    // the same second agree. Sending every small room to the SFU because a
    // second machine was up would have put a night's forty mesh rooms on a
    // two-core media box that cannot carry them.

    // THE ATOMIC PIN. With the registry on, an unpinned room's decision goes
    // through `voice_rooms` before it is applied here: whoever inserts first
    // decides, and the loser adopts the stored transport, so two instances
    // that open the same channel in the same second (or with different
    // LiveKit config mid-rollout) cannot split the call. A reconstruct whose
    // token remembers another transport becomes a cold join, exactly as it
    // does against a local pin. A failed insert falls back to the local
    // decision, which is what this instance did before the registry existed.
    const pinnedHere =
      registryOn() && !roomTransports.has(payload.voiceChannelId);
    if (pinnedHere) {
      try {
        const claim = await claimVoiceRoomTransport(
          payload.voiceChannelId,
          transport,
        );
        const stored = claim.transport;
        if (stored !== transport) {
          logEvent("voice.transportAdopted", {
            channelId: payload.voiceChannelId,
            wanted: transport,
            stored,
          });
          transport = stored;
        } else if (!claim.won && stored === "mesh") {
          // Pinned mesh by another process and adopted here: the number
          // that used to be a refusal, kept in the log for the flip.
          logEvent("voice.meshPinAdopted", {
            userId: user.id,
            voiceChannelId: payload.voiceChannelId,
            resumed: resume.kind !== "cold",
          });
        }
        // A resume is only kept on the transport its token remembers: the
        // media it is holding was built for that one. What matters is the
        // room's answer against the token's.
        if (
          (resume.kind === "reconstruct" || resume.kind === "adopt") &&
          resume.transport !== stored
        ) {
          resume = { kind: "cold" };
        }
      } catch (error) {
        logEvent("voice.registryPinFailed", {
          channelId: payload.voiceChannelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Same reason as the readiness check above: the await may have outlived
      // the socket, and a pinned room nobody joined must not stay pinned.
      if (socket.readyState !== 1) {
        void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
        return;
      }
    }

    // THE ADOPT. The transport is settled, so the row can change hands: one
    // conditional update stamps this instance on it and clears the orphan
    // mark. A null means the row went (a hangup landed first, or the
    // reconcile retired it), and the join proceeds as a reconstruct; the
    // retired check above is what keeps a retired id from coming back that
    // way, and a resume that lost to it exactly then simply cold-joins. The
    // `adopted` frame goes out now, ahead of the `joined` hint the welcome
    // will queue, so the old owner has forgotten the seat by the time its
    // room is told the person is (still) here.
    let adopted: VoicePeerRow | null = null;
    if (resume.kind === "adopt") {
      try {
        const adoption = await adoptVoicePeer(
          resume.peerId,
          user.id,
          payload.voiceChannelId,
        );
        if (adoption) {
          adopted = adoption.row;
          logEvent("voice.resumeAdopted", {
            peerId: resume.peerId,
            userId: user.id,
            voiceChannelId: payload.voiceChannelId,
            from: adoption.previousInstanceId,
            ownerAlive: adoption.previousOwnerAlive,
            orphaned: adoption.previousOrphanedAt !== null,
          });
          if (clusterOn()) {
            publishVoice(VOICE_ROOM_TOPIC, {
              channelId: payload.voiceChannelId,
              kind: "adopted",
              peerId: resume.peerId,
            } satisfies VoiceRoomFrame);
          }
        }
      } catch (error) {
        logEvent("voice.registryWriteFailed", {
          op: "adopt",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!adopted) {
        resume = {
          kind: "reconstruct",
          peerId: resume.peerId,
          transport: resume.transport,
        };
      }
      if (socket.readyState !== 1) {
        return;
      }
    }

    // A client that cannot run this room's transport is refused *here*, before
    // a peer exists. Admitting it and letting it discover the mismatch a round
    // trip later would put a participant in everyone's roster who cannot be
    // heard — the exact failure this is here to make impossible.
    if (!capabilities.includes(transport)) {
      const stale = socketToPeerId.get(socket);
      if (stale) {
        removePeer(stale);
      }
      if (pinnedHere) {
        void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
      }
      logEvent("voice.transportUnsupported", {
        userId: user.id,
        voiceChannelId: payload.voiceChannelId,
        transport,
        capabilities,
      });
      send(socket, {
        type: "voice-transport-unsupported",
        voiceChannelId: payload.voiceChannelId,
        transport,
      });
      return;
    }

    const resumePeerId =
      resume.kind === "reattach"
        ? resume.peer.id
        : resume.kind === "reconstruct" || resume.kind === "adopt"
          ? resume.peerId
          : undefined;

    // Occupying count for the mesh ceiling. A resume reattaches an existing
    // slot: that peer must not count against itself.
    const occupyingOf = () =>
      getRoomPeers(payload.voiceChannelId).filter((p) => {
        if (p.socket === socket) {
          return false;
        }
        if (resumePeerId && p.id === resumePeerId) {
          return false;
        }
        return true;
      });

    // Cold join after a blip: drop this user's orphans only when they are
    // what makes the mesh full. A phone that cannot resume must not evict a
    // holding web/Electron seat when the room still has space. Two seats for
    // 90s is cosmetic; a rebuilt call is not. When the ghosts *are* the cap
    // (e2e leftover Dev Users, a client that never sent the token) sweep so
    // the next join is not refused as full.
    // Seats held on the other instance count against the ceiling too, now
    // that a mesh room spans machines: the rows, minus what this map already
    // counts and minus the seat this resume is reclaiming. Read once, after
    // this channel's pending writes. Two joins landing on two machines in the
    // same instant can each read seven and both seat an eighth, the
    // read-then-write window the file banner names; a room of nine for the
    // rest of that call is a quality cost, not a split, and the ceiling is
    // exact again from the next join.
    let foreignOccupying = 0;
    if (registryOn() && transport === "mesh") {
      try {
        await settledRowWrites(payload.voiceChannelId);
        const rows = await listVoicePeersInRoom(payload.voiceChannelId);
        foreignOccupying = rows.filter(
          (row) =>
            row.instanceId !== INSTANCE_ID &&
            !peers.has(row.peerId) &&
            row.peerId !== resumePeerId,
        ).length;
      } catch (error) {
        logEvent("voice.registryReadFailed", {
          op: "meshCeiling",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (socket.readyState !== 1) {
        if (pinnedHere) {
          void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
        }
        return;
      }
    }
    let occupying = occupyingOf();
    const meshIsFull = () =>
      transport === "mesh" &&
      occupying.length + foreignOccupying >= MESH_VOICE_LIMIT;
    if (resume.kind === "cold" && meshIsFull()) {
      for (const ghost of getRoomPeers(payload.voiceChannelId)) {
        if (ghost.userId === user.id && ghost.orphanedAt !== undefined) {
          removePeer(ghost.id);
        }
      }
      occupying = occupyingOf();
    }

    // Enforce the mesh ceiling server-side. Above it, each client would carry
    // one Opus uplink per peer and quality collapses — reject instead. The
    // ceiling is a property of the mesh, so it does not apply once media is
    // routed through an SFU.
    if (meshIsFull()) {
      logEvent("voice.roomFull", {
        userId: user.id,
        voiceChannelId: payload.voiceChannelId,
        limit: MESH_VOICE_LIMIT,
      });
      send(socket, {
        type: "voice-room-full",
        voiceChannelId: payload.voiceChannelId,
        limit: MESH_VOICE_LIMIT,
      });
      if (pinnedHere) {
        void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
      }
      return;
    }

    // A moderator's mute on this person in this room, as the cluster has
    // it: set on another instance, or on this one before a restart emptied
    // the map. Seeded into the map so the seat below, `set-voice-state` and
    // every roster read it the same way a mute set here would be read.
    if (
      registryOn() &&
      !isVoiceUserServerMuted(payload.voiceChannelId, user.id)
    ) {
      try {
        if (
          await isVoiceServerMutedInRegistry(payload.voiceChannelId, user.id)
        ) {
          let set = roomServerMutes.get(payload.voiceChannelId);
          if (!set) {
            set = new Set();
            roomServerMutes.set(payload.voiceChannelId, set);
          }
          set.add(user.id);
        }
      } catch (error) {
        logEvent("voice.registryReadFailed", {
          op: "serverMute",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (socket.readyState !== 1) {
        if (pinnedHere) {
          void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
        }
        return;
      }
    }

    if (resume.kind === "reattach") {
      resume.peer.canResume = payload.resume === true;
      // A permission edit that landed during the signaling gap is carried by
      // this welcome; the SFU grant for a still-connected participant is the
      // live path's job (`reevaluateVoiceSpeak`), which ran when it changed.
      resume.peer.canSpeak = canSpeak;
      resume.peer.canStream = canStream;
      if (!canSpeak) {
        resume.peer.muted = true;
      }
      if (!canStream) {
        resume.peer.sharingScreen = false;
        resume.peer.screenAudioStreamId = null;
        resume.peer.cameraStreamId = null;
      }
      await reattachVoicePeer(resume.peer, socket, user);
      return;
    }

    const currentPeerId = socketToPeerId.get(socket);
    if (currentPeerId) {
      removePeer(currentPeerId);
    }

    const peerId =
      resume.kind === "reconstruct" || resume.kind === "adopt"
        ? resume.peerId
        : randomUUID();
    // What this person is called *here*: their nickname in this server, or
    // the name on their account. Every other surface already resolves it this
    // way; voice used to read `display_name` straight, which is how somebody
    // with a nickname had their account name shown to the whole call. Read
    // off the permission context above rather than in a query of its own —
    // same row, same statement, same answer as `resolveMemberName`.
    const shownName = nickname?.trim() ? nickname.trim() : user.display_name;
    // An adopted seat keeps what its row says (a share or a camera that is
    // still up on the SFU, a standing mute), exactly as a reattach keeps
    // the peer object: the person never left. A reconstruct starts clean,
    // as it always has; the client re-declares its state after `welcome`.
    const peer: VoicePeer = {
      id: peerId,
      socket,
      userId: user.id,
      displayName: shownName,
      avatarUrl: user.avatar_url,
      voiceChannelId: payload.voiceChannelId,
      sharingScreen: adopted?.sharingScreen ?? false,
      cameraStreamId: adopted?.cameraStreamId ?? null,
      screenAudioStreamId: adopted?.screenAudioStreamId ?? null,
      // Not muted until the client says so: the client re-declares its state
      // right after `welcome` (including after a rejoin, where this reset
      // would otherwise erase a standing mute). See use of `set-voice-state`.
      // Two exceptions: a listener, who is muted by rule from the first
      // frame and stays so whatever their client declares, and a standing
      // moderator mute on this person in this room, which outlives the seat
      // (see `roomServerMutes`) and is therefore already true in the
      // `welcome` that seats them.
      muted:
        (adopted?.muted ?? false) ||
        !canSpeak ||
        isVoiceUserServerMuted(payload.voiceChannelId, user.id),
      deafened: adopted?.deafened ?? false,
      canSpeak,
      canStream,
      canResume: payload.resume === true,
    };
    if (adopted && !canStream) {
      peer.sharingScreen = false;
      peer.cameraStreamId = null;
      peer.screenAudioStreamId = null;
    }
    peers.set(peerId, peer);
    socketToPeerId.set(socket, peerId);
    // A seat replaces the watch subscription: the roster counts this socket
    // now, and counting it twice would inflate the pill.
    hlsAudience.dropSocket(socket);
    noteRoomSizeForPeak(getRoomPeers(payload.voiceChannelId).length);
    if (!canSpeak) {
      // Once per join, so an operator can see a stage working (or a member
      // locked out by accident) without a client-side log.
      logEvent("voice.speakDenied", {
        peerId,
        userId: user.id,
        voiceChannelId: payload.voiceChannelId,
        transport,
      });
    }
    // Reconstruct pins the transport the token remembered, so a deploy cannot
    // silently switch mesh ↔ LiveKit under held media. Cold join pins the
    // policy's decision when the room is empty.
    const wasPinned = roomTransports.has(payload.voiceChannelId);
    if (resume.kind === "reconstruct" || resume.kind === "adopt") {
      roomTransports.set(payload.voiceChannelId, resume.transport);
    } else if (!wasPinned) {
      roomTransports.set(payload.voiceChannelId, transport);
    }
    if (!wasPinned) {
      // Pinned: every later join reads the pin, so the shared decision has no
      // more readers and must not answer the next call in this channel.
      forgetTransportDecision(payload.voiceChannelId);
      logEvent("voice.transportPinned", {
        channelId: payload.voiceChannelId,
        transport: roomTransports.get(payload.voiceChannelId),
        reason:
          resume.kind === "reconstruct" || resume.kind === "adopt"
            ? "resume"
            : opening?.reason,
      });
    }
    logEvent(resume.kind === "adopt" ? "voice.resume" : "voice.join", {
      peerId,
      userId: user.id,
      voiceChannelId: payload.voiceChannelId,
      roomSize: getRoomPeers(payload.voiceChannelId).length,
      resumed: resume.kind === "reconstruct" || resume.kind === "adopt",
    });
    // After the pin so the row carries the room's transport. For an adopted
    // seat this re-writes the row the adopt just claimed with the same
    // content plus whatever the permission re-check changed.
    writePeerRow(peer);

    await welcomeVoicePeer(
      peer,
      resume.kind === "reconstruct" || resume.kind === "adopt",
    );
    return;
  }

  if (payload.type === "leave-voice-room") {
    if (existingPeerId) {
      removePeer(existingPeerId);
      return;
    }
    for (const peer of peers.values()) {
      if (peer.socket === socket) {
        removePeer(peer.id);
        return;
      }
    }
    // Hangup while `/ws` was down: this socket never owned the peer. The
    // resume pair proves this user still owns that orphan; drop it now so
    // the roster does not keep a 90s ghost.
    if (payload.resumePeerId && payload.resumeToken) {
      await leaveVoiceByResumeToken(payload.resumePeerId, payload.resumeToken);
    }
    return;
  }

  if (payload.type === "set-sharing-screen") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    // Mesh encodes a screen once per peer connection; LiveKit forwards. The
    // cap is per transport so a mesh room of eight cannot grow four 2.5 Mbps
    // shares, while an SFU room can take Zoom's four. Count everyone else —
    // a live sharer re-declaring (audio-id update, rejoin) must not be refused
    // for occupying their own slot. Keep this check synchronous with the
    // write: an await between them would let two clicks both pass.
    //
    // Presenting is speaking: no SPEAK, no share. The client already hides
    // the button; this refuses the roster claim from one that did not.
    if (payload.sharing && !peer.canStream) {
      send(peer.socket, {
        type: "screen-share-denied",
        voiceChannelId: peer.voiceChannelId,
      });
      return;
    }
    if (payload.sharing) {
      const othersSharing = () =>
        getRoomPeers(peer.voiceChannelId).filter(
          (p) => p.id !== peer.id && p.sharingScreen,
        ).length;
      if (
        othersSharing() >=
        SCREEN_SHARE_LIMIT[getRoomTransport(peer.voiceChannelId)]
      ) {
        // The mesh cap is two because mesh encodes a copy per peer. Where
        // there is an SFU to move to, move the room rather than refuse the
        // share; `promoteRoomForVideo` prices the box first and answers false
        // when it cannot, which is exactly the old refusal.
        await promoteRoomForVideo(peer.voiceChannelId, "screens", user.id);
        // The await above may have outlived the socket, and the promotion
        // itself releases seats: re-read everything before the write. This is
        // the "keep the check in the same tick as the write" rule restated:
        // the counts below are the ones that decide, and they are taken after
        // every await on this path.
        if (socket.readyState !== 1 || peers.get(existingPeerId) !== peer) {
          return;
        }
        if (
          othersSharing() >=
          SCREEN_SHARE_LIMIT[getRoomTransport(peer.voiceChannelId)]
        ) {
          send(peer.socket, {
            type: "screen-share-denied",
            voiceChannelId: peer.voiceChannelId,
          });
          return;
        }
      }
    }
    peer.sharingScreen = payload.sharing;
    // Only a live share can have audio; stopping clears the id in the same
    // frame so no roster can advertise sound for a capture that is gone.
    peer.screenAudioStreamId = payload.sharing
      ? (payload.audioStreamId ?? null)
      : null;
    writePeerRow(peer);
    // Watch party scheduling seam: a scheduled session on this channel flips
    // live the moment anyone starts sharing here, and ends when the last
    // screen-share in the room stops. Fire-and-forget: a missed flip costs a
    // stale card, never a broken stream.
    if (payload.sharing) {
      void markChannelSessionLive(peer.voiceChannelId).catch((error) => {
        console.error("[channel-sessions] markLive failed:", error);
      });
    } else if (
      !getRoomPeers(peer.voiceChannelId).some((p) => p.sharingScreen)
    ) {
      void markChannelSessionEnded(peer.voiceChannelId).catch((error) => {
        console.error("[channel-sessions] markEnded failed:", error);
      });
    }
    await broadcastRoster(peer.voiceChannelId, {
      kind: "updated",
      peer: toParticipant(peer),
    });
    void pushLiveHls(peer.voiceChannelId);
    return;
  }

  // --- voice state ---
  if (payload.type === "set-voice-state") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    // A moderator's mute outranks the person's own declaration: while it
    // stands, `muted` is pinned true whatever the client says. There is no
    // refusal frame for this (the mute already reached them as a
    // `voice-moderation` notice, and `serverMuted` is on every roster they
    // hold), so a rejected unmute simply re-sends the roster, and the client
    // snaps back to the state everyone else already sees. Through the same
    // limiter as an honest toggle, so a client hammering unmute costs the
    // audience no more than one toggling mute.
    const serverMuted = isVoiceUserServerMuted(peer.voiceChannelId, peer.userId);
    const muted = serverMuted ? true : payload.muted;
    const refusedUnmute = serverMuted && !payload.muted;
    // No change, no fan-out: the client re-declares its state after every
    // (re)join, and most of those declarations are the defaults the peer
    // already has.
    if (
      peer.muted === muted &&
      peer.deafened === payload.deafened &&
      !refusedUnmute
    ) {
      return;
    }
    if (!stateLimiter.take(user.id)) {
      return;
    }
    // A listener cannot show as unmuted: the roster badge would claim a mic
    // the rules do not allow. The client keeps itself muted; this keeps the
    // display honest against one that does not. `muted` above already folds
    // in a standing moderator mute.
    peer.muted = muted || !peer.canSpeak;
    peer.deafened = payload.deafened;
    writePeerRow(peer);
    await broadcastRoster(peer.voiceChannelId, {
      kind: "updated",
      peer: toParticipant(peer),
    });
    return;
  }

  // --- watch party ---
  //
  // The audience is the ROOM, not the channel's viewers. `set-voice-state`
  // above fans out through `broadcastRoster`, which reaches everyone who can
  // see the channel, because occupancy badges are drawn for people standing
  // outside the call. A watch party is only ever meaningful to the people
  // inside it, so this uses `broadcastToRoom`, the same audience `peer-joined`
  // and `peer-left` use. That audience is a strict subset of the roster's:
  // membership of the room was granted by the join above, which is where
  // channel access, permissions, blocks and timeouts were all checked, and the
  // eviction helpers drop a peer from the room the moment any of those change.
  //
  // The sender is deliberately NOT excluded. The echo is an acknowledgement:
  // it is how a client learns its write was adopted rather than coalesced, and
  // an unechoed write is what its resend logic waits on.
  if (payload.type === "set-watch-party") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    const write = applyWatchPartyWrite(
      peer.voiceChannelId,
      payload.state,
      user.id,
    );
    if (write.kind === "coalesced") {
      return;
    }
    if (write.kind === "stale") {
      send(socket, {
        type: "watch-party",
        channelId: peer.voiceChannelId,
        state: write.held,
      });
      return;
    }
    // The row is the room's party when the flag is on, and the write is the
    // ordering the cache just applied, run again against what the cluster
    // holds. A write that lost there (this instance missed a frame, or two
    // people acted in the same instant on two machines) is handed the row's
    // winner, exactly as a local loser is handed the held state above. A
    // failed write degrades to the local decision, like every registry write.
    if (registryOn()) {
      let persisted: Awaited<ReturnType<typeof persistWatchParty>> | null =
        null;
      try {
        persisted = await persistWatchParty(peer.voiceChannelId, write.state);
      } catch (error) {
        logEvent("voice.registryWriteFailed", {
          op: "watchParty",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (persisted?.kind === "stale") {
        adoptWatchPartyState(peer.voiceChannelId, persisted.held);
        send(socket, {
          type: "watch-party",
          channelId: peer.voiceChannelId,
          state: persisted.held,
        });
        return;
      }
    }
    broadcastToRoom(peer.voiceChannelId, {
      type: "watch-party",
      channelId: peer.voiceChannelId,
      state: write.state,
    });
    if (clusterOn()) {
      publishVoice(VOICE_WATCH_TOPIC, {
        channelId: peer.voiceChannelId,
        state: write.state,
      } satisfies VoiceWatchFrame);
    }
    return;
  }

  // --- live reactions ---
  //
  // The audience is the ROOM, for the same reason the watch party's is: a
  // reaction floats over a shared screen, and only the people inside the call
  // are looking at one. Membership of `peers` IS that audience lookup: it is
  // what `peer-joined`, `peer-left` and the watch party all fan out to, and it
  // was granted by the join above, where channel access, permissions, blocks
  // and timeouts were checked and where every eviction path removes a peer the
  // moment one of those changes. So there is no second membership check here
  // and there must not be one: a check written separately from the room is a
  // check that eventually disagrees with it.
  //
  // `channelId` on the frame is a statement of intent, not an address. It is
  // compared against the room the sender actually holds and the frame is
  // dropped when they differ, so a client that raced a channel switch cannot
  // spray confetti into the room it just left.
  //
  // The sender is NOT excluded from the fan-out, but the client does not wait
  // for it either: the bar echoes the tap locally the instant it is pressed.
  // The window that comes back is drawn on top of that echo, which for
  // particles nobody counts is invisible, and the alternative of suppressing
  // the sender's own window would make one person's screen quieter than
  // everybody else's during a burst.
  if (payload.type === "live-reaction") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer || peer.voiceChannelId !== payload.channelId) {
      return;
    }
    // The answer is deliberately unused. A refused tap is silence: see
    // `offerLiveReaction`.
    offerLiveReaction(peer.voiceChannelId, payload.emoji, existingPeerId);
    return;
  }

  // Conversation-call frames — the logic lives in the bannered section below.
  // `call-decline` is deliberately dispatched before the peer requirement:
  // a decliner is by definition NOT in the room and holds no voice peer.
  if (payload.type === "set-camera") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    // Same rule as screen share: count everyone else, keep the check in the
    // same tick as the write, and never refuse a live camera that is only
    // re-declaring (a device switch sends a new stream id). Turning off is
    // always allowed.
    if (payload.streamId && !peer.canStream) {
      send(peer.socket, {
        type: "camera-denied",
        voiceChannelId: peer.voiceChannelId,
      });
      return;
    }
    if (payload.streamId) {
      const othersOn = () =>
        getRoomPeers(peer.voiceChannelId).filter(
          (p) => p.id !== peer.id && p.cameraStreamId,
        ).length;
      if (othersOn() >= CAMERA_LIMIT[getRoomTransport(peer.voiceChannelId)]) {
        // THE FOURTH CAMERA. Three is the mesh ceiling because a mesh camera
        // is a full uplink copy per peer; it is not a ceiling on how many
        // friends want to be seen. Move the room to the SFU and let the
        // camera on. See the promotion section for what makes that safe and
        // what stops it (the box's budget).
        await promoteRoomForVideo(peer.voiceChannelId, "cameras", user.id);
        if (socket.readyState !== 1 || peers.get(existingPeerId) !== peer) {
          return;
        }
        if (othersOn() >= CAMERA_LIMIT[getRoomTransport(peer.voiceChannelId)]) {
          send(peer.socket, {
            type: "camera-denied",
            voiceChannelId: peer.voiceChannelId,
          });
          return;
        }
      }
    }
    peer.cameraStreamId = payload.streamId;
    writePeerRow(peer);
    await broadcastRoster(peer.voiceChannelId, {
      kind: "updated",
      peer: toParticipant(peer),
    });
    return;
  }

  if (payload.type === "call-ring") {
    await handleCallRing(session, payload.conversationId);
    return;
  }

  if (payload.type === "call-decline") {
    handleCallDecline(user, payload.conversationId);
    return;
  }

  // --- live HLS watch mode (no seat) ---
  if (payload.type === "watch-live") {
    // The join limiter, because this is the same shape: one access query
    // per frame from a socket that has no peer yet.
    if (!roomLimiter.take(user.id)) {
      return;
    }
    // A socket without VIEW is ignored, not answered: an error frame would
    // confirm the channel exists to somebody who cannot see it.
    if (!(await canAccessChannel(payload.channelId, user.id))) {
      return;
    }
    if (socket.readyState !== 1) {
      return;
    }
    if (payload.watching && !socketIsInRoom(socket, payload.channelId)) {
      hlsAudience.subscribe(payload.channelId, socket);
    } else {
      hlsAudience.unsubscribe(payload.channelId, socket);
    }
    // This socket alone, right away. The audience hears the new count on the
    // keyframe, never per subscribe.
    send(socket, channelLiveFrame(payload.channelId, user.id));
    hlsAudienceFramesSent.frames += 1;
    return;
  }

  if (!existingPeerId) {
    return;
  }

  if (!isClientRelayMessage(payload)) {
    return;
  }

  const fromPeer = peers.get(existingPeerId);
  if (!fromPeer || payload.from !== existingPeerId) {
    return;
  }

  // Mesh signaling inside an SFU room means the sender built a peer mesh in a
  // room that is not running one. The target has no peer-connection manager and
  // drops the frame anyway; refusing it here makes the mistake visible in the
  // logs instead of leaving a client half-connected to a call it cannot hear.
  if (getRoomTransport(fromPeer.voiceChannelId) !== "mesh") {
    logEvent("voice.meshRelayInSfuRoom", {
      userId: fromPeer.userId,
      voiceChannelId: fromPeer.voiceChannelId,
      messageType: payload.type,
    });
    return;
  }

  const toPeer = peers.get(payload.to);
  if (!toPeer) {
    // Not held here. With the cluster on, the peer may be seated on the
    // other instance (a mesh room spans machines since the guard adopts
    // the pin): the frame crosses on `voice.signal`, stamped with the
    // sender's room, and the instance holding the target enforces the
    // same-room rule below against ITS map. An id nobody holds is dropped
    // by every receiver, so the sender learns nothing from the attempt.
    if (clusterOn()) {
      publishVoice(VOICE_SIGNAL_TOPIC, {
        channelId: fromPeer.voiceChannelId,
        frame: payload,
      } satisfies VoiceSignalFrame);
    }
    return;
  }

  // Only relay signaling between peers in the same voice room. Without this a
  // member of one room could open a WebRTC connection to a peer in another
  // room/server and pull their microphone audio.
  if (fromPeer.voiceChannelId !== toPeer.voiceChannelId) {
    return;
  }

  relayToTarget(payload);
}

// --- conversation calls -----------------------------------------------------
//
// A server voice channel is join-when-you-want; a conversation call RINGS.
// Everything below is the ringing lifecycle for DM / group-DM channels, and
// nothing in it may ever reach a server surface: every frame goes either to
// the room's peers or to the conversation's *participants*, resolved through
// `resolveRingableConversation` / `getChannelAudience`, whose conversation
// branch is `channel_members` and nothing else (`channelVisibleSql` is the
// law here — a conversation belongs to nobody, so there is no admin escape
// hatch and no server roster to leak into).
//
// The room mechanics above are untouched: a conversation call *is* a voice
// room on the conversation's channel id, with the same pinned transport, the
// same mesh ceiling and the same block/timeout checks at join. Ringing is a
// layer on top — "tell the absent participants the room went live" — plus the
// missed-call record when nobody came.

/** How long a call rings before it is recorded as missed. */
export const CALL_RING_TIMEOUT_MS = 45_000;

/**
 * How long an empty room keeps its ring alive. A rejoin (the reconnect path
 * removes the old peer before adding the new one) empties the room for a
 * moment, and a flappy caller network can empty it for a few seconds; killing
 * the ring on the first empty read would turn every caller hiccup into a
 * "missed call" that nobody missed.
 */
export const CALL_EMPTY_ROOM_GRACE_MS = 5_000;

/** What the missed-call record says. Stored as a normal message body. */
export const MISSED_CALL_BODY = "📞 Missed call";

interface ConversationRing {
  conversationId: string;
  kind: "dm" | "group";
  /** Kept whole: the missed-call message is authored by the caller. */
  caller: DbUser;
  /** Callees who have neither answered nor declined yet. */
  pending: Set<string>;
  /** The subset of `pending` that was actually sent `call-incoming` — DND and
   *  people who blocked the caller are rung silently (i.e. not at all). */
  rung: Set<string>;
  /** True once any callee joined; a call somebody answered is never "missed". */
  anyoneAnswered: boolean;
  timer: ReturnType<typeof setTimeout>;
  emptyRoomTimer: ReturnType<typeof setTimeout> | null;
}

const conversationRings = new Map<string, ConversationRing>();

/** Ringing fans out to every participant's every socket; keep it rare. */
const ringLimiter = createRateLimiter({ capacity: 5, refillPerSecond: 0.2 });

/** Test hook: forget every active ring and its timers. */
export function resetConversationCalls(): void {
  for (const ring of conversationRings.values()) {
    clearTimeout(ring.timer);
    if (ring.emptyRoomTimer) {
      clearTimeout(ring.emptyRoomTimer);
    }
  }
  conversationRings.clear();
  ringLimiter.reset();
}

/** Whether a conversation currently has an unanswered ring (for tests/UI). */
export function isConversationRinging(conversationId: string): boolean {
  return conversationRings.has(conversationId);
}

/** Returns how many sockets were sent the frame. */
function sendToUserSockets(
  userIds: ReadonlySet<string>,
  frame: VoiceSignalingMessage,
): number {
  if (userIds.size === 0) {
    return 0;
  }
  const encoded = JSON.stringify(frame);
  let sent = 0;
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState === 1 && userIds.has(user.id)) {
      socket.send(encoded);
      sent += 1;
    }
  });
  return sent;
}

/**
 * A ring frame to every socket these people hold, on every instance. The
 * ring itself (timers, `pending`, `rung`) is owned by the instance holding
 * the caller's socket (plan section 5.5); only the fan-out crosses, so the
 * other instance never decides anything, it delivers.
 */
function fanToUserSockets(
  userIds: ReadonlySet<string>,
  frame: VoiceCallDelivery,
): void {
  sendToUserSockets(userIds, frame);
  if (userIds.size > 0 && clusterOn()) {
    publishVoice(VOICE_CALL_TOPIC, {
      kind: "deliver",
      userIds: [...userIds],
      frame,
    } satisfies VoiceCallFrame);
  }
}

async function handleCallRing(
  session: { socket: WebSocket; user: DbUser },
  conversationId: string,
): Promise<void> {
  const { socket, user } = session;
  if (!ringLimiter.take(user.id)) {
    return;
  }
  // Only a live peer of exactly this room may ring it. The join is where
  // access, blocks, timeouts and transport were enforced, so requiring the
  // peer means a forged `call-ring` cannot reach anybody the sender could not
  // already sit in a call with.
  const peerId = socketToPeerId.get(socket);
  const peer = peerId ? peers.get(peerId) : undefined;
  if (!peer || peer.voiceChannelId !== conversationId) {
    return;
  }
  // One ring per call. A second `call-ring` while one is live would re-buzz
  // people who already ignored it.
  if (conversationRings.has(conversationId)) {
    return;
  }

  const channel = await getChannel(conversationId);
  if (!channel || channel.kind === "server") {
    return;
  }
  const participants = await resolveRingableConversation(conversationId, user.id);
  if (!participants) {
    return;
  }

  // The awaits above: the caller may have hung up or the socket died. A ring
  // whose room is already empty would be a missed call nobody placed.
  if (socketToPeerId.get(socket) !== peerId || !peers.has(peerId!)) {
    return;
  }

  const present = new Set(getRoomPeers(conversationId).map((p) => p.userId));
  if (registryOn()) {
    // Somebody already in the call on the other machine is not rung.
    try {
      for (const row of await listVoicePeersInRoom(conversationId)) {
        present.add(row.userId);
      }
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "ringPresent",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (socketToPeerId.get(socket) !== peerId || !peers.has(peerId!)) {
      return;
    }
  }
  const absent = participants.filter(
    (id) => id !== user.id && !present.has(id),
  );
  if (absent.length === 0) {
    return;
  }

  // Quiet exclusions. DND means "do not interrupt me": no ring, and the missed
  // call lands as an ordinary quiet message. Somebody who blocked the caller
  // hears nothing either — in a 1:1 the join was already refused outright, so
  // this only matters for the soft-block inside a group.
  const blockers = await listBlockersOf(user.id);
  const pending = new Set(absent);
  const rung = new Set(
    absent.filter(
      (id) => !blockers.has(id) && resolveStatus(id) !== "dnd",
    ),
  );

  const ring: ConversationRing = {
    conversationId,
    kind: channel.kind === "group" ? "group" : "dm",
    caller: user,
    pending,
    rung,
    anyoneAnswered: false,
    timer: setTimeout(() => {
      void endConversationRing(conversationId, "timeout");
    }, CALL_RING_TIMEOUT_MS),
    emptyRoomTimer: null,
  };
  conversationRings.set(conversationId, ring);

  logEvent("voice.callRing", {
    conversationId,
    callerId: user.id,
    pending: pending.size,
    rung: rung.size,
  });

  fanToUserSockets(rung, {
    type: "call-incoming",
    conversationId,
    kind: ring.kind,
    caller: {
      userId: user.id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
    },
  });

  // The same ring, for phones with the app closed. `rung` is THE decision —
  // participants minus blockers minus live-DND — and push narrows it only by
  // what a socket fan-out cannot know: no socket anywhere in the cluster, and
  // a stored DND the live registry reads as merely "offline". Short-TTL and
  // high-urgency inside (`CALL_PUSH_TTL_SECONDS`); fire-and-forget so the
  // ring never waits on, or dies with, a push vendor. Only the ring's owner
  // runs this function (a `voice.call` frame delivers, it never rings), so
  // this cannot double-send across replicas.
  pushIncomingCall({
    conversationId,
    kind: ring.kind,
    rungUserIds: [...rung],
    callerName: user.display_name,
  });
}

/**
 * Accepting a call is joining the room — there is no separate accept frame.
 * Also clears the empty-room grace timer on ANY join (the caller rejoining
 * after a blip must not let the grace timer kill their own ring).
 */
function noteConversationCallJoin(conversationId: string, userId: string) {
  if (answerRing(conversationId, userId)) {
    return;
  }
  // No ring here. If the call was placed from the other machine, that one
  // owns the ring and is the one to tell; a frame for a room nobody is
  // ringing is dropped there. Every join costs one small frame for this,
  // which is cheaper than knowing the channel's kind on this path.
  if (clusterOn()) {
    publishVoice(VOICE_CALL_TOPIC, {
      kind: "answered",
      conversationId,
      userId,
    } satisfies VoiceCallFrame);
  }
}

/** The owner's half of a join: false when no ring lives here. */
function answerRing(conversationId: string, userId: string): boolean {
  const ring = conversationRings.get(conversationId);
  if (!ring) {
    return false;
  }
  if (ring.emptyRoomTimer) {
    clearTimeout(ring.emptyRoomTimer);
    ring.emptyRoomTimer = null;
  }
  if (!ring.pending.delete(userId)) {
    return true;
  }
  ring.rung.delete(userId);
  ring.anyoneAnswered = true;
  // Their other devices stop ringing; everyone still pending keeps ringing.
  fanToUserSockets(new Set([userId]), {
    type: "call-ring-cancelled",
    conversationId,
    reason: "answered",
  });
  if (ring.pending.size === 0) {
    clearRing(ring);
  }
  return true;
}

function handleCallDecline(user: DbUser, conversationId: string) {
  if (declineRing(conversationId, user.id)) {
    return;
  }
  // Not rung from here: route it to whoever owns the ring. The owner still
  // checks `pending`, so a decline for a call the sender was never rung
  // for is dropped there exactly as it is dropped here.
  if (clusterOn()) {
    publishVoice(VOICE_CALL_TOPIC, {
      kind: "decline",
      conversationId,
      userId: user.id,
    } satisfies VoiceCallFrame);
  }
}

/** The owner's half of a decline: false when no ring lives here. */
function declineRing(conversationId: string, userId: string): boolean {
  const ring = conversationRings.get(conversationId);
  if (!ring) {
    return false;
  }
  if (!ring.pending.delete(userId)) {
    return true;
  }
  ring.rung.delete(userId);
  // Other devices of the decliner stop ringing…
  fanToUserSockets(new Set([userId]), {
    type: "call-ring-cancelled",
    conversationId,
    reason: "declined",
  });
  // …and the people in the call stop waiting for them, wherever they sit.
  const declined: VoiceSignalingMessage = {
    type: "call-declined",
    conversationId,
    userId,
  };
  broadcastToRoom(conversationId, declined);
  if (clusterOn()) {
    publishVoice(VOICE_CALL_TOPIC, {
      kind: "room",
      channelId: conversationId,
      frame: declined,
    } satisfies VoiceCallFrame);
  }
  logEvent("voice.callDeclined", { conversationId, userId });
  if (ring.pending.size === 0) {
    if (ring.anyoneAnswered) {
      clearRing(ring);
    } else {
      // Everyone said no: the ring is over and the record is a missed call.
      void endConversationRing(conversationId, "cancelled");
    }
  }
  return true;
}

/**
 * The room emptied here. After the grace period, an unanswered ring dies
 * with it. With the registry on the expiry check reads the rows as well,
 * because the caller may have come back on the other machine: an empty
 * local room is not an empty call.
 */
function noteVoiceRoomEmptied(voiceChannelId: string) {
  const ring = conversationRings.get(voiceChannelId);
  if (!ring || ring.emptyRoomTimer) {
    return;
  }
  ring.emptyRoomTimer = setTimeout(() => {
    ring.emptyRoomTimer = null;
    if (getRoomPeers(voiceChannelId).length > 0) {
      return;
    }
    if (!registryOn()) {
      void endConversationRing(voiceChannelId, "cancelled");
      return;
    }
    void listVoicePeersInRoom(voiceChannelId)
      .catch(() => [])
      .then((rows) => {
        if (
          rows.length === 0 &&
          getRoomPeers(voiceChannelId).length === 0 &&
          conversationRings.get(voiceChannelId) === ring &&
          ring.emptyRoomTimer === null
        ) {
          void endConversationRing(voiceChannelId, "cancelled");
        }
      });
  }, CALL_EMPTY_ROOM_GRACE_MS);
}

/** Remove the ring without any missed-call record (it was answered). */
function clearRing(ring: ConversationRing) {
  clearTimeout(ring.timer);
  if (ring.emptyRoomTimer) {
    clearTimeout(ring.emptyRoomTimer);
  }
  conversationRings.delete(ring.conversationId);
}

async function endConversationRing(
  conversationId: string,
  reason: "timeout" | "cancelled",
): Promise<void> {
  const ring = conversationRings.get(conversationId);
  if (!ring) {
    return;
  }
  clearRing(ring);
  fanToUserSockets(ring.rung, {
    type: "call-ring-cancelled",
    conversationId,
    reason,
  });
  logEvent("voice.callEnded", {
    conversationId,
    reason,
    answered: ring.anyoneAnswered,
  });
  if (!ring.anyoneAnswered) {
    await postMissedCallMessage(ring);
  }
}

/**
 * The missed-call record: an ordinary message from the caller, so history,
 * unread badges, blocks and retention all treat it like anything else said in
 * the conversation. The activity ping mirrors chat's own fan-out — audience
 * only, blockers of the caller excluded, never a mention — so a DND callee
 * gets the quiet badge and nothing louder.
 */
async function postMissedCallMessage(ring: ConversationRing): Promise<void> {
  try {
    const dbMessage = await createMessage(
      ring.conversationId,
      ring.caller,
      MISSED_CALL_BODY,
    );
    if (!dbMessage) {
      return;
    }
    broadcastToChannel(ring.conversationId, {
      type: "message-broadcast",
      message: mapMessage(dbMessage),
    });

    const [audience, blockers] = await Promise.all([
      getChannelAudience(ring.conversationId),
      listBlockersOf(ring.caller.id),
    ]);
    if (!audience) {
      return;
    }
    const activity = JSON.stringify({
      type: "channel-activity",
      // Null by construction — a conversation has no server. Asserted rather
      // than assumed: a server id here would file this badge into a sidebar.
      serverId: audience.serverId,
      kind: audience.kind,
      channelId: ring.conversationId,
      mention: false,
    });
    forEachAuthenticatedSocket((socket, socketUser) => {
      if (
        socket.readyState !== 1 ||
        socketUser.id === ring.caller.id ||
        !audience.has(socketUser.id) ||
        blockers.has(socketUser.id)
      ) {
        return;
      }
      socket.send(activity);
    });

    // The Web Push leg the socket loop above cannot reach: the missed-call
    // record is created here, not through chat's message handler, so without
    // this the one person a missed call most concerns — the callee whose
    // phone is closed — would never hear of it. Same conclusions handed over
    // as `notifyChannelActivity` hands its own (audience, blockers, never a
    // mention); push adds its usual narrowing (no socket, DND, level). Its
    // tag is the conversation id, the same tag as the call push, so at the
    // vendor "Incoming call" is *replaced* by the missed-call notice rather
    // than stacking beside it.
    pushChannelActivity({
      channelId: ring.conversationId,
      audience,
      authorId: ring.caller.id,
      mentionedUsernames: [],
      repliedToUserId: null,
      blockerIds: blockers,
    });
  } catch (error) {
    // A missed missed-call record must never take the voice handler down —
    // pitfall #9: an unhandled rejection here is a full-server crash.
    console.error("[voice] failed to record missed call:", error);
  }
}

// --- end conversation calls -------------------------------------------------

// --- voice moderation ---------------------------------------------------------
//
// Server-side voice sanctions, called from the bannered voice-moderation routes
// in api/index.ts. These reuse the eviction machinery above — both halves, mesh
// and SFU — and add the one thing a route-triggered eviction owes that a
// kick/ban does not: the target is *told*, before their peer is dropped, in a
// frame that carries the whole sentence (the sanction-notice principle). A
// person ejected from voice with no notice has been handed a broken app, not a
// moderation outcome.
//
// Scope: `peers` is per-instance, so on their own these helpers see (and
// notify) targets whose WebSocket lands on this instance. With the registry
// on, `findVoiceChannelForUser` finds a target on the other machine by row,
// and the notice and the drop cross on `voice.moderation` (M4): the instance
// holding the socket says the sentence and forgets the peer, this one
// releases the row and runs the SFU half once.

/**
 * The server voice channel this user is currently connected to, restricted to
 * the given channel set (a server's channels). Null when they are not in any —
 * including when they are only in a DM call, which a server's moderators have
 * no authority over.
 */
export function getVoiceChannelForUser(
  userId: string,
  channelIds: ReadonlySet<string>,
): string | null {
  for (const peer of peers.values()) {
    if (peer.userId === userId && channelIds.has(peer.voiceChannelId)) {
      return peer.voiceChannelId;
    }
  }
  return null;
}

/**
 * peer id → user id for this user's peers in one room — what the SFU helpers
 * need to identify a participant whose token predates the metadata fields.
 */
export function getVoicePeerIdentities(
  userId: string,
  voiceChannelId: string,
): Map<string, string> {
  return identityMapFor(
    getRoomPeers(voiceChannelId).filter((peer) => peer.userId === userId),
  );
}

// The cluster-aware pair of the two lookups above, for the moderation routes.
// Local map first (free, and exact for anybody on this instance), then the
// registry rows when the flag is on, so a moderator's target on the *other*
// machine is still found and still reaches the SFU. The notice and the mesh
// half stay local in M1; `voice.moderation` over the bus is M4.

export async function findVoiceChannelForUser(
  userId: string,
  channelIds: ReadonlySet<string>,
): Promise<string | null> {
  const local = getVoiceChannelForUser(userId, channelIds);
  if (local || !registryOn()) {
    return local;
  }
  try {
    for (const row of await listVoicePeersForUser(userId)) {
      if (channelIds.has(row.channelId)) {
        return row.channelId;
      }
    }
  } catch (error) {
    logEvent("voice.registryReadFailed", {
      op: "channelForUser",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

export async function findVoicePeerIdentities(
  userId: string,
  voiceChannelId: string,
): Promise<Map<string, string>> {
  const known = getVoicePeerIdentities(userId, voiceChannelId);
  if (!registryOn()) {
    return known;
  }
  try {
    for (const row of await listVoicePeersInRoom(voiceChannelId)) {
      if (row.userId === userId) {
        known.set(row.peerId, row.userId);
      }
    }
  } catch (error) {
    logEvent("voice.registryReadFailed", {
      op: "peerIdentities",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return known;
}

/**
 * Deliver a `voice-moderation` frame to every socket this user holds in the
 * room. Used on its own for the SFU mute (where the peer stays), and by
 * `disconnectVoiceUser` before the peer is dropped.
 */
export function notifyVoiceModeration(
  userId: string,
  voiceChannelId: string,
  notice: VoiceModerationNotice,
): void {
  notifyLocalVoiceModeration(userId, voiceChannelId, notice);
  if (clusterOn()) {
    publishVoice(VOICE_MODERATION_TOPIC, {
      kind: "notify",
      userId,
      channelId: voiceChannelId,
      notice,
    } satisfies VoiceModerationFrame);
  }
}

/** Returns how many seats of this person were told. */
function notifyLocalVoiceModeration(
  userId: string,
  voiceChannelId: string,
  notice: VoiceModerationNotice,
): number {
  let told = 0;
  for (const peer of getRoomPeers(voiceChannelId)) {
    if (peer.userId !== userId) {
      continue;
    }
    send(peer.socket, {
      type: "voice-moderation",
      action: notice.action,
      voiceChannelId,
      ...(notice.movedToChannelId
        ? { movedToChannelId: notice.movedToChannelId }
        : {}),
      message: notice.message,
    });
    told += 1;
  }
  return told;
}

/**
 * Eject one user from one room, with notice — the moderator's "disconnect from
 * voice" and the eviction half of "move to channel".
 *
 * Ordering matters: the notice must leave first, because `removePeer` is what
 * ends the session, and a frame sent after it would race the socket teardown
 * on a kicked-from-server target. The SFU half runs unconditionally and
 * fire-and-forget, exactly like the evictions above — the route has already
 * committed (and audit-logged) the action, and an SFU outage must not unwind
 * it.
 */
export function disconnectVoiceUser(
  userId: string,
  voiceChannelId: string,
  notice: { movedToChannelId?: string; message: string },
  /** Peer ids seen elsewhere in the cluster (`findVoicePeerIdentities`), merged into the SFU sweep's hint. */
  knownIdentities: Map<string, string> = getVoicePeerIdentities(
    userId,
    voiceChannelId,
  ),
): void {
  for (const [peerId, owner] of getVoicePeerIdentities(userId, voiceChannelId)) {
    knownIdentities.set(peerId, owner);
  }

  const sentence: VoiceModerationNotice = {
    action: notice.movedToChannelId ? "moved" : "disconnected",
    ...(notice.movedToChannelId
      ? { movedToChannelId: notice.movedToChannelId }
      : {}),
    message: notice.message,
  };
  // Local only: the cluster hears the notice inside the eviction frame, so
  // the other instance says it once, right before it drops the peer.
  notifyLocalVoiceModeration(userId, voiceChannelId, sentence);
  for (const peer of getRoomPeers(voiceChannelId)) {
    if (peer.userId === userId) {
      removePeer(peer.id);
    }
  }
  if (registryOn()) {
    void evictForeign(
      { kind: "user", userId, channelIds: [voiceChannelId], notice: sentence },
      listVoicePeersInRoom(voiceChannelId),
      (row) => row.userId === userId,
      "moderation",
      (known) => evictSfuUser(userId, [voiceChannelId], known),
      knownIdentities,
    );
    return;
  }
  void evictSfuUser(userId, [voiceChannelId], knownIdentities);
}

// --- end voice moderation -----------------------------------------------------

// --- speak permission ---------------------------------------------------------
//
// SPEAK is resolved at join and written into the peer (and, on the SFU, into
// the token's publish grant). That is right until somebody edits a role or a
// channel overwrite while people are in the room, which is exactly when an
// owner is *making* a stage. So every permissions bump for a server re-resolves
// the bit for everyone in that server's rooms and pushes the difference:
//
// - to the person, as `voice-speak-changed`, so the client mutes or unlocks;
// - to the SFU, as a participant permission update, so a client that ignores
//   the frame is silenced by LiveKit anyway (and a newly allowed one can
//   publish without re-minting a token);
// - to the roster, since `canSpeak` rides on every participant.
//
// A mesh room gets the first and third only. There the media never touches
// this process, so the client is the enforcement; `docs/voice-backends.md`
// says so under "Speak permission".

/**
 * Re-resolve SPEAK for every peer in this server's voice rooms and apply the
 * changes. Cheap when nothing is in voice (one Set walk); one `getChannel`
 * per occupied room and one permission resolution per distinct user in the
 * rooms that belong to `serverId` otherwise. Never throws.
 */
export async function reevaluateVoiceSpeak(serverId: string): Promise<void> {
  const rooms = new Set<string>();
  for (const peer of peers.values()) {
    rooms.add(peer.voiceChannelId);
  }
  for (const voiceChannelId of rooms) {
    let channel;
    try {
      channel = await getChannel(voiceChannelId);
    } catch (error) {
      console.error("[voice] speak re-check: channel lookup failed:", error);
      continue;
    }
    if (!channel || channel.kind !== "server" || channel.server_id !== serverId) {
      continue;
    }
    const byUser = new Map<string, VoicePeer[]>();
    for (const peer of getRoomPeers(voiceChannelId)) {
      const list = byUser.get(peer.userId) ?? [];
      list.push(peer);
      byUser.set(peer.userId, list);
    }
    const relabelled: VoicePeer[] = [];
    for (const [userId, userPeers] of byUser) {
      let next;
      try {
        next = await resolveVoicePublish(channel, voiceChannelId, userId);
      } catch (error) {
        console.error("[voice] speak re-check failed:", error);
        continue;
      }
      const changed = userPeers.filter(
        (peer) =>
          peer.canSpeak !== next.canSpeak || peer.canStream !== next.canStream,
      );
      if (changed.length === 0) {
        continue;
      }
      relabelled.push(...changed);
      for (const peer of changed) {
        peer.canSpeak = next.canSpeak;
        peer.canStream = next.canStream;
        if (!next.canSpeak) {
          peer.muted = true;
        }
        if (!next.canStream) {
          peer.sharingScreen = false;
          peer.screenAudioStreamId = null;
          peer.cameraStreamId = null;
        }
        send(peer.socket, {
          type: "voice-speak-changed",
          voiceChannelId,
          canSpeak: next.canSpeak,
          canStream: next.canStream,
        });
        writePeerRow(peer);
      }
      logEvent("voice.speakChanged", {
        userId,
        voiceChannelId,
        canSpeak: next.canSpeak,
        canStream: next.canStream,
        transport: getRoomTransport(voiceChannelId),
      });
      if (getRoomTransport(voiceChannelId) === "livekit") {
        void setSfuUserCanPublish(
          voiceChannelId,
          userId,
          next,
          identityMapFor(userPeers),
        );
      }
    }
    // One `updated` per peer whose bits moved, so this is a delta the size of
    // the change rather than a whole roster to the whole server every time an
    // owner edits a role while a stage is running.
    let announced: Promise<void> | null = null;
    for (const peer of relabelled) {
      announced = broadcastRoster(voiceChannelId, {
        kind: "updated",
        peer: toParticipant(peer),
      });
    }
    if (announced) {
      await announced;
    }
  }
}

onPermissionsUpdate((serverId) => {
  void reevaluateVoiceSpeak(serverId).catch((error) => {
    console.error("[voice] speak re-check failed:", error);
  });
});

// --- end speak permission -----------------------------------------------------

// --- promotion: the one time a live room changes transport ---------------------
//
// Read the banner over `roomTransports` first. The rule there is absolute and
// it stays absolute in the direction that matters: nothing moves a call from
// the SFU back to a mesh, and nothing moves a room while half of it is left
// behind.
//
// WHAT CHANGED. `CAMERA_LIMIT.mesh` is three, and it is three for a real
// reason: a mesh camera is a full uplink copy per peer, so the fourth camera
// in a six-person mesh room asks each publisher for about 7.5 Mbit/s of
// upload. The complaint that produced this ("não dá pra ter mais de 3 câmeras
// ligadas nessa porra") was not about the number. It was about the answer: the
// camera was refused, and the room was on mesh only because the server has
// fewer than `LARGE_SERVER_MEMBER_THRESHOLD` members, which is a guess about
// how many people might show up and predicts nothing about how many of the
// five who did want their faces on. Where LiveKit is configured the SFU can
// carry those cameras, so the room goes there and the camera turns on.
//
// THE FOUR THINGS THAT MAKE IT SAFE:
//
// 1. The pin is rewritten before anybody is told. With the registry on that is
//    one conditional UPDATE (`promoteVoiceRoomTransport`), so two people
//    clicking their camera in the same second, on one machine or on two,
//    produce one promotion and one announcement.
// 2. Every seat is told, here and on the other instances, over `voice.transport`.
// 3. A seat whose socket never negotiated `SOCKET_CAPS.voiceTransportChanged`
//    is NOT left building a mesh in a room whose media has moved. That is the
//    original split-brain bug and it is invisible on every screen. It is
//    released instead, and told, so it can rejoin onto the SFU. iOS and
//    Android are in that group today (see `docs/PARITY.md`).
// 4. The box has a budget. Every promoted room is egress on one media server
//    (`docs/CAPACITY.md`), and the click that spends it is a user's, so
//    `voice/promotion.ts` prices the room and refuses over
//    `VOICE_PROMOTION_MAX_SFU_MBPS` (600 Mbit/s by default, against a box
//    measured clean at 880 to 935). A refusal is the old camera limit, exactly
//    as before this existed.

export type VoicePromotionReason = "cameras" | "screens";

/**
 * In-flight promotions, keyed by room, shared by every caller racing to be
 * the one that moves it.
 *
 * The same shape as `pendingTransportDecisions` above and for the same
 * reason: the work behind a promotion is asynchronous (the SFU probe, the
 * cluster's room list, the conditional UPDATE), and the whole point of the
 * feature is that it fires when several people turn cameras on at once. Two
 * `set-camera` frames that both cross the mesh cap in the same tick must cost
 * one probe, one UPDATE and one announcement.
 */
const pendingPromotions = new Map<string, Promise<boolean>>();

/** Test hook: forget any in-flight promotion. */
export function resetVoicePromotions(): void {
  pendingPromotions.clear();
}

/** How many seats in a room are publishing video right now. */
function countVideoPublishers(
  people: readonly { sharingScreen: boolean; cameraStreamId: string | null }[],
): number {
  return people.filter(
    (person) => person.sharingScreen || person.cameraStreamId,
  ).length;
}

/**
 * Every room the process can see, priced for the budget guard.
 *
 * With the registry on this is the cluster's rooms, which is the number that
 * matters: the media box is shared by every instance. With it off there is
 * only one instance, so its own map is the whole truth.
 */
async function readRoomLoads(): Promise<SfuRoomLoad[]> {
  if (registryOn()) {
    try {
      const rooms = await listVoiceRosters();
      return rooms.map((room) => ({
        channelId: room.channelId,
        transport: room.transport,
        participants: room.peers.length,
        videoPublishers: countVideoPublishers(room.peers),
      }));
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "promotionLoad",
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall through to the local view rather than refusing: this instance's
      // own rooms are still a floor, and a database blip must not be a
      // silent, permanent "no more cameras" for everybody.
    }
  }
  const byRoom = new Map<string, SfuRoomLoad>();
  for (const peer of peers.values()) {
    let room = byRoom.get(peer.voiceChannelId);
    if (!room) {
      room = {
        channelId: peer.voiceChannelId,
        transport: getRoomTransport(peer.voiceChannelId),
        participants: 0,
        videoPublishers: 0,
      };
      byRoom.set(peer.voiceChannelId, room);
    }
    room.participants += 1;
    if (peer.sharingScreen || peer.cameraStreamId) {
      room.videoPublishers += 1;
    }
  }
  return [...byRoom.values()];
}

/**
 * Apply a promotion to the seats THIS instance holds: the pin, the frame for
 * everyone who can follow it, and the release of everyone who cannot.
 *
 * Runs on the instance that decided the promotion and, through
 * `voice.transport`, on every other instance holding seats in the room. It
 * never publishes anything itself (the same rule as every other bus
 * subscriber) and it is safe to run twice: setting the pin to a value it
 * already holds changes nothing, and a released seat is gone the first time.
 */
function applyPromotionLocally(
  voiceChannelId: string,
  transport: VoiceRoomTransport,
  reason: VoicePromotionReason,
): void {
  const seated = getRoomPeers(voiceChannelId);
  if (seated.length > 0) {
    roomTransports.set(voiceChannelId, transport);
  } else {
    noteRemoteTransport(voiceChannelId, transport);
  }
  forgetTransportDecision(voiceChannelId);
  if (seated.length === 0) {
    return;
  }
  // The room as it stands, so a client can build its SFU session without
  // waiting for a roster. Computed once, before anyone is released, so every
  // follower gets the same list.
  const participants = seated.map(toParticipant);
  const released: VoicePeer[] = [];
  let moved = 0;
  let orphaned = 0;
  for (const peer of seated) {
    // An orphan is a refresh in flight: its socket is gone, so it can neither
    // be told nor be asked to follow, and its resume re-runs the join, which
    // reads the new pin and cold-joins onto the SFU. Releasing it here would
    // turn a refresh into a dropped call.
    if (peer.orphanedAt !== undefined) {
      orphaned += 1;
      continue;
    }
    if (socketHasCap(peer.socket, SOCKET_CAPS.voiceTransportChanged)) {
      moved += 1;
      send(peer.socket, {
        type: "voice-transport-changed",
        voiceChannelId,
        transport,
        reason,
        participants,
      });
      continue;
    }
    released.push(peer);
  }
  for (const peer of released) {
    // The notice first: `removePeer` is what ends the seat, and a frame sent
    // after it races the roster the client is about to rebuild.
    send(peer.socket, {
      type: "voice-transport-unsupported",
      voiceChannelId,
      transport,
      reason: "promoted",
    });
    removePeer(peer.id);
  }
  // Counted, not derived: an orphan is neither moved nor released, and a
  // counter that quietly folds it into "moved" is the kind of number that
  // makes a mechanism look like it is working when it is not.
  logEvent("voice.transportPromotionApplied", {
    voiceChannelId,
    transport,
    reason,
    moved,
    released: released.length,
    orphaned,
  });
}

/**
 * Move a mesh room onto the SFU so a camera (or a screen share) past the mesh
 * cap can turn on. Returns whether the room is on the SFU when it resolves.
 *
 * `true` also covers "it was already there", so the caller can simply re-read
 * the transport and re-check the cap rather than branching on how it got
 * there. `false` is the old behaviour: the caller refuses the claim and the
 * client says the call is at its camera limit.
 */
async function promoteRoomForVideo(
  voiceChannelId: string,
  reason: VoicePromotionReason,
  userId: string,
): Promise<boolean> {
  if (getRoomTransport(voiceChannelId) !== "mesh") {
    return true;
  }
  const existing = pendingPromotions.get(voiceChannelId);
  if (existing) {
    return existing;
  }
  const attempt = attemptPromotion(voiceChannelId, reason, userId).finally(
    () => {
      pendingPromotions.delete(voiceChannelId);
    },
  );
  pendingPromotions.set(voiceChannelId, attempt);
  return attempt;
}

async function attemptPromotion(
  voiceChannelId: string,
  reason: VoicePromotionReason,
  userId: string,
): Promise<boolean> {
  const seated = getRoomPeers(voiceChannelId);
  const budgetMbps = promotionBudgetMbps();
  const [stats, rooms] = await Promise.all([
    readSfuStats().catch(() => null),
    readRoomLoads(),
  ]);
  // Priced as it will be once the claim lands: everyone in it, and one more
  // video publisher than there is now. The cluster's row for this room is
  // preferred over this instance's own seats, because a call legitimately
  // spans machines and the box carries all of it; the local view is the
  // floor, for the registry-off case and for a row that has not settled yet.
  const known = rooms.find((room) => room.channelId === voiceChannelId);
  const candidate: SfuRoomLoad = {
    channelId: voiceChannelId,
    transport: "mesh",
    participants: Math.max(known?.participants ?? 0, seated.length, 1),
    videoPublishers:
      Math.max(known?.videoPublishers ?? 0, countVideoPublishers(seated)) + 1,
  };
  const verdict = decidePromotion({
    liveKitConfigured: configuredTransport() === "livekit",
    sfuReachable: stats?.reachable ?? null,
    rooms,
    room: candidate,
    budgetMbps,
  });
  if (!verdict.promote) {
    logEvent("voice.transportPromotionRefused", {
      voiceChannelId,
      userId,
      reason,
      refusal: verdict.refusal,
      loadMbps: Math.round(verdict.loadMbps),
      addedMbps: Math.round(verdict.addedMbps),
      budgetMbps: verdict.budgetMbps,
      roomSize: seated.length,
      sfuReachable: stats?.reachable ?? null,
    });
    return false;
  }
  if (registryOn()) {
    let stored: VoiceRoomTransport | null = null;
    let won = false;
    try {
      const result = await promoteVoiceRoomTransport(
        voiceChannelId,
        "mesh",
        "livekit",
      );
      stored = result.transport;
      won = result.promoted;
    } catch (error) {
      logEvent("voice.registryPinFailed", {
        channelId: voiceChannelId,
        op: "promote",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (stored !== "livekit") {
      // The room row went (everybody left mid-click) or somebody pinned it
      // back to mesh. Either way there is nothing to move.
      return false;
    }
    applyPromotionLocally(voiceChannelId, "livekit", reason);
    if (won) {
      // The winner is the only one that tells the rest of the cluster, and
      // the only one that logs the promotion, so the count in the log is
      // rooms promoted rather than instances that noticed.
      publishVoice(VOICE_TRANSPORT_TOPIC, {
        channelId: voiceChannelId,
        transport: "livekit",
        reason,
      } satisfies VoiceTransportFrame);
      logEvent("voice.transportPromoted", {
        voiceChannelId,
        userId,
        reason,
        roomSize: seated.length,
        loadMbps: Math.round(verdict.loadMbps),
        addedMbps: Math.round(verdict.addedMbps),
        budgetMbps: verdict.budgetMbps,
      });
    }
    return true;
  }
  applyPromotionLocally(voiceChannelId, "livekit", reason);
  logEvent("voice.transportPromoted", {
    voiceChannelId,
    userId,
    reason,
    roomSize: seated.length,
    loadMbps: Math.round(verdict.loadMbps),
    addedMbps: Math.round(verdict.addedMbps),
    budgetMbps: verdict.budgetMbps,
  });
  return true;
}

// --- end promotion ------------------------------------------------------------

// --- the cluster bus ----------------------------------------------------------
//
// Milestone M2 of `docs/plans/MULTI_INSTANCE_VOICE.md`. Three topics, one
// rule: the publisher has already written the row and served its own
// sockets, and the frame tells the other instance to do *its* local half.
// A subscriber never republishes (the same rule as `sendPresence` in
// chat.ts), and never trusts the frame over the rows: a `voice.room` hint
// forwards the `peer-*` frame it carries to the local room, then rebuilds
// the roster from `voice_peers`, so a frame that was lost costs the other
// instance's audience a moment of staleness rather than a permanent ghost.
//
// Every handler checks `registryOn()` first. A bus with the registry off
// carries `voice.hello` and nothing else about voice: without rows to read,
// a room frame would be a rumour, and the flag-off path stays exactly what
// it was.

export const VOICE_ROOM_TOPIC = "voice.room";
export const VOICE_IDENTITY_TOPIC = "voice.identity";
export const VOICE_WATCH_TOPIC = "voice.watch";
export const VOICE_CALL_TOPIC = "voice.call";
export const VOICE_MODERATION_TOPIC = "voice.moderation";
export const VOICE_REACTIONS_TOPIC = "voice.reactions";
export const VOICE_SERVER_MUTE_TOPIC = "voice.serverMute";
export const VOICE_SIGNAL_TOPIC = "voice.signal";
export const VOICE_TRANSPORT_TOPIC = "voice.transport";

const voiceRoomFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    channelId: z.string().uuid(),
    kind: z.literal("joined"),
    peer: voiceParticipantSchema,
  }),
  z.object({
    channelId: z.string().uuid(),
    kind: z.literal("left"),
    peerId: z.string().min(1),
  }),
  z.object({
    channelId: z.string().uuid(),
    kind: z.literal("updated"),
    peer: voiceParticipantSchema,
  }),
  z.object({ channelId: z.string().uuid(), kind: z.literal("roster") }),
  /** Another instance answers for this peer id now: forget it, say nothing. */
  z.object({
    channelId: z.string().uuid(),
    kind: z.literal("adopted"),
    peerId: z.string().min(1),
  }),
]);
type VoiceRoomFrame = z.infer<typeof voiceRoomFrameSchema>;

const voiceIdentityFrameSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});
type VoiceIdentityFrame = z.infer<typeof voiceIdentityFrameSchema>;

/**
 * `voice.reactions`. Unlike every other voice topic this one does NOT check
 * `registryOn()`, and the difference is not an oversight. The registry gate
 * exists because those frames are hints about ROWS, and without rows to
 * re-read a hint is a rumour that could plant a ghost. A window of counts
 * refers to nothing stored, corrects itself in 250ms by being replaced, and
 * cannot leave a room in a wrong state even if it is entirely fabricated. It
 * needs the bus and nothing else, exactly like `chat.typing`.
 */
const voiceReactionsFrameSchema = z.object({
  channelId: z.string().uuid(),
  items: z.array(liveReactionCountSchema).min(1),
  seq: z.number().int().nonnegative(),
});
type VoiceReactionsFrame = z.infer<typeof voiceReactionsFrameSchema>;

const voiceWatchFrameSchema = z.object({
  channelId: z.string().uuid(),
  state: watchPartyStateSchema.nullable(),
});
type VoiceWatchFrame = z.infer<typeof voiceWatchFrameSchema>;

/**
 * `voice.call` (M4, plan section 5.5). Two directions on one topic. From the
 * ring's owner outwards: `deliver` (a `call-incoming` or a
 * `call-ring-cancelled`, addressed by user id, to whichever sockets those
 * people hold here) and `room` (a `call-declined` to the call's peers
 * here). Towards the owner: `decline` and `answered`, which this instance
 * handles only when it holds the ring, and ignores otherwise. Only the
 * owner ever calls `pushIncomingCall` or posts the missed-call message.
 *
 * Accepted degradation (documented, not fixed): if the owner dies mid-ring,
 * its timers die with it. The callees' `call-incoming` was delivered and the
 * phone push went out, but nobody sends `call-ring-cancelled` and no
 * missed-call record is written. The client's own ring timeout ends the
 * ring on screen.
 */
const voiceCallDeliverySchema = z.union([
  callIncomingMessageSchema,
  callRingCancelledMessageSchema,
]);
type VoiceCallDelivery = z.infer<typeof voiceCallDeliverySchema>;

const voiceCallFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deliver"),
    userIds: z.array(z.string().min(1)).min(1),
    frame: voiceCallDeliverySchema,
  }),
  z.object({
    kind: z.literal("room"),
    channelId: z.string().uuid(),
    frame: callDeclinedMessageSchema,
  }),
  z.object({
    kind: z.literal("decline"),
    conversationId: z.string().uuid(),
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("answered"),
    conversationId: z.string().uuid(),
    userId: z.string().min(1),
  }),
]);
type VoiceCallFrame = z.infer<typeof voiceCallFrameSchema>;

/**
 * `voice.moderation` (M4, plan section 5.8). Published by the instance the
 * moderation request landed on, before it releases the rows. The receiver
 * does the socket half for the peers it holds: says the notice, if the
 * frame carries one, then forgets the peer without a `peer-left` (the
 * publisher's `releaseForeignPeer` announces the departure once, for
 * everybody). `notify` is the notice alone, for the SFU mute where the
 * peer stays. No SFU call here, ever: that ran once, on the publisher.
 */
const voiceModerationNoticeSchema = voiceModerationMessageSchema.pick({
  action: true,
  movedToChannelId: true,
  message: true,
});
type VoiceModerationNotice = z.infer<typeof voiceModerationNoticeSchema>;

const voiceModerationFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notify"),
    userId: z.string().min(1),
    channelId: z.string().uuid(),
    notice: voiceModerationNoticeSchema,
  }),
  z.object({
    kind: z.literal("user"),
    userId: z.string().min(1),
    /** `null` is "wherever they are". */
    channelIds: z.array(z.string().uuid()).nullable(),
    notice: voiceModerationNoticeSchema.optional(),
  }),
  z.object({ kind: z.literal("channel"), channelId: z.string().uuid() }),
  z.object({
    kind: z.literal("except"),
    channelId: z.string().uuid(),
    allowedUserIds: z.array(z.string().min(1)),
  }),
]);
type VoiceModerationFrame = z.infer<typeof voiceModerationFrameSchema>;

subscribeToCluster(VOICE_REACTIONS_TOPIC, (data) => {
  const parsed = voiceReactionsFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId, items, seq } = parsed.data;
  // Only rooms somebody here is in. A `broadcastToRoom` for an empty room is
  // already a no-op; the early return keeps it obvious that a window addressed
  // elsewhere costs this instance a parse and nothing more.
  if (getRoomPeers(channelId).length === 0) {
    return;
  }
  noteClusterFrameReceived();
  broadcastToRoom(channelId, { type: "live-reactions", channelId, items, seq });
});

/**
 * Where a coalesced window goes once the 250ms is up: this instance's half of
 * the room, then the bus. Registered here rather than imported the other way
 * round so `live-reactions.ts` stays free of the socket layer and can be
 * tested without one.
 */
setLiveReactionSink((channelId, items, seq) => {
  broadcastToRoom(channelId, { type: "live-reactions", channelId, items, seq });
  if (clusterOn()) {
    publishVoice(VOICE_REACTIONS_TOPIC, {
      channelId,
      items,
      seq,
    } satisfies VoiceReactionsFrame);
  }
});

/**
 * `voice.serverMute`: a moderator's mute or unmute, published by the
 * instance the request landed on after it wrote `voice_server_mutes`. The
 * receiver runs the local half for the seats it holds: the map, the forced
 * `muted` on its own peers (their rows are its to write), and the fan-out.
 * The row is what a join or a roster reads; the frame is what makes the
 * target's tile change now rather than on the next roster.
 */
const voiceServerMuteFrameSchema = z.object({
  channelId: z.string().uuid(),
  userId: z.string().min(1),
  muted: z.boolean(),
});
type VoiceServerMuteFrame = z.infer<typeof voiceServerMuteFrameSchema>;

/**
 * `voice.signal`: an offer, answer or ICE candidate whose target this
 * instance does not hold. `channelId` is the SENDER's room as the publishing
 * instance verified it; the receiver applies the same-room rule against its
 * own map, so a frame can never reach a peer in another room through the
 * bus any more than it can through the local relay.
 */
const voiceSignalFrameSchema = z.object({
  channelId: z.string().uuid(),
  frame: clientRelayMessageSchema,
});
type VoiceSignalFrame = z.infer<typeof voiceSignalFrameSchema>;

/**
 * `voice.transport`: a room this cluster holds has been promoted from mesh to
 * the SFU (see the promotion section above). Published exactly once, by the
 * instance whose conditional UPDATE won, and never republished by a receiver.
 *
 * The frame is a hint about a row, like `voice.room`: the pin it announces is
 * already in `voice_rooms`, so an instance that misses this frame still reads
 * the promoted transport on its next join or roster. What the frame buys is
 * that the seats it holds move NOW instead of staying on a mesh whose signaling
 * the room no longer relays.
 */
const voiceTransportFrameSchema = z.object({
  channelId: z.string().uuid(),
  transport: voiceRoomTransportSchema,
  reason: z.enum(["cameras", "screens"]),
});
type VoiceTransportFrame = z.infer<typeof voiceTransportFrameSchema>;

subscribeToCluster(VOICE_TRANSPORT_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceTransportFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId, transport, reason } = parsed.data;
  if (getRoomPeers(channelId).length > 0) {
    noteClusterFrameReceived();
  }
  applyPromotionLocally(channelId, transport, reason);
});

subscribeToCluster(VOICE_SIGNAL_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceSignalFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId, frame } = parsed.data;
  const target = peers.get(frame.to);
  if (!target || target.voiceChannelId !== channelId) {
    return;
  }
  noteClusterFrameReceived();
  send(target.socket, frame);
});

subscribeToCluster(VOICE_SERVER_MUTE_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceServerMuteFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId, userId, muted } = parsed.data;
  if (getRoomPeers(channelId).some((peer) => peer.userId === userId)) {
    noteClusterFrameReceived();
  }
  void applyServerMuteLocally(channelId, userId, muted).catch(
    (error: unknown) => {
      console.error("[voice] server mute frame failed:", error);
    },
  );
});

subscribeToCluster(VOICE_CALL_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceCallFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const frame = parsed.data;
  switch (frame.kind) {
    case "deliver":
      if (sendToUserSockets(new Set(frame.userIds), frame.frame) > 0) {
        noteClusterFrameReceived();
      }
      return;
    case "room":
      if (getRoomPeers(frame.channelId).length > 0) {
        noteClusterFrameReceived();
      }
      broadcastToRoom(frame.channelId, frame.frame);
      return;
    case "decline":
      declineRing(frame.conversationId, frame.userId);
      return;
    case "answered":
      answerRing(frame.conversationId, frame.userId);
      return;
  }
});

subscribeToCluster(VOICE_MODERATION_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceModerationFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const frame = parsed.data;
  if (frame.kind === "notify") {
    if (notifyLocalVoiceModeration(frame.userId, frame.channelId, frame.notice) > 0) {
      noteClusterFrameReceived();
    }
    return;
  }
  const selected = [...peers.values()].filter((peer) => {
    switch (frame.kind) {
      case "user":
        return (
          peer.userId === frame.userId &&
          (frame.channelIds === null ||
            frame.channelIds.includes(peer.voiceChannelId))
        );
      case "channel":
        return peer.voiceChannelId === frame.channelId;
      case "except":
        return (
          peer.voiceChannelId === frame.channelId &&
          !frame.allowedUserIds.includes(peer.userId)
        );
    }
  });
  if (selected.length > 0) {
    noteClusterFrameReceived();
  }
  for (const peer of selected) {
    if (frame.kind === "user" && frame.notice) {
      send(peer.socket, {
        type: "voice-moderation",
        action: frame.notice.action,
        voiceChannelId: peer.voiceChannelId,
        ...(frame.notice.movedToChannelId
          ? { movedToChannelId: frame.notice.movedToChannelId }
          : {}),
        message: frame.notice.message,
      });
    }
    const { voiceChannelId, socket } = peer;
    dropVoicePeerSilently(peer.id);
    // The room half of `removePeer` that a silent drop skips: a ring's
    // empty-room grace and the watch party, for the room this leaves.
    onLiveRoomMaybeEmpty(voiceChannelId, socket);
    logEvent("voice.moderationApplied", {
      peerId: peer.id,
      userId: peer.userId,
      voiceChannelId,
      kind: frame.kind,
    });
  }
});

subscribeToCluster(VOICE_ROOM_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceRoomFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const frame = parsed.data;
  // Whatever the room row says now, this process's copy is stale for it;
  // the roster rebuild below refreshes the entry or drops it.
  remoteTransports.delete(frame.channelId);
  if (frame.kind === "adopted") {
    if (peers.has(frame.peerId)) {
      noteClusterFrameReceived();
    }
    dropVoicePeerSilently(frame.peerId);
    return;
  }
  if (getRoomPeers(frame.channelId).length > 0) {
    noteClusterFrameReceived();
  }
  // The room frame, to the peers this instance holds. A peer we hold
  // ourselves is never announced to us by somebody else: that would be a
  // seat both instances think they own, and the `adopted` frame above is
  // how the seat changes hands; until it arrives the local map wins.
  if (frame.kind === "joined" && !peers.has(frame.peer.peerId)) {
    broadcastToRoom(frame.channelId, { type: "peer-joined", peer: frame.peer });
  } else if (frame.kind === "left" && !peers.has(frame.peerId)) {
    broadcastToRoom(frame.channelId, { type: "peer-left", peerId: frame.peerId });
  } else if (frame.kind === "updated" && !peers.has(frame.peer.peerId)) {
    broadcastToRoom(frame.channelId, {
      type: "peer-updated",
      peer: frame.peer,
    });
  }
  // Rows are truth: the roster is rebuilt from `voice_peers`, not from the
  // frame, and `null` keeps this instance from publishing in turn.
  void broadcastRoster(frame.channelId, null);
});

subscribeToCluster(VOICE_IDENTITY_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceIdentityFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { userId, displayName, avatarUrl } = parsed.data;
  if ([...peers.values()].some((peer) => peer.userId === userId)) {
    noteClusterFrameReceived();
  }
  // The local half only: this instance's own peers for the user, their rows
  // (which are this instance's to write), their rooms and rosters.
  void applyVoiceIdentity(userId, {
    display_name: displayName,
    avatar_url: avatarUrl,
  }).catch((error: unknown) => {
    console.error("[voice] identity frame failed:", error);
  });
});

subscribeToCluster(VOICE_WATCH_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceWatchFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId, state } = parsed.data;
  // Only rooms this instance has somebody in. The cache is per room and is
  // torn down when the local room empties, so adopting for a room nobody
  // here is in would be an entry nothing ever removes.
  if (getRoomPeers(channelId).length === 0) {
    return;
  }
  noteClusterFrameReceived();
  if (!adoptWatchPartyState(channelId, state)) {
    // Older than what is held (a straggler behind a frame that already
    // landed, or behind the row a joiner just read). The room has the
    // newer state already; repeating the older one would roll it back.
    return;
  }
  broadcastToRoom(channelId, { type: "watch-party", channelId, state });
});

// --- end the cluster bus ------------------------------------------------------
