import type { ClientRelayMessage } from "@pqp/shared";

export type PeerConnectionState = "connecting" | "connected" | "failed";

export interface RemotePeer {
  peerId: string;
  connectionState: PeerConnectionState;
  stream: MediaStream | null;
  /** Screen-share video, if this peer is currently presenting. */
  screenStream: MediaStream | null;
  /**
   * Camera video, if this peer's camera is on (conversation calls).
   *
   * A video track on the wire does not say what it shows; the roster does. An
   * incoming video stream is filed here when its id matches the
   * `cameraStreamId` the peer announced over the WS (`set-camera`), and under
   * `screenStream` otherwise — which is also exactly the pre-camera behaviour
   * for every peer that never announces one.
   */
  cameraStream: MediaStream | null;
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
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  /**
   * Every video stream this peer is sending, keyed by the *sender-side*
   * MediaStream id (`a=msid`, preserved across the wire). Classification into
   * screen vs camera is re-derived from `remoteCameraStreamId` whenever either
   * side changes, because the roster announcement and the track can arrive in
   * either order.
   */
  videoStreams: Map<string, MediaStream>;
  /** The camera stream id this peer announced over the WS, or null. */
  remoteCameraStreamId: string | null;
  /** Our own outgoing video senders on this connection, one per purpose —
   *  looked up by role, never by `track.kind`, because both are video. */
  screenSender: RTCRtpSender | null;
  cameraSender: RTCRtpSender | null;
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
  /** Publish (stream set) or stop (null) a screen-share video track to every peer. */
  setLocalScreenStream(stream: MediaStream | null): Promise<void>;
  /** Publish (stream set) or stop (null) a camera video track to every peer. */
  setLocalCameraStream(stream: MediaStream | null): Promise<void>;
  /**
   * Record which of a peer's video streams is their camera (from the roster).
   * Null means "camera off" — any remaining video is treated as screen share.
   */
  setPeerCameraStreamId(remotePeerId: string, streamId: string | null): void;
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
  let localScreenStream: MediaStream | null = null;
  let localCameraStream: MediaStream | null = null;
  let stateHandler: PeerStateChangeHandler | null = null;
  let currentIceServers = iceServers;

  function emitState() {
    const remotePeers: RemotePeer[] = [...peers.values()].map((peer) => ({
      peerId: peer.peerId,
      connectionState: peer.connectionState,
      stream: peer.stream,
      screenStream: peer.screenStream,
      cameraStream: peer.cameraStream,
      userId: peer.userId,
      displayName: peer.displayName,
      avatarUrl: peer.avatarUrl,
    }));
    stateHandler?.(remotePeers);
  }

  /**
   * Re-derive which incoming video is the camera and which the screen.
   *
   * The announced id wins; anything else is screen share, which is byte-for-
   * byte the old behaviour for peers that never turn a camera on. Ran on both
   * track arrival and roster arrival, because the two race.
   */
  function classifyVideo(peer: ManagedPeer) {
    let camera: MediaStream | null = null;
    let screen: MediaStream | null = null;
    for (const [id, stream] of peer.videoStreams) {
      if (peer.remoteCameraStreamId !== null && id === peer.remoteCameraStreamId) {
        camera = camera ?? stream;
      } else {
        screen = screen ?? stream;
      }
    }
    peer.cameraStream = camera;
    peer.screenStream = screen;
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
      if (event.track.kind === "video") {
        managed.videoStreams.set(stream.id, stream);
        classifyVideo(managed);
        // Fires when the sender stops the track (share/camera ended or the
        // sender removed it and renegotiated) — nothing else observes that.
        event.track.onended = () => {
          managed.videoStreams.delete(stream.id);
          classifyVideo(managed);
          emitState();
        };
      } else {
        managed.stream = stream;
      }
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
      screenStream: null,
      cameraStream: null,
      videoStreams: new Map(),
      remoteCameraStreamId: null,
      screenSender: null,
      cameraSender: null,
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
    if (localScreenStream) {
      for (const track of localScreenStream.getTracks()) {
        managed.screenSender = pc.addTrack(track, localScreenStream);
      }
    }
    if (localCameraStream) {
      for (const track of localCameraStream.getTracks()) {
        managed.cameraSender = pc.addTrack(track, localCameraStream);
      }
    }

    return managed;
  }

  /**
   * Create-offer-and-send. Named generically because either side of a pair may
   * call it (initial connect, ICE restart, or adding a track later) — the
   * actual politeness/glare resolution happens in `applyRemoteDescription` on
   * whichever side receives the resulting offer, not here.
   */
  async function negotiate(peer: ManagedPeer, iceRestart = false) {
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

  /** A local track that no negotiated m-line carries — invisible to the peer. */
  function hasUnnegotiatedSender(peer: ManagedPeer): boolean {
    return peer.pc
      .getTransceivers()
      .some(
        (transceiver) =>
          transceiver.mid === null && transceiver.sender.track !== null,
      );
  }

  /**
   * Offer an unnegotiated local track once the pair has settled.
   *
   * Checked-and-retried rather than fired once: right after our answer goes
   * out the remote is still applying it, and an offer landing in that window
   * is glare that perfect negotiation resolves by *dropping* it — with nothing
   * left to try again, since this manager does not use `onnegotiationneeded`.
   * Every attempt re-checks the transceiver, so the loop is a no-op the moment
   * the track has its m-line (or the peer is gone).
   */
  function scheduleRenegotiation(peer: ManagedPeer, attempt = 0) {
    if (attempt >= 5) {
      return;
    }
    setTimeout(() => {
      if (peers.get(peer.peerId) !== peer) {
        return;
      }
      if (!hasUnnegotiatedSender(peer)) {
        return;
      }
      if (peer.makingOffer || peer.pc.signalingState !== "stable") {
        scheduleRenegotiation(peer, attempt + 1);
        return;
      }
      negotiate(peer)
        .catch(() => {
          // A failed offer (e.g. closed mid-call) is retried or given up on.
        })
        .finally(() => scheduleRenegotiation(peer, attempt + 1));
    }, 400 * (attempt + 1));
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
      // An answer can only cover the m-lines the offer carried. A track added
      // *before* this connection first negotiated — camera or screen already
      // on when this peer joined the call — sits on a transceiver with no
      // m-line (`mid === null`), and no code path would ever offer it: the
      // polite side never initiates, and set-local-stream renegotiates only
      // when it adds a track to an existing connection. So the caller's video
      // silently never reached anyone who joined after it was turned on.
      // Follow the answer with our own offer for exactly that case. Deferred,
      // not immediate: re-offering in the same tick as the answer reaches the
      // remote while it is still applying that answer (signaling not stable),
      // reads as glare, and gets dropped — the retry loop keeps trying until
      // the track has an m-line or the attempts run out.
      if (hasUnnegotiatedSender(peer)) {
        scheduleRenegotiation(peer);
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

    async setLocalScreenStream(stream: MediaStream | null) {
      localScreenStream = stream;
      const nextTrack = stream?.getVideoTracks()[0] ?? null;
      for (const peer of peers.values()) {
        if (nextTrack) {
          if (peer.screenSender) {
            await peer.screenSender.replaceTrack(nextTrack);
          } else {
            peer.screenSender = peer.pc.addTrack(nextTrack, stream!);
            await negotiate(peer);
          }
        } else if (peer.screenSender) {
          peer.pc.removeTrack(peer.screenSender);
          peer.screenSender = null;
          await negotiate(peer);
        }
      }
    },

    async setLocalCameraStream(stream: MediaStream | null) {
      localCameraStream = stream;
      const nextTrack = stream?.getVideoTracks()[0] ?? null;
      for (const peer of peers.values()) {
        if (nextTrack) {
          if (peer.cameraSender) {
            await peer.cameraSender.replaceTrack(nextTrack);
          } else {
            peer.cameraSender = peer.pc.addTrack(nextTrack, stream!);
            await negotiate(peer);
          }
        } else if (peer.cameraSender) {
          peer.pc.removeTrack(peer.cameraSender);
          peer.cameraSender = null;
          await negotiate(peer);
        }
      }
    },

    setPeerCameraStreamId(remotePeerId: string, streamId: string | null) {
      const peer = peers.get(remotePeerId);
      if (!peer || peer.remoteCameraStreamId === streamId) {
        return;
      }
      const previous = peer.remoteCameraStreamId;
      peer.remoteCameraStreamId = streamId;
      // Camera turned off: drop its stream outright. The sender's removeTrack
      // does not reliably end the receiver-side track (spec says it merely
      // mutes), and without this the dead camera stream would be reclassified
      // as a screen share and drawn as a frozen frame.
      if (streamId === null && previous !== null) {
        peer.videoStreams.delete(previous);
      }
      classifyVideo(peer);
      emitState();
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
        void negotiate(managed);
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

      const preservedCameraStreamId = previous?.remoteCameraStreamId ?? null;
      if (previous) {
        clearIceRestartTimer(previous);
        previous.pc.close();
        peers.delete(remotePeerId);
      }

      const managed = createPeerConnection(remotePeerId, preservedIdentity);
      // Survives the rebuild: no roster frame accompanies a manual retry, so
      // without this the re-arriving camera track would classify as a screen.
      managed.remoteCameraStreamId = preservedCameraStreamId;
      peers.set(remotePeerId, managed);
      emitState();
      await negotiate(managed, true);
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
