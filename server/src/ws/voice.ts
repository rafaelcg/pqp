import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  isClientRelayMessage,
  MESH_VOICE_LIMIT,
  voiceClientMessageSchema,
  type VoiceParticipant,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { logEvent } from "../lib/log.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { isDmSendBlocked } from "../services/dms.js";
import { getChannel, getChannelAudience } from "../services/servers.js";
import { canAccessChannel } from "../services/users.js";
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

const peers = new Map<string, VoicePeer>();
const socketToPeerId = new Map<WebSocket, string>();

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
        } satisfies VoiceSignalingMessage);

        const allowed = new Set(audience.userIds);
        forEachAuthenticatedSocket((socket, user) => {
          if (socket.readyState === 1 && allowed.has(user.id)) {
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
  logEvent("voice.leave", {
    peerId,
    userId: peer.userId,
    voiceChannelId,
    roomSize: getRoomPeers(voiceChannelId).length,
  });
  broadcastToRoom(voiceChannelId, { type: "peer-left", peerId });
  void broadcastRoster(voiceChannelId);
}

/** Drop every peer of a channel — used when a channel is deleted or made private. */
export function evictVoiceChannel(voiceChannelId: string) {
  for (const peer of getRoomPeers(voiceChannelId)) {
    removePeer(peer.id);
  }
}

/** Drop everyone from a channel's voice room except the given users. */
export function evictVoiceUsersExcept(
  voiceChannelId: string,
  allowedUserIds: Set<string>,
) {
  for (const peer of getRoomPeers(voiceChannelId)) {
    if (!allowedUserIds.has(peer.userId)) {
      removePeer(peer.id);
    }
  }
}

/** Drop a specific user from a channel's voice room (kick / access revoked). */
export function evictVoiceUser(userId: string, serverChannelIds?: Set<string>) {
  for (const peer of [...peers.values()]) {
    if (peer.userId !== userId) {
      continue;
    }
    if (serverChannelIds && !serverChannelIds.has(peer.voiceChannelId)) {
      continue;
    }
    removePeer(peer.id);
  }
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

    // Enforce the mesh ceiling server-side. Above it, each client would carry
    // one Opus uplink per peer and quality collapses — reject instead. The
    // ceiling is a property of the mesh, so it does not apply once media is
    // routed through an SFU.
    const usingMesh =
      getServerVoiceBackend() !== "livekit" || !isLiveKitConfigured();
    const roomIsFull =
      usingMesh &&
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

  relayToTarget(payload);
}
