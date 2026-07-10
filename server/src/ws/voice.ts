import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  isClientRelayMessage,
  voiceClientMessageSchema,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getChannel } from "../services/servers.js";
import { isChannelMember } from "../services/users.js";

interface VoicePeer {
  id: string;
  socket: WebSocket;
  userId: string;
  voiceChannelId: string;
}

const peers = new Map<string, VoicePeer>();
const socketToPeerId = new Map<WebSocket, string>();

function getRoomPeers(voiceChannelId: string): VoicePeer[] {
  return [...peers.values()].filter((p) => p.voiceChannelId === voiceChannelId);
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
}

export function removeVoicePeerBySocket(socket: WebSocket) {
  const peerId = socketToPeerId.get(socket);
  if (peerId) {
    removePeer(peerId);
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
      voiceChannelId: payload.voiceChannelId,
    };
    peers.set(peerId, peer);
    socketToPeerId.set(socket, peerId);

    const existingPeerIds = getRoomPeers(payload.voiceChannelId)
      .map((p) => p.id)
      .filter((id) => id !== peerId);

    send(socket, {
      type: "welcome",
      peerId,
      peers: existingPeerIds,
      voiceChannelId: payload.voiceChannelId,
    });

    broadcastToRoom(
      payload.voiceChannelId,
      { type: "peer-joined", peerId },
      peerId,
    );
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
