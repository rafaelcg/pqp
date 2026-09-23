import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  markChannelShareStarted,
  markChannelShareStopped,
  markChannelSessionLive,
} from "../services/channel-sessions.js";
import { z } from "zod";
import {
  clientRelayMessageSchema,
  isClientRelayMessage,
  clampReportedUplinkBps,
  meshVideoLimit,
  narrowestUplinkBps,
  MESH_VOICE_LIMIT,
  canStartWatchPartyStream,
  hasPermission,
  isVoiceRoomChannelType,
  isWatchPartyChannelType,
  mayGoOnAir,
  Permission,
  callDeclinedMessageSchema,
  callIncomingMessageSchema,
  callRingCancelledMessageSchema,
  voiceClientMessageSchema,
  voiceModerationMessageSchema,
  voiceParticipantSchema,
  voiceRoomTransportSchema,
  watchPartyStateSchema,
  musicStateSchema,
  liveReactionCountSchema,
  type MeshVideoKind,
  type MusicState,
  type VoiceParticipant,
  type VoiceRoomTransport,
  type LiveHlsStream,
  type VoiceSignalingMessage,
  liveHlsStreamSchema,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import {
  INSTANCE_ID,
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { logEvent } from "../lib/log.js";
import {
  noteJoinAttempt,
  noteJoinConnected,
  noteJoinRefused,
  noteRingAnswered,
  noteRingDeclined,
  noteRingEnded,
  noteRingStarted,
  type CallScope,
} from "../voice/call-metrics.js";
import { sharedRateLimit } from "../lib/cluster-rate-limit.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { listBlockersOf } from "../services/blocks.js";
import { recordActivationStep } from "../services/activation.js";
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
  onAudienceInvalidated,
  type ChannelRow,
} from "../services/servers.js";
import { resolveMemberChannelPermissions } from "../services/permissions.js";
/**
 * ONE STATIC EDGE, AND IT POINTS THIS WAY ON PURPOSE.
 *
 * `services/watch-parties.ts` calls back into this module (a host's socket
 * closing starts the grace clock, an options change re-resolves the room) and
 * does it through a dynamic `await import` precisely so the static graph stays
 * acyclic. Importing it statically from here is the direction that stays
 * acyclic, so the seat gate below costs no lazy import on the join path.
 */
import {
  listActiveWatchPartyStatusesByChannel,
  loadWatchPartySeat,
} from "../services/watch-parties.js";
import { canAccessChannel, resolveMemberName } from "../services/users.js";
import { broadcastToChannel, onPermissionsUpdate } from "./chat.js";
import { resolveStatus } from "./status.js";
import {
  cancelSfuPrivateResweep,
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
  isHlsSessionOpen,
  isLiveHlsEnabledForServer,
  liveHlsOwnsChannel,
  liveHlsStreamFor,
  liveHlsStreamFromDb,
  reconcileLiveHls,
  setLiveHlsChangeListener,
  setLiveHlsPresenterCheck,
  setLiveHlsSfuLoadReader,
  setVoiceTrackSeparated,
} from "../voice/hls-egress.js";
import { llStreamFor } from "../voice/hls-remux.js";
import {
  liveHlsForcesSfu,
  resolveVoiceTransport,
  type VoiceTransportDecision,
} from "../voice/transport-policy.js";
import {
  blockJoinPromotion,
  decidePromotion,
  decideVideoAdmission,
  estimateSfuLoadMbps,
  promotionBudgetMbps,
  promotionRoomSize,
  type SfuRoomLoad,
} from "../voice/promotion.js";
import { readSfuStats } from "../voice/sfu-stats.js";
import {
  adoptVoicePeer,
  clearMusicIfEmpty,
  clearWatchPartyIfEmpty,
  countIdleVoiceSeats,
  countVoicePeerUsersByChannel,
  deleteVoicePeer,
  getVoicePeerRow,
  isVoicePeerRetired,
  clusterTopologyTracked,
  isVoiceRegistryEnabled,
  getVoiceRaisedHand as getVoiceRaisedHandInRegistry,
  isVoiceServerMuted as isVoiceServerMutedInRegistry,
  listVoicePeersForUser,
  listVoicePeersInRoom,
  listVoiceRoomOccupancy,
  listVoiceRoster,
  listVoiceRosters,
  markVoicePeerOrphaned,
  persistMusic,
  persistWatchParty,
  claimVoiceRoomTransport,
  promoteVoiceRoomTransport,
  readMusicWithAnchor,
  readWatchParty,
  reconcileVoiceRegistry,
  otherLeasesTrustworthy,
  consumeOwnHeartbeatRecovery,
  retireVoicePeerId,
  setVoiceRaisedHand as setVoiceRaisedHandRow,
  setVoiceServerMute,
  sweepOwnStaleVoicePeers,
  trackPendingRegistryWork,
  unpinVoiceRoomIfEmpty,
  upsertVoicePeer,
  voiceRegistryWritesPerMinute,
  type VoicePeerRow,
  type VoiceRosterPeerRow,
} from "../voice/registry.js";
import {
  isVoiceRegistryBatchEnabled,
  voiceRegistryBatchMetrics,
  type VoiceRegistryBatchMetrics,
} from "../voice/registry-batch.js";
import {
  countAuthenticatedSockets,
  forEachAuthenticatedSocket,
  getSocketUser,
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
import {
  logWatchPartyOverStop,
  setWatchPartyLiveListener,
  watchPartyKnownOver,
} from "./watch-party-live.js";
import { stampViewerStream } from "../voice/hls-viewer-token.js";
import {
  adoptWatchPartyState,
  applyWatchPartyWrite,
  endWatchParty,
  getWatchPartyState,
  resetWatchPartyLimits,
} from "./watch-party.js";
import { completeMusicState, musicServerWriteAllowed } from "@pqp/shared";
import {
  adoptMusicWithAnchor,
  musicExpectedPositionMs,
  type MusicAnchor,
  applyMusicWrite,
  channelMusicTrack,
  endMusic,
  getMusicAnchor,
  getMusicState,
  musicChannels,
  resetMusicForTests,
} from "./music.js";
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
  /**
   * This seat's music player is on. Default true: a fresh player starts
   * that way, and a client that predates `set-music-listening` never
   * turns it off. Carried on the roster like `sharingScreen`.
   */
  listeningMusic: boolean;
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
  /** `Permission.MANAGE_MUSIC` here; always true in a conversation call. */
  canManageMusic: boolean;
  /**
   * `channel.kind === "server"`. Resolved once at join, alongside
   * `watchParty`, because it never changes for the life of a channel.
   *
   * The only thing this gates is `promoteRoomPastMeshCap`: a DM or group call
   * is pinned to mesh for good by `resolveVoiceTransport` (reason `"dm"`),
   * and that pin is a policy, not a guess the room-size or camera/screen
   * triggers are free to correct the way they correct a small server's guess.
   * Without this a conversation could still be priced and pinned to the SFU
   * the moment it crossed `MESH_ROOM_PROMOTION_SIZE` or a mesh video cap,
   * which is exactly the split the one-transport rule exists to prevent.
   */
  canPromoteTransport: boolean;
  /**
   * The seat is in a `watch_party` channel. Resolved from `channel.type` at
   * join, beside `canStream`, and read by exactly one thing: `pickHlsSharer`,
   * which will not start an HLS transcode from any other kind of room.
   */
  watchParty: boolean;
  /** Set when the socket closed; cleared on resume. Absent = live. */
  orphanedAt?: number;
  orphanTimer?: ReturnType<typeof setTimeout>;
  /**
   * The join that created this peer sent `resume: true`. Only those peers
   * stay in the room after the socket closes. Phones and old tabs omit the
   * flag and are removed immediately, so they do not occupy a mesh seat.
   */
  canResume: boolean;
  /**
   * The uplink this client last measured, in bit/s, clamped on arrival, or
   * null from a client that has never reported one (every native client
   * today, and every web client before its first camera or share).
   *
   * READ ONLY ON MESH, and that restriction is the whole safety argument. On
   * mesh a publication is uploaded by its publisher and by nobody else, so a
   * number somebody inflated buys them copies out of their own uplink; and
   * because `narrowestUplinkBps` takes the minimum, it cannot lift a limit
   * that somebody else's honest reading has already set. On the voice server
   * the cost IS shared, and there this field is never consulted: the box is
   * priced from the roster by `decideVideoAdmission`.
   */
  measuredUplinkBps: number | null;
  /**
   * Published capture height, in lines, last declared on
   * `set-sharing-screen`. The HLS ladder refuses a rung taller than this.
   * Not in the registry: a reconnect re-declares with the share.
   */
  sourceHeight: number | null;
  /**
   * When this seat last became the only one in its room, or the last time
   * its occupant did something while alone. Absent while somebody else is
   * seated. Read by `sweepIdleAloneSeats`, which is the idle hangup.
   */
  aloneSince?: number;
  /** The `voice-idle-warning` for the current alone stretch went out. */
  idleWarnedAt?: number;
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
 * THE COUNTERS THE SEAT LEAK DID NOT HAVE, both since boot, both on
 * `GET /api/admin/metrics`.
 *
 * `meshHoldsRefused` counts seats released at once rather than held, because
 * the room runs on mesh and the socket never declared `mesh-resume`. It is
 * how an operator reads whether `VOICE_MESH_RESUME_REQUIRES_CAP` is doing
 * anything after the flip: flat zero with the flag on means every client in a
 * mesh call is declaring the capability, and the rule is costing nothing.
 *
 * `staleRowWritesRefused` is `writePeerRow` catching a handler about to
 * resurrect a deleted seat; `ghostSeatsSwept` is `sweepOwnStaleVoicePeers`
 * finding one that got through anyway. Zero and zero is the healthy reading.
 * A climbing first number with a flat second is the guard doing its job; a
 * climbing second one is a path the guard does not cover, which is exactly
 * the thing that was invisible for months. Neither is derivable from the
 * rows after the fact, which is why they are counted rather than queried.
 */
/**
 * How long a seat may go unwritten before the dashboard counts it. An hour,
 * because a call where nobody mutes, unmutes, shares or rejoins for an hour
 * is rare enough to be worth a look and common enough not to be an alarm.
 */
const SEAT_IDLE_ALARM_MS = 60 * 60_000;

/**
 * THE IDLE HANGUP: somebody alone in a room for this long is disconnected,
 * with one warning a minute before.
 *
 * Why: a seat with nobody behind it still keeps a TURN allocation (billed
 * by the gigabyte) and an SFU session, and the green badge on the channel
 * tells everybody a friend is there to talk to when they are asleep. On
 * 2026-09-08 ten of nineteen live rooms held exactly one person, the oldest
 * for fifteen hours. Discord moves an idle person to an AFK channel after a
 * server-set 1 to 60 minutes; Google Meet leaves an empty call after a few
 * minutes with a prompt; Zoom ends a meeting 40 minutes after the last other
 * participant left. This is the Meet shape: ALONE is the condition, not
 * idle, because kicking somebody out of a live conversation is the
 * complaint under every Discord AFK thread.
 *
 * `VOICE_IDLE_ALONE_MINUTES` sets the limit (default 10); `0` turns the
 * hangup off, which is what a self-host with no bandwidth bill may want.
 * Anything the person does on purpose while alone (mute, share, camera,
 * hand, reaction, or the warning's own button) starts the clock over.
 * Orphaned seats are skipped: the resume window is already a timer.
 */
function idleAloneLimitMs(): number {
  const raw = Number(process.env.VOICE_IDLE_ALONE_MINUTES);
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : 10;
  return minutes * 60_000;
}

/** How long before the hangup the warning goes out. */
const IDLE_ALONE_WARNING_MS = 60_000;

/** How often `sweepIdleAloneSeats` runs; the warning window is four ticks. */
export const IDLE_ALONE_SWEEP_MS = 15_000;

let idleAloneWarned = 0;
let idleAloneDisconnected = 0;

let staleRowWritesRefused = 0;
let ghostSeatsSwept = 0;
let meshHoldsRefused = 0;
/** Seats re-written to their rows on the first beat after a DB outage. */
let seatsReassertedAfterOutage = 0;
/** Reconcile passes skipped because this instance's own lease had just lapsed. */
let reconcilesDeferredAfterOutage = 0;
/** Rosters built from memory because the rows could not be read. */
let rostersSentWithoutRows = 0;

/**
 * Registry writes, under TWO keys, because the two guarantees they carry are
 * not the same guarantee and do not want the same scope.
 *
 * ORDER IS PER PEER (`pendingPeerWrites`). A peer's own statements run one at
 * a time, in the order they were asked for. That is the whole of the race
 * this exists to close: on 2026-09-08 a client sent `set-voice-state` and
 * `leave-voice-room` back to back, the mute's UPSERT was issued first and the
 * hangup's DELETE second, and because both were already in flight on two
 * pooled connections the database ran them the other way round. The row came
 * back six milliseconds after it was deleted, with `orphaned_at` NULL and this
 * instance stamped on it, and nothing in the cluster is allowed to sweep a
 * live instance's rows. That seat sat in a call nobody was in.
 *
 * It is per PEER and not per channel for a reason worth writing down: two
 * people in one room never race each other, they write different rows. Making
 * a room's writes single-file would put one person's slow query in front of
 * everybody else's state changes, and, far worse, in front of their hangups,
 * so a leave could queue behind a backlog while the seat stayed occupied.
 * That is this very bug, rebuilt out of the fix for it. A peer's own chain is
 * a handful of statements and is naturally short.
 *
 * COMPLETION IS PER CHANNEL (`pendingRowWrites`). The handler never waits for
 * a row, but a roster built from the rows must not run ahead of the write it
 * is reporting, or the joiner's own audience would see a roster without them;
 * the same seam is what makes a resume racing a hangup see the retired id.
 * So the channel map JOINS every peer chain touching the room rather than
 * chaining them, and `settledRowWrites` still means "everything asked for in
 * this room has landed".
 *
 * `start` is a thunk, not a promise, and that is the load-bearing part: a
 * promise handed in has already issued its query, so joining it orders
 * nothing. Starting the write from inside the chain is what makes "later
 * frame, later row" true rather than merely likely.
 */
const pendingPeerWrites = new Map<string, Promise<void>>();
const pendingRowWrites = new Map<string, Promise<void>>();

function trackRowWrite(
  channelId: string,
  peerId: string,
  start: () => Promise<unknown>,
): void {
  const previous = pendingPeerWrites.get(peerId) ?? Promise.resolve();
  // Registry promises never reject (`track` swallows into a log), so the
  // chain cannot break; the `catch` is belt and braces against a future
  // caller, and it must not be able to skip `start`.
  const next = previous
    .catch(() => undefined)
    .then(start)
    .then(
      () => undefined,
      () => undefined,
    );
  pendingPeerWrites.set(peerId, next);
  void next.then(() => {
    if (pendingPeerWrites.get(peerId) === next) {
      pendingPeerWrites.delete(peerId);
    }
  });

  // The room's view of the same work: a join, never a chain, so one peer's
  // slow write delays nobody else's statement and only the readers wait.
  const roomPrevious = pendingRowWrites.get(channelId) ?? Promise.resolve();
  const roomNext = Promise.all([roomPrevious, next]).then(
    () => undefined,
    () => undefined,
  );
  pendingRowWrites.set(channelId, roomNext);
  void roomNext.then(() => {
    if (pendingRowWrites.get(channelId) === roomNext) {
      pendingRowWrites.delete(channelId);
    }
  });

  // The chain, not the query: a write still queued behind another has not
  // been issued and would otherwise be invisible to `settleVoiceRegistryWrites`.
  trackPendingRegistryWork(next);
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
  // THE SEAT MAY BE GONE. Every frame runs as its own promise
  // (`ws/index.ts` fires `void onMessage(...)` with no per-socket
  // serialisation), so a handler that awaited anything can arrive here
  // holding a `VoicePeer` that `removePeer` has already dropped from the
  // map and deleted the row for. Writing it would INSERT that row back with
  // `orphaned_at` NULL and this, living, instance stamped on it: a seat no
  // socket close can orphan, no orphan timer can release, and
  // `reconcileVoiceRegistry` will not touch because it belongs to an
  // instance that is alive. Immortal, and on the roster.
  //
  // Identity, not `peers.has`: a reconstructed peer reuses the id, and the
  // stale object must not be allowed to write over the new seat's row.
  if (peers.get(peer.id) !== peer) {
    staleRowWritesRefused += 1;
    logEvent("voice.staleRowWrite", {
      peerId: peer.id,
      userId: peer.userId,
      voiceChannelId: peer.voiceChannelId,
    });
    return;
  }
  trackRowWrite(peer.voiceChannelId, peer.id, () =>
    upsertVoicePeer({
      peerId: peer.id,
      channelId: peer.voiceChannelId,
      userId: peer.userId,
      displayName: peer.displayName,
      avatarUrl: peer.avatarUrl,
      muted: peer.muted,
      deafened: peer.deafened,
      sharingScreen: peer.sharingScreen,
      listeningMusic: peer.listeningMusic,
      cameraStreamId: peer.cameraStreamId,
      screenAudioStreamId: peer.screenAudioStreamId,
      canSpeak: peer.canSpeak,
      canStream: peer.canStream,
      canResume: peer.canResume,
      orphanedAt:
        peer.orphanedAt === undefined ? null : new Date(peer.orphanedAt),
      transport: getRoomTransport(peer.voiceChannelId),
      // The same identity check as above, handed to the registry so it can
      // ask it AGAIN at the moment the row goes out. With
      // `VOICE_REGISTRY_BATCH` on the write is issued a window later than it
      // was asked for, and a seat can leave inside that window; the check
      // here would then have passed for a peer that no longer exists, which
      // is precisely how pitfall 13's immortal rows were made.
      stillSeated: () => peers.get(peer.id) === peer,
    }),
  );
}

/**
 * Multiple seats for one person is by design for up to `VOICE_RESUME_TTL_MS`:
 * a cold rejoin (resume token missing, expired, or refused) can land a fresh
 * peer id while the old one is still held open, orphaned, waiting out its
 * resume window — see the "two seats for 90s is cosmetic" note beside the
 * cold-join mesh-ceiling check in the join handler. That was meant to be
 * invisible plumbing (occupancy counts, the mesh ceiling), not a roster
 * entry: left in the outgoing roster, both seats carry the same display name
 * and avatar, and everyone else in the room sees that person rendered twice
 * for up to ninety seconds. That is the duplicate-participant bug reported
 * 2026-09-20 ("ta duplicando, ta parecendo 2 pessoas na mesma call").
 *
 * Drops an orphaned seat once a live seat exists for the same person. A lone
 * orphan is left alone — nothing to prefer over it, and this is what keeps a
 * reconnecting person's own tile up while their client is mid-resume — and a
 * person genuinely holding more than one LIVE seat (two tabs, two devices)
 * is untouched: this only ever removes a seat nothing but a TTL is still
 * holding open. Order-preserving, because some receivers key their own
 * comparisons off roster position.
 */
function collapseOrphanedDuplicates<T>(
  entries: T[],
  userIdOf: (entry: T) => string,
  isOrphaned: (entry: T) => boolean,
): T[] {
  const hasLiveSeat = new Map<string, boolean>();
  for (const entry of entries) {
    const userId = userIdOf(entry);
    if (!isOrphaned(entry)) {
      hasLiveSeat.set(userId, true);
    } else if (!hasLiveSeat.has(userId)) {
      hasLiveSeat.set(userId, false);
    }
  }
  return entries.filter(
    (entry) => !isOrphaned(entry) || !hasLiveSeat.get(userIdOf(entry)),
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
    listeningMusic: row.listeningMusic,
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
    handRaisedAt: clusterHandRaisedAt(row),
  };
}

/**
 * The earlier of two readings of one hand while both say it is up.
 * Null is not a candidate: a missed lower must not be resurrected by a
 * stale cache (see `clusterHandRaisedAt`).
 */
function earlierHand(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.min(a, b);
}

/**
 * A roster rebuilt from the registry rows. `sendRoster` / `welcomeVoicePeer`
 * wait on `settledRowWrites` first, so a raise this process just wrote is
 * already visible here. After that settle, a database null is the cluster's
 * answer that the hand is down: forget a stale local cache rather than
 * letting `earlierHand(null, cached)` put the person back in the queue.
 */
function clusterHandRaisedAt(row: VoiceRosterPeerRow): number | null {
  if (row.handRaisedAt === null) {
    forgetLocalRaisedHand(row.channelId, row.userId);
    return null;
  }
  // After settle the row is the cluster's raise. Seed a cache this
  // process missed so a later local overlay (`toParticipant`) cannot
  // wipe it back to down.
  noteRaisedHand(row.channelId, row.userId, row.handRaisedAt);
  return earlierHand(
    row.handRaisedAt,
    voiceUserHandRaisedAt(row.channelId, row.userId),
  );
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
  const orphanedById = new Map<string, boolean>();
  for (const row of room?.peers ?? []) {
    byId.set(row.peerId, rowToParticipant(row));
    orphanedById.set(row.peerId, row.orphanedAt !== null);
  }
  for (const peer of getRoomPeers(voiceChannelId)) {
    byId.set(peer.id, toParticipant(peer));
    orphanedById.set(peer.id, peer.orphanedAt !== undefined);
  }
  noteRemoteTransport(voiceChannelId, room?.transport ?? null);
  if (!room && byId.size === 0) {
    return null;
  }
  return {
    participants: collapseOrphanedDuplicates(
      [...byId.values()],
      (participant) => participant.userId,
      (participant) => orphanedById.get(participant.peerId) ?? false,
    ),
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
  const liveHlsEnabled = await isLiveHlsEnabledForServer(channel.server_id);
  const voiceTransport = channel.voice_transport ?? null;
  // The query is skipped only for the branches that answer without it, and
  // HLS is one of them ONLY for a watch party. Testing `liveHlsEnabled`
  // alone here is what used to send an ordinary voice channel down the
  // `server: null` path and back out as `livekit` / `default`, so the
  // narrowing in the policy would have been undone by its own caller.
  const hlsForcesSfu = liveHlsForcesSfu({
    liveHlsEnabled,
    channelType: channel.type,
  });
  let server: { isCommunity: boolean; memberCount: number } | null = null;
  if (
    liveKitConfigured &&
    !hlsForcesSfu &&
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
    channel: { kind: channel.kind, type: channel.type, voiceTransport },
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

/**
 * In-flight policy re-reads for rooms that are ALREADY pinned, shared by every
 * join racing to notice the same stale pin.
 *
 * Separate from `pendingTransportDecisions`, and deleted the moment it
 * settles rather than when the room is pinned. That is the whole difference:
 * the opening decision is cached until it is applied, because it is the
 * answer; this one must never be cached, because the thing it is looking for
 * is precisely a change (a server crossing ten members, an override edited, a
 * community listed) that happened after the last read. Holding it would
 * rebuild the bug.
 *
 * Sharing the in-flight promise still costs one query for a stampede, which
 * is the shape that matters: 150 people tapping the same channel in the same
 * second all reach this before any of them promotes it.
 */
const pendingPinRechecks = new Map<string, Promise<VoiceTransportDecision>>();

/** Test hook: forget any in-flight policy re-read. */
export function resetVoicePinRechecks(): void {
  pendingPinRechecks.clear();
}

/**
 * What the policy would decide for this channel RIGHT NOW, for a room that is
 * already pinned. One query at most, and none at all for a DM, for a channel
 * carrying an override, or on a deployment without LiveKit: those are the
 * branches `decideRoomTransport` answers without touching the database.
 */
function recheckRoomTransport(
  voiceChannelId: string,
  channel: ChannelRow,
): Promise<VoiceTransportDecision> {
  const existing = pendingPinRechecks.get(voiceChannelId);
  if (existing) {
    return existing;
  }
  const decision = decideRoomTransport(channel).finally(() => {
    pendingPinRechecks.delete(voiceChannelId);
  });
  pendingPinRechecks.set(voiceChannelId, decision);
  return decision;
}

/** Test hook: forget every pinned room transport. */
export function resetVoiceRoomTransports(): void {
  roomTransports.clear();
  remoteTransports.clear();
  roomServerMutes.clear();
  roomRaisedHands.clear();
  resetMusicForTests();
  pendingTransportDecisions.clear();
  pendingPinRechecks.clear();
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
 * RAISED HANDS: room id -> user id -> the instant that hand went up (ms).
 *
 * Asked for in the QG: "levantar a mão e aí forma a fila de quem levantou
 * primeiro". A queue, and the only thing that makes it a queue rather than a
 * pile is that ONE clock stamps it. That clock is here (or, with the registry
 * on, Postgres), never the raiser's client, so nobody can arrive at the front
 * by mis-stating when they clicked and two people watching the same room read
 * the same order. Clients only sort what they are given
 * (`raisedHandQueue` in @pqp/shared).
 *
 * KEYED ON THE PERSON, NOT ON THE SEAT, for a reason the mute above shares
 * and then diverges from. A peer is a seat: a socket blip reattaches one, a
 * refresh inside the orphan window mints another, and neither of those is
 * somebody leaving the room. Losing your place in a queue because a tab
 * reloaded is precisely the complaint this feature exists to answer, so the
 * hand outlives the seat. Where it differs from a mute is at the other end:
 * a mute is a sanction that must survive a rejoin, and a hand is a request
 * that must NOT survive the person walking out. So `removePeer` clears it the
 * moment that person holds no seat in the room at all, orphans included.
 *
 * Lifetime is otherwise the room's, like `roomTransports` and
 * `roomServerMutes`: cleared when the last peer leaves, so tonight's queue is
 * never waiting for tomorrow's call. Per-process, and copied to
 * `voice_raised_hands` when the registry is on.
 */
const roomRaisedHands = new Map<string, Map<string, number>>();

/** When this person raised their hand in this room, or null when it is down. */
export function voiceUserHandRaisedAt(
  voiceChannelId: string,
  userId: string,
): number | null {
  return roomRaisedHands.get(voiceChannelId)?.get(userId) ?? null;
}

/**
 * Seed a hand this process has not heard about into the map. Used on the way
 * into a room, where the row may know something this instance does not (it
 * was raised on the other machine, or before this process restarted).
 */
function noteRaisedHand(
  voiceChannelId: string,
  userId: string,
  raisedAt: number,
): void {
  let hands = roomRaisedHands.get(voiceChannelId);
  if (!hands) {
    hands = new Map();
    roomRaisedHands.set(voiceChannelId, hands);
  }
  if (!hands.has(userId)) {
    hands.set(userId, raisedAt);
  }
}

/** Drop the in-process copy of one hand. Does not touch the registry row. */
function forgetLocalRaisedHand(voiceChannelId: string, userId: string): void {
  const hands = roomRaisedHands.get(voiceChannelId);
  if (!hands) {
    return;
  }
  hands.delete(userId);
  if (hands.size === 0) {
    roomRaisedHands.delete(voiceChannelId);
  }
}

/**
 * This person holds no seat in this room anywhere. Drop the hand: local
 * cache (even if this instance never saw the raise), the registry row, and
 * a null hint so the other machines do not keep a ghost in the queue.
 *
 * Callers with the registry on must already have confirmed there is no
 * remaining cluster seat, and should run this inside that peer's write
 * chain so the delete is visible to the roster that follows.
 */
async function dropRaisedHandForUser(
  voiceChannelId: string,
  userId: string,
): Promise<void> {
  forgetLocalRaisedHand(voiceChannelId, userId);
  if (registryOn()) {
    await setVoiceRaisedHandRow(voiceChannelId, userId, false);
  }
  if (clusterOn()) {
    publishVoice(VOICE_RAISED_HAND_TOPIC, {
      channelId: voiceChannelId,
      userId,
      raisedAt: null,
    } satisfies VoiceRaisedHandFrame);
  }
}

/**
 * Put one person's hand up or take it down, then tell the room.
 *
 * Row first, then the wire, then the local half, exactly as
 * `setVoiceUserServerMuted` does and for the same reason: the row is what a
 * join and a roster read, so an instance that re-reads on the hint below must
 * find the answer already there.
 *
 * THE ROW'S TIMESTAMP WINS when there is one. That is what stops two machines
 * with two wall clocks from disagreeing about who was first, and it is also
 * what makes a repeated raise idempotent: the insert does nothing on conflict
 * and the row hands back the original instant, so a client that redeclares
 * after a reconnect keeps the place it already had instead of going to the
 * back of its own queue.
 */
export async function setVoiceUserHandRaised(
  voiceChannelId: string,
  userId: string,
  raised: boolean,
): Promise<void> {
  let raisedAt: number | null = raised ? Date.now() : null;
  if (registryOn()) {
    raisedAt = await setVoiceRaisedHandRow(voiceChannelId, userId, raised);
    // The row refused the hand (the room emptied under it). Nothing to
    // announce: the queue's lifetime was that room's.
    if (raised && raisedAt === null) {
      return applyRaisedHandLocally(voiceChannelId, userId, null);
    }
  }
  if (clusterOn()) {
    publishVoice(VOICE_RAISED_HAND_TOPIC, {
      channelId: voiceChannelId,
      userId,
      raisedAt,
    } satisfies VoiceRaisedHandFrame);
  }
  return applyRaisedHandLocally(voiceChannelId, userId, raisedAt);
}

/**
 * The per-process half of a raise: the map and the fan-out. Run by the
 * instance the frame landed on and by every instance that receives
 * `voice.raisedHand`, each for the seats it holds.
 */
function applyRaisedHandLocally(
  voiceChannelId: string,
  userId: string,
  raisedAt: number | null,
): Promise<void> {
  let hands = roomRaisedHands.get(voiceChannelId);
  // Same rule as the mute map: a process with nobody in the room must not
  // cache the state, because nothing here would ever clear it and the rows
  // answer for that process anyway.
  const holdsRoom = getRoomPeers(voiceChannelId).length > 0;
  if (raisedAt !== null && (holdsRoom || !registryOn())) {
    if (!hands) {
      hands = new Map();
      roomRaisedHands.set(voiceChannelId, hands);
    }
    hands.set(userId, raisedAt);
  } else if (hands) {
    hands.delete(userId);
    if (hands.size === 0) {
      roomRaisedHands.delete(voiceChannelId);
    }
  }
  // Named peers rather than a bare "something changed", for the same reason
  // the mute names them: `handRaisedAt` is computed by `toParticipant` from
  // the map, so exactly this person's seats read differently and nothing
  // else does, which is what lets the fan-out send a delta.
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

/**
 * THE LAST SCREEN SHARE IN THE ROOM STOPPED. THE PARTY IS NOT OVER.
 *
 * This used to be `endSessionsOnChannel`, and it ended the live watch party
 * on the spot. PR #720 gave that end its missing fan-out (broadcast the
 * `watch-party-update`, put the channel's slow mode and floor back), which
 * turned a silent bug into a loud one within hours: on 2026-09-18 a host
 * stopped sharing to pick another window and the whole party ended under
 * everybody watching.
 *
 * Stopping the share is not a statement about the party. `pushLiveHls` runs
 * on the very next line of the caller and tears the egress down, so the
 * STREAM ends exactly as it should; the audience lands on the `holding`
 * stage the party panel already draws for a live party with no picture, and
 * the host can share again and be back on air. The party ends when a host
 * presses Encerrar, when `sweepWatchPartyHosts` decides the host is gone for
 * good, or when `sweepWatchPartiesWithoutShare` runs out of patience
 * (`WATCH_PARTY_NO_SHARE_MINUTES`, default 15, and generous on purpose).
 *
 * BEST EFFORT. A share stopping must never fail because a stamp did.
 */
async function noteShareStopped(voiceChannelId: string): Promise<void> {
  try {
    await markChannelShareStopped(voiceChannelId);
  } catch (error) {
    console.error("[channel-sessions] share-stopped stamp failed:", error);
  }
}

function getLiveRoomPeers(voiceChannelId: string): VoicePeer[] {
  return getRoomPeers(voiceChannelId).filter((p) => p.orphanedAt === undefined);
}

/**
 * Clears the orphan timer (and, with it, `orphanedAt`). Every caller is one
 * of three transitions, and the idle-alone marks must not survive any of
 * them: `removeVoicePeerBySocket` calls this to clear a STALE timer right
 * before starting a fresh orphan period (so a clock left running from
 * before the socket dropped cannot carry into it); `reattachVoicePeer`
 * calls this to end that period when the same seat comes back; and
 * `removePeer` / `dropVoicePeerSilently` call this right before discarding
 * the peer object entirely, where it is moot either way. Skipping this on
 * reattach was a real bug: a resumed tab (an API deploy, say) got the
 * remainder of a clock that started before the disconnect, immediately
 * eligible for a disconnect the sweep's very next tick, with the warning
 * check unreachable behind it — no `voice-idle-warning` ever reached the
 * resumed tab, only the hangup. A reattach must get the same full window
 * and warning eligibility a person who was never orphaned gets.
 */
function cancelOrphan(peer: VoicePeer): void {
  if (peer.orphanTimer) {
    clearTimeout(peer.orphanTimer);
    peer.orphanTimer = undefined;
  }
  peer.orphanedAt = undefined;
  peer.aloneSince = undefined;
  peer.idleWarnedAt = undefined;
}

function retirePeerId(peerId: string, voiceChannelId: string): void {
  if (registryOn()) {
    // Ordered behind this peer's own delete, and joined into the channel's
    // pending writes, so a resume for this id that arrives right behind the
    // hangup waits for the row before it asks whether the id is retired
    // (`settledRowWrites` in the join handler).
    trackRowWrite(voiceChannelId, peerId, () => retireVoicePeerId(peerId));
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
  endMusicForEmptyRoom(voiceChannelId, notifySocket);
}

/**
 * The room emptied HERE. Whether that means the music is over depends on
 * whether the room is only here.
 *
 * Registry off, a room lives on one instance and the two questions are the
 * same one: forget the queue, tell the channel's sidebar and tell the socket
 * that just left. Registry on, this instance having nobody left says nothing
 * about the other machine, and announcing `channel-music: null` on that basis
 * would blank the sidebar pill for every viewer here while the song is still
 * playing for the people still in the call. So the cache goes either way
 * (nobody here is listening to it) and the announcement waits on the rows,
 * which after `settledRowWrites` are the cluster's answer.
 */
function endMusicForEmptyRoom(
  voiceChannelId: string,
  notifySocket?: WebSocket,
): void {
  const had = endMusic(voiceChannelId);
  const announce = () => {
    void broadcastChannelMusic(voiceChannelId);
    if (notifySocket) {
      send(notifySocket, {
        type: "music",
        channelId: voiceChannelId,
        state: null,
      });
    }
  };
  if (!registryOn()) {
    if (had) {
      announce();
    }
    return;
  }
  // WHETHER THIS PROCESS HELD A CACHE ENTRY SAYS NOTHING ABOUT THE ROW, so
  // the cleanup does not ask. An instance that missed every `voice.music`
  // frame for a room can perfectly well be the last one out of it, and
  // returning early on an empty cache would leave the queue on the row for
  // the next call in the channel to inherit. `clearMusicIfEmpty` is a no-op
  // when there is nothing to clear, and it is the statement that decides:
  // its own `NOT EXISTS` is the second, authoritative half of the emptiness
  // check below.
  void (async () => {
    await settledRowWrites(voiceChannelId);
    const remaining = await listVoicePeersInRoom(voiceChannelId);
    if (remaining.length > 0) {
      // Still a call on another machine. The row keeps the queue; this
      // instance simply has nobody to play it to any more.
      return;
    }
    const cleared = await clearMusicIfEmpty(voiceChannelId);
    if (had || cleared) {
      announce();
    }
  })().catch((error: unknown) => {
    logEvent("voice.registryWriteFailed", {
      op: "musicEnd",
      error: error instanceof Error ? error.message : String(error),
    });
    if (had) {
      announce();
    }
  });
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
    /**
     * The music queue's share of the two above: writes published for the
     * other machine, and writes from it applied here. See `musicCluster`.
     */
    musicRelayed: number;
    musicAdopted: number;
    /**
     * `set-music-listening` writes this process accepted. With the registry
     * on, each one is a row write the other machine can read (pitfall 12).
     */
    musicListeningWrites: number;
    /** Rooms adopted from a row with a queue and no clock. See `musicCluster`. */
    musicAnchorMissing: number;
    /**
     * `voice.hlsReconcile`: reconcile intents this instance published for a
     * channel whose transcode lives on the other machine, and intents it
     * acted on for a channel it owns. See `relayHlsReconcile`.
     */
    hlsReconcileRelayed: number;
    hlsReconcileApplied: number;
  };
  /**
   * `voice.registry.writesPerMinute`: registry writes actually issued
   * (`voice/registry.ts`'s `track()`, excluding the per-peer chain wrapper
   * that would double-count them) in the trailing 60 seconds. Zero when the
   * registry is off — there is nothing to write. This is the number the
   * 2026-09-12 postmortem (A2) needed and did not have: before that night's
   * fix, a mute toggle, a join and a leave each cost their own round trip
   * with no way to see the rate add up across sixty seated people.
   */
  registry: {
    writesPerMinute: number;
    /**
     * `VOICE_REGISTRY_BATCH`: what the write coalescer is doing, since boot.
     *
     * `rowsCoalesced / batchFlushes` IS the compression ratio, and it is the
     * number that says whether the flag is doing anything at all: a ratio of
     * about one means every flush carried one row, which is the unbatched
     * cost with extra latency. Pitfall 12 is why it is here at all — a flag
     * production sets must carry the counter that proves it runs.
     *
     * `flushFailures` is flushes that failed twice and fell back to per-row
     * writes, and `staleDropped` is the pitfall-13 guard firing at flush time
     * on a seat that left inside the window. Both belong at zero; a climbing
     * `staleDropped` is the guard working, not a leak.
     *
     * Null when batching is off, so a zero never claims a batcher is healthy
     * on a deployment that has none.
     */
    batch: VoiceRegistryBatchMetrics | null;
  };
  /**
   * WHETHER ANYONE IS SITTING IN A CALL THEY LEFT.
   *
   * `idleOverAnHour` and `oldestIdleMinutes` read the rows: a seat is written
   * on join, on every state change and on resume, so a row nobody has
   * touched in an hour is either a person who has genuinely sat silent that
   * long or a seat with nobody behind it. On 2026-09-08 ten of nineteen rooms
   * held exactly one such person, the oldest for fifteen hours, and no number
   * anywhere said so.
   *
   * `staleRowWritesRefused` and `ghostsSwept` are this process since boot, and
   * they are the mechanism rather than the symptom: the first is a write that
   * would have resurrected a deleted seat, the second is one that got through
   * and had to be swept. Both should sit at zero.
   *
   * Null when the registry is off: with no rows there is nothing to read, and
   * a zero would claim an all-clear this deployment cannot give.
   */
  seats: {
    idleOverAnHour: number;
    oldestIdleMinutes: number | null;
    staleRowWritesRefused: number;
    ghostsSwept: number;
    meshHoldsRefused: number;
    /**
     * After a database outage: seats this instance re-wrote to their rows,
     * and reconcile passes it held back while other instances' leases were
     * stale for the same reason its own was (`otherLeasesTrustworthy`). Zero
     * outside an incident.
     */
    seatsReassertedAfterOutage: number;
    reconcilesDeferredAfterOutage: number;
    rostersSentWithoutRows: number;
    /** Idle hangups since boot: warnings sent, and seats actually released. */
    idleAloneWarned: number;
    idleAloneDisconnected: number;
    /**
     * Sockets that declared `mesh-resume`, against `roster.sockets` for the
     * denominator. THE NUMBER THAT SAYS WHEN TO FLIP
     * `VOICE_MESH_RESUME_REQUIRES_CAP`: while it is well short of the total,
     * turning the rule on would cost browsers still running an older bundle
     * their seamless mesh resume. Phones never declare it and never will, so
     * it does not converge on the total; it converges on the browser share.
     */
    meshResumeSockets: number;
    /** Authenticated sockets right now: the denominator for the line above. */
    sockets: number;
  } | null;
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
    /** `voice.live` frames published for the other machine since boot. */
    audienceFramesRelayed: number;
    /** `voice.live` frames from the bus applied here since boot. Zero on
     * one machine; on two, climbs beside the other machine's `Relayed`. */
    audienceFramesFromBus: number;
    /** Watch-mode viewers without a seat, every channel, right now. */
    watching: number;
    /** Channels with a live stream this instance last announced. */
    liveChannels: number;
    /** Proactive per-session token-renewal passes run since boot (`HLS_VIEWER_TOKEN_REMINT_MS`). */
    tokenRemintLoops: number;
    /** Fresh viewer tokens handed out by those passes since boot. */
    tokenRemints: number;
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
    /** The room's pinned media path. */
    transport: VoiceRoomTransport;
    /**
     * When the room's pin was written, ISO, or null when this process
     * cannot answer that cheaply. The registry knows it (`voice_rooms.created_at`,
     * one join, `listVoiceRoomOccupancy` below); the in-process fallback does
     * not track a room's open time and is not worth a new map just to answer
     * it, so it reports null rather than guessing.
     */
    openedAt: string | null;
  }[];
}

/**
 * Voice peers THIS PROCESS holds, for the per-instance snapshot the heartbeat
 * writes. Deliberately the map and not the registry: summing every instance's
 * map is what makes `voice_peers` auditable rather than merely trusted, and a
 * row whose owner stopped holding a peer for it is exactly the ghost pitfall
 * 13 was about.
 */
export function localVoicePeerCount(): number {
  return peers.size;
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
    .map(([voiceChannelId, room]) => ({
      voiceChannelId,
      ...room,
      transport: getRoomTransport(voiceChannelId),
      openedAt: null,
    }))
    .sort((a, b) => b.participants - a.participants);
}

/**
 * Async only for the registry: with it on, rooms and participants come from
 * `voice_peers`, so the operator dashboard counts the whole cluster rather
 * than the instance that happened to serve the request. The peak stays
 * per-process, as the payload states. A failed read falls back to the map.
 */
/**
 * Seat health, read once and used twice: by the dashboard payload below and
 * by the hourly log line in `runVoiceReconcile`.
 *
 * SHARED ON PURPOSE. Two copies of "how healthy are the seats" is two numbers
 * that can disagree, and an operator comparing a Grafana panel against the
 * dashboard would have no way to tell which one was lying.
 *
 * Null with the registry off: no rows, nothing to read, and a zero would
 * claim an all-clear this deployment cannot give.
 */
async function readSeatHealth(): Promise<VoiceActivitySnapshot["seats"]> {
  if (!registryOn()) {
    return null;
  }
  try {
    const idle = await countIdleVoiceSeats(SEAT_IDLE_ALARM_MS);
    return {
      idleOverAnHour: idle.seats,
      oldestIdleMinutes: idle.oldestIdleMinutes,
      // Both halves of the same refusal: the one this file catches when the
      // write is asked for, and the one `registry-batch.ts` catches at flush
      // time on a seat that left inside the window. They mean the same thing
      // to an operator, so they are one number.
      staleRowWritesRefused:
        staleRowWritesRefused + voiceRegistryBatchMetrics().staleDropped,
      ghostsSwept: ghostSeatsSwept,
      meshHoldsRefused,
      seatsReassertedAfterOutage,
      reconcilesDeferredAfterOutage,
      rostersSentWithoutRows,
      idleAloneWarned,
      idleAloneDisconnected,
      meshResumeSockets: countAuthenticatedSockets(SOCKET_CAPS.meshResume)
        .withCap,
      sockets: countAuthenticatedSockets(SOCKET_CAPS.meshResume).sockets,
    };
  } catch (error) {
    logEvent("voice.registryReadFailed", {
      op: "idleSeats",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The seat numbers, into the LOGS, once an hour.
 *
 * `GET /api/admin/metrics` is a pull: nothing writes it down, so nothing in
 * Loki has ever carried these numbers and no alert or panel could be built on
 * them. That matters most for exactly one decision, which is when it is safe
 * to set `VOICE_MESH_RESUME_REQUIRES_CAP`: the answer is a ratio of
 * `meshResumeSockets` to `sockets`, and reading a ratio off a dashboard that
 * only shows the current instant, at whatever moment you happen to look, is
 * not reading a trend. An hour is the right cadence for a number that moves
 * as browsers cycle onto a new bundle over days.
 *
 * Also the counter that proves the rest of this file runs at all:
 * `ghostsSwept` and `staleRowWritesRefused` sitting at zero forever is the
 * healthy reading, and until now nobody could have seen it.
 */
const SEAT_LOG_INTERVAL_MS = 60 * 60_000;
let seatsLoggedAt = 0;

async function logSeatHealth(now = Date.now()): Promise<void> {
  if (now - seatsLoggedAt < SEAT_LOG_INTERVAL_MS) {
    return;
  }
  seatsLoggedAt = now;
  const seats = await readSeatHealth();
  if (!seats) {
    return;
  }
  logEvent("voice.seats", {
    idleOverAnHour: seats.idleOverAnHour,
    oldestIdleMinutes: seats.oldestIdleMinutes ?? 0,
    ghostsSwept: seats.ghostsSwept,
    staleRowWritesRefused: seats.staleRowWritesRefused,
    meshHoldsRefused: seats.meshHoldsRefused,
    idleAloneWarned: seats.idleAloneWarned,
    idleAloneDisconnected: seats.idleAloneDisconnected,
    meshResumeSockets: seats.meshResumeSockets,
    sockets: seats.sockets,
    requiresCap: meshResumeRequiresCap(),
  });
}

/** Test seam: the hourly seat line is a clock, and a test needs to move it. */
export function resetSeatHealthLog(): void {
  seatsLoggedAt = 0;
}

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
  const seats = await readSeatHealth();
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
      musicRelayed: musicCluster.relayed,
      musicAdopted: musicCluster.adopted,
      musicListeningWrites: musicCluster.listeningWrites,
      musicAnchorMissing: musicCluster.anchorMissing,
      hlsReconcileRelayed: hlsReconcileRelay.published,
      hlsReconcileApplied: hlsReconcileRelay.applied,
    },
    registry: {
      writesPerMinute: registryOn() ? voiceRegistryWritesPerMinute() : 0,
      batch:
        registryOn() && isVoiceRegistryBatchEnabled()
          ? voiceRegistryBatchMetrics()
          : null,
    },
    seats,
    roster: {
      deltas: rosterFramesSent.deltas,
      snapshots: rosterFramesSent.snapshots,
      audienceSnapshots: rosterFramesSent.audienceSnapshots,
      sockets: rosterSocketCensus.sockets,
      socketsOnDeltas: rosterSocketCensus.withCap,
    },
    liveHls: {
      audienceFrames: hlsAudienceFramesSent.frames,
      audienceFramesRelayed: hlsAudienceFramesSent.relayed,
      audienceFramesFromBus: hlsAudienceFramesSent.fromBus,
      watching: hlsAudience
        .liveChannels()
        .reduce((sum, id) => sum + hlsAudience.count(id), 0),
      liveChannels: hlsAudience.liveChannels().length,
      tokenRemintLoops: hlsTokenRemint.loops,
      tokenRemints: hlsTokenRemint.tokens,
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
    listeningMusic: peer.listeningMusic,
    cameraStreamId: peer.cameraStreamId,
    screenAudioStreamId: peer.screenAudioStreamId,
    muted: peer.muted,
    deafened: peer.deafened,
    canSpeak: peer.canSpeak,
    serverMuted: isVoiceUserServerMuted(peer.voiceChannelId, peer.userId),
    canStream: peer.canStream,
    handRaisedAt: voiceUserHandRaisedAt(peer.voiceChannelId, peer.userId),
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
 * nothing (a channel deleted mid-share).
 *
 * It used to be skipped for a stop, which read as a saving and was a lost
 * distinction: `null` means "not a server channel" to `reconcileLiveHls`, so
 * an ordinary end of share took the not-allowlisted branch instead of the
 * no-share one and was torn down without a word. See `pushLiveHls`.
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
 * First sharer in a WATCH PARTY room gets a Track Composite HLS egress.
 * Nobody sharing stops it. Failures stay in the log: a missed transcode must
 * not refuse the share itself.
 *
 * The sharer is read through `pickHlsSharer`, which asks two questions and
 * this function asks neither of them itself. The stage bit (`canStream`,
 * which in a watch party is START_WATCH_PARTY): `set-sharing-screen` refuses
 * the claim without it and `reevaluateVoiceSpeak` clears the share when it is
 * revoked, and this is the same gate read where a transcode actually starts.
 * And the room type (`watchParty`): a screen share in an ordinary voice
 * channel that happens to be on the SFU never starts one.
 */
/**
 * How long the sharer may be missing before the broadcast is torn down.
 *
 * Five seconds: comfortably longer than a reconnect's re-declare or a
 * permissions bump's round trip, and short enough that a real "stop sharing"
 * does not leave a frozen frame up for a noticeable time. It is not the 90 s
 * seat orphan window: a seat being held is invisible, a transcode being held
 * costs a core.
 *
 * `HLS_NO_SHARER_GRACE_MS=0` restores the old behaviour, which is a stop on
 * the first push that finds nobody sharing. That is the rollback switch, and
 * it is also what the stop-path tests in `voice-hls-audience.test.ts` set, so
 * that what they pin stays "the stop reaches the channel" rather than
 * accidentally becoming "the grace works".
 */
function noSharerGraceMs(): number {
  const raw = Number(process.env.HLS_NO_SHARER_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

/** When each channel's sharer went missing, while a stream is still up. */
const noSharerSince = new Map<string, number>();

/**
 * WHICH OF THE THREE GATE BITS WENT FALSE, because "no sharer" is three
 * different faults wearing one name and the log could not tell them apart.
 *
 * `pickHlsSharer` needs `watchParty && sharingScreen && canStream`. A
 * presenter who stopped sharing, a peer rebuilt by a reconnect that has not
 * re-declared yet, and a permissions bump that cleared `canStream` all arrive
 * here identically. The peers are dumped with their bits so the next
 * occurrence names itself instead of needing another party to reproduce.
 */
function logNoSharer(voiceChannelId: string, presenterPeerId: string): void {
  logEvent("voice.hlsSharerVanished", {
    channelId: voiceChannelId,
    presenterPeerId,
    graceMs: noSharerGraceMs(),
    peers: getRoomPeers(voiceChannelId).map((peer) => ({
      id: peer.id,
      watchParty: peer.watchParty,
      sharingScreen: peer.sharingScreen,
      canStream: peer.canStream,
      wasPresenter: peer.id === presenterPeerId,
    })),
  });
}

/**
 * Whether the room owes everybody a fresh `voice-stream` / `channel-live`.
 *
 * Pure and exported so the rule can be read and tested without a room, a
 * socket or a transcode: it is the gate in front of a per-recipient fan-out
 * that re-mints a token for every peer, so getting it wrong is either a
 * rebuffer for everybody (too eager) or a player left on a playlist nobody
 * is writing (too lazy).
 *
 * FIVE FIELDS, AND EACH ONE IS SOMETHING A PLAYER HAS TO ACT ON.
 *
 *  - `hlsUrl`: a different session, or a different delivery mode's master.
 *  - `presenterPeerId`: somebody else is presenting.
 *  - `cameraHlsUrl`: the camera rung is additive to the session
 *    (`docs/WATCH_PARTY.md`, "The presenter's camera, floating over the
 *    film"), so `hlsUrl` and the presenter are both identical either side of
 *    a host switching their webcam on; without this the frame carrying
 *    `cameraHlsUrl` would simply never be sent.
 *  - `mode`: the LL DEMOTION (`sweepLlDemotions` -> `notifyChanged` ->
 *    `pushLiveHls`). The player has to reload onto the conventional ladder,
 *    not sit polling a torn-down LL playlist until it gives up and the
 *    audience reads "A transmissão caiu". `hlsUrl` almost always moves with
 *    it -- a demotion mints a new `startedAt`, and an LL master carries
 *    `?mode=ll` where a conventional one carries no marker at all -- so this
 *    is belt and braces. It is here anyway because `mode` IS the field the
 *    client keys its engine configuration on, and a frame that changed it
 *    without saying so is the failure this rule exists to stop.
 *  - `partTargetMs`: sizes the LL player's hold-back and its stall watchdog.
 *
 * Everything ELSE `LiveHlsStream` can carry (`topHeight`, `hasAudio`,
 * `delaySeconds`, ...) is deliberately not here: those are read once when a
 * player attaches, and re-sending the room over one of them would be a
 * per-peer fan-out for something nobody re-reads.
 */
export function liveHlsFrameChanged(
  prev: LiveHlsStream | null,
  next: LiveHlsStream | null,
): boolean {
  return (
    (prev?.hlsUrl ?? null) !== (next?.hlsUrl ?? null) ||
    (prev?.presenterPeerId ?? null) !== (next?.presenterPeerId ?? null) ||
    (prev?.cameraHlsUrl ?? null) !== (next?.cameraHlsUrl ?? null) ||
    (prev?.mode ?? null) !== (next?.mode ?? null) ||
    (prev?.partTargetMs ?? null) !== (next?.partTargetMs ?? null)
  );
}

/**
 * THE CAMERA IS ANNOUNCED BEFORE IT IS PUBLISHED. Every client sends
 * `set-camera` first (so receivers can classify the video when it lands) and
 * publishes to LiveKit after, so the reconcile that frame triggers asks the
 * SFU a moment too early, finds no camera track, and has nothing else to
 * wake it until an unrelated roster event. A presenter alone on stage in a
 * watch party produces none, which is how a 2026-09-23 rehearsal turned the
 * camera on right after going live and got no camera recording at all (and
 * why production had three camera rows ever). A few delayed reconciles after
 * the announcement close the gap for every client already out there,
 * phones included, without waiting for them to change their order. Each is
 * the same cheap, serialised, idempotent call: a no-op in a room that is not
 * transcoding, and one `listParticipants` in one that is.
 */
const CAMERA_FOLLOW_UP_RECONCILE_MS: readonly number[] = [1_500, 5_000, 15_000];
let cameraFollowUpDelays: readonly number[] = CAMERA_FOLLOW_UP_RECONCILE_MS;

/** Tests only: shorter follow-ups, or the defaults back with no argument. */
export function setCameraFollowUpDelaysForTests(delays?: readonly number[]): void {
  cameraFollowUpDelays = delays ?? CAMERA_FOLLOW_UP_RECONCILE_MS;
}
const cameraFollowUpTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

function scheduleCameraFollowUpReconciles(voiceChannelId: string): void {
  for (const timer of cameraFollowUpTimers.get(voiceChannelId) ?? []) {
    clearTimeout(timer);
  }
  const delays = cameraFollowUpDelays;
  const timers = delays.map((delay, i) => {
    const timer = setTimeout(() => {
      if (i === delays.length - 1) {
        cameraFollowUpTimers.delete(voiceChannelId);
      }
      void pushLiveHls(voiceChannelId).catch((error: unknown) => {
        console.error(
          "[voice] pushLiveHls failed on a camera follow-up:",
          voiceChannelId,
          error,
        );
      });
    }, delay);
    timer.unref?.();
    return timer;
  });
  cameraFollowUpTimers.set(voiceChannelId, timers);
}

async function pushLiveHls(voiceChannelId: string): Promise<void> {
  if (getRoomTransport(voiceChannelId) !== "livekit") {
    return;
  }
  // THE RECONCILE HAS TO HAPPEN WHERE THE TRANSCODE IS.
  //
  // Everything below is written against this process's own maps: the peers it
  // holds, `rooms` and `llRooms` in the two drivers. With two machines and no
  // session affinity, a viewer's `voice.join` lands on whichever one Fly
  // picked, and roughly half the time that is not the machine holding the
  // presenter and the egress. `reconcileLiveHls` then runs against an empty
  // map and does nothing whatsoever — including the mode re-check at the top
  // of `reconcileLiveHlsNow`, which is the only thing that would notice a
  // party that has been demoted off the LL path and owes its audience the
  // conventional ladder. On 2026-09-14 that is exactly what happened: joins
  // on machine A, presenter and egress on B, and the re-check never ran.
  //
  // So a machine that does not own the channel says so on the bus instead,
  // and the owner does its own local half. Nothing changes on one machine
  // (`isBusEnabled()` is false) and nothing changes on the owner, which takes
  // the local path below exactly as it always did.
  //
  // GATED ON THERE BEING SOMETHING TO RECONCILE, which is `hlsAudience`
  // holding a stream this instance did not produce: on a non-owner that map
  // is filled by `voice.live` and nothing else, so a non-empty entry is the
  // other machine having said "there is a party here" (a Farol finding on PR
  // #618 -- without it, every join and leave in every ordinary LiveKit voice
  // room published a frame that woke the whole cluster to discover there was
  // no transcode anywhere).
  //
  // THE LOCAL PATH STILL RUNS BELOW, deliberately. Relaying is not a handoff:
  // a channel NOBODY owns yet is the ordinary case for a share that is about
  // to start, and the machine holding the presenter is the one that has to
  // start it. Returning here instead would mean a party whose first reconcile
  // happens to find no owner never gets one. The two are not in conflict on
  // the machine that matters: a non-owner with no local sharer resolves
  // `presenterPeerId: null` and its `reconcileLiveHls` has no room to stop.
  if (!liveHlsOwnsChannel(voiceChannelId) && hlsAudience.stream(voiceChannelId)) {
    relayHlsReconcile(voiceChannelId);
  }
  // THE PARTY IS THE BROADCAST, AND ENDING IT ENDS THE BROADCAST.
  // `pickHlsSharer` asks whether somebody is sharing in a watch-party room
  // with the stage bit, and never asked whether a party is live, so a host who
  // pressed Encerrar and left their share running kept a two-rung transcode
  // alive with nothing naming it: about 1.4 cores of the media box, segments
  // written for as long as it ran, and a `channel-live` frame telling the
  // whole server there was something to watch. Seen in production on
  // 2026-09-09, half an hour after the last party ended.
  //
  // Their screen share itself is untouched: it is a voice room, people watch
  // each other's screens in it, and ending a show is not the same act as
  // stopping a share. Only the broadcast to people without a seat stops.
  const over = watchPartyKnownOver(voiceChannelId);
  const sharing = pickHlsSharer(getRoomPeers(voiceChannelId));
  // BOTH DRIVERS, BECAUSE BOTH DRIVERS PRODUCE A STREAM.
  //
  // `liveHlsStreamFor` is the conventional ladder's `rooms` map and nothing
  // else; an LL session lives in `llRooms` (`hls-remux.ts`) and is reached
  // through `llStreamFor`. Reading only the first made every comparison
  // below lie about an LL party in the one direction that matters: on the
  // push that ENDS one, `prev` was already null, `next` was null too, and
  // `liveHlsFrameChanged(null, null)` is false — so the whole fan-out under
  // it was skipped. No `voice-stream`, no `channel-live` with `ended`, no
  // `hlsAudience.setStream(null)` to stop the 30-second keyframe and the
  // token re-mint, and no `voice.live` on the bus for the other machine's
  // audience cache.
  //
  // Seen in production on 2026-09-15: channel `d5559e70`'s LL session ran
  // 18:14:47 to 18:33:11 UTC and ended cleanly, and at 19:36 the host's own
  // freshly loaded page was still being handed that dead session every
  // thirty seconds, on both machines. The edge Worker answered 503 "no-state"
  // for it (correctly), the player sat on "A transmissão travou,
  // reconectando", and the host could not get past the watch surface to set
  // up a new party.
  //
  // Reading both maps also stops the mirror-image waste on the way in: with
  // `prev` pinned at null, EVERY push for a live LL party compared null
  // against the running stream, called that a change, and re-minted a token
  // for every peer and every member of the channel's audience on every
  // roster event.
  const prev = liveHlsStreamFor(voiceChannelId) ?? llStreamFor(voiceChannelId);
  // Once, on the push that tears it down: `prev` is null on every push after.
  if (over && prev && sharing) {
    logWatchPartyOverStop(voiceChannelId, sharing.id);
  }
  if (sharing) {
    noSharerSince.delete(voiceChannelId);
  } else if (!over && prev) {
    // A SHARER THAT VANISHES FOR A MOMENT MUST NOT END THE BROADCAST.
    //
    // `pickHlsSharer` needs `watchParty && sharingScreen && canStream`, and
    // all three can go false without the presenter doing anything. A
    // reconnect that reconstructs rather than adopts starts the peer with
    // `sharingScreen: false` until the client re-declares; and
    // `reevaluateVoiceSpeak` clears `sharingScreen` outright for anyone whose
    // `canStream` resolves false, which runs on every permissions bump,
    // including the ones a watch party's own options reconciler causes by
    // writing channel overwrites.
    //
    // Until now the first such push ended the session, and production logged
    // `voice.hlsStopped reason=no-share` twice inside sixteen minutes on one
    // continuous party where nobody stopped sharing. Each one is a new
    // `startedAt` and a rebuffer for every seatless viewer.
    //
    // So a disappearance has to persist before it counts. A genuine stop
    // costs the audience one grace window of a frozen last frame, which
    // is nothing; a transient one now costs them nothing at all. Deliberately
    // NOT applied to `over`: ending the party is somebody pressing a button
    // and should take effect at once.
    const grace = noSharerGraceMs();
    const since = noSharerSince.get(voiceChannelId);
    if (grace > 0 && since === undefined) {
      noSharerSince.set(voiceChannelId, Date.now());
      logNoSharer(voiceChannelId, prev.presenterPeerId);
      // Nothing else will look again: the sharer going away is the last event
      // this channel produces until somebody does something. So the grace has
      // to wake itself up.
      setTimeout(() => {
        void pushLiveHls(voiceChannelId);
      }, grace + 100).unref?.();
      return;
    }
    if (grace > 0 && since !== undefined && Date.now() - since < grace) {
      return;
    }
    noSharerSince.delete(voiceChannelId);
  } else {
    noSharerSince.delete(voiceChannelId);
  }
  const sharer = over ? null : sharing;
  try {
    // RESOLVED EVEN WITH NO SHARER, and it used to be `sharer ? ... : null`.
    // That looked like a saved lookup and was a lost distinction: null means
    // "not a server channel" to `reconcileLiveHls`, so an ordinary end of
    // share took the not-allowlisted branch, which tore the session down
    // without a word, instead of the no-share branch, which says so. A live
    // party then showed two starts nine minutes apart with nothing logged in
    // between and no way to tell why. It is a map read (see
    // `hlsServerIdFor`), so the lookup was never worth the ambiguity.
    const serverId = await hlsServerIdFor(voiceChannelId);
    const next = await reconcileLiveHls(
      voiceChannelId,
      sharer?.id ?? null,
      serverId,
      sharer?.sourceHeight ?? null,
    );
    if (!liveHlsFrameChanged(prev, next)) {
      return;
    }
    // STAMPED HERE, BEFORE THE FAN-OUT'S AWAITS. `publishChannelLive` used to
    // read the clock when it ran, which is after this function has awaited
    // the audience: a start and a stop reconciling at once could then publish
    // out of order, the stop first and the stale start behind it with the
    // LATER number, and the other machine would accept the start and hold an
    // ended playlist. The number is now the moment this process accepted the
    // reconcile's answer, which is the order the answers actually happened in.
    const at = Date.now();
    // Per peer rather than `broadcastToRoom`: the playlist URL carries a
    // token bound to the recipient, so there is no one frame for the room.
    let peersTold = 0;
    for (const peer of getRoomPeers(voiceChannelId)) {
      send(peer.socket, {
        type: "voice-stream",
        channelId: voiceChannelId,
        stream: next ? stampViewerStream(next, peer.userId) : null,
      });
      peersTold += 1;
    }
    hlsAudience.setStream(voiceChannelId, next);
    rememberChannelStream(voiceChannelId, next, prev?.startedAt ?? null);
    // An LL stream this process just stopped or replaced cannot be verified
    // against a row any more either: forget the memo so the next resolve for
    // this channel asks again rather than trusting a "still open" from before
    // the stop.
    llVerifiedAt.delete(voiceChannelId);
    // `next` is the reconcile's own answer, so the frame carries it rather
    // than resolving again: a `null` here is the session this process just
    // ended, which is as certain as it gets.
    const audienceTold = await broadcastChannelLive(voiceChannelId, {
      stream: next,
      known: true,
    });
    publishChannelLive(voiceChannelId, next, prev, at);
    // ONE LINE PER LL TEARDOWN, because the fifteen hours this bug ran
    // produced not a single one. `voice.hlsLlStopped` says the box was told;
    // this says the PEOPLE were, and how many of them.
    if (prev?.mode === "ll" && next?.mode !== "ll") {
      logEvent("voice.hlsLlStreamCleared", {
        channelId: voiceChannelId,
        reason: next ? "replaced" : over ? "party-over" : "no-share",
        startedAt: prev.startedAt,
        sockets: peersTold + audienceTold,
        relayed: isBusEnabled(),
      });
    }
  } catch (error) {
    logEvent("voice.hlsReconcileFailed", {
      channelId: voiceChannelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// A party went live or ended: reconcile the stream on the spot rather than at
// the next roster event. Ending a show has to end the broadcast even when
// nobody joins or leaves the room afterwards, which is the ordinary case.
setWatchPartyLiveListener((channelId) => {
  void pushLiveHls(channelId);
});

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

/**
 * IS THIS PERSON STILL THE PRESENTER, asked by the media path at the moment
 * it is about to spend a core on them (`LiveHlsPresenterCheck`).
 *
 * The same two authorities `pushLiveHls` reads, and deliberately no others:
 * a party this process saw end, and the room's current `pickHlsSharer`. What
 * makes it worth asking twice is WHEN: the push reads them before a server-id
 * lookup, a mode resolve and this channel's whole reconcile queue, and on
 * 2026-09-17 a start that had been decided before a party ended ran after it,
 * for a presenter who left 200 ms later.
 *
 * A peer id that is no longer in the room, or is in it without the three bits
 * `pickHlsSharer` needs, is "gone". That is the conservative answer on
 * purpose: the cost of it being briefly wrong is a start the very next push
 * makes anyway (every one of those bits changing is itself a `pushLiveHls`),
 * and the cost of the other answer is a transcode nobody is watching.
 */
setLiveHlsPresenterCheck((channelId, presenterPeerId) => {
  if (watchPartyKnownOver(channelId)) {
    return false;
  }
  return pickHlsSharer(getRoomPeers(channelId))?.id === presenterPeerId;
});

/**
 * The stream a `channel-live` frame carries for this channel, from THIS
 * process's point of view.
 *
 * `liveHlsStreamFor` is the egress's own `rooms` map, populated only on the
 * instance running the transcode. `hlsAudience.stream` is what the audience
 * was last told, which on that same instance is the same object (`pushLiveHls`
 * sets it right before every fan-out) and on the OTHER instance is what
 * `voice.live` relayed (see `subscribeToCluster(VOICE_LIVE_TOPIC)`). Until
 * 2026-09-14 every frame read only the first, so the second machine's
 * keyframe, its socket-auth catch-up and its `watch-live` answer all said
 * `stream: null` for a party that was live one machine over; a viewer whose
 * socket landed there stayed on "Preparando a transmissão" for the whole
 * show. The order matches `getChannelLiveState`: the egress's own answer
 * wins wherever it exists.
 */
function channelStreamFor(channelId: string): LiveHlsStream | null {
  return (
    liveHlsStreamFor(channelId) ??
    llStreamFor(channelId) ??
    hlsAudience.stream(channelId)
  );
}

/**
 * What a frame may say about this channel's stream, and whether the server
 * can vouch for it.
 *
 * The in-process maps first (`channelStreamFor`); when every one of them is
 * empty, the `hls_sessions` row, the same last resort `getChannelLiveState`
 * reaches for and for the same reason: on the machine that is not running
 * the egress, "my maps are empty" is not "nothing is live". Until 2026-09-14
 * the welcome's `voice-stream`, every `channel-live` and the 30-second
 * keyframe read the raw local map, so that machine told a viewer who had
 * just loaded the right stream over `GET /live` that there was none, the
 * client believed the newer frame, and the seat backstop hung them up.
 *
 * `known` is false only when the table could not be asked: the frame then
 * carries `stream: null` without `ended`, which the client treats as "not
 * told" rather than "over". The row is memoised for a few seconds per
 * channel so a wave of `watch-live` subscribes or a socket-auth storm after a
 * deploy is one query per channel, not one per socket; the machine running
 * the egress never reaches the table at all (its own map answers first), and
 * once the `voice.live` relay has landed on the other machine neither does
 * that one.
 */
const HLS_DB_STREAM_MEMO_MS = 5_000;
/**
 * A row read that found NOTHING is held longer than one that found a stream.
 * A positive is short-lived because it is a guess that an authoritative frame
 * should replace within seconds; a negative is the answer for a channel with
 * no party at all, and the keyframe below asks for it once a tick for as long
 * as anybody has such a channel open. One query a minute per channel is the
 * price of converging after a lost bus frame; one per tick would be polling.
 */
const HLS_DB_STREAM_MISS_MEMO_MS = 60_000;
const dbStreamMemo = new Map<
  string,
  { at: number; stream: LiveHlsStream | null }
>();
/**
 * One query per channel, not per caller. The memo is written only when the
 * row comes back, so without this a wave of `watch-live` subscribes for the
 * same channel each start their own round trip (and each retry their own
 * failure) before any of them has an answer to memoise.
 */
const dbStreamInFlight = new Map<
  string,
  Promise<{ stream: LiveHlsStream | null; known: boolean }>
>();

/**
 * AN AUTHORITATIVE ANSWER DROPS THE GUESS. Called wherever this process
 * learns what a channel is really playing: its own `pushLiveHls` after a
 * reconcile, and the `voice.live` relay from the other machine.
 *
 * A stop is the case that matters. `resolveChannelStream` consults
 * `hlsAudience` before the memo, so a live stream always wins on its own;
 * but a machine that answered from the session row and then heard the stop
 * would keep handing that ended playlist to the next joiner for the rest of
 * the memo's few seconds, with no `ended` marker, which is the very shape
 * this PR exists to remove. Deleting rather than storing a null keeps the
 * recovery path honest: the next caller asks the table again, which is the
 * one source that can still say "a party started on the other machine while
 * the bus was down".
 */
function rememberChannelStream(
  channelId: string,
  stream: LiveHlsStream | null,
  /**
   * The `startedAt` of the session a local stop just ended. Recorded as a
   * fence: a `voice.live` frame that crossed while this process was stopping
   * carries that same session, and adopting it would put the stream back on
   * the machine that had just taken it down, with no `liveHlsStreamFor` and
   * no held stream left for the handler's lineage checks to catch it with.
   */
  endedStartedAt?: number | null,
): void {
  // Bumped BEFORE the write, so a query already in flight can see that it has
  // been overtaken (`readChannelStreamFromDb`). Without it the losing race is
  // the bug itself: the relay says the party stopped, deletes the memo, and
  // the row read that started a moment earlier lands afterwards and puts the
  // ended stream back for the rest of the TTL.
  streamGeneration.set(channelId, (streamGeneration.get(channelId) ?? 0) + 1);
  if (stream) {
    dbStreamMemo.set(channelId, { at: Date.now(), stream });
    locallyEndedAt.delete(channelId);
  } else {
    dbStreamMemo.delete(channelId);
    if (endedStartedAt != null) {
      locallyEndedAt.set(
        channelId,
        Math.max(locallyEndedAt.get(channelId) ?? 0, endedStartedAt),
      );
    }
  }
  pruneLiveChannelState();
}

/**
 * How many authoritative answers this process has installed for a channel.
 * Only ever compared for equality across one `await`; the number itself means
 * nothing.
 */
const streamGeneration = new Map<string, number>();

/** The newest session THIS process has stopped, per channel. See above. */
const locallyEndedAt = new Map<string, number>();

/**
 * Both per-channel maps are keyed by every channel that has ever gone live or
 * been asked about, and a `pqp-api` process runs for days. Neither entry is
 * large, but neither was ever removed either, so this sweeps the ones that
 * can no longer matter: a memo past its TTL, and a straggler guard for a
 * channel nothing has said anything about for half an hour (far longer than
 * a frame can be in flight). Only walked when the maps are big enough to be
 * worth walking, so the ordinary deployment never pays for it.
 */
const LIVE_CHANNEL_STATE_SWEEP_AT = 512;
const RELAYED_LIVE_AT_MAX_AGE_MS = 30 * 60_000;
function pruneLiveChannelState(): void {
  const now = Date.now();
  if (dbStreamMemo.size > LIVE_CHANNEL_STATE_SWEEP_AT) {
    for (const [channelId, memo] of dbStreamMemo) {
      if (now - memo.at > HLS_DB_STREAM_MISS_MEMO_MS) {
        dbStreamMemo.delete(channelId);
      }
    }
  }
  if (relayedLiveAt.size > LIVE_CHANNEL_STATE_SWEEP_AT) {
    for (const [channelId, at] of relayedLiveAt) {
      if (now - at > RELAYED_LIVE_AT_MAX_AGE_MS && !hlsAudience.stream(channelId)) {
        relayedLiveAt.delete(channelId);
        streamGeneration.delete(channelId);
        locallyEndedAt.delete(channelId);
      }
    }
  }
  // Bounded by its own TTL rather than by the sweep threshold: an entry is
  // meaningless the moment it expires, and there are never more of them than
  // there are LL parties this machine is watching without owning.
  for (const [channelId, memo] of llVerifiedAt) {
    if (now - memo.at > memo.ttl) {
      llVerifiedAt.delete(channelId);
    }
  }
}

/**
 * How long a `mode: "ll"` stream this process did not produce is trusted
 * before its session row is asked about again.
 *
 * A SECOND STRAP, and it exists because the first one can be lost. The stop
 * reaches this machine as a `voice.live` frame (`pushLiveHls` ->
 * `publishChannelLive`), the bus is best-effort by design, and a stream this
 * process holds in `hlsAudience` and nowhere else is restated to the whole
 * channel every `ROSTER_AUDIENCE_KEYFRAME_MS` for as long as it sits there.
 * That is the 2026-09-15 shape exactly: a dead LL session handed to the host
 * every thirty seconds for an hour, with the machine holding it perfectly
 * convinced it was being helpful.
 *
 * ONLY LL, and only when the local drivers cannot answer. A conventional
 * stream is not covered here on purpose: it has no equivalent of the edge
 * Worker's "no-state" wall (a stale conventional playlist reads as a frozen
 * DVR, not a hard stall), and adding a query behind every join for every
 * mode is a cost this path has spent five revisions avoiding. Half a
 * keyframe interval, so a missed stop costs the audience at most one more
 * restatement before the row settles it.
 */
const LL_SESSION_VERIFY_MS = 15_000;

/**
 * And how long a check that COULD NOT BE MADE is held for.
 *
 * `isHlsSessionOpen` fails open, which is right — a query timeout must not
 * take a live party's playlist away — but "fails open" without a memo means
 * the very next welcome, keyframe, re-mint and `GET /live` each start another
 * query into a database that is already the reason the last one failed. So a
 * failure is remembered too, just briefly: the stream keeps being served
 * throughout, and the retry is paced instead of being driven by traffic (a
 * Farol finding on this PR).
 */
const LL_SESSION_VERIFY_BACKOFF_MS = 5_000;

/**
 * When this process last ASKED about a relayed LL session, per channel: which
 * session, when, and how long that answer is good for (the two constants
 * above, by whether the row could be read).
 */
const llVerifiedAt = new Map<
  string,
  { startedAt: number; at: number; ttl: number }
>();
/**
 * Keyed by channel AND session, never by channel alone: a query for session A
 * that is still in flight when A is replaced by B must not be handed to B's
 * caller as if it had answered about B (a Farol finding on this PR).
 */
const llVerifyInFlight = new Map<string, Promise<boolean>>();

/**
 * Whether this stream is one the row check above has to be run for: an LL
 * stream, not verified recently enough, for this exact session.
 *
 * Pure and synchronous so the audience keyframe can ask before deciding
 * whether to restate from memory or resolve properly.
 */
function llVerifyDue(channelId: string, stream: LiveHlsStream): boolean {
  if (stream.mode !== "ll") {
    return false;
  }
  const memo = llVerifiedAt.get(channelId);
  return !(
    memo && memo.startedAt === stream.startedAt && Date.now() - memo.at < memo.ttl
  );
}

/**
 * Ask the row. Deduped per channel so a wave of joins, a keyframe and a
 * re-mint landing together is one query; a positive answer is memoised for
 * `LL_SESSION_VERIFY_MS` and a NEGATIVE one is not, because a negative is
 * acted on at once and there is nothing left to re-ask about.
 *
 * "Could not ask" answers true: see `isHlsSessionOpen`.
 */
async function relayedLlStillOpen(
  channelId: string,
  stream: LiveHlsStream,
): Promise<boolean> {
  if (!llVerifyDue(channelId, stream)) {
    return true;
  }
  const key = `${channelId}:${stream.startedAt}`;
  const inFlight = llVerifyInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  /**
   * NEVER BACKWARDS. Two sessions of one channel can be in flight at once
   * during a turnover, and the older query can land last; letting it stamp
   * the memo would leave the entry naming a session nobody holds, so the new
   * one re-queries on every caller until the stale entry expires (a Farol
   * finding on this PR). The memo is not load-bearing for correctness —
   * `llVerifyDue` compares the session before trusting it — so the whole cost
   * of getting this wrong is queries, which is exactly what the memo is for.
   */
  const remember = (ttl: number) => {
    const existing = llVerifiedAt.get(channelId);
    if (existing && existing.startedAt > stream.startedAt) {
      return;
    }
    // Nor for a session the channel has already moved past: the entry would
    // be about nothing, and the one slot is the session that IS held.
    const current = hlsAudience.stream(channelId);
    if (current && current.startedAt > stream.startedAt) {
      return;
    }
    llVerifiedAt.set(channelId, {
      startedAt: stream.startedAt,
      at: Date.now(),
      ttl,
    });
  };
  const query = isHlsSessionOpen(channelId, stream.startedAt)
    .then((answer) => {
      if (!answer.ok) {
        remember(LL_SESSION_VERIFY_BACKOFF_MS);
        return true;
      }
      if (answer.open) {
        remember(LL_SESSION_VERIFY_MS);
        return true;
      }
      // Only this session's own memo: a newer one installed while the row was
      // being read is not ours to drop.
      if (llVerifiedAt.get(channelId)?.startedAt === stream.startedAt) {
        llVerifiedAt.delete(channelId);
      }
      return false;
    })
    .finally(() => {
      llVerifyInFlight.delete(key);
    });
  llVerifyInFlight.set(key, query);
  return query;
}

/**
 * The cached stream is over: forget it, fence the session so a straggling
 * `voice.live` cannot put it back, tell this machine's sockets, and tell the
 * other machines.
 *
 * COMPARE AND CLEAR. The row read that sent us here is an `await` wide enough
 * for the channel to have moved on — a `voice.live` carrying the conventional
 * ladder a demotion started, a stop that arrived by the ordinary path, another
 * waiter on the same query getting here first. Clearing unconditionally would
 * then erase a stream that is genuinely live, or fan the same end out once per
 * waiter (both Farol findings on this PR). The map is only emptied while it
 * still holds the exact session that was verified, and because that test and
 * the write happen in one synchronous stretch, the first caller through is the
 * only one that acts.
 *
 * THE FAN-OUT RE-RESOLVES rather than carrying a `null` of its own, which is
 * what makes a REPLACEMENT the same code path as an end: with `hlsAudience`
 * emptied and the memo dropped, the resolve falls through to the session row
 * and finds whatever actually is live now. It terminates because this process
 * no longer holds the stream that sent it here.
 *
 * AND IT CROSSES THE BUS. Every machine that missed the original stop is
 * holding the same dead session, and each finding out for itself is a
 * `LL_SESSION_VERIFY_MS` wait apiece; `publishChannelLive` makes the first one
 * to notice tell the rest. The receiving handler's own lineage checks are what
 * keep that safe — a machine holding a NEWER session, or running the egress
 * for this one, drops the frame.
 */
function clearEndedLlStream(channelId: string, held: LiveHlsStream): boolean {
  const current = hlsAudience.stream(channelId);
  if (
    !current ||
    current.mode !== "ll" ||
    current.startedAt !== held.startedAt
  ) {
    return false;
  }
  const at = Date.now();
  hlsAudience.setStream(channelId, null);
  rememberChannelStream(channelId, null, held.startedAt);
  void broadcastChannelLive(channelId)
    .then((sockets) => {
      logEvent("voice.hlsLlStreamCleared", {
        channelId,
        reason: "row-ended",
        startedAt: held.startedAt,
        sockets,
        relayed: isBusEnabled(),
      });
    })
    .catch((error: unknown) => {
      console.error("[voice] ll stream clear fan-out failed:", error);
    });
  publishChannelLive(channelId, null, held, at);
  return true;
}

async function resolveChannelStream(
  channelId: string,
): Promise<{ stream: LiveHlsStream | null; known: boolean }> {
  // THE DRIVERS FIRST, and they are never second-guessed: this process is
  // running the session, so its own map is the authority `channelStreamFor`
  // describes.
  const owned = liveHlsStreamFor(channelId) ?? llStreamFor(channelId);
  if (owned) {
    return { stream: owned, known: true };
  }
  const relayed = hlsAudience.stream(channelId);
  if (relayed) {
    if (!(await relayedLlStillOpen(channelId, relayed))) {
      // A no-op when the channel moved on while the row was being read; the
      // re-read below is then the whole of this branch.
      clearEndedLlStream(channelId, relayed);
    }
    // RE-READ, NEVER `relayed`, EITHER WAY. The check above awaited a row, and
    // a stop or a replacement can have landed in that gap. Whatever is held
    // NOW is the answer; only when nothing is held at all does the row below
    // get asked what, if anything, replaced it.
    const current =
      liveHlsStreamFor(channelId) ??
      llStreamFor(channelId) ??
      hlsAudience.stream(channelId);
    if (current) {
      return { stream: current, known: true };
    }
  }
  const memo = dbStreamMemo.get(channelId);
  if (
    memo &&
    Date.now() - memo.at <
      (memo.stream ? HLS_DB_STREAM_MEMO_MS : HLS_DB_STREAM_MISS_MEMO_MS)
  ) {
    return { stream: memo.stream, known: true };
  }
  const inFlight = dbStreamInFlight.get(channelId);
  if (inFlight) {
    return inFlight;
  }
  const query = readChannelStreamFromDb(channelId).finally(() => {
    dbStreamInFlight.delete(channelId);
  });
  dbStreamInFlight.set(channelId, query);
  return query;
}

async function readChannelStreamFromDb(
  channelId: string,
): Promise<{ stream: LiveHlsStream | null; known: boolean }> {
  const generation = streamGeneration.get(channelId) ?? 0;
  try {
    const stream = await liveHlsStreamFromDb(channelId, { strict: true });
    if ((streamGeneration.get(channelId) ?? 0) !== generation) {
      // AN AUTHORITATIVE ANSWER LANDED WHILE WE WERE ASKING, and it is newer
      // than this row by construction: the machine running the egress ends
      // the session and only then says so. Answer from what it installed
      // (`null` after a stop, which is a positive `ended`), and do not put
      // this row in the memo, where it would outlive the stop it lost to.
      return { stream: channelStreamFor(channelId), known: true };
    }
    dbStreamMemo.set(channelId, { at: Date.now(), stream });
    pruneLiveChannelState();
    return { stream, known: true };
  } catch {
    // Already logged by `liveHlsStreamFromDb` (`voice.hlsLiveStreamDbFallbackFailed`).
    return { stream: null, known: false };
  }
}

function channelLiveFrameWith(
  channelId: string,
  userId: string,
  stream: LiveHlsStream | null,
  known: boolean,
): VoiceSignalingMessage {
  return {
    type: "channel-live",
    channelId,
    stream: stream ? stampViewerStream(stream, userId) : null,
    watching: hlsAudience.count(channelId),
    ...(stream === null && known ? { ended: true } : {}),
  };
}

async function channelLiveFrame(
  channelId: string,
  userId: string,
): Promise<VoiceSignalingMessage> {
  const { stream, known } = await resolveChannelStream(channelId);
  return channelLiveFrameWith(channelId, userId, stream, known);
}

function countMusicListenersFromPeers(channelId: string): number {
  return getRoomPeers(channelId).filter((peer) => peer.listeningMusic !== false)
    .length;
}

async function countMusicListeners(channelId: string): Promise<number> {
  if (registryOn()) {
    await settledRowWrites(channelId);
    try {
      const rows = await listVoicePeersInRoom(channelId);
      return rows.filter((row) => row.listeningMusic !== false).length;
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "musicListeners",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return countMusicListenersFromPeers(channelId);
}

/**
 * Who is seated, for the music rights check. The count is the skip
 * threshold's denominator and the ids are its numerator, so both come from
 * one read: taking the size here and the ids somewhere else is how they
 * drift apart. With the registry on this is the cluster room, so a voter on
 * the other instance still counts.
 */
/**
 * Exported for `music-room-seats-registry.test.ts`: with the registry on
 * this must read the CLUSTER's seats, because a vote is counted against
 * who is still in the room and a room can span two machines.
 */
export async function musicRoomSeats(
  channelId: string,
): Promise<{ roomSize: number; seatedUserIds: string[] }> {
  if (registryOn()) {
    await settledRowWrites(channelId);
    try {
      const room = await readClusterRoom(channelId);
      if (room) {
        return {
          roomSize: room.participants.length,
          seatedUserIds: room.participants.map((person) => person.userId),
        };
      }
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "musicRoomSeats",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const local = getRoomPeers(channelId);
  return {
    roomSize: local.length,
    seatedUserIds: local.map((peer) => peer.userId),
  };
}

async function channelMusicFrame(
  channelId: string,
): Promise<VoiceSignalingMessage> {
  const listeners = await countMusicListeners(channelId);
  return {
    type: "channel-music",
    channelId,
    track: channelMusicTrack(channelId, listeners),
  };
}

/**
 * What the room is playing, to everyone who may view the channel, so the
 * sidebar row exists for people outside the call. Same audience as
 * `channel-live`, and the same reason a socket in the room gets it too.
 */
async function broadcastChannelMusic(channelId: string): Promise<void> {
  const audience = await getChannelAudience(channelId).catch(
    (error: unknown) => {
      console.error("[voice] failed to load audience for channel-music:", error);
      return null;
    },
  );
  if (!audience) {
    return;
  }
  const frame = await channelMusicFrame(channelId);
  forEachAuthenticatedSocket((socket, user) => {
    if (audience.has(user.id)) {
      send(socket, frame);
    }
  });
}

const lastMusicListeners = new Map<string, number>();
const musicListenerBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

function noteMusicListenerCount(
  channelId: string,
  participants: readonly { listeningMusic?: boolean }[],
): void {
  if (!getMusicState(channelId)?.current) {
    lastMusicListeners.delete(channelId);
    return;
  }
  const listeners = participants.filter((peer) => peer.listeningMusic !== false)
    .length;
  if (lastMusicListeners.get(channelId) === listeners) {
    return;
  }
  lastMusicListeners.set(channelId, listeners);
  scheduleChannelMusicBroadcast(channelId);
}

/** Re-send channel-music when the listener count changes. Debounced. */
function scheduleChannelMusicBroadcast(channelId: string): void {
  const held = musicListenerBroadcasts.get(channelId);
  if (held) {
    clearTimeout(held);
  }
  musicListenerBroadcasts.set(
    channelId,
    setTimeout(() => {
      musicListenerBroadcasts.delete(channelId);
      void broadcastChannelMusic(channelId);
    }, 80),
  );
}

/**
 * The stream and the count to every authenticated socket of every user who
 * may view the channel. Encoded per socket: the token in `hlsUrl` names the
 * recipient. A socket in the room gets it too, so a tab that is both in the
 * call and drawing the sidebar needs no second source for the pill.
 */
async function broadcastChannelLive(
  channelId: string,
  /**
   * The answer the caller already has (`pushLiveHls` after its reconcile,
   * the `voice.live` handler with the relayed frame). Absent, the keyframe
   * case: resolved once here, never per socket.
   */
  answer?: { stream: LiveHlsStream | null; known: boolean },
): Promise<number> {
  const audience = await getChannelAudience(channelId).catch(
    (error: unknown) => {
      console.error("[voice] failed to load audience for channel-live:", error);
      return null;
    },
  );
  if (!audience) {
    return 0;
  }
  const { stream, known } = answer ?? (await resolveChannelStream(channelId));
  let sent = 0;
  forEachAuthenticatedSocket((socket, user) => {
    if (!audience.has(user.id)) {
      return;
    }
    send(socket, channelLiveFrameWith(channelId, user.id, stream, known));
    hlsAudienceFramesSent.frames += 1;
    sent += 1;
  });
  return sent;
}

/**
 * THE STREAM, TO THE OTHER MACHINE. Production runs two `pqp-api` machines
 * behind Fly's proxy with no session affinity, so the presenter's socket and
 * a viewer's socket are on different processes about half the time. Every
 * fan-out above walks `forEachAuthenticatedSocket`, which is this process's
 * sockets and nobody else's, so until 2026-09-14 (14:56 UTC, a live party: the
 * host shared from machine A and a viewer on machine B sat on "Preparando a
 * transmissão" for good) the other machine's audience was never told there
 * was anything to watch. `GET /live` had already been given a Postgres
 * fallback (#598), but that only helps a client that asks; the sidebar pill,
 * the keyframe and the mid-show catch-up all ride this frame.
 *
 * UNSTAMPED ON PURPOSE. The playlist URL a viewer receives carries a token
 * naming that viewer (`stampViewerStream`), so there is no one frame for the
 * cluster; what crosses is what `pushLiveHls` computed, and the receiving
 * instance stamps it per socket exactly as this one did.
 *
 * `endsStartedAt` names the session a `null` ends, and `at` orders frames of
 * one session (a camera appearing keeps `startedAt`, so `startedAt` alone
 * cannot order them). Both are read by the handler at the bottom of the file.
 * Not gated on the registry: the frame carries its own truth and needs no
 * row, and a machine that cannot see a live stream is the incident itself.
 */
function publishChannelLive(
  channelId: string,
  stream: LiveHlsStream | null,
  prev: LiveHlsStream | null,
  /** When this process accepted the reconcile, not when this ran. See above. */
  at: number,
): void {
  if (!isBusEnabled()) {
    return;
  }
  hlsAudienceFramesSent.relayed += 1;
  publishVoice(VOICE_LIVE_TOPIC, {
    channelId,
    stream,
    endsStartedAt: stream ? null : (prev?.startedAt ?? null),
    at,
  } satisfies VoiceLiveFrame);
}

/**
 * "SOMETHING HAPPENED IN THIS CHANNEL AND I AM NOT THE ONE WHO CAN ACT ON IT."
 *
 * An intent, not a fact: the frame carries a channel id and nothing else, and
 * the receiving instance decides whether it is the owner and what the right
 * answer is by reading its own maps. That is deliberate — every other thing
 * this topic could carry (a stream, a presenter, a mode) is something the
 * owner already knows better than the sender does, and a frame that asserted
 * any of it would be a rumour the owner could act on wrongly.
 *
 * Throttled per channel, because the event that triggers it is a join: a
 * hundred viewers arriving on this machine in ten seconds is one frame, not a
 * hundred. The owner's reconcile is single-flighted per channel anyway
 * (`reconcileQueue`), so a coalesced burst loses nothing.
 *
 * No echo guard needed here beyond the bus's own: `subscribeToCluster` never
 * hands a handler a frame this process published (`lib/bus.ts`).
 */
const RECONCILE_RELAY_THROTTLE_MS = 1_000;
const lastReconcileRelayAt = new Map<string, number>();

function relayHlsReconcile(channelId: string, now = Date.now()): void {
  if (!isBusEnabled()) {
    return;
  }
  for (const [id, at] of lastReconcileRelayAt) {
    if (now - at > 10 * RECONCILE_RELAY_THROTTLE_MS) {
      lastReconcileRelayAt.delete(id);
    }
  }
  const last = lastReconcileRelayAt.get(channelId);
  if (last !== undefined && now - last < RECONCILE_RELAY_THROTTLE_MS) {
    return;
  }
  lastReconcileRelayAt.set(channelId, now);
  hlsReconcileRelay.published += 1;
  publishVoice(VOICE_HLS_RECONCILE_TOPIC, {
    channelId,
  } satisfies VoiceHlsReconcileFrame);
}


/**
 * What `GET /api/channels/:channelId/live` answers: the unstamped stream (the
 * route stamps it for the caller), watchers without a seat, and seats. For a
 * client that opened the channel before its socket was up.
 */
export async function getChannelLiveState(channelId: string): Promise<{
  stream: LiveHlsStream | null;
  /**
   * The server can vouch for a `stream: null` (its maps and the session table
   * agree there is nothing live). False when the table could not be asked at
   * all: the route must then say "I do not know", because the client treats
   * this answer as authoritative and would otherwise mark a live party ended
   * on the strength of one failed query.
   */
  known: boolean;
  watching: number;
  participants: number;
}> {
  // Three in-process sources, tried in order, because no single one always
  // has the answer. `liveHlsStreamFor` only ever knows about the conventional
  // ladder (its `rooms` map, `hls-egress.ts`). `llStreamFor` is the LL
  // driver's own room map (`hls-remux.ts`), populated by both a live
  // reconcile AND boot adoption -- checking it directly, rather than only
  // through `hlsAudience`, is what makes an adopted-but-not-yet-pushed LL
  // session visible right after a restart (a Farol finding on PR #580:
  // adoption never called `hlsAudience.setStream`, so this route answered
  // null for a session that was, in fact, still running). `hlsAudience.stream`
  // is next: what `pushLiveHls` most recently told the audience, which is the
  // only source when the caller wants a stream adoption itself does not
  // populate (a mid-party camera or mic-archive change is layered onto the
  // conventional stream this way today, and the conventional answer is tried
  // first regardless, so the two agree for every conventional session).
  //
  // ALL THREE ARE IN-PROCESS MAPS. Since 2026-09-14 the third is also fed
  // by the bus: `voice.live` carries every stream change `pushLiveHls`
  // fans out (start, camera, stop) to the other machine, which records it in
  // `hlsAudience.setStream` before telling its own sockets, so on two
  // machines this read normally answers from memory on either one. What is
  // left for `liveHlsStreamFromDb`, a fourth and LAST resort, is the window
  // the bus cannot cover: a process that booted after the party started and
  // did not adopt the session, or a frame lost while the bus was down. One
  // Postgres round trip, only paid when the other three already came up
  // empty (which is never the case on the instance actually running the
  // egress -- this read never touches the database there).
  const { stream, known } = await resolveChannelStream(channelId);
  return {
    stream,
    known,
    watching: hlsAudience.count(channelId),
    participants: getRoomPeers(channelId).length,
  };
}

/** Test hook: forget every watcher and stream, stop every keyframe clock. */
export function resetHlsAudience(): void {
  hlsAudience.reset();
  relayedLiveAt.clear();
  dbStreamMemo.clear();
  dbStreamInFlight.clear();
  streamGeneration.clear();
  locallyEndedAt.clear();
  llVerifiedAt.clear();
  llVerifyInFlight.clear();
  resetConvergenceTurns();
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
const hlsAudienceFramesSent = {
  frames: 0,
  /** `voice.live` frames this instance published for the other machine. */
  relayed: 0,
  /** `voice.live` frames from the bus this instance applied (recorded and
   * fanned out to its own sockets). Both zero on one machine; on two, both
   * climb within seconds of a party starting, and a `relayed` that climbs
   * beside a `fromBus` that stays at zero is the bus not delivering, which is
   * the shape pitfall 12 in CLAUDE.md exists for. */
  fromBus: 0,
};

/**
 * `voice.hlsReconcile`: reconcile intents this instance published because it
 * does not own the channel, and intents from the bus it acted on because it
 * does. Both zero on one machine. On two, `published` climbing while
 * `applied` stays at zero means either nobody owns the channel (fine, and
 * common: nothing is live) or the frames are not arriving — which is the
 * distinction `voice.hlsReconcileFromBus` in the log makes per channel.
 */
const hlsReconcileRelay = { published: 0, applied: 0 };

/**
 * How long a live session waits between proactively re-minting its
 * watchers' viewer tokens, independent of any change to the stream itself.
 *
 * `HLS_VIEWER_TOKEN_TTL_MS` (`hls-viewer-token.ts`) is 60 minutes; before
 * this existed, a token only ever got refreshed by `broadcastChannelLive`
 * running on a genuine change (a new session, a sharer swap) or by the
 * 30-second audience keyframe happening to catch a socket that is also part
 * of the DB-backed "may view this channel" audience. A viewer who never left
 * that audience but also never triggered a change could still ride the same
 * `?t=` for the length of a film, and on 2026-09-12 production logged
 * exactly that: rolling waves of `hlsPlaylistRejected reason=expired`. Ten
 * minutes of margin under the hour, matching the same number iOS
 * (`WatchStreamSwap.renewAfter`) and Android (`WATCH_TOKEN_RENEWAL_MS`)
 * already schedule their own client-side renewal at, so every platform
 * converges on one number.
 */
export const HLS_VIEWER_TOKEN_REMINT_MS = 50 * 60 * 1000;

/** `voice.hlsTokenRemint` loops and tokens sent, since boot. Belongs nonzero
 * on any deployment carrying a watch party past the 50-minute mark: a zero
 * here while `liveHls.watching` is nonzero is this feature not running,
 * which is indistinguishable from working right up until an hour in (the
 * shape pitfall 9 in CLAUDE.md warns about). */
const hlsTokenRemint = { loops: 0, tokens: 0 };

/**
 * Watch mode without a seat. `voice-stream` only reaches the room, so until
 * this path a viewer learned a stream was live by joining, and the sidebar
 * pill saw nothing but the roster. `channel-live` goes to everyone who may
 * view the channel (the same audience as the roster), when the stream
 * changes and on the audience keyframe cadence while it is live or watched.
 * Never per subscribe: see `createHlsAudience`.
 */
/**
 * How many quiet watched channels may reach `hls_sessions` on one keyframe
 * tick, across the whole process. Small on purpose: this is the recovery path
 * for a bus frame that was lost, not a source of truth, and every other way
 * into the same answer (the welcome, `watch-live`, `GET /live`) is triggered
 * by a person and bounded by them.
 */
const HLS_CONVERGENCE_PER_TICK = 8;

/**
 * WHOSE TURN IT IS, kept between ticks. The keyframe timers are per channel
 * and fire in whatever order they were started, so a budget alone is spent by
 * whichever channels happen to tick first and the ones behind them would
 * never recover from a lost bus frame at all -- which is the entire point of
 * this path. So the budget is not "the first eight to ask": every channel
 * that has ever asked is on `convergenceOrder`, and each refill hands the
 * turn to the next `HLS_CONVERGENCE_PER_TICK` of them from a cursor that
 * survives the refill. A channel that stops being watched keeps its place
 * until the sweep drops it, which costs nothing: an unwatched channel simply
 * never calls in to use its turn.
 */
const convergenceOrder: string[] = [];
const convergenceIndex = new Map<string, number>();
let convergenceCursor = 0;
let convergenceTurn = new Set<string>();

function rotateConvergenceTurn(): void {
  convergenceTurn = new Set();
  if (convergenceOrder.length === 0) {
    return;
  }
  for (let i = 0; i < HLS_CONVERGENCE_PER_TICK; i += 1) {
    if (convergenceTurn.size >= convergenceOrder.length) {
      break;
    }
    convergenceTurn.add(convergenceOrder[convergenceCursor % convergenceOrder.length]!);
    convergenceCursor = (convergenceCursor + 1) % convergenceOrder.length;
  }
}

setInterval(rotateConvergenceTurn, ROSTER_AUDIENCE_KEYFRAME_MS).unref?.();

/**
 * Whether this channel may spend a convergence read right now. Registers a
 * channel the first time it asks (it takes its turn on a later rotation, not
 * this one, which is what keeps the per-tick cost flat however many channels
 * appear at once).
 */
export function takeConvergenceTurn(channelId: string): boolean {
  if (!convergenceIndex.has(channelId)) {
    convergenceIndex.set(channelId, convergenceOrder.length);
    convergenceOrder.push(channelId);
    return false;
  }
  if (!convergenceTurn.has(channelId)) {
    return false;
  }
  // One read per turn: a channel with several watchers still asks once.
  convergenceTurn.delete(channelId);
  return true;
}

/** Test hook: forget the rotation. */
export function resetConvergenceTurns(): void {
  convergenceOrder.length = 0;
  convergenceIndex.clear();
  convergenceCursor = 0;
  convergenceTurn = new Set();
}

/** Test hook: the rotation the interval would do. */
export function rotateConvergenceTurnsForTests(): string[] {
  rotateConvergenceTurn();
  return [...convergenceTurn];
}

const hlsAudience = createHlsAudience({
  keyframeMs: ROSTER_AUDIENCE_KEYFRAME_MS,
  broadcast: (channelId) => {
    // THE KEYFRAME IS ALSO THE CONVERGENCE TICK. A stream this machine holds
    // is restated from memory and costs nothing. A channel that is merely
    // WATCHED and holds no stream is the case where a `voice.live` frame may
    // simply have been lost -- the bus is best-effort by design -- and
    // nothing else would ever tell this machine's viewers, so a resolve has
    // to happen somewhere.
    //
    // BOUNDED BY THE TICK, NOT BY THE CHANNEL COUNT. One resolve per quiet
    // watched channel per tick is a query rate that grows with how many
    // channels people happen to have open, which at ten thousand of them is
    // a sustained load nobody asked for. Instead each tick spends a small
    // budget of resolves, taken round-robin, so the cost is flat
    // (`HLS_CONVERGENCE_PER_TICK` queries per tick, ever) and the worst case
    // is that a lost frame takes a few more ticks to be noticed.
    const held = hlsAudience.stream(channelId);
    if (held) {
      // A RELAYED LL STREAM IS RESTATED ONLY WHILE ITS ROW AGREES. This is
      // the tick that ran every thirty seconds for an hour on 2026-09-15
      // handing out a session that had ended at 18:33, so it is the tick that
      // has to be able to notice. `resolveChannelStream` does the asking (and
      // the clearing, and its own fan-out, if the answer is "over"); this
      // only restates when the stream came back unchanged.
      if (llVerifyDue(channelId, held)) {
        void resolveChannelStream(channelId)
          .then((answer) => {
            // RESTATE ONLY THE SESSION THIS TICK WAS ABOUT, and only while it
            // is still what the channel holds. A clear does its own fan-out; a
            // replacement arrived with the frame that carried it; either way
            // repeating an answer from before the await is how a stale stream
            // gets put back (a Farol finding on this PR).
            if (
              answer.stream &&
              answer.stream.startedAt === held.startedAt &&
              answer.stream === hlsAudience.stream(channelId)
            ) {
              void broadcastChannelLive(channelId, answer);
            }
          })
          .catch((error: unknown) => {
            console.error("[voice] ll keyframe verification failed:", error);
          });
        return;
      }
      void broadcastChannelLive(channelId, { stream: held, known: true });
      return;
    }
    if (takeConvergenceTurn(channelId)) {
      void broadcastChannelLive(channelId);
    }
    // Not this channel's turn: SAY NOTHING. There is no news to restate --
    // this machine holds no stream for the channel and has not asked -- and a
    // frame carrying `stream: null` is one more chance for a client to read
    // silence as an end. A null goes out only when something positively
    // answered that there is nothing live.
  },
  remintMs: HLS_VIEWER_TOKEN_REMINT_MS,
  remint: (channelId, watchers) => {
    remintHlsAudienceTokens(channelId, watchers);
  },
});

/**
 * One loop over a live session's already-known watchers (`hlsAudience`
 * tracks the `Set<WebSocket>` in memory; no DB round trip for the
 * membership itself), minting each a fresh capability and pushing it as an
 * ordinary `channel-live` frame. Same frame shape a change or a keyframe
 * would have sent, so the client's existing same-session token-swap path
 * (`shouldAdoptHlsSource` on web, `WatchStreamSwap`/`watchSourceChanged` on
 * iOS/Android) is what actually applies it — this only has to make sure a
 * fresh one keeps arriving.
 *
 * `watch-live` checks `canAccessChannel` once, at subscribe time, and never
 * again — a socket that stays open and subscribed is otherwise never asked
 * twice. Without a re-check here, a ban, a kick, a channel turned private,
 * or a permission overwrite that revokes VIEW would leave that socket
 * quietly re-authorized every `HLS_VIEWER_TOKEN_REMINT_MS` for as long as
 * the connection and the broadcast both last — the exact opposite of what a
 * capability with a TTL is for. `canAccessChannelForRoster` is the cached,
 * invalidation-aware wrapper this file already built for "ask access
 * repeatedly for many sockets against the same channel": its cache is
 * cleared by the same events that can make this answer flip (membership,
 * privacy, an overwrite change), so a revoked watcher is caught within one
 * cache TTL rather than only on their next natural resubscribe. A watcher
 * that fails the check is dropped from `hlsAudience` outright, not merely
 * skipped this once, so the next remint does not re-ask the same settled
 * question for a socket that is never getting the answer back.
 *
 * TWO MORE THINGS an `await` per watcher makes possible that a purely
 * synchronous loop never had to worry about, both closed here rather than
 * left for the next incident. First, `stream` is re-read fresh from
 * `liveHlsStreamFor` on every iteration rather than captured once before the
 * loop: each `await` is a real suspension point, wide enough on a long
 * watcher list for the broadcast to end or restart underneath it, and a
 * snapshot taken before the loop would keep handing out a session that no
 * longer exists — or worse, one a newer session has already replaced,
 * regressing a client back to an obsolete HLS session the same way a
 * stale, out-of-order frame would (see the `generation` guards this same
 * remint feeds on every client). Second, this function is called from
 * `setInterval` (`createHlsAudience`, `hls-audience.ts`) without an await or
 * a `.catch`, which used to be safe because nothing here could reject; now
 * that it can (a database error inside `canAccessChannelForRoster`, or `send`
 * throwing on a socket that closed between the readyState check and the
 * write), an uncaught rejection here would be unhandled at the interval
 * boundary — fatal on Node configurations that treat unhandled rejections as
 * such, and even short of that, it would abort the loop for every watcher
 * still waiting behind the one that failed. So every watcher's own work is
 * wrapped below: one failure is logged and skipped, never allowed to reach
 * the caller or cost anyone else their renewal.
 */
async function remintHlsAudienceTokens(
  channelId: string,
  watchers: readonly WebSocket[],
): Promise<void> {
  if (!(await resolveChannelStream(channelId)).stream) {
    return;
  }
  hlsTokenRemint.loops += 1;
  for (const socket of watchers) {
    if (socket.readyState !== 1 /* WebSocket.OPEN */) {
      continue;
    }
    const user = getSocketUser(socket);
    if (!user) {
      continue;
    }
    try {
      if (!(await canAccessChannelForRoster(channelId, user.id))) {
        hlsAudience.unsubscribe(channelId, socket);
        continue;
      }
      const { stream } = await resolveChannelStream(channelId);
      if (!stream) {
        continue;
      }
      send(socket, {
        type: "channel-live",
        channelId,
        stream: stampViewerStream(stream, user.id),
        watching: hlsAudience.count(channelId),
      });
      hlsTokenRemint.tokens += 1;
    } catch (error) {
      console.error(
        "[voice] remintHlsAudienceTokens failed for one watcher:",
        channelId,
        error,
      );
    }
  }
}

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

/**
 * The music queue's own half of that, because the aggregate cannot tell a
 * relay that runs from one that does not. `relayed` is a write this instance
 * accepted and published; `adopted` is a write from the other machine this
 * instance applied to its half of the room. Both zero on one machine, both
 * climbing on two as soon as anybody presses play — and `relayed` climbing
 * while `adopted` stays at zero on every instance is the shape of pitfall 12
 * in CLAUDE.md: a path that ships, publishes, and is never once applied.
 */
const musicCluster = {
  relayed: 0,
  adopted: 0,
  listeningWrites: 0,
  /**
   * Rooms adopted from a row that carried a queue and no clock. The clamp
   * and the clock-based end-of-track gate stand down for those until a
   * trusted write sets an anchor, so this is what says whether the rollout
   * left anybody unprotected.
   */
  anchorMissing: 0,
};

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
  hlsAudienceFramesSent.relayed = 0;
  hlsAudienceFramesSent.fromBus = 0;
  hlsReconcileRelay.published = 0;
  hlsReconcileRelay.applied = 0;
  lastReconcileRelayAt.clear();
  relayedLiveAt.clear();
  hlsTokenRemint.loops = 0;
  hlsTokenRemint.tokens = 0;
  clusterFrames.relayed = 0;
  clusterFrames.received = 0;
  musicCluster.relayed = 0;
  musicCluster.adopted = 0;
  musicCluster.anchorMissing = 0;
  musicCluster.listeningWrites = 0;
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
 * `rowsRead` false means the read failed and `participants` is
 * `rosterWithoutRows`'s best picture: sent whole, and kept as the memory,
 * because it is what the receivers now hold. An empty room
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
  // Kept even when the rows could not be read: `participants` is then
  // `rosterWithoutRows`, what every receiver is about to hold, and the next
  // window's fallback (or the first good read's diff) starts from it. It is
  // still sent whole (`previous` is undefined above).
  if (current.size === 0) {
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
 * THE ROSTER TO SEND WHEN THE ROWS CANNOT BE READ (registry on, Postgres
 * down). It used to be this instance's own peers alone, sent as a whole
 * `voice-roster`, which a client treats as authoritative: everybody seated
 * on the OTHER machine vanished from the call for the length of the outage,
 * the client forgot their peer ids and dropped their offers and ICE, and a
 * mesh leg that failed in that window was pruned as a ghost. Any local mute
 * or camera toggle during the outage was enough to send it.
 *
 * What this process knows instead is what it last told its clients
 * (`sentRosters`, written from the rows), plus everything that happened
 * since (`events`, this window's queue: local changes, and the joins,
 * updates and leaves the bus delivered from other machines). So: the last
 * roster sent, with those events replayed in order, and this instance's own
 * peers laid over it by id. `diffSentRoster` keeps THIS as the memory for the next window,
 * because it is what the receivers now hold, so a leave in one window stays
 * applied in the next. A remote
 * peer who left while the bus was also down stays listed until the rows can
 * be read again, which is the cheap mistake; the one this replaces hung up
 * people who were still there. With nothing sent before, this is the local
 * picture, as it always was.
 */
/** Replay a window's room events, in order, onto a roster keyed by peer id. */
function applyRoomEvents(
  roster: Map<string, VoiceParticipant>,
  events: readonly VoiceRoomEvent[],
): void {
  for (const event of events) {
    if (event.kind === "left") {
      roster.delete(event.peerId);
    } else if (event.kind === "joined" || event.kind === "updated") {
      roster.set(event.peer.peerId, event.peer);
    }
  }
}

function rosterWithoutRows(
  voiceChannelId: string,
  local: readonly VoiceParticipant[],
  events: readonly VoiceRoomEvent[],
): VoiceParticipant[] {
  const lastSent = sentRosters.get(voiceChannelId);
  if (!lastSent) {
    return [...local];
  }
  const merged = new Map(lastSent);
  applyRoomEvents(merged, events);
  for (const peer of local) {
    merged.set(peer.peerId, peer);
  }
  rostersSentWithoutRows += 1;
  return [...merged.values()];
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
    events = pendingRoomEvents.get(voiceChannelId) ?? [];
    pendingRoomEvents.delete(voiceChannelId);
    const local = collapseOrphanedDuplicates(
      getRoomPeers(voiceChannelId),
      (peer) => peer.userId,
      (peer) => peer.orphanedAt !== undefined,
    ).map(toParticipant);
    const participants =
      room?.participants ??
      (registryOn() ? rosterWithoutRows(voiceChannelId, local, events) : local);
    noteMusicListenerCount(voiceChannelId, participants);
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
    // And for the queue, which the room row's cascade also takes care of on
    // the cluster side: the last peer's delete removes the room, and the
    // hands go with it. This process holds nobody, so the cache goes too;
    // whether THIS user's registry row should be deleted is the check below
    // (another instance may still seat them).
    roomRaisedHands.delete(voiceChannelId);
  } else if (
    !registryOn() &&
    !getRoomPeers(voiceChannelId).some((other) => other.userId === peer.userId)
  ) {
    // LEAVING LOWERS YOUR HAND. Not the socket closing (an orphan is still
    // in the call and is still in the queue) but this person holding no seat
    // in this room at all any more. Registry off: this map is the room.
    void dropRaisedHandForUser(voiceChannelId, peer.userId);
  }
  if (registryOn()) {
    // One statement: the row goes, and the room row with it if this was the
    // last peer anywhere in the cluster (not only on this instance). Then the
    // party, for the one race that can leave a room row behind. Then the
    // hand: only if no cluster seat remains for this person, including a
    // seat this instance never held. The cache may be empty (we missed the
    // raise frame); the row is deleted anyway.
    const userId = peer.userId;
    trackRowWrite(voiceChannelId, peerId, () =>
      deleteVoicePeer(peerId)
        .then(() => clearWatchPartyIfEmpty(voiceChannelId))
        .then(async () => {
          const remaining = await listVoicePeersInRoom(voiceChannelId);
          if (!remaining.some((row) => row.userId === userId)) {
            await dropRaisedHandForUser(voiceChannelId, userId);
          }
        }),
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

/**
 * A channel's access just widened — it went public, or its `@everyone`
 * overwrite regained VIEW — so any channel-private re-sweep `evictVoiceUsersExcept`
 * left running for it no longer has anybody to keep out. Cancel it rather
 * than let it run its window: `evictSfuUsersExcept` schedules one on every
 * call regardless of whether the channel is still private, and a permission
 * save on an already-public channel must not leave a 15-minute sweep behind
 * that spends its ticks evicting the room's own HLS egress every 5 s (see
 * `isEgressIdentity` in `voice/admin.ts`).
 */
export function cancelPrivateVoiceResweep(voiceChannelId: string): Promise<void> {
  return cancelSfuPrivateResweep(voiceChannelId);
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
  trackRowWrite(channelId, peerId, () =>
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
    roomRaisedHands.delete(peer.voiceChannelId);
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
  /** Rows this instance owned with no peer behind them. Should be zero. */
  ghosts: number;
}> {
  if (!registryOn()) {
    return { orphaned: 0, removed: 0, roomsSwept: 0, ghosts: 0 };
  }
  // BACK FROM A DATABASE OUTAGE: put every seat this instance holds back in
  // its row before anything else reads the table. Writes made during the
  // outage were dropped, and another instance's reconcile may have stamped
  // `orphaned_at` on seats that never left. Orphans held for the resume
  // window are rewritten as orphans (their own `orphanedAt`), so this changes
  // no seat's state, it only makes the rows say what the map already knows.
  if (consumeOwnHeartbeatRecovery()) {
    const channels = new Set<string>();
    const reasserted = peers.size;
    for (const peer of peers.values()) {
      writePeerRow(peer);
      channels.add(peer.voiceChannelId);
    }
    // Landed before anything below reads the table. The writes go through
    // the same per-peer chain as every other (and through the batcher when
    // `VOICE_REGISTRY_BATCH` is on, which is what keeps a large instance's
    // re-assertion from being one round trip per seat).
    await Promise.all([...channels].map((channelId) => settledRowWrites(channelId)));
    seatsReassertedAfterOutage += reasserted;
    logEvent("voice.registryReasserted", { seats: reasserted });
  }
  // See `otherLeasesTrustworthy`: a lease that went stale while this instance
  // could not reach the database either is not a dead instance, and treating
  // it as one hangs up every seat on the other machine.
  let result: Awaited<ReturnType<typeof reconcileVoiceRegistry>>;
  if (otherLeasesTrustworthy()) {
    result = await reconcileVoiceRegistry();
  } else {
    reconcilesDeferredAfterOutage += 1;
    result = { orphaned: [], removed: [], roomsSwept: 0, instancesSwept: 0 };
  }
  // The SFU re-sweep claims ride on the same beat (plan section 5.4): every
  // instance ticks, and only the rows this tick won are swept.
  await tickSfuResweeps();
  // And this instance's own rows that this instance's map does not hold.
  // `reconcileVoiceRegistry` cannot do it (it skips its own rows on purpose,
  // and must, because another instance's live seat is none of its business),
  // so the owner has to. The peer ids are read from the map here rather than
  // in the registry, which is the only place they exist.
  const ghosts = await sweepOwnStaleVoicePeers([...peers.keys()]);
  if (ghosts.length > 0) {
    ghostSeatsSwept += ghosts.length;
    logEvent("voice.ghostSeatsSwept", {
      count: ghosts.length,
      peerIds: ghosts.map((ghost) => ghost.peerId).join(","),
    });
  }
  // Rate-limited to hourly inside; the beat is just the clock that is already
  // ticking. Never allowed to break the reconcile.
  await logSeatHealth().catch(() => undefined);
  const touched = new Set<string>();
  for (const { peerId, channelId } of [...result.removed, ...ghosts]) {
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
    ghosts: ghosts.length,
  };
}

/**
 * The rollout switch for the mesh hold rule below. Off by default, and that
 * default is the whole reason it exists.
 *
 * The rule refuses to hold a mesh seat for a socket that did not declare
 * `mesh-resume`. Web and Electron declare it from the bundle this shipped in,
 * but a Pages deploy does not reload a tab that is already open, and an API
 * deploy reconnects those tabs without reloading them (pitfall 11). So on the
 * deploy that carries this change, every browser in a mesh call is by
 * definition running a bundle that predates the capability, and turning the
 * rule on in the same breath would cost each of them the seamless resume they
 * have today: one cold rejoin, a new peer id, a couple of seconds of audio.
 *
 * Shipping the mechanism dark and flipping it later is the same pattern
 * `TURN_PREFER_STATIC` and `WS_COMPRESSION` use. Flip it once tabs have
 * cycled (the dashboard's `mesh-resume` socket fraction is the number to
 * read), and from that moment every phone build already in the field stops
 * leaving mesh ghosts, with no app update and no client deploy.
 *
 * Read per call, never cached: a restart is the only other way it changes.
 */
function meshResumeRequiresCap(): boolean {
  return process.env.VOICE_MESH_RESUME_REQUIRES_CAP === "true";
}

/**
 * Whether this socket's mesh seat is worth holding.
 *
 * The hold exists so a client that still has live media can come back to the
 * same peer id. In a mesh room that media is a set of peer connections this
 * client owns, and a client that tears them down on reconnect gains nothing
 * from the hold while the room pays for it: ninety seconds of a participant
 * who is not there, a tile nobody can talk to, and a `peer-left` that arrives
 * long after the person did.
 *
 * LiveKit is untouched. Its media is a separate connection that genuinely
 * survives a signalling drop, which is why iOS keeps a LiveKit call across an
 * API restart today and must go on doing so.
 *
 * WHAT THIS CANNOT DO. The server knows the room's transport exactly; it does
 * not know whether a given build can rebuild mesh media, and no signal on the
 * wire tells it. `join-voice-room.resume` is a self-report, and the incident
 * this comes from is a build that got its own self-report wrong. So this asks
 * for a narrower promise instead of inferring one, and a client that never
 * makes it is treated as unable. Guessing from a fingerprint (which caps a
 * build happens to send, what its user agent says) would work today and rot
 * silently the first time a client changed, which is pitfall 12 exactly.
 *
 * Called from `removeVoicePeerBySocket`, which the close handler runs BEFORE
 * `deleteAuthenticatedSocket`, so the socket's caps are still readable here.
 */
function meshHoldAllowed(peer: VoicePeer, socket: WebSocket): boolean {
  if (!meshResumeRequiresCap()) {
    return true;
  }
  if (getRoomTransport(peer.voiceChannelId) !== "mesh") {
    return true;
  }
  if (socketHasCap(socket, SOCKET_CAPS.meshResume)) {
    return true;
  }
  meshHoldsRefused += 1;
  logEvent("voice.meshHoldRefused", {
    peerId: peer.id,
    userId: peer.userId,
    voiceChannelId: peer.voiceChannelId,
  });
  return false;
}

/**
 * Socket closed. Peers that declared `resume: true` stay in the room for
 * `VOICE_RESUME_TTL_MS` so a brief signaling outage can reattach the same
 * id without broadcasting `peer-left`. Everyone else (phones, old tabs)
 * is removed now. Intentional hangup is `leave-voice-room`.
 */
/** The client frames that count as the person doing something. */
const SELF_INITIATED_VOICE_FRAMES: ReadonlySet<string> = new Set([
  "set-voice-state",
  "set-sharing-screen",
  "set-camera",
  "set-raised-hand",
  "set-watch-party",
  "set-music",
  "set-music-listening",
  "live-reaction",
  "voice-still-here",
]);

/**
 * Defensive only, not reachable today: an SFU-side composite-egress bot
 * (LiveKit's own `EG_...` participant, minted to subscribe to tracks for a
 * watch-party transcode) never sends our `join-voice-room` and so never gets
 * a `VoicePeer` or a `voice_peers` row — nothing in this file or
 * `registry.ts` writes one for it. If that ever changes (a LiveKit webhook
 * syncing participants, say), the idle sweep must still never count it as
 * the person keeping a seat warm.
 */
function isEgressIdentity(userId: string): boolean {
  return userId.startsWith("EG_");
}

/**
 * Per-room occupant counts for one sweep tick, batched into at most one
 * registry query total (`countVoicePeerUsersByChannel`) rather than one per
 * room — a room with more than one LOCAL occupant already knows it is not
 * alone and never touches the registry at all. `roomPeers` must include
 * orphaned seats: a seat held for the resume window still counts as
 * somebody being there (pitfall 11), it is just never itself a sweep
 * candidate (see the `orphanedAt` filter in `sweepIdleAloneSeats`).
 *
 * A room's count comes back `null` only when the registry had to be asked
 * and the read failed — the caller must treat that as "unknown this tick"
 * and skip the room, never as "alone": a DB hiccup must never manufacture a
 * disconnect for a room that has a second occupant on another instance.
 */
async function computeRoomOccupancy(
  byRoom: ReadonlyMap<string, VoicePeer[]>,
): Promise<Map<string, number | null>> {
  const occupants = new Map<string, number | null>();
  const needsRegistry: string[] = [];
  for (const [voiceChannelId, roomPeers] of byRoom) {
    const localUsers = new Set<string>();
    for (const peer of roomPeers) {
      if (!isEgressIdentity(peer.userId)) {
        localUsers.add(peer.userId);
      }
    }
    occupants.set(voiceChannelId, localUsers.size);
    if (registryOn() && localUsers.size <= 1) {
      needsRegistry.push(voiceChannelId);
    }
  }
  if (needsRegistry.length > 0) {
    try {
      const registryCounts = await countVoicePeerUsersByChannel(needsRegistry);
      for (const voiceChannelId of needsRegistry) {
        const local = occupants.get(voiceChannelId) ?? 0;
        const registryCount = registryCounts.get(voiceChannelId) ?? 0;
        occupants.set(voiceChannelId, Math.max(local, registryCount));
      }
    } catch (error) {
      console.error("[voice] idle sweep: occupancy read failed:", error);
      for (const voiceChannelId of needsRegistry) {
        occupants.set(voiceChannelId, null);
      }
    }
  }
  return occupants;
}

/**
 * A lone seat that is presenting a live watch party to an audience is not
 * alone — the audience is watching HLS without a seat by design (see
 * `docs/WATCH_PARTY.md`, "The stream"), so the room's only `VoicePeer` is
 * genuinely the host with nobody else in this channel. Cluster-safe: reads
 * `channel_sessions` (Postgres), not the per-process egress map, because the
 * host's socket and the instance actually running the HLS egress are not
 * guaranteed to be the same machine.
 *
 * ONE QUERY FOR THE WHOLE TICK, not one per room. The naive version awaited
 * `getActiveWatchPartyRow` inside the per-room loop — W qualifying rooms,
 * every `IDLE_ALONE_SWEEP_MS`, W sequential reads (Farol's N+1 finding).
 * Every room that could possibly need the answer this tick (occupants <= 1
 * and at least one seat is in a `watch_party` channel) is collected first,
 * then asked in one `listActiveWatchPartyStatusesByChannel` call.
 *
 * Fails toward NOT disconnecting: a read error treats every candidate as
 * presenting live for this tick — the same direction `computeRoomOccupancy`
 * fails in for its own registry read, and for the same reason (a DB hiccup
 * must never manufacture a disconnect).
 */
async function computeLiveWatchPartyRooms(
  byRoom: ReadonlyMap<string, VoicePeer[]>,
  occupancy: ReadonlyMap<string, number | null>,
): Promise<Set<string>> {
  const candidates: string[] = [];
  for (const [voiceChannelId, roomPeers] of byRoom) {
    const occupants = occupancy.get(voiceChannelId);
    if (
      occupants !== null &&
      occupants !== undefined &&
      occupants <= 1 &&
      roomPeers.some((peer) => peer.watchParty)
    ) {
      candidates.push(voiceChannelId);
    }
  }
  if (candidates.length === 0) {
    return new Set();
  }
  try {
    const statuses = await listActiveWatchPartyStatusesByChannel(candidates);
    const live = new Set<string>();
    for (const [voiceChannelId, status] of statuses) {
      if (status === "live") {
        live.add(voiceChannelId);
      }
    }
    return live;
  } catch (error) {
    console.error("[voice] idle sweep: watch-party read failed:", error);
    return new Set(candidates);
  }
}

/**
 * Clears a peer's idle-alone marks and, only when there was actually a
 * pending warning to take back, tells the client so — `voice-idle-warning-
 * cancelled`. Every place `aloneSince` / `idleWarnedAt` get reset to
 * "nothing happening" goes through here, so the client's banner is driven
 * by an explicit server confirmation instead of guessing from a roster diff
 * (a peer joining the same channel) or clearing itself optimistically on a
 * click that may never have reached the server (the two client-side gaps a
 * Farol review found on this PR: the banner outliving a joiner, and
 * "I'm still here" clearing state before the frame is confirmed delivered).
 */
function clearIdleAloneMarks(peer: VoicePeer, voiceChannelId: string): void {
  if (peer.idleWarnedAt !== undefined) {
    send(peer.socket, {
      type: "voice-idle-warning-cancelled",
      voiceChannelId,
    });
  }
  peer.aloneSince = undefined;
  peer.idleWarnedAt = undefined;
}

/**
 * The very last check before a peer is actually cut, reading fresh rather
 * than the tick's cached `computeRoomOccupancy` snapshot. That snapshot is
 * read once per tick and the loop below can spend real time — other rooms'
 * awaits, including this same function for a different room — before this
 * room's turn to act on it comes up; on a cluster, a join can also land on
 * the OTHER instance in exactly that window, which the batched snapshot has
 * no way to see since it was never asked again (Farol's finding: a stale
 * snapshot must never be what a destructive disconnect is decided on).
 * Fails toward NOT disconnecting: a read error here means "not confirmed
 * alone", and the seat is left for the next tick rather than cut on a
 * guess.
 */
async function isStillAloneRightNow(voiceChannelId: string): Promise<boolean> {
  const localUsers = new Set<string>();
  for (const peer of peers.values()) {
    if (peer.voiceChannelId === voiceChannelId && !isEgressIdentity(peer.userId)) {
      localUsers.add(peer.userId);
    }
  }
  if (localUsers.size > 1) {
    return false;
  }
  if (!registryOn()) {
    return localUsers.size <= 1;
  }
  try {
    const registryCounts = await countVoicePeerUsersByChannel([voiceChannelId]);
    const count = Math.max(localUsers.size, registryCounts.get(voiceChannelId) ?? 0);
    return count <= 1;
  } catch (error) {
    console.error(
      "[voice] idle sweep: pre-disconnect occupancy re-check failed:",
      error,
    );
    return false;
  }
}

/** Guards `sweepIdleAloneSeats` against overlapping itself: a slow registry
 * (or a slow watch-party read) under load must not stack a second full scan
 * on top of a first one still awaiting Postgres, which is exactly the kind
 * of pile-up an outage turns into cascading load. A skipped tick is fine —
 * the next one 15s later, or the one after, picks the state back up; there
 * is no cumulative state this drops (`aloneSince` lives on the peer, not on
 * the sweep). */
let idleAloneSweepRunning = false;

/**
 * THE IDLE HANGUP'S TICK. Walks this instance's live seats; a seat whose
 * room holds nobody else starts (or keeps) its `aloneSince`, gets one
 * `voice-idle-warning` a minute before the limit and is released through
 * `disconnectVoiceUser` at it, which is the same path a moderator's
 * disconnect takes (notice first, then the seat, then the SFU). A room that
 * gains a second person clears both marks without a frame. Never throws.
 *
 * MULTI-INSTANCE: this only ever reads and acts on `peers`, this process's
 * own local map — every `peers.has`, every `disconnectVoiceUser` call is
 * scoped to a seat whose socket lives on THIS instance. It is therefore
 * correct, not merely tolerated, to run this same sweep unmodified on every
 * `pqp-api` machine: each instance disconnects only its own seats, and the
 * registry (`countVoicePeerUsersByChannel`) is what tells an instance
 * holding a lone local seat whether a second person is seated on some other
 * machine before it acts.
 *
 * WORKER_MODE: `fly.worker.toml` runs the production worker as
 * `node server/dist/worker.js`, a separate entry point that never imports
 * this file at all — `voice-idle-alone.test.ts`'s "the idle sweep's reach"
 * group reads that file's imports directly rather than assuming so. The
 * `setInterval` in `server/src/index.ts` that calls this IS still created
 * at module scope even under `WORKER_MODE=worker node dist/index.js` (the
 * secondary, non-Fly way to run a worker on this same entry point), the
 * same as several sibling sweeps beside it — nothing in that file gates
 * sweep creation on the role. Harmless there in practice, because a
 * process running that way never accepts a `/ws` connection and `peers`
 * stays permanently empty, so every tick is a no-op walk of nothing; it is
 * a per-socket timer with no sockets, not a batch job that needed guarding.
 *
 * Exported for the tests and for `server/src/index.ts`, which runs it every
 * `IDLE_ALONE_SWEEP_MS`. `now` is a parameter so a test can move the clock.
 */
export async function sweepIdleAloneSeats(now = Date.now()): Promise<void> {
  const limit = idleAloneLimitMs();
  if (limit <= 0) {
    return;
  }
  if (idleAloneSweepRunning) {
    return;
  }
  idleAloneSweepRunning = true;
  try {
    // Every local peer, orphans included: occupancy counts them (pitfall
    // 11 — a seat mid-resume is still a seat), even though the candidate
    // loop below skips them as a target.
    const byRoom = new Map<string, VoicePeer[]>();
    for (const peer of peers.values()) {
      const list = byRoom.get(peer.voiceChannelId) ?? [];
      list.push(peer);
      byRoom.set(peer.voiceChannelId, list);
    }
    const occupancy = await computeRoomOccupancy(byRoom);
    const liveWatchPartyRooms = await computeLiveWatchPartyRooms(byRoom, occupancy);
    for (const [voiceChannelId, roomPeers] of byRoom) {
      const occupants = occupancy.get(voiceChannelId);
      // null: the registry read for this room failed this tick. undefined
      // cannot happen (every room in byRoom got an entry above), but is
      // treated the same way out of caution — skip, never guess.
      if (occupants === null || occupants === undefined) {
        continue;
      }
      const candidates = roomPeers.filter(
        (peer) => peer.orphanedAt === undefined && !isEgressIdentity(peer.userId),
      );
      if (candidates.length === 0) {
        continue;
      }
      if (occupants <= 1 && liveWatchPartyRooms.has(voiceChannelId)) {
        // Presenting, not alone. Clear the clock rather than merely
        // skipping it: a warning issued before the party went live must not
        // survive the party, or the very next tick after it ends could
        // disconnect the presenter on pre-party elapsed time instead of
        // starting a fresh window now that they are genuinely alone again.
        for (const peer of candidates) {
          clearIdleAloneMarks(peer, voiceChannelId);
        }
        continue;
      }
      for (const peer of candidates) {
        // Re-read: an earlier hangup in this loop may have removed it.
        if (!peers.has(peer.id)) {
          continue;
        }
        if (occupants > 1) {
          clearIdleAloneMarks(peer, voiceChannelId);
          continue;
        }
        if (peer.aloneSince === undefined) {
          peer.aloneSince = now;
          continue;
        }
        const elapsed = now - peer.aloneSince;
        if (elapsed >= limit) {
          // LAST CHECK, FRESH READ: the tick's occupancy snapshot can be
          // stale by the time execution reaches this specific peer (other
          // rooms' awaits ran first), and on a cluster a join can land on
          // the OTHER instance in that same window. A destructive
          // disconnect is decided on the room's state right now, never on
          // the cached `occupants` above.
          if (!(await isStillAloneRightNow(voiceChannelId))) {
            clearIdleAloneMarks(peer, voiceChannelId);
            continue;
          }
          idleAloneDisconnected += 1;
          const aloneMinutes = Math.round(limit / 60_000);
          logEvent("voice.idleAloneDisconnected", {
            channelId: voiceChannelId,
            userId: peer.userId,
            peerId: peer.id,
            aloneMinutes: Math.round(elapsed / 60_000),
          });
          disconnectVoiceUser(peer.userId, voiceChannelId, {
            message: `You were alone in the call for ${aloneMinutes} minute${
              aloneMinutes === 1 ? "" : "s"
            }, so you were disconnected.`,
            reason: "idle",
            aloneMinutes,
          });
          continue;
        }
        if (
          peer.idleWarnedAt === undefined &&
          elapsed >= limit - IDLE_ALONE_WARNING_MS
        ) {
          peer.idleWarnedAt = now;
          idleAloneWarned += 1;
          send(peer.socket, {
            type: "voice-idle-warning",
            voiceChannelId,
            disconnectAt: peer.aloneSince + limit,
          });
        }
      }
    }
  } finally {
    idleAloneSweepRunning = false;
  }
}

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
  // `canResume` is the client's own promise; `meshHoldAllowed` is whether
  // this room is one where the promise can be kept.
  if (!peer.canResume || !meshHoldAllowed(peer, socket)) {
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
    trackRowWrite(peer.voiceChannelId, peerId, () =>
      markVoicePeerOrphaned(peerId, new Date(peer.orphanedAt as number)),
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
  for (const timers of cameraFollowUpTimers.values()) {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
  cameraFollowUpTimers.clear();
  peers.clear();
  socketToPeerId.clear();
  retiredPeerIds.clear();
  roomTransports.clear();
  pendingTransportDecisions.clear();
  pendingPeerWrites.clear();
  rosterCoalescer.reset();
  pendingRoomEvents.clear();
  remoteTransports.clear();
  roomServerMutes.clear();
  roomRaisedHands.clear();
  rosterAccessInvalidateAll();
  resetMusicForTests();
}

/** Whether a socket currently holds a voice peer (for disconnect diagnostics). */
export function isSocketInVoice(socket: WebSocket): boolean {
  return socketToPeerId.has(socket);
}

// --- roster membership cache -------------------------------------------------
//
// `canAccessChannel` is one query, and `sendAllVoiceRosters` below asks it
// once per room this instance (or the registry) knows about, EVERY TIME a
// socket (re)authenticates. A watch party's reconnect storm multiplies that
// by rooms times reconnecting sockets for a question — "can this user still
// see this channel" — that almost never changes between one reconnect and
// the next. CLAUDE.md's watch-party postmortem (item A2) named this
// call site directly ("roster membership check failed").
//
// Wraps the already-imported `canAccessChannel` binding rather than calling a
// new cached export from `services/users.js`, on purpose: this file's tests
// mock that module at the `canAccessChannel` granularity throughout (over
// twenty suites), and a cache living in `users.js` under a new export name
// would be invisible to every one of those mocks — the roster would silently
// stop being sent under test while working in production, exactly the
// pitfall-9 shape CLAUDE.md already warns about (the flag/path a test
// exercises is not the one production takes). Wrapping the mocked binding
// keeps every existing test correct with no changes to any of them.
//
// INVALIDATION: `onAudienceInvalidated` (servers.ts) fires on every write
// that can move `canAccessChannel`'s answer through membership or privacy —
// `channel_members`, `is_private`, `server_members`, a role change, a
// deleted channel or server — and `onPermissionsUpdate` (chat.ts, already
// subscribed by this file for SPEAK) fires on top of that for a channel
// overwrite change, which moves the answer without touching either
// membership table. Both invalidations are BLUNT (channel-scoped clears one
// channel; server-scoped and permissions-update clear the whole cache)
// rather than tracking which channel belongs to which server: invalidations
// are rare and the cache is small, so a full clear costs one extra query
// burst on the next reconnect, not a correctness gap. The TTL below is the
// bound that does not depend on this list being complete.
const ROSTER_ACCESS_TTL_MS = 30_000;
const ROSTER_ACCESS_JITTER_MS = 5_000;
/**
 * Global cap on distinct (channel, user) pairs. Without one, a sustained
 * multi-room reconnect/auth workload grows this map without bound — every
 * miss (including a denied one) adds an entry, and the TTL only bounds how
 * long an entry survives, not how many can pile up before it expires. LRU by
 * touch order (see `rosterAccessGet`/`rosterAccessSet`): the entries evicted
 * first are the ones nobody has asked about recently.
 */
export const ROSTER_ACCESS_MAX_ENTRIES = 20_000;

interface RosterAccessEntry {
  allowed: boolean;
  expiresAt: number;
}

/**
 * `Map` iteration order is insertion order, which is what makes this an LRU:
 * a "touch" (hit or fresh write) deletes-then-reinserts the key so it moves
 * to the end, and eviction always takes from the front (oldest-touched).
 * Keyed on a colon-joined composite; channel and user ids are UUIDs, which
 * never contain one.
 */
const rosterAccessCache = new Map<string, RosterAccessEntry>();
/** channelId -> the composite keys living in `rosterAccessCache` for it, so a
 *  channel-scoped invalidation doesn't have to scan the whole cache. */
const rosterAccessChannelIndex = new Map<string, Set<string>>();
/**
 * Bumped on EVERY invalidation — channel-scoped or whole-cache alike. A
 * single counter rather than a per-channel generation map on purpose: a
 * per-channel map needs its own reclamation (a long-lived process that sees
 * invalidations for many distinct channels over its lifetime would grow it
 * forever, independent of the 20k cache cap), while one integer is bounded
 * by construction. The cost is coarseness — an invalidation on channel A
 * also makes an in-flight query for channel B skip caching its answer this
 * one time — which is strictly cheaper than the bug this replaces (a stale
 * answer served after revocation) and self-heals on the next request.
 * Consulted twice: before caching a resolved query's answer, and by a
 * caller that joined someone else's in-flight query (see
 * `canAccessChannelForRoster`) to decide whether that shared answer is
 * still trustworthy for THEM, not just whether it was safe to cache.
 */
let rosterAccessEpoch = 0;
/** Coalesces concurrent misses for the same pair — a reconnect storm asks
 *  the same question from N sockets at once; only the first actually queries
 *  Postgres, the rest await its result. */
const rosterAccessInFlight = new Map<string, Promise<boolean>>();

function rosterAccessKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

function rosterAccessGet(
  channelId: string,
  userId: string,
  now: number,
): boolean | undefined {
  const key = rosterAccessKey(channelId, userId);
  const entry = rosterAccessCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    rosterAccessCache.delete(key);
    rosterAccessChannelIndex.get(channelId)?.delete(key);
    return undefined;
  }
  // Touch: move to the end so a hot pair survives LRU eviction.
  rosterAccessCache.delete(key);
  rosterAccessCache.set(key, entry);
  return entry.allowed;
}

function rosterAccessSet(
  channelId: string,
  userId: string,
  allowed: boolean,
  now: number,
): void {
  const key = rosterAccessKey(channelId, userId);
  rosterAccessCache.delete(key);
  rosterAccessCache.set(key, {
    allowed,
    expiresAt:
      now + ROSTER_ACCESS_TTL_MS - Math.random() * ROSTER_ACCESS_JITTER_MS,
  });
  let bucket = rosterAccessChannelIndex.get(channelId);
  if (!bucket) {
    bucket = new Set();
    rosterAccessChannelIndex.set(channelId, bucket);
  }
  bucket.add(key);
  while (rosterAccessCache.size > ROSTER_ACCESS_MAX_ENTRIES) {
    const oldestKey = rosterAccessCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    rosterAccessCache.delete(oldestKey);
    const sep = oldestKey.indexOf(":");
    const oldestChannel = sep === -1 ? oldestKey : oldestKey.slice(0, sep);
    rosterAccessChannelIndex.get(oldestChannel)?.delete(oldestKey);
  }
}

/**
 * Drops one channel's cache entries AND its in-flight queries, then bumps
 * the epoch. Dropping the in-flight entries is what stops a NEW caller from
 * being handed a pending query that is about to answer a question that no
 * longer applies — it will instead see a clean miss and start its own,
 * current query. The epoch bump is the second half: a caller that already
 * captured a reference to the now-removed in-flight promise (a straight
 * race between reading the map and this delete) still safely awaits it, but
 * `canAccessChannelForRoster` re-checks the epoch after that await and
 * refuses to trust an answer that predates it — see the comment there.
 */
function rosterAccessInvalidateChannel(channelId: string): void {
  const bucket = rosterAccessChannelIndex.get(channelId);
  if (bucket) {
    for (const key of bucket) {
      rosterAccessCache.delete(key);
    }
    rosterAccessChannelIndex.delete(channelId);
  }
  const prefix = `${channelId}:`;
  for (const key of rosterAccessInFlight.keys()) {
    if (key.startsWith(prefix)) {
      rosterAccessInFlight.delete(key);
    }
  }
  rosterAccessEpoch += 1;
}

/** Drops everything and bumps the epoch, for invalidations that carry no
 *  channelId (server-scoped, permissions update) and for test resets. */
function rosterAccessInvalidateAll(): void {
  rosterAccessCache.clear();
  rosterAccessChannelIndex.clear();
  rosterAccessInFlight.clear();
  rosterAccessEpoch += 1;
}

async function canAccessChannelForRoster(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const now = Date.now();
  const cached = rosterAccessGet(channelId, userId, now);
  if (cached !== undefined) {
    return cached;
  }

  const key = rosterAccessKey(channelId, userId);
  // Captured before joining or starting a query: this is the epoch OUR
  // answer needs to still be current under, whether that answer comes from
  // a query we start below or one somebody else already has in flight.
  const epochAtStart = rosterAccessEpoch;

  const existing = rosterAccessInFlight.get(key);
  if (existing) {
    const allowed = await existing;
    if (epochAtStart === rosterAccessEpoch) {
      return allowed;
    }
    // The channel was invalidated while we were waiting on someone else's
    // in-flight query — normally that query's own promise is removed from
    // `rosterAccessInFlight` by `rosterAccessInvalidateChannel` the moment
    // this happens, so a caller arriving after us would already see a clean
    // miss; we got here because we had already captured `existing` before
    // that happened. Its answer predates the invalidation and is not
    // trustworthy for us, cached or not: ask again, fresh.
    return canAccessChannelForRoster(channelId, userId);
  }

  const promise = canAccessChannel(channelId, userId)
    .then((allowed) => {
      if (epochAtStart === rosterAccessEpoch) {
        rosterAccessSet(channelId, userId, allowed, Date.now());
      }
      return allowed;
    })
    .finally(() => {
      // Only clear it if it's still OUR promise: an invalidation may have
      // already deleted this entry (and, in principle, let a later query
      // replace it) by the time this runs.
      if (rosterAccessInFlight.get(key) === promise) {
        rosterAccessInFlight.delete(key);
      }
    });

  rosterAccessInFlight.set(key, promise);
  return promise;
}

// Guarded, not a bare call: a couple dozen suites in this file's own test
// tree mock `../services/servers.js` down to the handful of exports they
// need (`getChannel`, `getChannelAudience`, ...) and predate this one.
// Vitest's mock proxy throws on the mere PROPERTY READ of an export the
// factory never declared — even inside a `typeof` check — so this has to be
// a try/catch, not an `if`: skipping registration when it is absent costs
// those suites nothing they exercise, and the TTL above is still the
// correctness bound either way, exactly as documented on the cache.
try {
  onAudienceInvalidated(({ channelId, serverId }) => {
    if (channelId) {
      rosterAccessInvalidateChannel(channelId);
      return;
    }
    if (serverId) {
      // No per-entry server id kept (see the block comment above): the whole
      // cache is small, so a server-scoped invalidation clears all of it
      // rather than tracking a channel→server index nothing else here needs.
      rosterAccessInvalidateAll();
    }
  });
} catch {
  // Mocked without this export — see above.
}

onPermissionsUpdate(() => {
  // An overwrite change: same reasoning, no channelId travels with this
  // event, so the whole cache clears.
  rosterAccessInvalidateAll();
});

/** Drop expired entries. Called from the same 60s sweep as the audience cache. */
export function sweepVoiceChannelAccessCache(now = Date.now()): void {
  for (const [key, entry] of rosterAccessCache) {
    if (entry.expiresAt <= now) {
      rosterAccessCache.delete(key);
      const sep = key.indexOf(":");
      const channelId = sep === -1 ? key : key.slice(0, sep);
      rosterAccessChannelIndex.get(channelId)?.delete(key);
    }
  }
  for (const [channelId, bucket] of rosterAccessChannelIndex) {
    if (bucket.size === 0) {
      rosterAccessChannelIndex.delete(channelId);
    }
  }
}

/** Test helper: what the cache is holding. */
export function voiceChannelAccessCacheStats(): {
  channels: number;
  entries: number;
} {
  return {
    channels: rosterAccessChannelIndex.size,
    entries: rosterAccessCache.size,
  };
}

/**
 * Send current voice occupancy to a newly authenticated socket — but only for
 * the rooms this user is allowed to see.
 */
export async function sendAllVoiceRosters(socket: WebSocket, user: DbUser) {
  const rooms = new Map<
    string,
    {
      participants: Map<string, VoiceParticipant>;
      orphaned: Map<string, boolean>;
      transport?: VoiceRoomTransport;
    }
  >();
  const roomOf = (voiceChannelId: string) => {
    let room = rooms.get(voiceChannelId);
    if (!room) {
      room = { participants: new Map(), orphaned: new Map() };
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
          room.orphaned.set(peer.peerId, peer.orphanedAt !== null);
        }
      }
    } catch (error) {
      logEvent("voice.registryReadFailed", {
        op: "rosters",
        error: error instanceof Error ? error.message : String(error),
      });
      // Rows unreadable: what this process last sent for each room, not an
      // empty cluster (see `rosterWithoutRows`). A socket that reconnected
      // during a database outage must not be told the other machine's
      // seats are empty.
      for (const [voiceChannelId, sent] of sentRosters) {
        const room = roomOf(voiceChannelId);
        // With whatever this window has learned since that roster went out,
        // not consumed: the coalesced run still owns the queue.
        const current = new Map(sent);
        applyRoomEvents(current, pendingRoomEvents.get(voiceChannelId) ?? []);
        for (const participant of current.values()) {
          room.participants.set(participant.peerId, participant);
          room.orphaned.set(participant.peerId, false);
        }
      }
    }
  }
  for (const peer of peers.values()) {
    const room = roomOf(peer.voiceChannelId);
    room.participants.set(peer.id, toParticipant(peer));
    room.orphaned.set(peer.id, peer.orphanedAt !== undefined);
  }

  await Promise.all(
    [...rooms].map(async ([voiceChannelId, room]) => {
      try {
        // CACHED, NOT `canAccessChannel` DIRECTLY: this runs once per room this
        // instance or the registry knows about, on EVERY socket that
        // (re)authenticates — a reconnect storm multiplies it by both the
        // number of rooms and the number of reconnecting sockets, for a
        // question ("can this user still see this channel") that does not
        // change from one reconnect to the next. 30s of staleness here costs
        // nothing a client would notice: a room this socket cannot see is
        // simply not sent, same as before, at most half a minute later than a
        // membership change that just happened.
        if (!(await canAccessChannelForRoster(voiceChannelId, user.id))) {
          return;
        }
      } catch (error) {
        console.error("[voice] roster membership check failed:", error);
        return;
      }
      send(socket, {
        type: "voice-roster",
        voiceChannelId,
        participants: collapseOrphanedDuplicates(
          [...room.participants.values()],
          (participant) => participant.userId,
          (participant) => room.orphaned.get(participant.peerId) ?? false,
        ),
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
  //
  // THE AUDIENCE'S OWN ANSWER, never a query. This walk is over
  // `hlsAudience.liveChannels()`, which is exactly the channels this process
  // holds a stream for, so resolving would find it in memory anyway -- but it
  // would also put a Postgres fallback one refactor away from a path that runs
  // once per socket, and a reconnect storm after a deploy is hundreds of
  // sockets in a few seconds (2026-09-12: 141 tabs pinned the pool).
  // Discovery belongs to the paths a person triggers.
  //
  // THE ENUMERATION IS A SNAPSHOT AND THE ACCESS CHECK IS A ROUND TRIP, so a
  // party can end (or restart as a new session) between the two. The
  // generation moves on every authoritative change this process installs
  // (`rememberChannelStream`), so a generation that moved is this process
  // having learned something newer than the snapshot: re-read it, and say
  // `ended` rather than shipping a session that is over or an unknown null
  // the client is now written to ignore.
  const live = hlsAudience.liveChannels().map((channelId) => ({
    channelId,
    stream: hlsAudience.stream(channelId),
    generation: streamGeneration.get(channelId) ?? 0,
  }));
  await Promise.all(
    live.map(async (entry) => {
      try {
        if (!(await canAccessChannelForRoster(entry.channelId, user.id))) {
          return;
        }
      } catch (error) {
        console.error("[voice] channel-live membership check failed:", error);
        return;
      }
      const moved =
        (streamGeneration.get(entry.channelId) ?? 0) !== entry.generation;
      const stream = moved
        ? hlsAudience.stream(entry.channelId)
        : entry.stream;
      send(
        socket,
        // A null this process installed itself is an answer, not silence.
        channelLiveFrameWith(
          entry.channelId,
          user.id,
          stream,
          stream !== null || moved,
        ),
      );
      hlsAudienceFramesSent.frames += 1;
    }),
  );
  // And every room with music this user may view, for the sidebar row.
  // Off the audience cache (`getChannelAudience`, one query per channel per
  // TTL, shared by every socket), not one access query per socket per room.
  for (const channelId of musicChannels()) {
    const audience = await getChannelAudience(channelId).catch(() => null);
    if (audience?.has(user.id)) {
      send(socket, await channelMusicFrame(channelId));
    }
  }
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

/**
 * Take the room's queue off the row on the way into a call.
 *
 * A joiner cannot ask for the queue — there is no request frame in the
 * contract — so the row is the only thing standing between them and a silent
 * player beside a room three minutes into a song. But the joiner is not the
 * only one who benefits: reaching the row is also THE RECONCILIATION for a
 * `voice.music` frame this instance never received. The bus is fire and
 * forget by design (`lib/bus.ts`), so a dropped frame leaves everybody
 * already in the room here on the old queue with nothing coming to correct
 * them. If the row turns out to be ahead of the cache, the room hears it,
 * not only the person who just walked in.
 *
 * Read in the welcome's existing `Promise.all`, so it costs no extra round
 * trip on the join path.
 */
function adoptMusicFromRow(
  voiceChannelId: string,
  held: MusicState | null,
  anchor: MusicAnchor | null,
  joinerPeerId: string,
): void {
  const previous = getMusicState(voiceChannelId);
  const unchanged =
    previous === null
      ? held === null
      : held !== null &&
        held.rev === previous.rev &&
        held.actorId === previous.actorId;
  if (unchanged || !adoptMusicWithAnchor(voiceChannelId, held, anchor)) {
    return;
  }
  if (held !== null && anchor === null) {
    // A room whose anchor predates this column or was never set. The clamp
    // and the clock-based gate stand down until a trusted write sets one,
    // which is the documented cold-cache behaviour.
    musicCluster.anchorMissing += 1;
  }
  const before = previous?.current?.videoId ?? null;
  // The joiner is excluded: `welcomeVoicePeer` hands it the state itself, a
  // moment later and in the order the contract wants (after `welcome`).
  broadcastToRoom(
    voiceChannelId,
    { type: "music", channelId: voiceChannelId, state: held },
    joinerPeerId,
  );
  if ((held?.current?.videoId ?? null) !== before) {
    void broadcastChannelMusic(voiceChannelId);
  }
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
  // Orphans stay on the roster (sidebar still shows them) but must not be
  // in `welcome.peers`. A joiner that offered to a closed socket would sit
  // in `have-local-offer` forever; on resume `connectToPeer` is a no-op.
  const byId = new Map<string, VoiceParticipant>();
  let party = getWatchPartyState(peer.voiceChannelId);
  if (registryOn()) {
    // The room's other instances' peers, the party the room holds and the
    // queue it is playing. One read each, all best effort: a failed read
    // leaves the local view, which is what a single machine would have
    // shown. The raised hand is folded into this roster (the LEFT JOIN on
    // `voice_raised_hands`): after the peer row exists there is no second
    // round trip for it.
    //
    // THE MUSIC READ CATCHES ITS OWN FAILURE rather than riding the `try`
    // below. All three are in one `Promise.all` to keep the join to a single
    // round trip, but a rejection there would abandon the other two results
    // — and a socket seated with no roster and no watch party because the
    // music query hiccuped would be a far worse trade than a silent player.
    // `undefined` is already "no row to adopt" on this path.
    try {
      await settledRowWrites(peer.voiceChannelId);
      const [room, held, heldMusic] = await Promise.all([
        listVoiceRoster(peer.voiceChannelId),
        readWatchParty(peer.voiceChannelId),
        readMusicWithAnchor(peer.voiceChannelId).catch((error: unknown) => {
          logEvent("voice.registryReadFailed", {
            op: "welcomeMusic",
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }),
      ]);
      if (heldMusic !== undefined) {
        // The row's clock comes with the row's queue, and only with it: a
        // row refused as stale carries the clock of the queue we refused.
        adoptMusicFromRow(
          peer.voiceChannelId,
          heldMusic.state,
          heldMusic.anchor,
          peer.id,
        );
      }
      noteRemoteTransport(peer.voiceChannelId, room?.transport ?? null);
      for (const row of room?.peers ?? []) {
        if (row.userId === peer.userId) {
          if (row.handRaisedAt !== null) {
            noteRaisedHand(peer.voiceChannelId, peer.userId, row.handRaisedAt);
          } else {
            forgetLocalRaisedHand(peer.voiceChannelId, peer.userId);
          }
        }
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
  const self = toParticipant(peer);
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
    canManageMusic: peer.canManageMusic,
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
  const music = getMusicState(peer.voiceChannelId);
  if (music) {
    send(peer.socket, {
      type: "music",
      channelId: peer.voiceChannelId,
      state: music,
    });
  }
  // Resolved, not read off the local map: on the machine that is not running
  // the egress the map is empty for a party that is live one machine over,
  // and a joiner there used to be seated with no stream (`resolveChannelStream`).
  const liveStream = (await resolveChannelStream(peer.voiceChannelId)).stream;
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

  // Anything the person does on purpose restarts the idle-alone clock. The
  // signaling frames (offer, answer, ICE) are not on the list: browsers
  // send those on their own, and a seat that renegotiates by itself is
  // exactly the seat this clock is for.
  if (existingPeerId && SELF_INITIATED_VOICE_FRAMES.has(payload.type)) {
    const peer = peers.get(existingPeerId);
    if (peer?.aloneSince !== undefined) {
      // Restart, not stop: still alone, just did something on purpose. If a
      // warning was pending, the client's banner is cleared by an explicit
      // confirmation rather than by the click itself — see
      // `clearIdleAloneMarks`'s doc comment for why: a `voice-still-here`
      // that never reached the server (a closing or reconnecting socket)
      // must not have already cleared a banner the deadline behind it is
      // still counting down to.
      if (peer.idleWarnedAt !== undefined) {
        send(peer.socket, {
          type: "voice-idle-warning-cancelled",
          voiceChannelId: peer.voiceChannelId,
        });
      }
      peer.aloneSince = Date.now();
      peer.idleWarnedAt = undefined;
    }
  }
  if (payload.type === "voice-still-here") {
    return;
  }

  if (payload.type === "join-voice-room") {
    if (!roomLimiter.take(user.id)) {
      return;
    }
    // Every join past the per-user room rate limiter is one attempt. The
    // outcome — connected, or one of the named refusal doors below — is what
    // `calls.*` on GET /api/admin/metrics is built from; `joinAttempts` is
    // its denominator, and `joinAttempts - joinConnected` the refusals.
    noteJoinAttempt();
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
      noteJoinRefused("character");
      refuseResume();
      return;
    }
    if (!(await canAccessChannel(payload.voiceChannelId, user.id))) {
      noteJoinRefused("no-access");
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
      noteJoinRefused("invalid-channel");
      refuseResume();
      return;
    }
    if (channel.kind === "server" && !isVoiceRoomChannelType(channel.type)) {
      noteJoinRefused("invalid-channel");
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
      noteJoinRefused("blocked");
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
      noteJoinRefused("timeout");
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
    let canManageMusic = true;
    let nickname: string | null = null;
    if (channel.kind === "server" && channel.server_id) {
      const resolved = await resolveMemberChannelPermissions(
        channel.server_id,
        user.id,
        channel,
      );
      if (!hasPermission(resolved.permissions, Permission.CONNECT)) {
        noteJoinRefused("no-access");
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
      canManageMusic = hasPermission(resolved.permissions, Permission.MANAGE_MUSIC);
      nickname = resolved.nickname;
    }
    // THE ROOM GATE for the egress, read off the same row as the stage gate
    // so the two cannot disagree. See `pickHlsSharer`.
    const watchParty = isWatchPartyChannelType(channel.type);
    // Cached on the seat so `promoteRoomPastMeshCap` never has to re-fetch
    // the channel for a trigger that only holds a peer, not a channel row
    // (`set-sharing-screen`, `set-camera`). See the field's own comment.
    const canPromoteTransport = channel.kind === "server";

    /**
     * THE SEAT GATE. A watch party has no voice by default, and this is the
     * enforcement rather than the affordance.
     *
     * The audience of a watch party is seatless by construction: watching is
     * a socket reading an HLS playlist, and a seat is a LiveKit participant
     * with forwarded streams against an envelope of about 600 of them. The
     * client stopped offering a viewer any way in (#436), but a removed
     * button is a convention and not a model, and `join-voice-room` is the
     * only way into a room, so this is where the model lives.
     *
     * NOT A PERMISSION BIT, deliberately. A CONNECT deny on @everyone would
     * be the same mechanism as the SPEAK deny whose leftovers caused this
     * whole change: a rule written onto a channel that can outlive the party
     * that wrote it. This asks the party's own row instead, so it goes when
     * the party goes.
     *
     * SKIPPED ENTIRELY FOR ANYBODY WHO MAY PRESENT HERE, which is the host on
     * every path, so the snapshot below is not even consulted for them.
     * `canStream` in a watch party IS `START_WATCH_PARTY`
     * (`canStartWatchPartyStream`), so the two gates read one resolution and
     * cannot disagree. Everybody else reads a per-channel snapshot (voice
     * on or off, host, co-hosts, stage invites) that `loadWatchPartySeat`
     * caches in front of the database: a 500-person audience is one query,
     * not 500. `broadcastWatchParty` drops that snapshot on every mutation.
     *
     * FAILS OPEN. A database hiccup here must not lock a host out of their
     * own show minutes before it starts; the worst an allowed join can cost
     * is one seat, and the worst a wrongly refused one costs is the party.
     */
    if (watchParty && !canStream) {
      // `allowed` starts TRUE and only a read that succeeded may set it
      // false. Written this way round on purpose: an early return, a thrown
      // query or a branch added later all leave a join allowed, which is the
      // direction whose worst case is one seat rather than a cancelled show.
      let allowed = true;
      try {
        const seat = await loadWatchPartySeat(payload.voiceChannelId, user.id);
        allowed = mayGoOnAir({
          canStartWatchParty: false,
          party: seat,
        });
      } catch (error) {
        console.error("[voice] failed to read the watch party seat:", error);
      }
      if (!allowed) {
        noteJoinRefused("watch-party-full");
        logEvent("voice.watchPartySeatRefused", {
          channelId: payload.voiceChannelId,
        });
        // A COLD JOIN TOO. `refuseResume` only answers a resume, because the
        // other gates on this path (no access, a timeout, a block) have
        // always been silent and iOS treats `voice-join-refused` as "could
        // not rejoin". A watch-party viewer is different: Android treats the
        // channel as an ordinary voice room and sits on "connecting" until
        // a watchdog fires, unless we say so. Same frame shape as a resume.
        send(socket, {
          type: "voice-join-refused",
          voiceChannelId: payload.voiceChannelId,
        });
        return;
      }
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
    // Whether the transport this join is about to use was decided by an
    // EARLIER join. True when this process already holds the pin, and true
    // when the conditional insert below loses to a row another process (or
    // this one, before a restart) wrote. It is what the stale-pin re-read
    // keys off: a room this join is opening has just been decided and cannot
    // be stale.
    let pinPredatesThisJoin = roomTransports.has(payload.voiceChannelId);
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
        if (!claim.won) {
          // The row was already there: somebody else's join decided this
          // room, however long ago.
          pinPredatesThisJoin = true;
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

    // THE STALE PIN. A room's transport is decided when it opens and never
    // re-decided, which is right for a call that ends and wrong for a room
    // that never empties. On 2026-09-08 a voice channel in a server of
    // seventeen members was still pinned to the mesh it opened on at 11:46,
    // when that server was small, and at 16:13 it turned three people away in
    // a row for being the ninth. Nothing was broken: the pin had simply
    // outlived the condition that created it, and a popular room can hold one
    // for a whole day.
    //
    // So a room that was pinned to mesh by an earlier join has its policy
    // re-read here, and if the answer is the SFU today the room moves through
    // the same guarded path a fourth camera uses. `decideRoomTransport` is the
    // one used to open a room, so this cannot drift from it, and it answers
    // without a query for a DM, for a channel carrying an override, and on a
    // deployment with no LiveKit. An explicit `mesh` override therefore keeps
    // the room exactly where the operator put it, because the policy itself
    // answers `mesh` for one; an explicit `livekit` override edited during a
    // live call is a legitimate reason to move, and moves it.
    if (transport === "mesh" && pinPredatesThisJoin && resume.kind !== "reattach") {
      const now = await recheckRoomTransport(payload.voiceChannelId, channel);
      if (
        now.transport === "livekit" &&
        (await promoteRoomPastMeshCap(
          payload.voiceChannelId,
          "stale-pin",
          user.id,
          channel.kind === "server",
          "mesh",
        ))
      ) {
        transport = "livekit";
        // The room moved, so a resume holding mesh media is holding media for
        // a room that no longer exists. Same rule as the pin comparison
        // above, for the same reason.
        if (
          (resume.kind === "reconstruct" || resume.kind === "adopt") &&
          resume.transport !== "livekit"
        ) {
          resume = { kind: "cold" };
        }
      }
      // The awaits may have outlived the socket, and the promotion releases
      // seats: nothing below may assume either survived.
      if (socket.readyState !== 1) {
        if (pinnedHere) {
          void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
        }
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
      noteJoinRefused("transport-unsupported");
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

    // THE FOURTH PERSON, which is the one that stops anybody meeting a cap.
    //
    // Every limit a small call runs into is a mesh limit: three cameras, two
    // screen shares, eight people. The room moves when somebody hits one, and
    // that works, but it means the caps are still something people MEET, mid
    // call, as a refusal or as a stutter. Rafael's framing: "a 2 or 3 person
    // call is fine. 4 or 5 becomes a proper thing. I want people to be able to
    // share screen or use webcam."
    //
    // So the room moves at `MESH_ROOM_PROMOTION_SIZE` people, before anybody
    // asks for anything. Four is where a call stops being a chat, and it is
    // also exactly where the mesh arithmetic turns: `CAMERA_LIMIT.mesh` is 3,
    // so a room of four is the first size at which somebody is told no.
    //
    // Two and three person calls stay peer to peer, deliberately: one hop
    // instead of two is the lowest latency path there is, it costs the media
    // box nothing, and it still works when the box does not. Most calls are
    // that size, which is also what keeps the box's load proportional to the
    // calls that need it.
    //
    // `promotionRoomSize()` is read per join, so the threshold is tunable
    // (and switchable off, with `0`) in one `fly secrets set`, without a
    // deploy. Every other guard is the room-full path's, unchanged: the same
    // gate, the same budget, the same handling of a seat that cannot follow.
    const sizeThreshold = promotionRoomSize();
    if (
      sizeThreshold !== null &&
      transport === "mesh" &&
      resume.kind === "cold" &&
      occupying.length + foreignOccupying + 1 >= sizeThreshold
    ) {
      const blocked = blockJoinPromotion({
        channelOverride: channel.voice_transport ?? null,
        joinerCapabilities: capabilities,
      });
      if (blocked) {
        // Not a refusal of the JOIN: the room simply stays on mesh and this
        // person is seated on it, exactly as before this trigger existed.
        // Logged all the same, because a room that never moves when the
        // operator expects it to is otherwise invisible.
        logEvent("voice.transportPromotionRefused", {
          voiceChannelId: payload.voiceChannelId,
          userId: user.id,
          reason: "room-size",
          refusal: blocked,
          roomSize: occupying.length + foreignOccupying + 1,
          threshold: sizeThreshold,
        });
      } else if (
        await promoteRoomPastMeshCap(
          payload.voiceChannelId,
          "room-size",
          user.id,
          channel.kind === "server",
          "mesh",
        )
      ) {
        transport = "livekit";
      }
      // The awaits may have outlived the socket, and the promotion releases
      // seats: re-read everything below rather than trusting the counts above.
      if (socket.readyState !== 1) {
        if (pinnedHere) {
          void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
        }
        return;
      }
      occupying = occupyingOf();
    }

    // THE NINTH PERSON, still the backstop. With the threshold above on and
    // the box healthy a mesh room does not reach eight any more, but it does
    // when the size promotion was refused (the budget, an operator's mesh
    // override, a mesh-only joiner) or when the threshold is switched off.
    //
    // `MESH_VOICE_LIMIT` is eight and the number is right:
    // above it each client carries one Opus uplink per peer and quality
    // collapses. What was wrong is what happened at it. The room is on mesh
    // because of a guess about how many people would show up, and the ninth
    // person at the door is the evidence that the guess was low; refusing
    // them keeps the guess and loses the person. Three of them were turned
    // away from one call on 2026-09-08.
    //
    // So the room moves and the join lands, through the same path a fourth
    // camera uses: the box is priced first (`decidePromotion`), and a refusal
    // is the old refusal, byte for byte, including the log line below.
    //
    // Only for a cold join. A resume does not count its own seat against the
    // ceiling, so it reaches here only when its seat is already gone, and its
    // media was built for the mesh it cannot follow anyway.
    if (meshIsFull() && resume.kind === "cold") {
      const blocked = blockJoinPromotion({
        channelOverride: channel.voice_transport ?? null,
        joinerCapabilities: capabilities,
      });
      if (blocked) {
        logEvent("voice.transportPromotionRefused", {
          voiceChannelId: payload.voiceChannelId,
          userId: user.id,
          reason: "room-full",
          refusal: blocked,
          roomSize: occupying.length + foreignOccupying,
        });
      } else if (
        await promoteRoomPastMeshCap(
          payload.voiceChannelId,
          "room-full",
          user.id,
          channel.kind === "server",
          "mesh",
        )
      ) {
        // The room is on the SFU now, so the ceiling that refused this person
        // belongs to a mesh they are no longer joining. `meshIsFull()` reads
        // `transport`, so this one assignment reopens the door.
        transport = "livekit";
      }
      if (socket.readyState !== 1) {
        if (pinnedHere) {
          void unpinVoiceRoomIfEmpty(payload.voiceChannelId);
        }
        return;
      }
    }

    // Enforce the mesh ceiling server-side. Above it, each client would carry
    // one Opus uplink per peer and quality collapses — reject instead. The
    // ceiling is a property of the mesh, so it does not apply once media is
    // routed through an SFU.
    if (meshIsFull()) {
      noteJoinRefused("room-full");
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
      resume.peer.canManageMusic = canManageMusic;
      resume.peer.watchParty = watchParty;
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
      listeningMusic: adopted?.listeningMusic ?? true,
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
      canManageMusic,
      watchParty,
      canPromoteTransport,
      canResume: payload.resume === true,
      // Deliberately not carried across a resume and not in the registry row.
      // A measurement is about a link at a moment; a client that reconnects
      // re-measures and re-reports on its next claim, and until it does the
      // room falls back to the old constant, which is the same thing every
      // client without the field gets.
      measuredUplinkBps: null,
      sourceHeight: null,
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
    // Clear any idle-alone clock on this instance's OTHER seats in the room
    // right now, rather than waiting up to `IDLE_ALONE_SWEEP_MS` for the next
    // sweep to notice. Without this, a visit that starts and ends between two
    // sweeps is invisible to `sweepIdleAloneSeats` (it only samples once per
    // tick), so the departed visitor's presence would never reset the
    // remaining peer's `aloneSince` and a later sweep could count the whole
    // stretch, visit included, as one uninterrupted alone period. Same-
    // instance only: a join on a DIFFERENT machine still reaches the other
    // peer through the next sweep's registry read, bounded by one tick.
    for (const other of getRoomPeers(payload.voiceChannelId)) {
      if (other.id !== peerId) {
        clearIdleAloneMarks(other, payload.voiceChannelId);
      }
    }
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
    // Connected: a peer is seated (a fresh join or a resume reattaching a
    // seat; both passed noteJoinAttempt above, so counting resumes here keeps
    // `joinAttempts - joinConnected` equal to the refusals). `transport` is
    // mesh|livekit; scope is the room kind (a conversation is dm or group).
    const joinScope: CallScope =
      channel.kind === "server"
        ? "server"
        : channel.kind === "group"
          ? "group"
          : "dm";
    noteJoinConnected(transport, joinScope);
    // Funnel step `first_voice`: a peer is seated. A resume can also reach here,
    // but a resume by definition follows an earlier join, so stamp-if-null on
    // the first real join is what wins; a resume is a harmless no-op. Cheap on
    // repeat (the in-process memo skips the DB after this user's first join),
    // which matters on the path a watch party runs several hundred times a night.
    await recordActivationStep(user.id, "first_voice");
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
    // The measurement, before it is used. Clamped here and nowhere else, so
    // every read of the field is already inside the believable window.
    if (payload.uplinkBps !== undefined) {
      peer.measuredUplinkBps =
        clampReportedUplinkBps(payload.uplinkBps) ?? peer.measuredUplinkBps;
    }
    if (payload.sourceHeight !== undefined) {
      peer.sourceHeight = payload.sourceHeight;
    }
    if (!payload.sharing) {
      peer.sourceHeight = null;
    }
    if (payload.sharing) {
      const othersSharing = () =>
        getRoomPeers(peer.voiceChannelId).filter(
          (p) => p.id !== peer.id && p.sharingScreen,
        ).length;
      const shareCap = () => meshShareLimit(peer.voiceChannelId);
      const cap = shareCap();
      if (cap !== null && othersSharing() >= cap) {
        // The mesh cap is what this room's measured links can carry (see
        // `meshShareLimit`). Where there is an SFU to move to, move the room
        // rather than refuse the share; `promoteRoomPastMeshCap` prices the
        // box first and answers false when it cannot, which is exactly the
        // old refusal.
        await promoteRoomPastMeshCap(
          peer.voiceChannelId,
          "screens",
          user.id,
          peer.canPromoteTransport,
        );
        // The await above may have outlived the socket, and the promotion
        // itself releases seats: re-read everything before the write. This is
        // the "keep the check in the same tick as the write" rule restated:
        // the counts below are the ones that decide, and they are taken after
        // every await on this path.
        if (socket.readyState !== 1 || peers.get(existingPeerId) !== peer) {
          return;
        }
        const after = shareCap();
        if (after !== null && othersSharing() >= after) {
          send(peer.socket, {
            type: "screen-share-denied",
            voiceChannelId: peer.voiceChannelId,
          });
          return;
        }
      }
      // THE FIFTH SHARE. On the voice server there is no count to hit, the
      // box has a budget instead. A live sharer re-declaring (an audio id
      // arriving, a rejoin) is not a new publication and is never priced, so
      // re-declaring can never be refused for the slot it already holds.
      if (shareCap() === null && !peer.sharingScreen) {
        const admitted = await admitVideoOnSfu(
          peer.voiceChannelId,
          "screens",
          user.id,
        );
        if (socket.readyState !== 1 || peers.get(existingPeerId) !== peer) {
          return;
        }
        if (!admitted) {
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
    // live the moment anyone starts sharing here. The last share STOPPING
    // only stamps when the picture went away (see `noteShareStopped`); it
    // does not end the party. Fire-and-forget: a missed stamp costs a party
    // a later bound, never a broken stream.
    if (payload.sharing) {
      void markChannelSessionLive(peer.voiceChannelId).catch((error) => {
        console.error("[channel-sessions] markLive failed:", error);
      });
      void markChannelShareStarted(peer.voiceChannelId).catch((error) => {
        console.error("[channel-sessions] share-started stamp failed:", error);
      });
    } else if (
      !getRoomPeers(peer.voiceChannelId).some((p) => p.sharingScreen)
    ) {
      void noteShareStopped(peer.voiceChannelId);
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

  // --- raised hands ---
  //
  // "levantar a mão e aí forma a fila de quem levantou primeiro". Only ever
  // about the sender: lowering somebody else's hand is a moderation action
  // and lives on the HTTP route with the rest of them
  // (`voice-lower-hand`, `Permission.MUTE_MEMBERS`).
  //
  // No refusal frame and no ack. The answer is the roster: `handRaisedAt` on
  // the next one is where in the queue this person landed, and it is the same
  // number everyone else in the room is reading. A raise that is dropped by
  // the limiter below therefore corrects itself the moment the person clicks
  // again, and never leaves the room disagreeing with itself.
  if (payload.type === "set-raised-hand") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    // No change, no fan-out. A client redeclares after every reconnect, and
    // most of those declarations say what the room already holds. Note that
    // a repeated `raised: true` is not a re-raise even when it does get
    // through: the row keeps the original instant, so nobody loses their
    // place by saying the same thing twice.
    const standing =
      voiceUserHandRaisedAt(peer.voiceChannelId, peer.userId) !== null;
    if (standing === payload.raised) {
      return;
    }
    // Through the same limiter as a mute toggle: both spend the whole
    // channel audience's bandwidth on one person's click.
    if (!stateLimiter.take(user.id)) {
      return;
    }
    await setVoiceUserHandRaised(
      peer.voiceChannelId,
      peer.userId,
      payload.raised,
    );
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

  // --- music queue ---
  //
  // Same audience, same echo-as-acknowledgement and, since the room can span
  // machines, the same three-step tail as the watch party above: the cache
  // decides, the row decides again for the cluster, and `voice.music` tells
  // the other instance to catch its half of the room up.
  if (payload.type === "set-music") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    const before = channelMusicTrack(peer.voiceChannelId)?.videoId ?? null;
    const { roomSize, seatedUserIds } = await musicRoomSeats(peer.voiceChannelId);
    const held = getMusicState(peer.voiceChannelId);
    const incoming =
      payload.state === null ? null : completeMusicState(held, payload.state);
    // A privileged write (one a plain member could not make) re-resolves
    // MANAGE_MUSIC before it is trusted: the cached bit is refreshed when
    // cargos change (`reevaluateVoiceSpeak`), and this is the belt to that
    // brace, so a member stripped of the bit a moment ago cannot skip on a
    // stale seat. Ordinary adds never pay for it. `openControls` is read
    // from the held state inside `musicWriteAllowed`, not computed here.
    if (
      peer.canManageMusic &&
      !musicServerWriteAllowed(held, incoming, {
        userId: user.id,
        canManage: false,
        canAdd: peer.canSpeak,
        roomSize,
        peerId: peer.id,
        // The same clock the real check below will use. This one used to
        // pass neither it nor a peer id, which quietly gave this call the
        // CLIENT's lenient reading of the end-of-track gate.
        expectedPositionMs: musicExpectedPositionMs(peer.voiceChannelId),
        seatedUserIds,
      })
    ) {
      try {
        const channel = await getChannel(peer.voiceChannelId);
        const grant = await resolveVoicePublish(channel, peer.voiceChannelId, user.id);
        peer.canManageMusic = grant.canManageMusic;
      } catch (error) {
        console.error("[voice] music permission re-check failed:", error);
      }
    }
    const write = applyMusicWrite(peer.voiceChannelId, incoming, {
      userId: user.id,
      canManage: peer.canManageMusic,
      canAdd: peer.canSpeak,
      roomSize,
      seatedUserIds,
      peerId: peer.id,
    });
    if (write.kind === "coalesced") {
      return;
    }
    if (write.kind === "refused") {
      send(socket, {
        type: "music",
        channelId: peer.voiceChannelId,
        state: write.held,
        forced: true,
      });
      return;
    }
    if (
      write.kind === "accepted" &&
      (write.state?.current?.videoId ?? null) !== before
    ) {
      void broadcastChannelMusic(peer.voiceChannelId);
    }
    if (write.kind === "stale") {
      send(socket, {
        type: "music",
        channelId: peer.voiceChannelId,
        state: write.held,
      });
      return;
    }
    // The row is the room's queue when the flag is on, and the write is the
    // ordering the cache just applied, run again against what the cluster
    // holds. A write that lost there (this instance missed a frame, or two
    // people hit skip in the same instant on two machines) is handed the
    // row's winner, exactly as a local loser is handed the held state above.
    // A failed write degrades to the local decision, like every registry
    // write.
    if (registryOn()) {
      let persisted: Awaited<ReturnType<typeof persistMusic>> | null = null;
      try {
        persisted = await persistMusic(
          peer.voiceChannelId,
          write.state,
          getMusicAnchor(peer.voiceChannelId),
        );
      } catch (error) {
        logEvent("voice.registryWriteFailed", {
          op: "music",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (persisted?.kind === "stale") {
        adoptMusicWithAnchor(
          peer.voiceChannelId,
          persisted.held,
          persisted.anchor,
        );
        // TO THE ROOM, NOT ONLY TO THE LOSER. This instance lost in the row
        // because it had missed the frame that put the winner there, which
        // means every peer here is on the stale queue and not just the
        // person who wrote. Correcting the writer alone would leave them
        // watching a different track from the people sitting next to them.
        // The frame is an absolute state at a higher `rev`, so a peer that
        // somehow had it already is unaffected.
        broadcastToRoom(peer.voiceChannelId, {
          type: "music",
          channelId: peer.voiceChannelId,
          state: persisted.held,
        });
        // The sidebar was told about a track this instance no longer holds.
        void broadcastChannelMusic(peer.voiceChannelId);
        return;
      }
    }
    broadcastToRoom(peer.voiceChannelId, {
      type: "music",
      channelId: peer.voiceChannelId,
      state: write.state,
    });
    if (clusterOn()) {
      musicCluster.relayed += 1;
      const anchor = getMusicAnchor(peer.voiceChannelId);
      publishVoice(VOICE_MUSIC_TOPIC, {
        channelId: peer.voiceChannelId,
        state: write.state,
        ...(anchor
          ? { anchorPositionMs: anchor.positionMs, anchorAt: anchor.at }
          : {}),
      } satisfies VoiceMusicFrame);
    }
    return;
  }

  if (payload.type === "set-music-listening") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    const listening = payload.listening;
    if (peer.listeningMusic === listening) {
      return;
    }
    peer.listeningMusic = listening;
    writePeerRow(peer);
    musicCluster.listeningWrites += 1;
    logEvent("voice.musicListening", {
      peerId: peer.id,
      userId: peer.userId,
      voiceChannelId: peer.voiceChannelId,
      listening,
      registry: registryOn(),
    });
    await broadcastRoster(peer.voiceChannelId, {
      kind: "updated",
      peer: toParticipant(peer),
    });
    scheduleChannelMusicBroadcast(peer.voiceChannelId);
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
    if (payload.uplinkBps !== undefined) {
      peer.measuredUplinkBps =
        clampReportedUplinkBps(payload.uplinkBps) ?? peer.measuredUplinkBps;
    }
    if (payload.streamId) {
      const othersOn = () =>
        getRoomPeers(peer.voiceChannelId).filter(
          (p) => p.id !== peer.id && p.cameraStreamId,
        ).length;
      const meshCap = () => meshCameraLimit(peer.voiceChannelId);
      const cap = meshCap();
      if (cap !== null && othersOn() >= cap) {
        // THE CAMERA THE MESH CANNOT CARRY. A mesh camera is a full uplink
        // copy per peer, so the room's own links decide how many fit
        // (`meshCameraLimit`); that is not a ceiling on how many friends want
        // to be seen. Move the room to the SFU and let the camera on. See the
        // promotion section for what makes that safe and what stops it (the
        // box's budget).
        await promoteRoomPastMeshCap(
          peer.voiceChannelId,
          "cameras",
          user.id,
          peer.canPromoteTransport,
        );
        if (socket.readyState !== 1 || peers.get(existingPeerId) !== peer) {
          return;
        }
        const after = meshCap();
        if (after !== null && othersOn() >= after) {
          send(peer.socket, {
            type: "camera-denied",
            voiceChannelId: peer.voiceChannelId,
          });
          return;
        }
      }
      // THE NINTH CAMERA. On the voice server there is no count to hit: the
      // box has a budget instead (see `admitVideoOnSfu`). A camera already up
      // that is only re-declaring (a device switch mints a new stream id) is
      // not a new publication and is never priced, so a device change cannot
      // be refused for the seat it already holds.
      if (meshCap() === null && !peer.cameraStreamId) {
        const admitted = await admitVideoOnSfu(
          peer.voiceChannelId,
          "cameras",
          user.id,
        );
        if (socket.readyState !== 1 || peers.get(existingPeerId) !== peer) {
          return;
        }
        if (!admitted) {
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
    // A WATCH PARTY'S PRESENTER TURNING THEIR CAMERA ON IS A STREAM CHANGE.
    // The seatless audience never joins the room, so a camera published into
    // it reaches nobody on the playlist; the reconcile is what gives it a
    // transcode of its own. Nothing else on this path ever called it, so
    // without this line the camera egress would only ever start at the next
    // unrelated roster event. Cheap and fire-and-forget: the reconcile is
    // serialised per channel and returns without an RPC in every room that is
    // not transcoding.
    //
    // `.catch` rather than `await`, on purpose: `set-camera` must ack the
    // sender at once regardless of how the transcode side is doing, the same
    // way every other call site of this function treats it. Most of what can
    // go wrong in there is already self-healing (the health monitor, the
    // camera's own probe retry, the next roster event), so this exists only
    // to keep a truly unexpected throw from becoming an unhandled rejection
    // rather than to add a retry of its own.
    void pushLiveHls(peer.voiceChannelId).catch((error: unknown) => {
      console.error(
        "[voice] pushLiveHls failed after set-camera:",
        peer.voiceChannelId,
        error,
      );
    });
    if (payload.streamId) {
      scheduleCameraFollowUpReconciles(peer.voiceChannelId);
    }
    return;
  }

  // `LIVE_HLS_VOICE_TRACK`'s "separada" declaration. See
  // `setVoiceTrackSeparated` in `hls-egress.ts` for why the server wants
  // this as its own signal rather than inferring the mode from the
  // `voice-track` publication alone.
  if (payload.type === "set-voice-track-mode") {
    if (!existingPeerId) {
      return;
    }
    const peer = peers.get(existingPeerId);
    if (!peer) {
      return;
    }
    // ONLY THE ROOM'S CURRENT PRESENTER'S WORD COUNTS — the same authority
    // `pushLiveHls` already defers to for who is presenting at all. Anybody
    // else declaring a mode for a party they are not running is a no-op,
    // never an error: a stale or mistaken frame from a non-presenter must
    // not move a fact the real presenter's own client owns.
    if (pickHlsSharer(getRoomPeers(peer.voiceChannelId))?.id !== peer.id) {
      return;
    }
    setVoiceTrackSeparated(peer.voiceChannelId, peer.id, payload.separated);
    // Same shape as `set-camera` above: fire-and-forget, `.catch` rather
    // than `await`, so this frame acks at once regardless of how the
    // transcode side is doing.
    void pushLiveHls(peer.voiceChannelId).catch((error: unknown) => {
      console.error(
        "[voice] pushLiveHls failed after set-voice-track-mode:",
        peer.voiceChannelId,
        error,
      );
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
    send(socket, await channelLiveFrame(payload.channelId, user.id));
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

/**
 * Ringing fans out to every participant's every socket; keep it rare.
 *
 * THE ONE LIMITER IN THIS FILE THAT IS NOT PER PROCESS. Five rings per five
 * minutes is a budget aimed at the person being buzzed, and two API machines
 * turned it into ten for anybody with a tab on each — the exact failure the
 * banner in `lib/rate-limit.ts` describes and declines to fix for the hot
 * paths. This path is neither hot nor harmless: one call, one round trip,
 * spent atomically in `rate_limit_buckets`. The in-memory bucket below stays
 * as the backstop, so a database that cannot be reached degrades to the
 * per-machine behaviour rather than to no limit at all.
 */
export const RING_BUDGET = {
  bucket: "voice.ring",
  capacity: 5,
  refillPerSecond: 0.2,
} as const;
const ringLimiter = createRateLimiter({
  capacity: RING_BUDGET.capacity,
  refillPerSecond: RING_BUDGET.refillPerSecond,
});

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

/**
 * The cluster half of the ring budget. Never throws: `sharedRateLimit` fails
 * open on its own, and this wrapper keeps the promise for the caller so a
 * database blip cannot turn "you may ring" into an exception on the voice
 * socket.
 */
async function takeSharedRingBudget(userId: string): Promise<boolean> {
  // ONE MACHINE NEEDS NO SECOND DOOR. The in-memory bucket is exact when
  // there is only one of it, and a self-host or a local dev run should not
  // pay a round trip — or own a table — for a budget that already holds.
  //
  // THE SAME PREDICATE THE LEASE USES, deliberately: `clusterTopologyTracked`
  // is the one answer to "does this deployment expect siblings", and either
  // flag makes it true because `docs/plans/MULTI_INSTANCE_VOICE.md` allows
  // turning on either first. Gating this on the registry alone would have
  // left `CLUSTER_BUS=postgres` with `VOICE_REGISTRY=off` — a configuration
  // that now writes instance leases precisely because it has siblings —
  // enforcing five rings per machine again.
  if (!clusterTopologyTracked()) {
    return true;
  }
  try {
    return await sharedRateLimit(RING_BUDGET, userId);
  } catch (error) {
    logEvent("voice.ringBudgetFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
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
  // The free door first: an in-memory bucket, no query, and it is what
  // refuses the repeat-tap case. The cluster's budget is spent much further
  // down, immediately before the ring is committed — see there for why.
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

  // THE CLUSTER'S BUDGET IS SPENT HERE, not at the top of the function.
  //
  // Everything above this line is rejection-only: a stale socket, a forged
  // conversation id, a ring already in flight, a room where nobody is absent.
  // Spending a five-per-five-minutes token on any of those would let a
  // misbehaving client burn somebody's ring budget without a single ring
  // being delivered, and the budget is cluster-wide now, so it would not even
  // be recoverable by reconnecting to the other machine. Below this line the
  // ring is committed, so a spent token always bought a ring.
  //
  // `takeSharedRingBudget` fails open, so it can only ever be the second of
  // two doors; and the `conversationRings` re-check is the window its await
  // opens, closed the same way every other await in this function closes its
  // own.
  if (!(await takeSharedRingBudget(user.id))) {
    return;
  }
  if (conversationRings.has(conversationId)) {
    return;
  }
  if (socketToPeerId.get(socket) !== peerId || !peers.has(peerId!)) {
    return;
  }

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
  noteRingStarted(ring.kind);

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
  // Count the ring as answered on the FIRST answer only, so a group call where
  // three people pick up is one answered ring, not three.
  if (!ring.anyoneAnswered) {
    noteRingAnswered(ring.kind);
  }
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
  noteRingDeclined();
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
    noteRingEnded(reason);
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
      ...(notice.reason ? { reason: notice.reason } : {}),
      ...(notice.aloneMinutes !== undefined
        ? { aloneMinutes: notice.aloneMinutes }
        : {}),
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
  notice: {
    movedToChannelId?: string;
    message: string;
    reason?: "idle";
    aloneMinutes?: number;
  },
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
    ...(notice.reason ? { reason: notice.reason } : {}),
    ...(notice.aloneMinutes !== undefined
      ? { aloneMinutes: notice.aloneMinutes }
      : {}),
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
          peer.canSpeak !== next.canSpeak ||
          peer.canStream !== next.canStream ||
          peer.canManageMusic !== next.canManageMusic,
      );
      if (changed.length === 0) {
        continue;
      }
      relabelled.push(...changed);
      for (const peer of changed) {
        peer.canSpeak = next.canSpeak;
        peer.canStream = next.canStream;
        peer.canManageMusic = next.canManageMusic;
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
          canManageMusic: next.canManageMusic,
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

/**
 * WHY a room moved. Four triggers, one path.
 *
 * `cameras` and `screens` are a publication past the mesh cap (PR #366).
 * `room-full` is the ninth person at the door of a full mesh, `room-size` is a
 * room reaching `MESH_ROOM_PROMOTION_SIZE` so that nobody meets a mesh cap at
 * all, and `stale-pin` is a room whose pin no longer matches what the policy
 * would decide today.
 * The value travels to every seat in `voice-transport-changed`, where it picks
 * the sentence, and into `voice.transportPromoted`, where it is what separates
 * the triggers in production.
 */
export type VoicePromotionReason =
  | "cameras"
  | "screens"
  | "room-full"
  | "room-size"
  | "stale-pin";

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

/** How many seats in a room are publishing each kind of video right now. */
function countPublishers(
  people: readonly { sharingScreen: boolean; cameraStreamId: string | null }[],
): { cameras: number; screens: number } {
  let cameras = 0;
  let screens = 0;
  for (const person of people) {
    if (person.cameraStreamId) {
      cameras += 1;
    }
    if (person.sharingScreen) {
      screens += 1;
    }
  }
  return { cameras, screens };
}

/**
 * WHAT THIS ROOM'S LINKS CAN CARRY, or null when the room is not on mesh and
 * the question is the box's rather than anybody's link.
 *
 * The constants (2 shares, 3 cameras) were guesses about a typical home
 * connection applied to every room on every connection. This reads what the
 * room actually reported instead, takes the narrowest of it, and asks
 * `meshVideoLimit`. A room where nobody has reported anything gets exactly the
 * old constant, so a call full of native clients behaves as it did before.
 *
 * ORPHANS COUNT toward the room size, the same rule the rest of this file
 * follows: an orphan is a refresh in flight and its media is still on the
 * wire, so it is still a viewer that every copy has to be encoded for.
 */
function meshVideoLimitFor(
  voiceChannelId: string,
  kind: MeshVideoKind,
): number | null {
  if (getRoomTransport(voiceChannelId) !== "mesh") {
    return null;
  }
  const seated = getRoomPeers(voiceChannelId);
  return meshVideoLimit({
    kind,
    roomSize: seated.length,
    uplinkBps: narrowestUplinkBps(
      seated.map((person) => person.measuredUplinkBps),
    ),
  });
}

/**
 * The room as it will be once whatever triggered this actually lands.
 *
 * TWO AXES, AND EVERY TRIGGER MOVES EXACTLY ONE OF THEM OR NEITHER.
 *
 * A camera or a share adds a PUBLICATION, which the estimate multiplies by
 * every participant. Which of the two counts it lands in is a factor of nearly
 * three (a share is charged at `SCREEN_STREAM_MBPS`, a camera at
 * `CAMERA_STREAM_MBPS`), so the reason travels here rather than being
 * inferred: charging a share as a camera is exactly the mistake the split
 * counts exist to prevent.
 *
 * A ninth person at the door, or the fourth person who trips the size
 * threshold, adds a PARTICIPANT: one more subscriber to the publications
 * already there, and no publication at all. Charging either of those for a
 * camera nobody turned on would refuse the promotion of a big, silent call for
 * load it is not about to create.
 *
 * A stale pin adds neither: the room is being moved because the policy already
 * says it belongs on the SFU, and the seats and publications are the ones it
 * already has.
 */
function withOneMore(
  room: SfuRoomLoad,
  reason: VoicePromotionReason,
): SfuRoomLoad {
  switch (reason) {
    case "screens":
      return { ...room, screenPublishers: room.screenPublishers + 1 };
    case "cameras":
      return { ...room, cameraPublishers: room.cameraPublishers + 1 };
    case "room-full":
    case "room-size":
      return { ...room, participants: room.participants + 1 };
    default:
      return room;
  }
}

function meshShareLimit(voiceChannelId: string): number | null {
  return meshVideoLimitFor(voiceChannelId, "screens");
}

function meshCameraLimit(voiceChannelId: string): number | null {
  return meshVideoLimitFor(voiceChannelId, "cameras");
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
      return rooms.map((room) => {
        const publishing = countPublishers(room.peers);
        return {
          channelId: room.channelId,
          transport: room.transport,
          participants: room.peers.length,
          cameraPublishers: publishing.cameras,
          screenPublishers: publishing.screens,
        };
      });
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
        cameraPublishers: 0,
        screenPublishers: 0,
      };
      byRoom.set(peer.voiceChannelId, room);
    }
    room.participants += 1;
    if (peer.cameraStreamId) {
      room.cameraPublishers += 1;
    }
    if (peer.sharingScreen) {
      room.screenPublishers += 1;
    }
  }
  return [...byRoom.values()];
}

/**
 * May one more camera or share go up in a room that is ALREADY on the SFU?
 *
 * The other half of the promotion guard. A room on mesh asks
 * `promoteRoomPastMeshCap`, which prices the box and moves the room; a room on
 * the SFU has nowhere to move, so it asks the same price and gets a yes or a
 * no. There is no count in either answer.
 *
 * A read that fails is a yes. The alternative is a database blip turning into
 * "nobody's camera works" for everybody on the box, which is a worse failure
 * than an estimate that is a little low: `readRoomLoads` already falls back to
 * this instance's own peers, so a throw here is the rarer case where even that
 * failed.
 *
 * NOT CACHED, DELIBERATELY. This runs once per camera anybody turns on in a
 * voice-server room rather than once per promotion, so a cache was the obvious
 * next thought. It is not worth its staleness: the frame this sits on already
 * writes the peer row and fans a roster update out to the whole room, so one
 * indexed read beside those is proportionate, and a cache window is exactly
 * the window in which a burst of clicks is admitted against a total that has
 * not seen the first of them.
 */
async function admitVideoOnSfu(
  voiceChannelId: string,
  reason: VoicePromotionReason,
  userId: string,
): Promise<boolean> {
  const budgetMbps = promotionBudgetMbps();
  let rooms: SfuRoomLoad[];
  try {
    rooms = await readRoomLoads();
  } catch (error) {
    logEvent("voice.videoAdmissionLoadFailed", {
      voiceChannelId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  const seated = getRoomPeers(voiceChannelId);
  const known = rooms.find((room) => room.channelId === voiceChannelId);
  const candidate = withOneMore(
    {
      channelId: voiceChannelId,
      transport: "livekit",
      participants: Math.max(known?.participants ?? 0, seated.length, 1),
      cameraPublishers: Math.max(
        known?.cameraPublishers ?? 0,
        countPublishers(seated).cameras,
      ),
      screenPublishers: Math.max(
        known?.screenPublishers ?? 0,
        countPublishers(seated).screens,
      ),
    },
    reason,
  );
  const verdict = decideVideoAdmission({ rooms, room: candidate, budgetMbps });
  if (!verdict.admit) {
    // The counter that proves the mechanism runs. Without it a budget that is
    // wrong looks exactly like a room where nobody wanted their camera on.
    logEvent("voice.videoAdmissionRefused", {
      voiceChannelId,
      userId,
      reason,
      loadMbps: Math.round(verdict.loadMbps),
      addedMbps: Math.round(verdict.addedMbps),
      budgetMbps: verdict.budgetMbps,
      roomSize: candidate.participants,
      cameraPublishers: candidate.cameraPublishers,
      screenPublishers: candidate.screenPublishers,
    });
  }
  return verdict.admit;
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
 * Move a mesh room onto the SFU: for a camera or a screen share past the mesh
 * cap, for a ninth person at a full mesh, or for a pin that no longer matches
 * the policy. Returns whether the room is on the SFU when it resolves.
 *
 * `true` also covers "it was already there", so the caller can simply re-read
 * the transport and re-check the cap rather than branching on how it got
 * there. `false` is the old behaviour: the caller refuses the claim and the
 * client says the call is at its camera limit, or that the room is full.
 *
 * `currentTransport` is the caller's authoritative reading of the room. The
 * join path has one and this function's own does not: `getRoomTransport` falls
 * back to the configured ceiling for a room this process holds no seat in, so
 * on a second instance it would answer `livekit` for a room that is live on
 * mesh elsewhere and this would return `true` without moving anything. That is
 * the split-brain the whole one-transport rule exists to prevent, so the
 * caller that knows says so.
 *
 * `canPromoteTransport` is the one-transport rule's other half: a DM or group
 * call is pinned to mesh for good (`resolveVoiceTransport`, reason `"dm"`),
 * and every caller here already knows whether its room is one — the join
 * path from `channel.kind`, `set-sharing-screen` and `set-camera` from the
 * seat's own `canPromoteTransport` (resolved once at join, since a channel's
 * kind never changes). Checked before the dedup map and before anything is
 * priced, so a conversation never starts a probe of the SFU or the cluster's
 * room list for a promotion that was always going to be refused.
 */
async function promoteRoomPastMeshCap(
  voiceChannelId: string,
  reason: VoicePromotionReason,
  userId: string,
  canPromoteTransport: boolean,
  currentTransport: VoiceRoomTransport = getRoomTransport(voiceChannelId),
): Promise<boolean> {
  if (currentTransport !== "mesh") {
    return true;
  }
  if (!canPromoteTransport) {
    logEvent("voice.transportPromotionRefused", {
      voiceChannelId,
      userId,
      reason,
      refusal: "conversation",
      loadMbps: 0,
      addedMbps: 0,
      budgetMbps: promotionBudgetMbps(),
      roomSize: getRoomPeers(voiceChannelId).length,
      sfuReachable: null,
    });
    return false;
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
  // Priced as it will be once the claim lands. The cluster's row for this room
  // is preferred over this instance's own seats, because a call legitimately
  // spans machines and the box carries all of it; the local view is the
  // floor, for the registry-off case and for a row that has not settled yet.
  //
  // What the room GAINS depends on which trigger fired, and the difference is
  // not cosmetic: a camera adds a publication, which the estimate multiplies
  // by every participant, while a ninth person adds one subscriber to the
  // publications already there. Charging a room-full promotion for a camera
  // nobody turned on would refuse the promotion of a big, silent call for
  // load it is not about to create.
  const known = rooms.find((room) => room.channelId === voiceChannelId);
  const candidate = withOneMore(
    {
      channelId: voiceChannelId,
      transport: "mesh",
      participants: Math.max(known?.participants ?? 0, seated.length, 1),
      cameraPublishers: Math.max(
        known?.cameraPublishers ?? 0,
        countPublishers(seated).cameras,
      ),
      screenPublishers: Math.max(
        known?.screenPublishers ?? 0,
        countPublishers(seated).screens,
      ),
    },
    reason,
  );
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
// Every handler checks `registryOn()` first, with one exception. A bus with
// the registry off carries `voice.hello` and nothing else about voice:
// without rows to read, a room frame would be a rumour, and the flag-off
// path stays exactly what it was. The exception is `voice.live`: the frame
// IS the stream (there is no row it points at), so it is gated on the bus
// alone, the same way the watch-party seat cache relays its invalidations.

export const VOICE_ROOM_TOPIC = "voice.room";
export const VOICE_IDENTITY_TOPIC = "voice.identity";
export const VOICE_WATCH_TOPIC = "voice.watch";
export const VOICE_MUSIC_TOPIC = "voice.music";
export const VOICE_CALL_TOPIC = "voice.call";
export const VOICE_MODERATION_TOPIC = "voice.moderation";
export const VOICE_REACTIONS_TOPIC = "voice.reactions";
export const VOICE_SERVER_MUTE_TOPIC = "voice.serverMute";
export const VOICE_RAISED_HAND_TOPIC = "voice.raisedHand";
export const VOICE_SIGNAL_TOPIC = "voice.signal";
export const VOICE_TRANSPORT_TOPIC = "voice.transport";
/**
 * A watch party's stream to the other machine: what `pushLiveHls` just told
 * this instance's audience, unstamped. The one voice topic that is NOT gated
 * on the registry (see the banner above): it carries its own truth.
 */
export const VOICE_LIVE_TOPIC = "voice.live";
/**
 * "Reconcile this channel's transcode, because I cannot." Published by an
 * instance that holds sockets in a room whose session lives on the other
 * machine; acted on only by the instance that actually owns the channel
 * (`liveHlsOwnsChannel`). Gated on the bus alone, like `voice.live`: it
 * points at no row and asserts nothing, so there is nothing for the registry
 * to make true.
 */
export const VOICE_HLS_RECONCILE_TOPIC = "voice.hlsReconcile";

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

const voiceLiveFrameSchema = z.object({
  channelId: z.string().uuid(),
  stream: liveHlsStreamSchema.nullable(),
  /** The `startedAt` of the session a `null` ends; null when `stream` is set. */
  endsStartedAt: z.number().int().nullable(),
  /** The publisher's clock when the frame was built; orders frames of one session. */
  at: z.number().int(),
});
type VoiceLiveFrame = z.infer<typeof voiceLiveFrameSchema>;

/** One channel id, and deliberately nothing else. See `relayHlsReconcile`. */
const voiceHlsReconcileFrameSchema = z.object({
  channelId: z.string().uuid(),
});
type VoiceHlsReconcileFrame = z.infer<typeof voiceHlsReconcileFrameSchema>;

/**
 * The `at` of the last `voice.live` frame this instance applied, per channel.
 * A frame older than that is a straggler and is dropped: without this, a
 * `null` and the start that preceded it arriving out of order would leave the
 * other machine's audience holding a stream that has ended, or worse, a stale
 * start after a stop. Kept after a stop on purpose (a late start must still
 * lose to it); one number per channel that ever went live, cleared with the
 * audience in tests.
 */
const relayedLiveAt = new Map<string, number>();

/**
 * `voice.music`: the room's queue changed, published by the instance that
 * accepted the write after `persistMusic` agreed. A hint about a row like
 * every other voice topic here — an instance that misses this frame still
 * reads the queue on its next join — and what the frame buys is that the
 * other half of the room hears the play, the pause or the skip NOW instead of
 * whenever somebody next walks in.
 */
const voiceMusicFrameSchema = z.object({
  channelId: z.string().uuid(),
  state: musicStateSchema.nullable(),
  /**
   * The room's clock as the accepting instance holds it. Without this the
   * other instance keeps its own anchor through a manager's seek, does not
   * know the frame was a manager's, and then clamps every honest sample on
   * its half of the room back by the size of the seek. Optional so a frame
   * from an instance that predates the field still applies.
   */
  anchorPositionMs: z.number().int().nonnegative().optional(),
  anchorAt: z.number().int().nonnegative().optional(),
});
type VoiceMusicFrame = z.infer<typeof voiceMusicFrameSchema>;

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
  reason: true,
  aloneMinutes: true,
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
  reason: z.enum(["cameras", "screens", "room-full", "room-size", "stale-pin"]),
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

/**
 * `voice.raisedHand`: one person's hand went up or came down, published by
 * the instance the frame landed on after it wrote `voice_raised_hands`.
 * `raisedAt` is the ROW's instant, not the publisher's clock, so the other
 * machine files the hand at the same place in the queue rather than at the
 * moment the frame happened to arrive. Null is a hand coming down.
 *
 * A hint about a row, like every other voice topic here: an instance that
 * misses this frame still reads the hand on its next roster and on the next
 * join. What the frame buys is that the queue moves now. A delayed raise
 * must not resurrect a hand the row has already deleted, so a non-null
 * hint is re-read before it is applied.
 */
const voiceRaisedHandFrameSchema = z.object({
  channelId: z.string().uuid(),
  userId: z.string().min(1),
  raisedAt: z.number().int().nonnegative().nullable(),
});
type VoiceRaisedHandFrame = z.infer<typeof voiceRaisedHandFrameSchema>;

async function applyClusterRaisedHandHint(
  channelId: string,
  userId: string,
  raisedAt: number | null,
): Promise<void> {
  let next = raisedAt;
  if (next !== null) {
    // Raise writes then publishes; a lower on another instance can delete
    // the row and publish null before that raise is delivered. The row is
    // the order: if it is gone, apply down, not the delayed timestamp.
    next = await getVoiceRaisedHandInRegistry(channelId, userId);
  }
  return applyRaisedHandLocally(channelId, userId, next);
}

subscribeToCluster(VOICE_RAISED_HAND_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceRaisedHandFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId, userId, raisedAt } = parsed.data;
  if (getRoomPeers(channelId).some((peer) => peer.userId === userId)) {
    noteClusterFrameReceived();
  }
  void applyClusterRaisedHandHint(channelId, userId, raisedAt).catch(
    (error: unknown) => {
      console.error("[voice] raised hand frame failed:", error);
    },
  );
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

subscribeToCluster(VOICE_MUSIC_TOPIC, (data) => {
  if (!registryOn()) {
    return;
  }
  const parsed = voiceMusicFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId, state, anchorPositionMs, anchorAt } = parsed.data;
  // Only rooms this instance has somebody in, for the same reason the watch
  // party's handler says so: the cache is per room and is torn down when the
  // local room empties, so adopting for a room nobody here is in would be an
  // entry nothing ever removes. The sidebar pill for a viewer on a machine
  // with nobody in the call is not covered by this and never was — it is
  // drawn from `musicChannels()`, which is this instance's rooms.
  if (getRoomPeers(channelId).length === 0) {
    return;
  }
  noteClusterFrameReceived();
  const before = channelMusicTrack(channelId)?.videoId ?? null;
  // The frame's clock with the frame's queue. `undefined` is an instance
  // older than the field saying nothing about the clock, which is not the
  // same as a row that has none: `adoptMusicWithAnchor` keeps them apart.
  const framed =
    anchorPositionMs !== undefined && anchorAt !== undefined
      ? { positionMs: anchorPositionMs, at: anchorAt }
      : undefined;
  if (!adoptMusicWithAnchor(channelId, state, framed)) {
    // Older than what is held (a straggler behind a frame that already
    // landed, or behind the row a joiner just read). The room has the newer
    // queue already; repeating the older one would roll it back.
    return;
  }
  musicCluster.adopted += 1;
  broadcastToRoom(channelId, { type: "music", channelId, state });
  if ((state?.current?.videoId ?? null) !== before) {
    void broadcastChannelMusic(channelId);
  }
});

subscribeToCluster(VOICE_HLS_RECONCILE_TOPIC, (data) => {
  const parsed = voiceHlsReconcileFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const { channelId } = parsed.data;
  // ONLY THE OWNER ACTS. Every instance with a socket in the room hears this;
  // the one holding the session is the only one whose `pushLiveHls` can
  // change anything, and the others running it would be the no-op that the
  // sender already established this frame exists to avoid. An intent for a
  // channel nobody here owns is dropped in silence and costs a map lookup.
  if (!liveHlsOwnsChannel(channelId)) {
    return;
  }
  hlsReconcileRelay.applied += 1;
  noteClusterFrameReceived();
  logEvent("voice.hlsReconcileFromBus", { channelId });
  void pushLiveHls(channelId).catch((error: unknown) => {
    // The bus's own try/catch is synchronous and cannot see a rejected
    // promise (pitfall 10: an unhandled rejection is how this server used to
    // die). `pushLiveHls` has its own catch around the reconcile; this is the
    // belt for anything outside it.
    console.error("[voice] relayed hls reconcile failed:", error);
  });
});

subscribeToCluster(VOICE_LIVE_TOPIC, (data) => {
  const parsed = voiceLiveFrameSchema.safeParse(data);
  if (!parsed.success) {
    return;
  }
  const frame = parsed.data;
  // THIS PROCESS RUNS THE EGRESS: its own `pushLiveHls` is the authority for
  // what its sockets are told, and a frame from the other machine about the
  // same channel (a second instance with peers in the room reconciling too)
  // must not overwrite it. BOTH DRIVERS, for the same reason `pushLiveHls`
  // now reads both: this guard used to ask the conventional ladder's map
  // alone, so it did not protect a machine whose session is low-latency.
  if (liveHlsStreamFor(frame.channelId) ?? llStreamFor(frame.channelId)) {
    return;
  }
  const lastAt = relayedLiveAt.get(frame.channelId) ?? 0;
  if (frame.at < lastAt) {
    return;
  }
  // THE LOCAL STOP FENCE. `liveHlsStreamFor` and `hlsAudience` are both empty
  // the moment this process ends a session, so neither guard below can catch
  // the frame that was already in flight for it.
  const endedHere = locallyEndedAt.get(frame.channelId);
  if (
    endedHere !== undefined &&
    frame.stream &&
    frame.stream.startedAt <= endedHere
  ) {
    return;
  }
  const held = hlsAudience.stream(frame.channelId);
  if (held) {
    // Lineage: a stream older than the one held, or a stop that names an
    // older session, is a straggler from before the current session and
    // would roll the audience back.
    if (frame.stream && frame.stream.startedAt < held.startedAt) {
      return;
    }
    if (
      !frame.stream &&
      frame.endsStartedAt !== null &&
      frame.endsStartedAt < held.startedAt
    ) {
      return;
    }
  }
  relayedLiveAt.set(frame.channelId, frame.at);
  // Recorded FIRST, so `getChannelLiveState`, the socket-auth catch-up, the
  // keyframe and the `watch-live` answer on this machine all agree with the
  // frames about to go out, and so the audience keyframe clock starts here
  // exactly as it does on the machine running the egress.
  hlsAudience.setStream(frame.channelId, frame.stream);
  // And the memo, so a stop cannot be undone by a row this process read
  // seconds earlier (`rememberChannelStream`).
  rememberChannelStream(
    frame.channelId,
    frame.stream,
    frame.endsStartedAt ?? held?.startedAt ?? null,
  );
  hlsAudienceFramesSent.fromBus += 1;
  // The room's own frame too, for the seats this instance holds in it: a
  // room spans machines (M2), and `pushLiveHls` only ever reached the
  // presenter's machine's peers with `voice-stream`.
  let sent = 0;
  for (const peer of getRoomPeers(frame.channelId)) {
    send(peer.socket, {
      type: "voice-stream",
      channelId: frame.channelId,
      stream: frame.stream ? stampViewerStream(frame.stream, peer.userId) : null,
    });
    sent += 1;
  }
  void broadcastChannelLive(frame.channelId, {
    stream: frame.stream,
    known: true,
  })
    .then((count) => {
      if (sent + count > 0) {
        noteClusterFrameReceived();
      }
    })
    // The bus's own try/catch is synchronous and cannot see a rejected
    // promise: without this an audience load that throws here would surface
    // as an unhandled rejection, which is how the server used to die
    // (pitfall 10). The stream is already recorded either way.
    .catch((error: unknown) => {
      console.error("[voice] relayed channel-live fan-out failed:", error);
    });
});

// --- end the cluster bus ------------------------------------------------------

/**
 * What a voice channel is set to, what a call in it would open on, and what
 * the call in it right now is actually using.
 *
 * Three different facts, and conflating the first two is the mistake this
 * exists to prevent: "Automático" is a *configuration*, not an answer, and the
 * answer it produces depends on the size of the server, whether the server has
 * a public address, and whether the deployment has a media server at all. The
 * live half is a fourth thing again. A room's path is pinned when the first
 * person joins and does not change while anybody is in it, so a call that
 * started before the setting was touched keeps the old path until it empties.
 *
 * Read by `GET /api/channels/:channelId/voice-transport`, once, when somebody
 * opens the channel's settings. Nothing on the hot path calls it.
 */
export async function describeChannelVoiceTransport(
  channel: ChannelRow,
): Promise<{
  configured: VoiceRoomTransport | null;
  resolved: VoiceTransportDecision;
  live: { transport: VoiceRoomTransport; participants: number } | null;
}> {
  const [resolved, room] = await Promise.all([
    decideRoomTransport(channel),
    readClusterRoom(channel.id),
  ]);
  return {
    configured: channel.voice_transport ?? null,
    resolved,
    live: room
      ? { transport: room.transport, participants: room.participants.length }
      : null,
  };
}
