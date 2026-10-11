import type { RemotePeer } from "@/lib/peer-connection-manager";

/**
 * A MESH ROOM MOVING ONTO THE VOICE SERVER, ONE PEER AT A TIME.
 *
 * When the server promotes a live mesh room to the SFU
 * (`voice-transport-changed`), every seat used to drop its peer connections
 * first and build the LiveKit session second. For the whole of the token
 * request, the connect and the republish of the mic, the camera and any
 * running screen share, nobody heard anybody, and the people in the call read
 * that silence as the call breaking: in production about one promotion in five
 * was followed by somebody leaving and rejoining within 30 seconds.
 *
 * Now the mesh stays up while the SFU session comes up, and each peer's mesh
 * connection is retired the moment the SFU carries everything that peer was
 * sending over it. Until then the tile keeps playing the mesh media. The
 * peer connections need no signaling to keep flowing (the server stopped
 * relaying mesh frames when it rewrote the pin), so this is pure bookkeeping:
 * which of the two copies of a peer to play, and when the old one can go.
 *
 * NEVER BOTH. A peer whose SFU audio has arrived plays the SFU audio and only
 * that, so there is no moment where the same voice comes out twice with a
 * relay's worth of delay between the copies. Each media kind is taken from
 * the SFU when the SFU has it and from the mesh only while it does not.
 */
export interface MeshHandoffPlan {
  /** What the call should draw and play right now, one entry per peer. */
  peers: RemotePeer[];
  /** Mesh peer ids whose connection the SFU has fully replaced. */
  retire: string[];
}

const MEDIA_KEYS = [
  "stream",
  "screenStream",
  "cameraStream",
  "screenAudioStream",
] as const;

/**
 * Whether the SFU entry carries every kind of media the mesh entry does.
 *
 * A mesh entry carrying nothing at all (a listener with no mic, or a
 * connection still negotiating) is covered as soon as the peer is on the SFU:
 * its only remaining job was carrying OUR media to them, and they now get that
 * from the SFU.
 */
function covers(sfu: RemotePeer, mesh: RemotePeer): boolean {
  return MEDIA_KEYS.every((key) => !mesh[key] || Boolean(sfu[key]));
}

function merge(sfu: RemotePeer, mesh: RemotePeer): RemotePeer {
  const audioFromSfu = Boolean(sfu.stream) || !mesh.stream;
  return {
    ...sfu,
    stream: sfu.stream ?? mesh.stream,
    screenStream: sfu.screenStream ?? mesh.screenStream,
    cameraStream: sfu.cameraStream ?? mesh.cameraStream,
    screenAudioStream: sfu.screenAudioStream ?? mesh.screenAudioStream,
    // The state and the bars describe whichever path the voice is on.
    connectionState: audioFromSfu ? sfu.connectionState : mesh.connectionState,
    quality: audioFromSfu ? sfu.quality : mesh.quality,
    userId: sfu.userId ?? mesh.userId,
    displayName: sfu.displayName ?? mesh.displayName,
    avatarUrl: sfu.avatarUrl ?? mesh.avatarUrl ?? null,
  };
}

/**
 * Fold the retiring mesh's peers into the SFU's, and say which mesh
 * connections are no longer needed.
 *
 * Order follows the mesh first (the tiles people are already looking at stay
 * where they are), then anybody only the SFU knows, in the SFU's order. With
 * no mesh left the SFU's own array comes back untouched, so the steady state
 * is exactly what it was before this existed.
 */
export function planMeshHandoff(
  sfuPeers: readonly RemotePeer[],
  meshPeers: readonly RemotePeer[],
): MeshHandoffPlan {
  if (meshPeers.length === 0) {
    return { peers: sfuPeers as RemotePeer[], retire: [] };
  }
  const sfuById = new Map(sfuPeers.map((peer) => [peer.peerId, peer]));
  const peers: RemotePeer[] = [];
  const retire: string[] = [];
  const seen = new Set<string>();
  for (const mesh of meshPeers) {
    seen.add(mesh.peerId);
    const sfu = sfuById.get(mesh.peerId);
    if (!sfu) {
      peers.push(mesh);
      continue;
    }
    if (covers(sfu, mesh)) {
      retire.push(mesh.peerId);
      peers.push(sfu);
      continue;
    }
    peers.push(merge(sfu, mesh));
  }
  for (const sfu of sfuPeers) {
    if (!seen.has(sfu.peerId)) {
      peers.push(sfu);
    }
  }
  return { peers, retire };
}
