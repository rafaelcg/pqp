import type { ClientRelayMessage } from "@pqp/shared";

export type PeerConnectionState = "connecting" | "connected" | "failed";

export interface RemotePeer {
  peerId: string;
  connectionState: PeerConnectionState;
  stream: MediaStream | null;
}

export type SignalingSend = (message: ClientRelayMessage) => void;

export type PeerStateChangeHandler = (peers: RemotePeer[]) => void;

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as
    | string
    | undefined;

  if (turnUrl && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
}

function mapIceState(state: RTCIceConnectionState): PeerConnectionState {
  if (state === "connected" || state === "completed") {
    return "connected";
  }
  if (state === "failed" || state === "disconnected" || state === "closed") {
    return "failed";
  }
  return "connecting";
}

function isImpolite(localPeerId: string, remotePeerId: string): boolean {
  return localPeerId > remotePeerId;
}

interface ManagedPeer {
  peerId: string;
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  connectionState: PeerConnectionState;
  stream: MediaStream | null;
  pendingCandidates: RTCIceCandidateInit[];
}

export interface PeerConnectionManager {
  setLocalStream(stream: MediaStream): void;
  replaceLocalTrack(stream: MediaStream): Promise<void>;
  connectToPeer(remotePeerId: string): void;
  handleOffer(from: string, sdp: string): Promise<void>;
  handleAnswer(from: string, sdp: string): Promise<void>;
  handleIceCandidate(from: string, candidate: RTCIceCandidateInit | null): Promise<void>;
  removePeer(remotePeerId: string): void;
  dispose(): void;
  onPeerStateChange(handler: PeerStateChangeHandler): void;
}

export function createPeerConnectionManager(
  localPeerId: string,
  send: SignalingSend,
): PeerConnectionManager {
  const peers = new Map<string, ManagedPeer>();
  let localStream: MediaStream | null = null;
  let stateHandler: PeerStateChangeHandler | null = null;

  function emitState() {
    const remotePeers: RemotePeer[] = [...peers.values()].map((peer) => ({
      peerId: peer.peerId,
      connectionState: peer.connectionState,
      stream: peer.stream,
    }));
    stateHandler?.(remotePeers);
  }

  function createPeerConnection(remotePeerId: string): ManagedPeer {
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });

    const managed: ManagedPeer = {
      peerId: remotePeerId,
      pc,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      connectionState: "connecting",
      stream: null,
      pendingCandidates: [],
    };

    pc.onicecandidate = (event) => {
      send({
        type: "ice-candidate",
        from: localPeerId,
        to: remotePeerId,
        candidate: event.candidate
          ? event.candidate.toJSON()
          : null,
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        managed.stream = stream;
        emitState();
      }
    };

    pc.oniceconnectionstatechange = () => {
      managed.connectionState = mapIceState(pc.iceConnectionState);
      emitState();
    };

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    return managed;
  }

  async function negotiateAsImpolite(peer: ManagedPeer) {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      send({
        type: "offer",
        from: localPeerId,
        to: peer.peerId,
        sdp: peer.pc.localDescription!.sdp,
      });
    } finally {
      peer.makingOffer = false;
    }
  }

  async function applyRemoteDescription(
    peer: ManagedPeer,
    description: RTCSessionDescriptionInit,
  ) {
    const offerCollision =
      description.type === "offer" &&
      (peer.makingOffer || peer.pc.signalingState !== "stable");

    peer.ignoreOffer =
      !isImpolite(localPeerId, peer.peerId) && offerCollision;

    if (peer.ignoreOffer) {
      return;
    }

    if (offerCollision) {
      await peer.pc.setLocalDescription({ type: "rollback" });
    }

    await peer.pc.setRemoteDescription(description);

    if (description.type === "offer") {
      peer.isSettingRemoteAnswerPending = true;
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      peer.isSettingRemoteAnswerPending = false;
      send({
        type: "answer",
        from: localPeerId,
        to: peer.peerId,
        sdp: peer.pc.localDescription!.sdp,
      });
    }

    for (const candidate of peer.pendingCandidates) {
      await peer.pc.addIceCandidate(candidate);
    }
    peer.pendingCandidates = [];
  }

  async function addCandidate(
    peer: ManagedPeer,
    candidate: RTCIceCandidateInit | null,
  ) {
    if (!candidate) {
      return;
    }

    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }

    await peer.pc.addIceCandidate(candidate);
  }

  return {
    setLocalStream(stream: MediaStream) {
      localStream = stream;
    },

    async replaceLocalTrack(stream: MediaStream) {
      localStream = stream;
      const nextTrack = stream.getAudioTracks()[0] ?? null;
      for (const peer of peers.values()) {
        const sender = peer.pc
          .getSenders()
          .find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(nextTrack);
        } else if (nextTrack) {
          peer.pc.addTrack(nextTrack, stream);
        }
      }
    },

    connectToPeer(remotePeerId: string) {
      if (peers.has(remotePeerId)) {
        return;
      }

      const managed = createPeerConnection(remotePeerId);
      peers.set(remotePeerId, managed);
      emitState();

      if (isImpolite(localPeerId, remotePeerId)) {
        void negotiateAsImpolite(managed);
      }
    },

    async handleOffer(from: string, sdp: string) {
      let peer = peers.get(from);
      if (!peer) {
        peer = createPeerConnection(from);
        peers.set(from, peer);
        emitState();
      }

      await applyRemoteDescription(peer, { type: "offer", sdp });
    },

    async handleAnswer(from: string, sdp: string) {
      const peer = peers.get(from);
      if (!peer) {
        return;
      }

      if (peer.isSettingRemoteAnswerPending) {
        return;
      }

      await applyRemoteDescription(peer, { type: "answer", sdp });
    },

    async handleIceCandidate(
      from: string,
      candidate: RTCIceCandidateInit | null,
    ) {
      const peer = peers.get(from);
      if (!peer) {
        return;
      }

      await addCandidate(peer, candidate);
    },

    removePeer(remotePeerId: string) {
      const peer = peers.get(remotePeerId);
      if (!peer) {
        return;
      }

      peer.pc.close();
      peers.delete(remotePeerId);
      emitState();
    },

    dispose() {
      for (const peer of peers.values()) {
        peer.pc.close();
      }
      peers.clear();
      emitState();
    },

    onPeerStateChange(handler: PeerStateChangeHandler) {
      stateHandler = handler;
    },
  };
}
