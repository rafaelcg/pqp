import type { ClientRelayMessage } from "@pqp/shared";
import {
  cameraBitrateFor,
  DEFAULT_VIDEO_QUALITY,
  screenBitrateFor,
  type VideoQuality,
} from "./video-quality";
import {
  registerVoiceConnection,
  unregisterVoiceConnection,
  type VideoSenderRole,
} from "./voice-stats-probe";

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
  /**
   * The audio of this peer's screen share, when their capture had any.
   *
   * Kept apart from `stream` (their microphone) rather than merged into it:
   * the two are played through different sinks, and merging would put a film
   * under the same speaking detection as the presenter's voice. Null is the
   * normal case, since most captures are silent (see
   * `voiceParticipantSchema.screenAudioStreamId`).
   */
  screenAudioStream: MediaStream | null;
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
  screenAudioStream: MediaStream | null;
  /**
   * Every video stream this peer is sending, keyed by the *sender-side*
   * MediaStream id (`a=msid`, preserved across the wire). Classification into
   * screen vs camera is re-derived from `remoteCameraStreamId` whenever either
   * side changes, because the roster announcement and the track can arrive in
   * either order.
   */
  videoStreams: Map<string, MediaStream>;
  /**
   * Every audio stream this peer is sending, keyed the same way and for the
   * same reason: a peer sharing a tab with sound sends two audio tracks, and
   * only the announced id says which of them is the microphone.
   */
  audioStreams: Map<string, MediaStream>;
  /** The camera stream id this peer announced over the WS, or null. */
  remoteCameraStreamId: string | null;
  /** The screen-audio stream id this peer announced over the WS, or null. */
  remoteScreenAudioStreamId: string | null;
  /**
   * Whether the roster currently says this peer is presenting.
   *
   * Unlike the camera and the screen *audio*, a screen share announces no
   * stream id, so this flag is the only thing that can tell us a share ended —
   * see `setPeerSharingScreen` for why nothing else can.
   */
  remoteSharingScreen: boolean;
  /** Our own outgoing video senders on this connection, one per purpose —
   *  looked up by role, never by `track.kind`, because both are video. */
  screenSender: RTCRtpSender | null;
  cameraSender: RTCRtpSender | null;
  /** The system-audio half of a screen share, when the capture carried one. */
  screenAudioSender: RTCRtpSender | null;
  pendingCandidates: RTCIceCandidateInit[];
  /**
   * We changed our own senders and this peer has not been told yet.
   *
   * Set the moment a track is added or removed, cleared only once an offer
   * carrying that change has actually been applied. It exists because the
   * change and the offer are no longer the same step: an offer can only be
   * made from a settled connection, and the moment a person clicks "share" is
   * not under our control. Without it, an offer that had to wait would be
   * waited for by nobody — `hasUnnegotiatedSender` cannot see a *removal*,
   * which has no sender left to look at.
   */
  owedOffer: boolean;
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
  /**
   * Publish (stream set) or stop (null) a screen share to every peer.
   *
   * Takes the whole capture rather than a track: `getDisplayMedia` may hand
   * back a system-audio track alongside the video, both belong to the same
   * share, and both are added, replaced and removed together under a single
   * renegotiation.
   */
  setLocalScreenStream(stream: MediaStream | null): Promise<void>;
  /** Publish (stream set) or stop (null) a camera video track to every peer. */
  setLocalCameraStream(stream: MediaStream | null): Promise<void>;
  /**
   * Change the camera's bitrate ceiling and re-apply it to every live sender.
   *
   * Separate from `setLocalCameraStream` because changing quality mid-call must
   * not require re-capturing: a swap would blink the webcam light and drop a
   * second of video, and `setParameters` alone is enough for the encoder half.
   */
  setCameraMaxBitrate(maxBitrate: number): void;
  /**
   * Change the screen share's quality and re-apply it to every live sender.
   *
   * Takes a quality rather than a bitrate, unlike its camera twin, because the
   * screen's ceiling is not the chosen number on its own: it is that number
   * intersected with the mesh budget, which moves whenever the room does. The
   * manager is the only place that knows both, so it is the only place that can
   * do the intersection. Same mid-call promise as the camera: no re-capture, so
   * the share never blinks and the picker never reopens.
   */
  setScreenQuality(quality: VideoQuality): void;
  /**
   * Record which of a peer's video streams is their camera (from the roster).
   * Null means "camera off" — any remaining video is treated as screen share.
   */
  setPeerCameraStreamId(remotePeerId: string, streamId: string | null): void;
  /**
   * Record which of a peer's audio streams is their screen share (from the
   * roster). Null means "no screen audio": every audio track is their voice.
   */
  setPeerScreenAudioStreamId(
    remotePeerId: string,
    streamId: string | null,
  ): void;
  /**
   * Record whether a peer is presenting (from the roster).
   *
   * The screen share is the one incoming stream with no announced id — it is
   * defined negatively, as "video that is not the camera" — so a share ending
   * has nothing to null out the way the camera and the screen audio do. That
   * is what this is for, and without it a re-share is a black rectangle: see
   * the implementation.
   */
  setPeerSharingScreen(remotePeerId: string, sharing: boolean): void;
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

/**
 * Total upload the presenter is allowed to spend on the screen, in bits per
 * second, and what each peer gets out of it.
 *
 * WHY THIS EXISTS AT ALL. Nothing here used to call `setParameters`, so every
 * screen share ran on the encoder's defaults, and the defaults are wrong for
 * this. A capture track with no `contentHint` is treated as detail-first, and
 * the default degradation preference for screen content is
 * `maintain-resolution`: under any bandwidth pressure the encoder holds 1080p
 * and spends the framerate instead. That is the correct trade for a slide and
 * exactly the wrong one for a film, which is what people actually share here,
 * and it is why a share looked like a slideshow.
 *
 * WHY IT DIVIDES. This is a full mesh. The presenter uploads a separate copy to
 * every peer, so a fixed per-peer bitrate multiplies by the room. A single
 * budget split between peers keeps a six-person room from asking one domestic
 * uplink for 15 Mbps and getting congestion collapse instead of video. The
 * floor stops the arithmetic from producing something unwatchable in a big
 * room: past that point the honest fix is the SFU, not a smaller number.
 */
const SCREEN_UPLOAD_BUDGET_BPS = 5_000_000;
const SCREEN_MIN_BITRATE_BPS = 600_000;
/**
 * The most any single screen sender may be given, whatever else is agreed.
 *
 * RAISED FROM 2.5 Mbps, ON PURPOSE, AND IT IS NOT AN OVERSIGHT. 2.5 Mbps was
 * never enough for the 1080p30 this code asks the browser to capture. Moving
 * screen content at that size wants somewhere around 4 to 6 Mbps, and
 * `contentHint = "motion"` plus `maintain-framerate` means the encoder pays
 * the shortfall in resolution: it holds 30 fps and quietly scales 1080p down
 * until the picture fits. That is the entire explanation for "I selected 1080p
 * and it was blurry". Nothing was broken; the ceiling simply said no.
 *
 * WHY 4 Mbps AND NOT MORE. Two limits, and both are real:
 *
 *  - `SCREEN_UPLOAD_BUDGET_BPS` is 5 Mbps and is divided by the peer count, so
 *    a two-person call is already capped at 5 Mbps by the budget alone. Going
 *    past 4 here would only push a 1:1 call toward saturating the 5 to 10 Mbps
 *    uplink a great many Brazilian home connections actually have, and a
 *    saturated uplink is not a sharper picture, it is a stalled one.
 *  - The budget still binds from two remote peers upward (5 / 2 = 2.5 Mbps),
 *    which is exactly the number every share got before this change. So this
 *    raise is surgical: it reaches the 1:1 and small calls where there is
 *    headroom to spend, and changes nothing at all about a crowded room.
 *
 * A CEILING IS NOT A DEMAND. Read this before "optimising" it back down. This
 * number never obliges anyone to send 4 Mbps. WebRTC's bandwidth estimator
 * measures the path continuously and sends the lower of (estimate, ceiling);
 * on a 3 Mbps uplink the ceiling is inert and the estimate governs, exactly as
 * it did at 2.5. Lowering it protects nobody who was not already protected and
 * costs the picture for everybody who was not at risk.
 */
const SCREEN_MAX_BITRATE_BPS = 4_000_000;
const SCREEN_MAX_FRAMERATE = 30;

/**
 * What one screen sender is allowed, given the room and the chosen quality.
 *
 * Three terms, in the order they matter:
 *
 *  - the **chosen ceiling**, which is the user's answer to "how much upload am
 *    I willing to spend on video". It is an upper bound and always wins as one:
 *    picking 480p cannot be overruled into sending 4 Mbps by an empty room.
 *  - the **mesh budget share**, which is the room's answer. A full mesh uploads
 *    a separate copy per peer, so a per-peer rate multiplies; the split is what
 *    stops a six-way call asking one domestic uplink for 24 Mbps.
 *  - the **floor**, which only ever lifts the *budget share*, never the chosen
 *    ceiling. It exists so the division cannot produce something unwatchable
 *    in a big room. It is not a licence to exceed what the user asked for,
 *    which is why the chosen ceiling is the outermost `min`.
 */
export function meshScreenBitrate(
  peerCount: number,
  quality: VideoQuality = DEFAULT_VIDEO_QUALITY,
): number {
  const share = SCREEN_UPLOAD_BUDGET_BPS / Math.max(1, peerCount);
  const chosen = Math.min(screenBitrateFor(quality), SCREEN_MAX_BITRATE_BPS);
  return Math.round(
    Math.min(chosen, Math.max(SCREEN_MIN_BITRATE_BPS, share)),
  );
}

/** The camera's own ceiling. Framerate is what the whole tuning protects. */
const CAMERA_MAX_FRAMERATE = 30;

/** Where a manager starts before anybody has chosen a quality. */
const DEFAULT_CAMERA_MAX_BITRATE_BPS = cameraBitrateFor(DEFAULT_VIDEO_QUALITY);

/**
 * Point one camera-video sender at framerate rather than sharpness, and give
 * it a ceiling.
 *
 * The camera twin of `tuneScreenSender`, and the reason it did not exist until
 * now is simply that nobody wrote it: the camera sender was added with
 * `addTrack` and never touched again, so it ran on encoder defaults with no
 * bitrate ceiling of any kind. On a mesh call that also carries a screen share
 * the two video senders then bid against each other for one bandwidth estimate
 * with nothing arbitrating, which is how a camera ends up at 240p while the
 * share looks fine.
 *
 * DIFFERS FROM THE SCREEN TWIN IN ONE WAY, DELIBERATELY: a rejection is logged
 * rather than silently discarded. The outcome is the same — the camera keeps
 * working on browser defaults, which is exactly today's behaviour, so the worst
 * case of this whole change is "no improvement" rather than "no video" — but a
 * silent `catch` is how nobody noticed the camera had no ceiling in the first
 * place. Resolves to whether it took, for the tests and for the probe.
 */
async function tuneCameraSender(
  sender: RTCRtpSender | null,
  maxBitrate: number,
): Promise<boolean> {
  if (!sender) {
    return false;
  }
  try {
    const params = sender.getParameters();
    // Same Firefox-before-first-negotiation guard as the screen path: an empty
    // encodings array is legal, and writing one in is what the spec prescribes.
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.degradationPreference = "maintain-framerate";
    for (const encoding of params.encodings) {
      encoding.maxBitrate = maxBitrate;
      encoding.maxFramerate = CAMERA_MAX_FRAMERATE;
    }
    await sender.setParameters(params);
    return true;
  } catch (err) {
    console.warn(
      "[pqp] camera encoder tuning rejected; running on browser defaults",
      err,
    );
    return false;
  }
}

/**
 * Point one screen-video sender at framerate rather than sharpness.
 *
 * `degradationPreference` is set on the parameters object rather than passed to
 * `addTransceiver`, because the track is added with `addTrack` and there is no
 * other hook. Every field is applied on top of the parameters the browser
 * already produced: replacing the object wholesale would drop the SSRCs and RTX
 * settings the connection is already using.
 *
 * Failure is swallowed on purpose. `setParameters` rejects on browsers that do
 * not accept one of these fields, and a share that runs on the old defaults is
 * enormously better than one that throws while starting.
 */
async function tuneScreenSender(
  sender: RTCRtpSender | null,
  peerCount: number,
  quality: VideoQuality,
): Promise<void> {
  if (!sender) {
    return;
  }
  try {
    const params = sender.getParameters();
    // Firefox has been known to hand back parameters with no encodings at all
    // before the first negotiation completes; writing one in is what the spec
    // says to do and is a no-op where the array is already populated.
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.degradationPreference = "maintain-framerate";
    for (const encoding of params.encodings) {
      encoding.maxBitrate = meshScreenBitrate(peerCount, quality);
      encoding.maxFramerate = SCREEN_MAX_FRAMERATE;
    }
    await sender.setParameters(params);
  } catch {
    // Old defaults, working share.
  }
}

export function createPeerConnectionManager(
  localPeerId: string,
  send: SignalingSend,
  iceServers: RTCIceServer[] = getDefaultIceServers(),
): PeerConnectionManager {
  const peers = new Map<string, ManagedPeer>();

  /**
   * Re-split the screen upload budget across everyone currently connected.
   *
   * Called whenever the room's size changes, in both directions: a joiner means
   * every existing sender must give some bitrate back, and someone leaving
   * means the rest can have it. Without the leaving half, a call that started
   * at six and dropped to two would keep encoding at the six-way rate forever.
   *
   * `peerCount` is an argument rather than always `peers.size` because the
   * joiner case is called from inside `createPeerConnection`, which runs
   * *before* the new peer is put in the map. Reading `peers.size` there
   * retuned everybody for a room one smaller than the one they were about to
   * be in, and nothing recomputed it afterwards — so every existing sender
   * stayed over budget for the rest of the call, which is the opposite of what
   * the split exists to prevent.
   */
  function retuneAllScreenSenders(peerCount = peers.size): void {
    if (!localScreenStream) {
      return;
    }
    for (const peer of peers.values()) {
      void tuneScreenSender(peer.screenSender, peerCount, screenQuality);
    }
  }

  /**
   * Re-apply the camera ceiling to every peer.
   *
   * Not budget-split the way the screen is: the camera's ceiling is a user
   * choice, and dividing a chosen 720p by the room size would quietly turn
   * "720p" into a setting that means something different in every call. The
   * mesh's per-peer multiplication is a real cost, and the honest answer to it
   * is the SFU, not a number that lies about what it does.
   */
  function retuneAllCameraSenders(): void {
    if (!localCameraStream) {
      return;
    }
    for (const peer of peers.values()) {
      void tuneCameraSender(peer.cameraSender, cameraMaxBitrate);
    }
  }

  let localStream: MediaStream | null = null;
  let localScreenStream: MediaStream | null = null;
  let localCameraStream: MediaStream | null = null;
  /** The chosen quality's ceiling, in bps. Replaced by `setCameraMaxBitrate`. */
  let cameraMaxBitrate = DEFAULT_CAMERA_MAX_BITRATE_BPS;
  /**
   * The chosen quality, for the screen sender.
   *
   * Held as the quality rather than as a bitrate, unlike the camera's, because
   * the screen's number is not a constant: it is the chosen ceiling intersected
   * with a budget that moves every time the room's size does. Storing the
   * resolved bitrate would freeze one of those two inputs.
   */
  let screenQuality: VideoQuality = DEFAULT_VIDEO_QUALITY;
  let stateHandler: PeerStateChangeHandler | null = null;
  let currentIceServers = iceServers;

  function emitState() {
    const remotePeers: RemotePeer[] = [...peers.values()].map((peer) => ({
      peerId: peer.peerId,
      connectionState: peer.connectionState,
      stream: peer.stream,
      screenStream: peer.screenStream,
      cameraStream: peer.cameraStream,
      screenAudioStream: peer.screenAudioStream,
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

  /**
   * Re-derive which incoming audio is the voice and which the screen share.
   *
   * The mirror image of `classifyVideo`, racing the same way: the roster frame
   * and the track arrive in either order. The announced stream is the screen
   * one, everything else is the microphone, which preserves the old behaviour
   * exactly for a peer that announces nothing. The microphone slot is
   * first-wins so that a screen-audio track arriving before its announcement
   * cannot take the voice away from the peer.
   */
  function classifyAudio(peer: ManagedPeer) {
    let voice: MediaStream | null = null;
    let screenAudio: MediaStream | null = null;
    for (const [id, stream] of peer.audioStreams) {
      if (
        peer.remoteScreenAudioStreamId !== null &&
        id === peer.remoteScreenAudioStreamId
      ) {
        screenAudio = screenAudio ?? stream;
      } else {
        voice = voice ?? stream;
      }
    }
    peer.stream = voice;
    peer.screenAudioStream = screenAudio;
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
        managed.audioStreams.set(stream.id, stream);
        classifyAudio(managed);
        // Same reason as the video branch: the sender ending the track (share
        // stopped, capture revoked) is observed nowhere else, and a dead
        // screen-audio stream left behind keeps an <audio> element pointed at
        // silence.
        event.track.onended = () => {
          managed.audioStreams.delete(stream.id);
          classifyAudio(managed);
          emitState();
        };
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
      screenAudioStream: null,
      videoStreams: new Map(),
      audioStreams: new Map(),
      remoteCameraStreamId: null,
      remoteScreenAudioStreamId: null,
      remoteSharingScreen: false,
      screenSender: null,
      cameraSender: null,
      screenAudioSender: null,
      pendingCandidates: [],
      owedOffer: false,
      iceRestartTimer: null,
      politeRestartFallback: null,
      iceRestartAttempts: 0,
    };
    applyIdentity(managed, identity);
    wirePeerConnection(managed, remotePeerId);
    // Console-only measurement (`lib/voice-stats-probe.ts`). The role lookup is
    // resolved live rather than captured, because `replaceTrack` changes the
    // track id under a sender that keeps its identity.
    registerVoiceConnection(remotePeerId, pc, (trackId): VideoSenderRole => {
      if (managed.cameraSender?.track?.id === trackId) {
        return "camera";
      }
      if (managed.screenSender?.track?.id === trackId) {
        return "screen";
      }
      return "unknown";
    });

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }
    if (localScreenStream) {
      // Filed by role rather than by iteration order: the capture may hold a
      // video track and a system-audio track, and each needs its own sender so
      // that stopping later can remove exactly one of them.
      for (const track of localScreenStream.getVideoTracks()) {
        managed.screenSender = pc.addTrack(track, localScreenStream);
        // Somebody joining mid-share gets the same treatment as everybody who
        // was already here, and the room just grew, so this is also the moment
        // the existing senders need their share of the budget recomputed.
        void tuneScreenSender(managed.screenSender, peers.size + 1, screenQuality);
        // `+ 1` for the same reason: this runs before the caller files the new
        // peer, and the room everyone is about to be in is the one to budget
        // for.
        void retuneAllScreenSenders(peers.size + 1);
      }
      for (const track of localScreenStream.getAudioTracks()) {
        managed.screenAudioSender = pc.addTrack(track, localScreenStream);
      }
    }
    if (localCameraStream) {
      for (const track of localCameraStream.getTracks()) {
        managed.cameraSender = pc.addTrack(track, localCameraStream);
        // Somebody joining mid-call gets the same ceiling as everybody who was
        // already here. Unlike the screen budget this needs no re-split, so
        // the existing senders are left alone.
        void tuneCameraSender(managed.cameraSender, cameraMaxBitrate);
      }
    }

    return managed;
  }

  /**
   * Set to false the first time a browser refuses `setLocalDescription()`.
   *
   * Per manager rather than per module so nothing carries across a rebuilt
   * call, and so a test gets a clean one. In practice it is decided once, on
   * the first offer of the first call, and never looked at again.
   */
  let implicitLocalDescription = true;

  /**
   * Put our own offer on the connection.
   *
   * The argument-less form is the point. `setLocalDescription(await
   * createOffer())` is two operations with an await between them, and an offer
   * describes the session it was built from: anything landing in that gap — a
   * remote offer being answered, our own second track, an ICE restart — leaves
   * the browser asked to apply a description of a session that no longer
   * exists. Chrome does not shrug at that. It throws out of
   * `setLocalDescription` with "Failed to set local offer sdp: ...", and
   * whatever the caller was doing dies with it. The implicit form builds the
   * offer and applies it as one step, so there is no gap to lose it in.
   *
   * An ICE restart cannot use it (there is nowhere to ask for one), which is
   * the only reason the explicit form is still here at all — that, and a
   * browser old enough to still require the argument. Losing every call on
   * such a browser would be a far worse bug than the one this fixes, and the
   * cost of not risking it is one `catch`.
   */
  async function applyLocalOffer(pc: RTCPeerConnection, iceRestart: boolean) {
    if (!iceRestart && implicitLocalDescription) {
      try {
        await pc.setLocalDescription();
        return;
      } catch (err) {
        // A browser that still requires the argument rejects the *call*, with
        // a TypeError, before any SDP exists. Every real SDP failure is a
        // DOMException, so this is the one error that means "wrong overload"
        // rather than "bad session".
        if (!(err instanceof TypeError)) {
          throw err;
        }
        implicitLocalDescription = false;
      }
    }
    await pc.setLocalDescription(
      await pc.createOffer(iceRestart ? { iceRestart: true } : undefined),
    );
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
      await applyLocalOffer(peer.pc, iceRestart);
      send({
        type: "offer",
        from: localPeerId,
        to: peer.peerId,
        sdp: peer.pc.localDescription!.sdp,
      });
      // `owedOffer` is deliberately NOT cleared here. Sending an offer is not
      // the same as the peer having received it: perfect negotiation resolves
      // glare by having one side drop the other's offer on the floor, and a
      // debt cleared on send would be forgotten exactly when it was not paid.
      // The answer is the acknowledgement, and that is where it clears.
    } finally {
      peer.makingOffer = false;
    }
  }

  /**
   * Tell this peer about a sender we just added or removed. Never throws.
   *
   * An offer is only legal from a settled connection, and nothing about the
   * moment a person clicks "share my screen" respects that: the pair may be
   * halfway through answering an offer of their own, or restarting ICE. The
   * old code offered anyway, `setLocalDescription` rejected, and the rejection
   * travelled all the way out to `startScreenShare`, which tore the capture
   * down and printed Chrome's own English sentence on a Brazilian user's
   * screen. The share was destroyed by its own timing.
   *
   * The tracks are already on the connection by the time this is called, so
   * there is nothing to undo and nothing to apologise for — only an offer that
   * has to wait for its turn. `scheduleRenegotiation` is exactly that waiting
   * room, and it already existed for the neighbouring case of a track that
   * never got an m-line.
   */
  async function requestNegotiation(peer: ManagedPeer): Promise<void> {
    peer.owedOffer = true;
    if (peer.makingOffer || peer.pc.signalingState !== "stable") {
      scheduleRenegotiation(peer);
      return;
    }
    try {
      await negotiate(peer);
    } catch {
      // Lost a race that opened after the check above. The offer is still
      // owed, so hand it to the same waiting room rather than to the caller.
      scheduleRenegotiation(peer);
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
   * Anything this peer has not been told about our senders.
   *
   * Two questions, not one. `hasUnnegotiatedSender` reads the connection and
   * catches a track that never got an m-line, including one added by a code
   * path that never asked for an offer. `owedOffer` is our own record, and it
   * is the only one of the two that survives a *removal*: stopping a share
   * leaves no sender behind to notice, and a peer never told about the stop
   * keeps rendering a frozen frame.
   */
  function needsNegotiation(peer: ManagedPeer): boolean {
    return peer.owedOffer || hasUnnegotiatedSender(peer);
  }

  /**
   * Offer whatever this peer has not been told, once the pair has settled.
   *
   * Checked-and-retried rather than fired once: right after our answer goes
   * out the remote is still applying it, and an offer landing in that window
   * is glare that perfect negotiation resolves by *dropping* it — with nothing
   * left to try again, since this manager does not use `onnegotiationneeded`.
   * Every attempt re-checks, so the loop is a no-op the moment the peer knows
   * (or is gone).
   *
   * This is also where a screen share's offer ends up when the person started
   * sharing at a moment the connection was busy. That is not a rare corner:
   * a click arrives whenever it arrives.
   */
  function scheduleRenegotiation(peer: ManagedPeer, attempt = 0) {
    if (attempt >= 5) {
      return;
    }
    setTimeout(() => {
      if (peers.get(peer.peerId) !== peer) {
        return;
      }
      if (!needsNegotiation(peer)) {
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

    if (description.type === "answer") {
      // They answered, so they have our senders. This is the only moment that
      // is actually evidence of that.
      peer.owedOffer = false;
    }

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
      // The answer we just sent describes every sender that had an m-line to
      // be described on, so anything owed from before is now paid — unless a
      // track is still sitting on a transceiver the offer never covered, which
      // is the case the next block exists for.
      if (!hasUnnegotiatedSender(peer)) {
        peer.owedOffer = false;
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
    }

    // Both description types, not just offers. Applying a remote *answer* is
    // the moment the connection returns to stable, which makes it the first
    // legal opportunity to send an offer that had to wait — a screen share
    // started while this exchange was in flight is exactly that offer.
    if (needsNegotiation(peer)) {
      scheduleRenegotiation(peer);
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
        // Explicitly not the screen-audio sender: it is an audio sender too,
        // and swapping the microphone into it would send the mic to the
        // presentation and the film to nobody.
        const sender = peer.pc
          .getSenders()
          .find(
            (s) => s.track?.kind === "audio" && s !== peer.screenAudioSender,
          );
        if (sender) {
          await sender.replaceTrack(nextTrack);
        } else if (nextTrack) {
          peer.pc.addTrack(nextTrack, stream);
        }
      }
    },

    async setLocalScreenStream(stream: MediaStream | null) {
      localScreenStream = stream;
      const nextVideo = stream?.getVideoTracks()[0] ?? null;
      // Absent on Safari and Firefox, on any macOS screen or window capture,
      // and whenever the user leaves the "share audio" box unticked. None of
      // that is a failure here: the share is silent, exactly as it always was.
      const nextAudio = stream?.getAudioTracks()[0] ?? null;
      for (const peer of peers.values()) {
        let needsOffer = false;
        if (nextVideo) {
          if (peer.screenSender) {
            await peer.screenSender.replaceTrack(nextVideo);
          } else {
            peer.screenSender = peer.pc.addTrack(nextVideo, stream!);
            needsOffer = true;
          }
          await tuneScreenSender(peer.screenSender, peers.size, screenQuality);
        } else if (peer.screenSender) {
          peer.pc.removeTrack(peer.screenSender);
          peer.screenSender = null;
          needsOffer = true;
        }
        if (nextAudio) {
          if (peer.screenAudioSender) {
            await peer.screenAudioSender.replaceTrack(nextAudio);
          } else {
            peer.screenAudioSender = peer.pc.addTrack(nextAudio, stream!);
            needsOffer = true;
          }
        } else if (peer.screenAudioSender) {
          peer.pc.removeTrack(peer.screenAudioSender);
          peer.screenAudioSender = null;
          needsOffer = true;
        }
        // One offer covering both m-lines. Offering once per track would put
        // the second offer on the wire while the first answer was still being
        // applied, which perfect negotiation resolves by dropping it.
        //
        // Requested, not commanded: whether an offer is legal right now is the
        // connection's business, not the share's. A person clicking "share"
        // during any other exchange used to get Chrome's own SDP error printed
        // at them and lose the capture; now the tracks are on the connection
        // either way and the offer waits its turn.
        if (needsOffer) {
          await requestNegotiation(peer);
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
            await requestNegotiation(peer);
          }
          // After both branches: `replaceTrack` keeps the sender's parameters,
          // but a camera re-opened at a new quality is exactly when the ceiling
          // must follow it, and re-applying an unchanged one costs nothing.
          await tuneCameraSender(peer.cameraSender, cameraMaxBitrate);
        } else if (peer.cameraSender) {
          peer.pc.removeTrack(peer.cameraSender);
          peer.cameraSender = null;
          await requestNegotiation(peer);
        }
      }
    },

    setCameraMaxBitrate(maxBitrate: number) {
      if (maxBitrate === cameraMaxBitrate) {
        return;
      }
      cameraMaxBitrate = maxBitrate;
      retuneAllCameraSenders();
    },

    setScreenQuality(quality: VideoQuality) {
      if (quality === screenQuality) {
        return;
      }
      screenQuality = quality;
      retuneAllScreenSenders();
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

    setPeerScreenAudioStreamId(remotePeerId: string, streamId: string | null) {
      const peer = peers.get(remotePeerId);
      if (!peer || peer.remoteScreenAudioStreamId === streamId) {
        return;
      }
      const previous = peer.remoteScreenAudioStreamId;
      peer.remoteScreenAudioStreamId = streamId;
      // Share stopped: drop the stream outright rather than let it fall back
      // into the microphone slot, for the same reason the camera does.
      if (streamId === null && previous !== null) {
        peer.audioStreams.delete(previous);
      }
      classifyAudio(peer);
      emitState();
    },

    /**
     * A peer started or stopped presenting, per the roster.
     *
     * WHY A SHARE ENDING NEEDS ITS OWN SIGNAL. The other three incoming media
     * slots are announced by stream id, so each has a natural "it is over":
     * the id goes null and the stream is dropped. The screen *video* is the
     * one defined negatively — "video from this peer that is not the announced
     * camera" — so it announces nothing, and nothing here ever learned that a
     * share stopped.
     *
     * That was invisible until somebody shared twice:
     *
     *   1. First share arrives. `videoStreams` holds `{ share-1 }`, and
     *      `classifyVideo` picks it. Correct.
     *   2. They press Stop. `removeTrack` on their side only *mutes* our
     *      receiver's track — the spec is explicit that it does not end it —
     *      so `onended` never fires and `share-1` stays in the map. Harmless
     *      so far: the roster drops them from `screenSharePeerIds`, so no tile
     *      is rendered.
     *   3. They share again. A fresh `getDisplayMedia` capture means a fresh
     *      stream id, so `videoStreams` becomes `{ share-1, share-2 }`.
     *      `classifyVideo` takes the *first* non-camera stream, which is the
     *      dead `share-1` — and the tile the roster just brought back renders
     *      a stream with no frames in it. A black rectangle, permanently:
     *      nothing recomputes it, and the live `share-2` is never looked at.
     *
     * The camera has the same hazard and the same cure a few lines up ("the
     * sender's removeTrack does not reliably end the receiver-side track"); the
     * screen simply never got one.
     *
     * Dropping only fires on the true -> false edge, so a roster frame that
     * repeats `sharing: true` cannot take a live share away, and the camera's
     * own stream is left alone.
     */
    setPeerSharingScreen(remotePeerId: string, sharing: boolean) {
      const peer = peers.get(remotePeerId);
      if (!peer || peer.remoteSharingScreen === sharing) {
        return;
      }
      peer.remoteSharingScreen = sharing;
      if (sharing) {
        return;
      }
      let dropped = false;
      for (const id of [...peer.videoStreams.keys()]) {
        // Never the camera: it is announced, it is classified by that
        // announcement, and it outlives any number of screen shares.
        if (id === peer.remoteCameraStreamId) {
          continue;
        }
        peer.videoStreams.delete(id);
        dropped = true;
      }
      if (!dropped) {
        return;
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
      const preservedScreenAudioStreamId =
        previous?.remoteScreenAudioStreamId ?? null;
      const preservedSharingScreen = previous?.remoteSharingScreen ?? false;
      if (previous) {
        clearIceRestartTimer(previous);
        unregisterVoiceConnection(previous.pc);
        previous.pc.close();
        peers.delete(remotePeerId);
      }

      const managed = createPeerConnection(remotePeerId, preservedIdentity);
      // Survives the rebuild: no roster frame accompanies a manual retry, so
      // without this the re-arriving camera track would classify as a screen.
      managed.remoteCameraStreamId = preservedCameraStreamId;
      managed.remoteScreenAudioStreamId = preservedScreenAudioStreamId;
      // Same reason: a rebuild that forgot the peer was presenting would treat
      // the next `sharing: false` as a no-op and keep the dead stream.
      managed.remoteSharingScreen = preservedSharingScreen;
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
      unregisterVoiceConnection(peer.pc);
      peer.pc.close();
      peers.delete(remotePeerId);
      // The room just shrank, so whoever is left can have the departed peer's
      // share of the upload budget.
      retuneAllScreenSenders();
      emitState();
    },

    dispose() {
      for (const peer of peers.values()) {
        clearIceRestartTimer(peer);
        unregisterVoiceConnection(peer.pc);
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
