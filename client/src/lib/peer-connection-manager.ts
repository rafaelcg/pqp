import type { ClientRelayMessage } from "@pqp/shared";

export type PeerConnectionState = "connecting" | "connected" | "failed";

export interface RemotePeer {
  peerId: string;
  connectionState: PeerConnectionState;
  stream: MediaStream | null;
  userId?: string;
  displayName?: string;
  avatarUrl?: string | null;
}

export type SignalingSend = (message: ClientRelayMessage) => void;

export type PeerStateChangeHandler = (peers: RemotePeer[]) => void;

export interface PeerIdentity {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export function getDefaultIceServers(): RTCIceServer[] {
  const servers = [...DEFAULT_ICE_SERVERS];
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as
    | string
    | undefined;

  if (
    turnUrl &&
    turnUsername &&
    turnCredential &&
    !turnUrl.includes("example.com") &&
    !turnUsername.includes("your-") &&
    !turnCredential.includes("your-")
  ) {
    const urls = turnUrl
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    servers.push({
      urls: urls.length === 1 ? urls[0]! : urls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
}

function mapPeerState(
  connectionState: RTCPeerConnectionState,
  iceState: RTCIceConnectionState,
): PeerConnectionState {
  if (
    connectionState === "connected" ||
    iceState === "connected" ||
    iceState === "completed"
  ) {
    return "connected";
  }
  if (connectionState === "failed" || iceState === "failed") {
    return "failed";
  }
  if (connectionState === "closed" || iceState === "closed") {
    return "failed";
  }
  // "disconnected" is often transient — keep showing connecting so UI can recover
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
  userId?: string;
  displayName?: string;
  avatarUrl?: string | null;
  iceRestartTimer: ReturnType<typeof setTimeout> | null;
  politeRestartFallback: ReturnType<typeof setTimeout> | null;
  iceRestartAttempts: number;
}

const MAX_ICE_RESTARTS = 3;

export interface PeerConnectionManager {
  setLocalStream(stream: MediaStream): void;
  replaceLocalTrack(stream: MediaStream): Promise<void>;
  setIceServers(servers: RTCIceServer[]): void;
  connectToPeer(remotePeerId: string, identity?: PeerIdentity): void;
  setPeerIdentity(remotePeerId: string, identity: PeerIdentity): void;
  handleOffer(from: string, sdp: string): Promise<void>;
  handleAnswer(from: string, sdp: string): Promise<void>;
  handleIceCandidate(
    from: string,
    candidate: RTCIceCandidateInit | null,
  ): Promise<void>;
  retryPeer(remotePeerId: string): Promise<void>;
  removePeer(remotePeerId: string): void;
  dispose(): void;
  onPeerStateChange(handler: PeerStateChangeHandler): void;
}

export function createPeerConnectionManager(
  localPeerId: string,
  send: SignalingSend,
  iceServers: RTCIceServer[] = getDefaultIceServers(),
): PeerConnectionManager {
  const peers = new Map<string, ManagedPeer>();
  let localStream: MediaStream | null = null;
  let stateHandler: PeerStateChangeHandler | null = null;
  let currentIceServers = iceServers;

  function emitState() {
    const remotePeers: RemotePeer[] = [...peers.values()].map((peer) => ({
      peerId: peer.peerId,
      connectionState: peer.connectionState,
      stream: peer.stream,
      userId: peer.userId,
      displayName: peer.displayName,
      avatarUrl: peer.avatarUrl,
    }));
    stateHandler?.(remotePeers);
  }

  function applyIdentity(peer: ManagedPeer, identity?: PeerIdentity) {
    if (!identity) {
      return;
    }
    peer.userId = identity.userId;
    peer.displayName = identity.displayName;
    peer.avatarUrl = identity.avatarUrl;
  }

  function clearIceRestartTimer(peer: ManagedPeer) {
    if (peer.iceRestartTimer) {
      clearTimeout(peer.iceRestartTimer);
      peer.iceRestartTimer = null;
    }
    if (peer.politeRestartFallback) {
      clearTimeout(peer.politeRestartFallback);
      peer.politeRestartFallback = null;
    }
  }

  async function restartIce(peer: ManagedPeer) {
    if (peer.iceRestartAttempts >= MAX_ICE_RESTARTS) {
      peer.connectionState = "failed";
      emitState();
      return;
    }
    if (!isImpolite(localPeerId, peer.peerId)) {
      // Normally the impolite peer drives the restart (avoids glare). But if
      // only our side detected the failure, waiting forever strands the call —
      // so after a grace period the polite peer restarts anyway.
      if (peer.politeRestartFallback) {
        return;
      }
      peer.politeRestartFallback = setTimeout(() => {
        peer.politeRestartFallback = null;
        if (peer.pc.iceConnectionState === "failed" || peer.pc.connectionState === "failed") {
          void forceRestartIce(peer);
        }
      }, 4000);
      return;
    }
    peer.iceRestartAttempts += 1;
    peer.connectionState = "connecting";
    emitState();
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(
        await peer.pc.createOffer({ iceRestart: true }),
      );
      send({
        type: "offer",
        from: localPeerId,
        to: peer.peerId,
        sdp: peer.pc.localDescription!.sdp,
      });
    } catch {
      peer.connectionState = "failed";
      emitState();
    } finally {
      peer.makingOffer = false;
    }
  }

  // Used by the polite-peer fallback: restart regardless of politeness once the
  // impolite side has clearly failed to.
  async function forceRestartIce(peer: ManagedPeer) {
    if (peer.iceRestartAttempts >= MAX_ICE_RESTARTS) {
      peer.connectionState = "failed";
      emitState();
      return;
    }
    peer.iceRestartAttempts += 1;
    peer.connectionState = "connecting";
    emitState();
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(
        await peer.pc.createOffer({ iceRestart: true }),
      );
      send({
        type: "offer",
        from: localPeerId,
        to: peer.peerId,
        sdp: peer.pc.localDescription!.sdp,
      });
    } catch {
      peer.connectionState = "failed";
      emitState();
    } finally {
      peer.makingOffer = false;
    }
  }

  function scheduleIceRestart(peer: ManagedPeer) {
    clearIceRestartTimer(peer);
    peer.iceRestartTimer = setTimeout(() => {
      peer.iceRestartTimer = null;
      void restartIce(peer);
    }, 1500);
  }

  function wirePeerConnection(managed: ManagedPeer, remotePeerId: string) {
    const { pc } = managed;

    pc.onicecandidate = (event) => {
      send({
        type: "ice-candidate",
        from: localPeerId,
        to: remotePeerId,
        candidate: event.candidate ? event.candidate.toJSON() : null,
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      managed.stream = stream;
      emitState();
    };

    pc.onconnectionstatechange = () => {
      managed.connectionState = mapPeerState(
        pc.connectionState,
        pc.iceConnectionState,
      );
      if (pc.connectionState === "connected") {
        managed.iceRestartAttempts = 0;
        clearIceRestartTimer(managed);
      } else if (pc.connectionState === "failed") {
        scheduleIceRestart(managed);
      }
      emitState();
    };

    pc.oniceconnectionstatechange = () => {
      managed.connectionState = mapPeerState(
        pc.connectionState,
        pc.iceConnectionState,
      );
      if (
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed"
      ) {
        managed.iceRestartAttempts = 0;
        clearIceRestartTimer(managed);
      } else if (pc.iceConnectionState === "failed") {
        scheduleIceRestart(managed);
      }
      emitState();
    };
  }

  function createPeerConnection(
    remotePeerId: string,
    identity?: PeerIdentity,
  ): ManagedPeer {
    const pc = new RTCPeerConnection({
      iceServers: currentIceServers,
      iceCandidatePoolSize: 4,
    });

    const managed: ManagedPeer = {
      peerId: remotePeerId,
      pc,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      connectionState: "connecting",
      stream: null,
      pendingCandidates: [],
      iceRestartTimer: null,
      politeRestartFallback: null,
      iceRestartAttempts: 0,
    };
    applyIdentity(managed, identity);
    wirePeerConnection(managed, remotePeerId);

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    return managed;
  }

  async function negotiateAsImpolite(peer: ManagedPeer, iceRestart = false) {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(
        await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined),
      );
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
      try {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        send({
          type: "answer",
          from: localPeerId,
          to: peer.peerId,
          sdp: peer.pc.localDescription!.sdp,
        });
      } finally {
        peer.isSettingRemoteAnswerPending = false;
      }
    }

    for (const candidate of peer.pendingCandidates) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        // Candidate may be obsolete after restart — ignore
      }
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

    try {
      await peer.pc.addIceCandidate(candidate);
    } catch {
      // Ignore stale candidates
    }
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

    setIceServers(servers: RTCIceServer[]) {
      if (servers.length === 0) {
        return;
      }
      currentIceServers = servers;
      for (const peer of peers.values()) {
        try {
          peer.pc.setConfiguration({
            iceServers: currentIceServers,
            iceCandidatePoolSize: 4,
          });
        } catch {
          // setConfiguration may fail mid-negotiation — retry path handles it
        }
      }
    },

    connectToPeer(remotePeerId: string, identity?: PeerIdentity) {
      const existing = peers.get(remotePeerId);
      if (existing) {
        if (identity) {
          applyIdentity(existing, identity);
          emitState();
        }
        return;
      }

      const managed = createPeerConnection(remotePeerId, identity);
      peers.set(remotePeerId, managed);
      emitState();

      if (isImpolite(localPeerId, remotePeerId)) {
        void negotiateAsImpolite(managed);
      }
    },

    setPeerIdentity(remotePeerId: string, identity: PeerIdentity) {
      const peer = peers.get(remotePeerId);
      if (!peer) {
        return;
      }
      applyIdentity(peer, identity);
      emitState();
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

    async retryPeer(remotePeerId: string) {
      const peer = peers.get(remotePeerId);
      if (!peer) {
        return;
      }
      peer.iceRestartAttempts = 0;
      // Manual retry: always re-offer; perfect negotiation resolves glare.
      const previous = peers.get(remotePeerId);
      const preservedIdentity: PeerIdentity | undefined = previous?.userId
        ? {
            userId: previous.userId,
            displayName: previous.displayName ?? "Peer",
            avatarUrl: previous.avatarUrl ?? null,
          }
        : undefined;

      if (previous) {
        clearIceRestartTimer(previous);
        previous.pc.close();
        peers.delete(remotePeerId);
      }

      const managed = createPeerConnection(remotePeerId, preservedIdentity);
      peers.set(remotePeerId, managed);
      emitState();
      await negotiateAsImpolite(managed, true);
    },

    removePeer(remotePeerId: string) {
      const peer = peers.get(remotePeerId);
      if (!peer) {
        return;
      }

      clearIceRestartTimer(peer);
      peer.pc.close();
      peers.delete(remotePeerId);
      emitState();
    },

    dispose() {
      for (const peer of peers.values()) {
        clearIceRestartTimer(peer);
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
