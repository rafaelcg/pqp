import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  isClientRelayMessage,
  MESH_VOICE_LIMIT,
  voiceClientMessageSchema,
  type VoiceParticipant,
  type VoiceRoomTransport,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
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
import { getChannel, getChannelAudience } from "../services/servers.js";
import { canAccessChannel } from "../services/users.js";
import { broadcastToChannel } from "./chat.js";
import { resolveStatus } from "./status.js";
import {
  evictSfuRoom,
  evictSfuUser,
  evictSfuUsersExcept,
} from "../voice/admin.js";
import {
  getServerVoiceBackend,
  isLiveKitConfigured,
} from "../voice/backends.js";
import { forEachAuthenticatedSocket } from "./sockets.js";

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
  // --- voice state ---
  // Self-reported over `set-voice-state`, carried on every roster so the
  // channel list can badge occupants for people outside the call. Display
  // state only: enforcement of anything never hangs off these flags.
  muted: boolean;
  deafened: boolean;
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
 */
const peers = new Map<string, VoicePeer>();
const socketToPeerId = new Map<WebSocket, string>();

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
 * - It is taken from config when the room's **first** peer joins and pinned
 *   here for as long as the room has anyone in it. A live call therefore never
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

function configuredTransport(): VoiceRoomTransport {
  return getServerVoiceBackend() === "livekit" && isLiveKitConfigured()
    ? "livekit"
    : "mesh";
}

/** The transport a room is running on, or would get if it were opened now. */
export function getRoomTransport(voiceChannelId: string): VoiceRoomTransport {
  return roomTransports.get(voiceChannelId) ?? configuredTransport();
}

/** Test hook: forget every pinned room transport. */
export function resetVoiceRoomTransports(): void {
  roomTransports.clear();
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
}

function getRoomPeers(voiceChannelId: string): VoicePeer[] {
  return [...peers.values()].filter((p) => p.voiceChannelId === voiceChannelId);
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
  /** The transport a room opened now would get. */
  backend: VoiceRoomTransport;
}

export function getVoiceActivitySnapshot(): VoiceActivitySnapshot {
  rollPeakDay();
  const sizes = new Map<string, number>();
  for (const peer of peers.values()) {
    sizes.set(peer.voiceChannelId, (sizes.get(peer.voiceChannelId) ?? 0) + 1);
  }
  let largestRoomNow = 0;
  for (const size of sizes.values()) {
    if (size > largestRoomNow) {
      largestRoomNow = size;
    }
  }
  return {
    activeRooms: sizes.size,
    participants: peers.size,
    largestRoomNow,
    peakRoomSizeToday: Math.max(peakRoomSizeToday, largestRoomNow),
    peakTrackedSince,
    backend: configuredTransport(),
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
    muted: peer.muted,
    deafened: peer.deafened,
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
  const encoded = JSON.stringify(message);
  for (const peer of getRoomPeers(voiceChannelId)) {
    if (peer.id !== excludePeerId && peer.socket.readyState === 1) {
      peer.socket.send(encoded);
    }
  }
}

/**
 * Roster fan-out. Occupancy drives the channel-list badges, so it goes to
 * everyone who can *see* the channel — sending it to every socket on the
 * instance would leak cross-server presence and, worse, hand out the peer IDs
 * used for signaling.
 *
 * Serialized per channel: the audience lookup is async, and two overlapping
 * broadcasts could otherwise deliver an older snapshot last, leaving a departed
 * peer visible in everyone's sidebar.
 */
const rosterQueue = new Map<string, Promise<void>>();

function broadcastRoster(voiceChannelId: string): Promise<void> {
  const previous = rosterQueue.get(voiceChannelId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      try {
        const audience = await getChannelAudience(voiceChannelId);
        if (!audience) {
          return;
        }

        // Read the room *after* the await so the payload reflects state at send
        // time, not at the time the broadcast was requested.
        const encoded = JSON.stringify({
          type: "voice-roster",
          voiceChannelId,
          participants: getRoomPeers(voiceChannelId).map(toParticipant),
          transport: getRoomTransport(voiceChannelId),
        } satisfies VoiceSignalingMessage);

        forEachAuthenticatedSocket((socket, user) => {
          if (socket.readyState === 1 && audience.has(user.id)) {
            socket.send(encoded);
          }
        });
      } catch (error) {
        console.error("[voice] failed to load audience for roster:", error);
      }
    })
    .finally(() => {
      if (rosterQueue.get(voiceChannelId) === next) {
        rosterQueue.delete(voiceChannelId);
      }
    });

  rosterQueue.set(voiceChannelId, next);
  return next;
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
  const { voiceChannelId } = peer;
  peers.delete(peerId);
  if (socketToPeerId.get(peer.socket) === peerId) {
    socketToPeerId.delete(peer.socket);
  }
  // Empty room: forget the pin, so the next call in this channel picks up the
  // current config instead of a decision taken before LiveKit was added,
  // removed or fixed. Nobody is mid-call, so nobody's audio moves.
  if (getRoomPeers(voiceChannelId).length === 0) {
    roomTransports.delete(voiceChannelId);
    // A ring with nobody left in the room is a call that ended unanswered —
    // after a grace period, because this same path runs mid-rejoin.
    // See `// --- conversation calls ---` below.
    noteVoiceRoomEmptied(voiceChannelId);
  }
  logEvent("voice.leave", {
    peerId,
    userId: peer.userId,
    voiceChannelId,
    roomSize: getRoomPeers(voiceChannelId).length,
  });
  broadcastToRoom(voiceChannelId, { type: "peer-left", peerId });
  void broadcastRoster(voiceChannelId);
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
  for (const peer of getRoomPeers(voiceChannelId)) {
    removePeer(peer.id);
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
  void evictSfuUser(
    userId,
    serverChannelIds ? [...serverChannelIds] : null,
    knownIdentities,
  );
}

/** LiveKit identity (peer id) → user id, for peers this instance can see. */
function identityMapFor(roster: VoicePeer[]): Map<string, string> {
  return new Map(roster.map((peer) => [peer.id, peer.userId]));
}

/**
 * Look up a live voice peer. Used by the SFU token endpoint to prove the
 * requested peer id really belongs to the requesting user and channel.
 */
export function getVoicePeer(
  peerId: string,
): { userId: string; voiceChannelId: string; displayName: string } | null {
  const peer = peers.get(peerId);
  if (!peer) {
    return null;
  }
  return {
    userId: peer.userId,
    voiceChannelId: peer.voiceChannelId,
    displayName: peer.displayName,
  };
}

export function removeVoicePeerBySocket(socket: WebSocket) {
  const peerId = socketToPeerId.get(socket);
  if (peerId) {
    removePeer(peerId);
  }
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
  const byChannel = new Map<string, VoiceParticipant[]>();
  for (const peer of peers.values()) {
    const list = byChannel.get(peer.voiceChannelId) ?? [];
    list.push(toParticipant(peer));
    byChannel.set(peer.voiceChannelId, list);
  }

  await Promise.all(
    [...byChannel].map(async ([voiceChannelId, participants]) => {
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
        participants,
        transport: getRoomTransport(voiceChannelId),
      });
    }),
  );
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
      return;
    }
    if (!(await canAccessChannel(payload.voiceChannelId, user.id))) {
      return;
    }
    // Ringing somebody is the loudest thing one account can do to another, so a
    // block closes a 1:1's call the same way it closes its messages. Without
    // this, a blocked person keeps a working phone line to the person who
    // blocked them.
    if (await isDmSendBlocked(payload.voiceChannelId, user.id)) {
      return;
    }
    // THE VOICE CHOKEPOINT for timeouts. `join-voice-room` is the only way into
    // a room, so refusing it here is the whole enforcement — plus the eviction
    // the issuing route performs for anybody already inside one.
    //
    // WHY REFUSING THE JOIN AND NOT A SERVER-SIDE MUTE. A mute is the more
    // surgical sanction and it is the one this product cannot actually deliver:
    // in mesh mode the audio never touches the server at all, so "muted" would
    // mean asking the sanctioned client to please stop sending — which is a
    // suggestion, not enforcement, and would be defeated by any modified
    // client. Refusing the room is enforceable in both mesh and SFU mode, and a
    // sanction that only works when the sanctioned party cooperates is worse
    // than an honest blunter one. The same join reaches a conversation's call,
    // and `findTimeoutForChannel` returns nothing for those — a server's
    // moderators do not get to hang up their members' DM calls.
    if (await findTimeoutForChannel(user.id, payload.voiceChannelId)) {
      return;
    }

    // `type` says which kind of *server* channel this is, and a conversation is
    // neither: it has one room that is text and voice at once, the way a DM
    // call works everywhere else. Gating on `type` alone rejected every
    // conversation, since they are all stored as text.
    const channel = await getChannel(payload.voiceChannelId);
    if (!channel) {
      return;
    }
    if (channel.kind === "server" && channel.type !== "voice") {
      return;
    }

    // The awaits above mean the socket may have closed, or the client may have
    // sent a second join, while this one was in flight. Registering a peer for a
    // dead socket leaves a ghost in the roster that nothing ever removes.
    if (socket.readyState !== 1) {
      return;
    }

    // Read before any peer is removed or added: for a rejoin by the room's only
    // occupant, removing them first would empty the room and drop the pin, and
    // the join would silently re-decide the transport.
    const transport = getRoomTransport(payload.voiceChannelId);

    // A client that cannot run this room's transport is refused *here*, before
    // a peer exists. Admitting it and letting it discover the mismatch a round
    // trip later would put a participant in everyone's roster who cannot be
    // heard — the exact failure this is here to make impossible.
    const capabilities: VoiceRoomTransport[] = payload.transports ?? [
      "mesh",
      "livekit",
    ];
    if (!capabilities.includes(transport)) {
      // Drop any peer this socket still holds: it is not going to be in the
      // room, so leaving the previous one behind would leave a ghost.
      const stale = socketToPeerId.get(socket);
      if (stale) {
        removePeer(stale);
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

    // Enforce the mesh ceiling server-side. Above it, each client would carry
    // one Opus uplink per peer and quality collapses — reject instead. The
    // ceiling is a property of the mesh, so it does not apply once media is
    // routed through an SFU.
    const roomIsFull =
      transport === "mesh" &&
      getRoomPeers(payload.voiceChannelId).filter((p) => p.socket !== socket)
        .length >= MESH_VOICE_LIMIT;
    if (roomIsFull) {
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
      return;
    }

    const currentPeerId = socketToPeerId.get(socket);
    if (currentPeerId) {
      removePeer(currentPeerId);
    }

    const peerId = randomUUID();
    const peer: VoicePeer = {
      id: peerId,
      socket,
      userId: user.id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      voiceChannelId: payload.voiceChannelId,
      sharingScreen: false,
      cameraStreamId: null,
      // Not muted until the client says so: the client re-declares its state
      // right after `welcome` (including after a rejoin, where this reset
      // would otherwise erase a standing mute). See use of `set-voice-state`.
      muted: false,
      deafened: false,
    };
    peers.set(peerId, peer);
    socketToPeerId.set(socket, peerId);
    noteRoomSizeForPeak(getRoomPeers(payload.voiceChannelId).length);
    // Pinned only now that the room is non-empty, so `removePeer`'s cleanup
    // above cannot race this write away.
    roomTransports.set(payload.voiceChannelId, transport);
    logEvent("voice.join", {
      peerId,
      userId: user.id,
      voiceChannelId: payload.voiceChannelId,
      roomSize: getRoomPeers(payload.voiceChannelId).length,
    });

    const self = toParticipant(peer);
    const existingPeers = getRoomPeers(payload.voiceChannelId)
      .filter((p) => p.id !== peerId)
      .map(toParticipant);

    send(socket, {
      type: "welcome",
      peerId,
      peers: existingPeers,
      voiceChannelId: payload.voiceChannelId,
      self,
      transport,
    });

    broadcastToRoom(
      payload.voiceChannelId,
      { type: "peer-joined", peer: self },
      peerId,
    );
    // A join into a conversation that is ringing this user IS the answer —
    // see `// --- conversation calls ---` below.
    noteConversationCallJoin(payload.voiceChannelId, user.id);
    await broadcastRoster(payload.voiceChannelId);
    return;
  }

  if (payload.type === "leave-voice-room") {
    if (existingPeerId) {
      removePeer(existingPeerId);
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
    // Mesh mode would otherwise multiply every peer's video-encode cost by the
    // number of concurrent sharers; capping to one keeps the limit uniform
    // across mesh and SFU rather than only enforcing it for mesh.
    if (payload.sharing) {
      const alreadySharing = getRoomPeers(peer.voiceChannelId).some(
        (p) => p.id !== peer.id && p.sharingScreen,
      );
      if (alreadySharing) {
        send(peer.socket, {
          type: "screen-share-denied",
          voiceChannelId: peer.voiceChannelId,
        });
        return;
      }
    }
    peer.sharingScreen = payload.sharing;
    await broadcastRoster(peer.voiceChannelId);
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
    // No change, no fan-out: the client re-declares its state after every
    // (re)join, and most of those declarations are the defaults the peer
    // already has.
    if (peer.muted === payload.muted && peer.deafened === payload.deafened) {
      return;
    }
    if (!stateLimiter.take(user.id)) {
      return;
    }
    peer.muted = payload.muted;
    peer.deafened = payload.deafened;
    await broadcastRoster(peer.voiceChannelId);
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
    peer.cameraStreamId = payload.streamId;
    await broadcastRoster(peer.voiceChannelId);
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

  const toPeer = peers.get(payload.to);
  if (!toPeer) {
    return;
  }

  // Only relay signaling between peers in the same voice room. Without this a
  // member of one room could open a WebRTC connection to a peer in another
  // room/server and pull their microphone audio.
  if (fromPeer.voiceChannelId !== toPeer.voiceChannelId) {
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

function sendToUserSockets(userIds: ReadonlySet<string>, frame: VoiceSignalingMessage) {
  if (userIds.size === 0) {
    return;
  }
  const encoded = JSON.stringify(frame);
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState === 1 && userIds.has(user.id)) {
      socket.send(encoded);
    }
  });
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

  sendToUserSockets(rung, {
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
  // ring never waits on, or dies with, a push vendor. Voice is per-instance
  // (see the module banner), so this cannot double-send across replicas.
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
  const ring = conversationRings.get(conversationId);
  if (!ring) {
    return;
  }
  if (ring.emptyRoomTimer) {
    clearTimeout(ring.emptyRoomTimer);
    ring.emptyRoomTimer = null;
  }
  if (!ring.pending.delete(userId)) {
    return;
  }
  ring.rung.delete(userId);
  ring.anyoneAnswered = true;
  // Their other devices stop ringing; everyone still pending keeps ringing.
  sendToUserSockets(new Set([userId]), {
    type: "call-ring-cancelled",
    conversationId,
    reason: "answered",
  });
  if (ring.pending.size === 0) {
    clearRing(ring);
  }
}

function handleCallDecline(user: DbUser, conversationId: string) {
  const ring = conversationRings.get(conversationId);
  if (!ring || !ring.pending.delete(user.id)) {
    return;
  }
  ring.rung.delete(user.id);
  // Other devices of the decliner stop ringing…
  sendToUserSockets(new Set([user.id]), {
    type: "call-ring-cancelled",
    conversationId,
    reason: "declined",
  });
  // …and the people in the call stop waiting for them.
  broadcastToRoom(conversationId, {
    type: "call-declined",
    conversationId,
    userId: user.id,
  });
  logEvent("voice.callDeclined", { conversationId, userId: user.id });
  if (ring.pending.size === 0) {
    if (ring.anyoneAnswered) {
      clearRing(ring);
    } else {
      // Everyone said no: the ring is over and the record is a missed call.
      void endConversationRing(conversationId, "cancelled");
    }
  }
}

/** The room emptied. After the grace period, an unanswered ring dies with it. */
function noteVoiceRoomEmptied(voiceChannelId: string) {
  const ring = conversationRings.get(voiceChannelId);
  if (!ring || ring.emptyRoomTimer) {
    return;
  }
  ring.emptyRoomTimer = setTimeout(() => {
    ring.emptyRoomTimer = null;
    if (getRoomPeers(voiceChannelId).length === 0) {
      void endConversationRing(voiceChannelId, "cancelled");
    }
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
  sendToUserSockets(ring.rung, {
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
// Scope caveat, same as the roster: `peers` is per-instance, so these helpers
// can only see (and notify) targets whose WebSocket lands on this instance.
// That matches the visibility the moderator acted on — the member panel's
// voice badges come from the same map — and mesh voice already pins the
// deployment to one instance (see the note above `peers`).

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

/**
 * Deliver a `voice-moderation` frame to every socket this user holds in the
 * room. Used on its own for the SFU mute (where the peer stays), and by
 * `disconnectVoiceUser` before the peer is dropped.
 */
export function notifyVoiceModeration(
  userId: string,
  voiceChannelId: string,
  notice: {
    action: "disconnected" | "moved" | "muted" | "unmuted";
    movedToChannelId?: string;
    message: string;
  },
): void {
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
  }
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
): void {
  const knownIdentities = getVoicePeerIdentities(userId, voiceChannelId);

  notifyVoiceModeration(userId, voiceChannelId, {
    action: notice.movedToChannelId ? "moved" : "disconnected",
    movedToChannelId: notice.movedToChannelId,
    message: notice.message,
  });
  for (const peer of getRoomPeers(voiceChannelId)) {
    if (peer.userId === userId) {
      removePeer(peer.id);
    }
  }
  void evictSfuUser(userId, [voiceChannelId], knownIdentities);
}

// --- end voice moderation -----------------------------------------------------
