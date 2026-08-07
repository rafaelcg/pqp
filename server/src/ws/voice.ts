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
import { isDmSendBlocked } from "../services/dms.js";
import { findTimeoutForChannel } from "../services/sanctions.js";
import { getChannel, getChannelAudience } from "../services/servers.js";
import { canAccessChannel } from "../services/users.js";
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

export function resetVoiceRateLimits(): void {
  roomLimiter.reset();
}

function getRoomPeers(voiceChannelId: string): VoicePeer[] {
  return [...peers.values()].filter((p) => p.voiceChannelId === voiceChannelId);
}

function toParticipant(peer: VoicePeer): VoiceParticipant {
  return {
    peerId: peer.id,
    userId: peer.userId,
    displayName: peer.displayName,
    avatarUrl: peer.avatarUrl,
    sharingScreen: peer.sharingScreen,
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
    };
    peers.set(peerId, peer);
    socketToPeerId.set(socket, peerId);
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
