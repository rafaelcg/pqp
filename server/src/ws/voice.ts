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
import { getChannel } from "../services/servers.js";
import { isChannelMember, isServerMember, listServerMemberIds } from "../services/users.js";
import { forEachAuthenticatedSocket } from "./sockets.js";

interface VoicePeer {
  id: string;
  socket: WebSocket;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  voiceChannelId: string;
  serverId: string;
}

const peers = new Map<string, VoicePeer>();
const socketToPeerId = new Map<WebSocket, string>();

function getRoomPeers(voiceChannelId: string): VoicePeer[] {
  return [...peers.values()].filter((p) => p.voiceChannelId === voiceChannelId);
}

function toParticipant(peer: VoicePeer): VoiceParticipant {
  return {
    peerId: peer.id,
    userId: peer.userId,
    displayName: peer.displayName,
    avatarUrl: peer.avatarUrl,
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
  for (const peer of getRoomPeers(voiceChannelId)) {
    if (peer.id !== excludePeerId) {
      send(peer.socket, message);
    }
  }
}

// Roster/occupancy is only for members of the server that owns the voice
// channel — not every authenticated socket on the instance (which would leak
// cross-server presence and, worse, hand out the peer IDs used for signaling).
async function broadcastRoster(voiceChannelId: string, serverId: string) {
  const message: VoiceSignalingMessage = {
    type: "voice-roster",
    voiceChannelId,
    participants: getRoomPeers(voiceChannelId).map(toParticipant),
  };
  let memberIds: Set<string>;
  try {
    memberIds = new Set(await listServerMemberIds(serverId));
  } catch (error) {
    console.error("[voice] failed to load members for roster:", error);
    return;
  }
  forEachAuthenticatedSocket((socket, user) => {
    if (memberIds.has(user.id)) {
      send(socket, message);
    }
  });
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
  const { voiceChannelId, serverId } = peer;
  peers.delete(peerId);
  socketToPeerId.delete(peer.socket);
  broadcastToRoom(voiceChannelId, { type: "peer-left", peerId });
  void broadcastRoster(voiceChannelId, serverId);
}

export function removeVoicePeerBySocket(socket: WebSocket) {
  const peerId = socketToPeerId.get(socket);
  if (peerId) {
    removePeer(peerId);
  }
}

/**
 * Send current voice occupancy to a newly authenticated socket — but only for
 * servers the connecting user actually belongs to.
 */
export async function sendAllVoiceRosters(socket: WebSocket, user: DbUser) {
  const byChannel = new Map<
    string,
    { serverId: string; participants: VoiceParticipant[] }
  >();
  for (const peer of peers.values()) {
    const entry = byChannel.get(peer.voiceChannelId) ?? {
      serverId: peer.serverId,
      participants: [],
    };
    entry.participants.push(toParticipant(peer));
    byChannel.set(peer.voiceChannelId, entry);
  }
  for (const [voiceChannelId, { serverId, participants }] of byChannel) {
    try {
      if (!(await isServerMember(serverId, user.id))) {
        continue;
      }
    } catch (error) {
      console.error("[voice] roster membership check failed:", error);
      continue;
    }
    send(socket, {
      type: "voice-roster",
      voiceChannelId,
      participants,
    });
  }
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
    if (!(await isChannelMember(payload.voiceChannelId, user.id))) {
      return;
    }

    const channel = await getChannel(payload.voiceChannelId);
    if (!channel || channel.type !== "voice") {
      return;
    }

    // Enforce the mesh ceiling server-side. Above it, each client would carry
    // one Opus uplink per peer and quality collapses — reject instead.
    const roomIsFull =
      getRoomPeers(payload.voiceChannelId).filter(
        (p) => p.socket !== socket,
      ).length >= MESH_VOICE_LIMIT;
    if (roomIsFull) {
      send(socket, {
        type: "voice-room-full",
        voiceChannelId: payload.voiceChannelId,
        limit: MESH_VOICE_LIMIT,
      });
      return;
    }

    if (existingPeerId) {
      removePeer(existingPeerId);
    }

    const peerId = randomUUID();
    const peer: VoicePeer = {
      id: peerId,
      socket,
      userId: user.id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      voiceChannelId: payload.voiceChannelId,
      serverId: channel.server_id,
    };
    peers.set(peerId, peer);
    socketToPeerId.set(socket, peerId);

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
    void broadcastRoster(payload.voiceChannelId, channel.server_id);
    return;
  }

  if (payload.type === "leave-voice-room") {
    if (existingPeerId) {
      removePeer(existingPeerId);
    }
    return;
  }

  if (!existingPeerId) {
    return;
  }

  if (!isClientRelayMessage(payload)) {
    return;
  }

  const fromPeer = peers.get(payload.from);
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
