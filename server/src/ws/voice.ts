import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  isClientRelayMessage,
  voiceClientMessageSchema,
  type VoiceParticipant,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getChannel } from "../services/servers.js";
import { isChannelMember } from "../services/users.js";
import { forEachAuthenticatedSocket } from "./sockets.js";

interface VoicePeer {
  id: string;
  socket: WebSocket;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  voiceChannelId: string;
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

function broadcastRoster(voiceChannelId: string) {
  const message: VoiceSignalingMessage = {
    type: "voice-roster",
    voiceChannelId,
    participants: getRoomPeers(voiceChannelId).map(toParticipant),
  };
  forEachAuthenticatedSocket((socket) => {
    send(socket, message);
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
  const { voiceChannelId } = peer;
  peers.delete(peerId);
  socketToPeerId.delete(peer.socket);
  broadcastToRoom(voiceChannelId, { type: "peer-left", peerId });
  broadcastRoster(voiceChannelId);
}

export function removeVoicePeerBySocket(socket: WebSocket) {
  const peerId = socketToPeerId.get(socket);
  if (peerId) {
    removePeer(peerId);
  }
}

/** Send current voice occupancy for every active room (e.g. after auth). */
export function sendAllVoiceRosters(socket: WebSocket) {
  const byChannel = new Map<string, VoiceParticipant[]>();
  for (const peer of peers.values()) {
    const list = byChannel.get(peer.voiceChannelId) ?? [];
    list.push(toParticipant(peer));
    byChannel.set(peer.voiceChannelId, list);
  }
  for (const [voiceChannelId, participants] of byChannel) {
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
    broadcastRoster(payload.voiceChannelId);
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

  if (!peers.has(payload.from) || payload.from !== existingPeerId) {
    return;
  }

  if (!peers.has(payload.to)) {
    return;
  }

  relayToTarget(payload);
}
