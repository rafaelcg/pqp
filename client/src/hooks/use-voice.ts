import {
  MESH_VOICE_WARNING,
  type ClientRelayMessage,
  type VoiceParticipant,
  type VoiceRoomTransport,
  type VoiceSessionInfo,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import {
  screenShareUnavailableMessage,
  supportsScreenShare,
} from "@/components/voice/capabilities";
import { desktopContext } from "@/lib/desktop";
import { translateMessage, type MessageKey } from "@/lib/i18n";
import {
  buildAudioConstraints,
  defaultMicProcessing,
  sameMicProcessing,
  type MicProcessing,
} from "@/lib/audio-devices";
import {
  connectLiveKit,
  type LiveKitIdentity,
  type LiveKitSession,
} from "@/lib/livekit-session";
import {
  createPeerConnectionManager,
  getDefaultIceServers,
  type PeerConnectionState,
  type RemotePeer,
} from "@/lib/peer-connection-manager";
import type { RealtimeTransport } from "@/lib/realtime";
import {
  createSpeakingTracker,
  createStreamAnalyser,
  readAnalyserLevel,
} from "@/lib/voice-audio";

export type VoiceStatus = "idle" | "joining" | "connected";

/**
 * One wording for "this browser cannot capture a screen", shared with the UI.
 *
 * A function, not a constant: a constant is evaluated when this module is
 * imported, which is before the non-English catalogue chunk has loaded, and
 * would pin the sentence to English for the whole session.
 */
function screenShareUnsupportedMessage(): string {
  return screenShareUnavailableMessage("no-api");
}

/**
 * Why a join was refused because of the room's transport.
 *
 * - `unsupported` — this build cannot run the transport at all (mesh-forced
 *   build, or no way to obtain an SFU session). The server refused the join
 *   before creating a peer, so nobody saw us arrive.
 * - `unreachable` — we can run it in principle but could not establish it:
 *   token request failed, or the SFU is not reachable from this network.
 *
 * Either way the user is **not** in the call and is told so. There is
 * deliberately no third option where we join on the other transport instead;
 * that is the partition this type exists to prevent.
 */
export interface VoiceTransportFailure {
  transport: VoiceRoomTransport;
  reason: "unsupported" | "unreachable";
}

const TRANSPORT_FAILURE_KEY: Record<
  VoiceTransportFailure["reason"],
  MessageKey
> = {
  unsupported: "voice.error.transportUnsupported",
  unreachable: "voice.error.transportUnreachable",
};

/**
 * How the microphone decides whether to transmit.
 *
 * - `voice-activity` — open whenever you are not muted. What this app has
 *   always done, and still the default.
 * - `push-to-talk` — closed unless a key (or the hold button) is down.
 */
export type VoiceInputMode = "voice-activity" | "push-to-talk";

export interface VoiceAudioOptions {
  inputDeviceId?: string;
  inputVolume?: number;
  /**
   * Join with the microphone already off. Applied before the track is published
   * so "mute on join" is muted from the very first sample.
   */
  startMuted?: boolean;
  inputMode?: VoiceInputMode;
  processing?: MicProcessing;
}

export interface VoiceState {
  status: VoiceStatus;
  peerId: string | null;
  remotePeers: RemotePeer[];
  /** The user's explicit mute. Independent of push-to-talk. */
  isMuted: boolean;
  /** Deafened silences everyone else and forces your own mic off, as in Discord. */
  isDeafened: boolean;
  inputMode: VoiceInputMode;
  /**
   * Whether audio is actually leaving this machine right now — the one thing
   * a push-to-talk user needs to be able to check at a glance.
   *
   * Derived, never set: `!muted && !deafened && (voice-activity || key held)`.
   * The UI reads this rather than `isMuted` when it wants to say "you are
   * live", because in push-to-talk those two answer different questions.
   */
  isTransmitting: boolean;
  error: string | null;
  voiceChannelId: string | null;
  self: VoiceParticipant | null;
  speakingPeerIds: string[];
  /** channelId → participants currently in that voice channel */
  occupancy: Record<string, VoiceParticipant[]>;
  /** userId → 0..1 playback multiplier, persisted for the session. */
  peerVolumes: Record<string, number>;
  /** True when media is flowing through an SFU rather than a peer mesh. */
  usingSfu: boolean;
  /**
   * Set when the last join was refused because this client could not use the
   * room's transport. Distinct from `error` so the UI (and tests) can tell this
   * apart from a mic failure or a dropped socket.
   */
  transportFailure: VoiceTransportFailure | null;
  /** True when this client is the one presenting. */
  isSharingScreen: boolean;
  /** peerId of whoever is presenting (self or remote), or null if nobody is. */
  screenSharePeerId: string | null;
  /** Our own outgoing capture, for a local preview of what's being shared. */
  localScreenStream: MediaStream | null;
  /**
   * Whether *our* live share is carrying sound.
   *
   * False for most shares and that is not a fault: only a Chromium browser
   * gives display audio at all, and on macOS only for a tab. The UI uses this
   * to say so once, quietly, instead of leaving people to discover the silence
   * from the other side of the call.
   */
  isSharingScreenAudio: boolean;
  // --- conversation calls ---
  /**
   * Conversations currently ringing this device, oldest first. Lives on the
   * voice controller because the frames arrive on the voice signaling path,
   * and survives joins/leaves of *other* calls — an invitation is not call
   * state of ours until we accept it.
   */
  incomingCalls: IncomingCall[];
  /** True while our camera capture is live and being sent to the call. */
  isCameraOn: boolean;
  /** Our own camera capture, for the self tile. */
  localCameraStream: MediaStream | null;
  /** Users who declined the current call's ring (cleared on join/leave). */
  callDeclinedUserIds: string[];
}

/** One ringing invitation, as shown on the incoming-call surface. */
export interface IncomingCall {
  conversationId: string;
  kind: "dm" | "group";
  caller: { userId: string; displayName: string; avatarUrl: string | null };
}

interface MicPipeline {
  rawStream: MediaStream;
  processedStream: MediaStream;
  audioContext: AudioContext;
  gainNode: GainNode;
  analyser: AnalyserNode;
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function clampVolume(value: number): number {
  if (Number.isNaN(value)) {
    return 1;
  }
  return Math.min(2, Math.max(0, value));
}

function sameSpeaking(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

async function createMicPipeline(
  deviceId: string | undefined,
  inputVolume: number,
  processing: MicProcessing,
): Promise<MicPipeline> {
  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: buildAudioConstraints(deviceId, processing),
    video: false,
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(rawStream);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = clampVolume(inputVolume);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  const destination = audioContext.createMediaStreamDestination();

  source.connect(gainNode);
  gainNode.connect(analyser);
  gainNode.connect(destination);

  return {
    rawStream,
    processedStream: destination.stream,
    audioContext,
    gainNode,
    analyser,
  };
}

function stopMicPipeline(pipeline: MicPipeline | null) {
  if (!pipeline) {
    return;
  }
  for (const track of pipeline.rawStream.getTracks()) {
    track.stop();
  }
  void pipeline.audioContext.close();
}

function micErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return translateMessage("voice.error.micFailed");
  }
  if (err.name === "NotAllowedError") {
    return translateMessage("voice.error.micBlocked", desktopContext());
  }
  // A browser's own message, in the browser's own language. Better than a
  // generic sentence that throws away what actually went wrong.
  return err.message;
}

function screenShareErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return translateMessage("voice.error.shareFailed");
  }
  if (err.name === "NotSupportedError" || err instanceof TypeError) {
    // A browser without getDisplayMedia throws a TypeError from the call
    // itself. That is a platform limit, not a fault: say it plainly rather
    // than surfacing "…is not a function" as an alarm.
    return screenShareUnsupportedMessage();
  }
  if (err.name === "NotAllowedError") {
    // Also covers the user dismissing the OS/browser picker without choosing
    // a source — that rejects with the same error name, so this isn't really
    // a permissions problem in the usual sense, but the copy still fits.
    return translateMessage("voice.error.shareBlocked");
  }
  return err.message;
}

/**
 * The display-capture options the DOM lib does not know about yet.
 *
 * `systemAudio`, `selfBrowserSurface` and `surfaceSwitching` are Screen Capture
 * spec extensions that TypeScript's `DisplayMediaStreamOptions` still omits.
 * Declared narrowly, as the three fields we actually pass, so a typo stays a
 * compile error, where casting the call to `any` would hide exactly the
 * mistakes this feature is most likely to make. A browser that does not know a key
 * ignores it, which is the degradation we want.
 */
interface ScreenCaptureOptions extends DisplayMediaStreamOptions {
  /** Chromium: offer the machine's own output as a capturable source. */
  systemAudio?: "include" | "exclude";
  /** Chromium: whether the tab running this app may be picked. */
  selfBrowserSurface?: "include" | "exclude";
  /** Chromium: offer "share this tab instead" while a share is running. */
  surfaceSwitching?: "include" | "exclude";
}

/**
 * What we ask a screen capture for.
 *
 * Audio is requested every time; a browser that cannot supply it answers with a
 * stream that simply has no audio track, and every path below treats that as
 * normal rather than as an error. The mic's processing chain is explicitly off:
 * echo cancellation and noise suppression exist for a person talking into a
 * laptop and would chew holes in a film's soundtrack.
 *
 * `selfBrowserSurface: "exclude"` is the anti-feedback rule. Sharing the pqp
 * tab itself would put the call's own audio back into the call, and the loop
 * gets louder every trip; the picker not offering that tab is a cheaper answer
 * than an echo nobody can locate.
 */
const SCREEN_CAPTURE_OPTIONS: ScreenCaptureOptions = {
  // `video: true` used to be the whole of this, and it is why a share arrived
  // as a slideshow. With no frameRate asked for, a capture of a large surface
  // is handed over at whatever rate the browser feels like, and with no ceiling
  // on size a 4K or Retina display is captured at its full pixel count and then
  // has to be scaled down inside the encoder every frame. 1080p30 is the shape
  // of the thing people actually share, and asking for it is cheaper than
  // paying for pixels nobody in the call can see.
  video: {
    frameRate: { ideal: 30, max: 30 },
    width: { max: 1920 },
    height: { max: 1080 },
  },
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  systemAudio: "include",
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
};

/**
 * Supplies an SFU session for a voice channel.
 *
 * Registering one is a statement of **capability**, not a choice of transport:
 * whether media actually goes through the SFU is decided per room by the server
 * and delivered in `welcome.transport`. With a provider registered this client
 * can run either transport; without one it can only run mesh, and the server
 * will refuse to admit it to an SFU room rather than let it sit there inaudible.
 */
export type VoiceSessionProvider = (
  voiceChannelId: string,
  peerId: string,
) => Promise<VoiceSessionInfo | null>;

export function createVoiceController(transport: RealtimeTransport) {
  let manager: ReturnType<typeof createPeerConnectionManager> | null = null;
  let sfu: LiveKitSession | null = null;
  let sessionProvider: VoiceSessionProvider | null = null;
  /**
   * What to assume when `welcome` carries no `transport` — i.e. the server
   * predates the field. Set from `GET /api/voice/backend` at bootstrap, which
   * is the only thing an older server can tell us. Never used when the server
   * states the room's transport, which it always does from this version on.
   */
  let legacyRoomTransport: VoiceRoomTransport = "mesh";
  /** peerId → roster identity, used to label SFU participants. */
  const identities = new Map<string, LiveKitIdentity>();
  let pipeline: MicPipeline | null = null;
  /** Owns the getDisplayMedia() capture; mirrored into state.localScreenStream. */
  let screenCaptureStream: MediaStream | null = null;
  let joinTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let speakingRaf = 0;
  let iceServers: RTCIceServer[] = getDefaultIceServers();
  const remoteAnalysers = new Map<
    string,
    { analyser: AnalyserNode; dispose: () => void }
  >();
  const speakingTracker = createSpeakingTracker();
  // Peers the server has told us are in *our* room. Signaling from anyone else
  // is dropped so a stray/cross-room offer can never open a mic connection.
  const knownPeerIds = new Set<string>();
  let joinGeneration = 0;
  // The room the user means to be in. Kept across a WS drop so we can auto-
  // rejoin on reconnect instead of ejecting them from the call.
  let intendedChannelId: string | null = null;
  let audioOptions: Required<
    Pick<VoiceAudioOptions, "inputDeviceId" | "inputVolume" | "processing">
  > = {
    inputDeviceId: "",
    inputVolume: 1,
    processing: defaultMicProcessing,
  };
  /**
   * True only while the push-to-talk key or button is physically down.
   *
   * Module-private on purpose: nothing outside `setPushToTalkActive` may set
   * it, and every path that could lose track of the key (mode change, leave,
   * reconnect) resets it to `false`. A stuck-open mic is the worst outcome this
   * feature can produce, so the invariant is that this only ever *fails closed*.
   */
  let pushToTalkHeld = false;
  // --- conversation calls: controller-privates ---
  /** Ring the room's absent participants as soon as this join is welcomed. */
  let ringOnWelcomeChannelId: string | null = null;
  /** Owns the camera capture; mirrored into state.localCameraStream. */
  let cameraCaptureStream: MediaStream | null = null;
  let state: VoiceState = {
    status: "idle",
    peerId: null,
    remotePeers: [],
    isMuted: false,
    isDeafened: false,
    inputMode: "voice-activity",
    // No mic yet, so nothing is going anywhere. `join` recomputes it.
    isTransmitting: false,
    error: null,
    voiceChannelId: null,
    self: null,
    speakingPeerIds: [],
    occupancy: {},
    peerVolumes: {},
    usingSfu: false,
    transportFailure: null,
    isSharingScreen: false,
    screenSharePeerId: null,
    localScreenStream: null,
    isSharingScreenAudio: false,
    incomingCalls: [],
    isCameraOn: false,
    localCameraStream: null,
    callDeclinedUserIds: [],
  };
  let listener: ((state: VoiceState) => void) | null = null;

  function clearJoinTimeout() {
    if (joinTimeoutId) {
      clearTimeout(joinTimeoutId);
      joinTimeoutId = null;
    }
  }

  /** Which transports this client can actually run — sent with every join. */
  function transportCapabilities(): [
    VoiceRoomTransport,
    ...VoiceRoomTransport[],
  ] {
    return sessionProvider ? ["mesh", "livekit"] : ["mesh"];
  }

  function sendJoin(voiceChannelId: string) {
    transport.sendVoice({
      type: "join-voice-room",
      voiceChannelId,
      transports: transportCapabilities(),
    });
  }

  /**
   * Returns the generation this attempt owns; older attempts are abandoned.
   *
   * The same timer covers the WebSocket handshake *and*, on an SFU room, the
   * media connection: `welcome` does not mean the call is up, and a black-holed
   * SFU host used to take LiveKit's own 15s to give up while the UI said "Voice
   * connected". Nothing here reports a live call until media is actually running.
   */
  function armJoinTimeout(failure?: VoiceTransportFailure): number {
    clearJoinTimeout();
    const generation = ++joinGeneration;
    joinTimeoutId = setTimeout(() => {
      if (state.status === "joining" && generation === joinGeneration) {
        // A media transport that never came up is a transport failure, and has
        // to look like one: a black-holed SFU host hangs rather than refusing,
        // and that is the *likely* cloud failure, not the exotic one.
        if (failure) {
          refuseTransport(failure);
          return;
        }
        joinGeneration++;
        // Release the mic so the browser recording indicator clears, and tell
        // the server to drop us if the room ever registered the join.
        stopMicPipeline(pipeline);
        pipeline = null;
        intendedChannelId = null;
        ringOnWelcomeChannelId = null;
        releaseCameraCapture();
        pushToTalkHeld = false;
        state.isTransmitting = false;
        void teardownSfu();
        manager?.dispose();
        manager = null;
        transport.sendVoice({ type: "leave-voice-room" });
        state.error =
          "Voice connection timed out. Is the server running and WebSocket connected?";
        state.status = "idle";
        state.peerId = null;
        state.self = null;
        state.remotePeers = [];
        state.voiceChannelId = null;
        emit();
      }
    }, 12_000);
    return generation;
  }

  /**
   * The room runs a transport we cannot run. Leave — do not build the other one.
   *
   * Falling back to mesh here is what used to make two people sit in a call
   * unable to hear each other with no error anywhere. The user is told, and the
   * `leave-voice-room` keeps them out of everyone else's roster so nobody is
   * left talking to a participant who was never there.
   */
  function refuseTransport(failure: VoiceTransportFailure) {
    clearJoinTimeout();
    joinGeneration++;
    intendedChannelId = null;
    ringOnWelcomeChannelId = null;
    knownPeerIds.clear();
    stopSpeakingLoop();
    disposeRemoteAnalysers();
    transport.sendVoice({ type: "leave-voice-room" });
    manager?.dispose();
    manager = null;
    void teardownSfu();
    stopMicPipeline(pipeline);
    pipeline = null;
    releaseScreenCapture();
    releaseCameraCapture();
    pushToTalkHeld = false;
    state.isTransmitting = false;
    state.status = "idle";
    state.peerId = null;
    state.self = null;
    state.remotePeers = [];
    state.voiceChannelId = null;
    state.speakingPeerIds = [];
    state.transportFailure = failure;
    state.error = translateMessage(TRANSPORT_FAILURE_KEY[failure.reason]);
    emit();
  }

  // WS dropped mid-call: the media session is dead. Tear it down but keep the
  // mic pipeline and intendedChannelId so we can rejoin on reconnect.
  function teardownMeshForReconnect() {
    knownPeerIds.clear();
    stopSpeakingLoop();
    disposeRemoteAnalysers();
    manager?.dispose();
    manager = null;
    void teardownSfu();
    state.peerId = null;
    state.remotePeers = [];
    state.self = null;
    state.speakingPeerIds = [];
  }

  function snapshot(): VoiceState {
    return {
      ...state,
      remotePeers: [...state.remotePeers],
      speakingPeerIds: [...state.speakingPeerIds],
      occupancy: { ...state.occupancy },
      peerVolumes: { ...state.peerVolumes },
      self: state.self ? { ...state.self } : null,
      incomingCalls: [...state.incomingCalls],
      callDeclinedUserIds: [...state.callDeclinedUserIds],
    };
  }

  function emit() {
    listener?.(snapshot());
  }

  function sendRelay(message: ClientRelayMessage) {
    if (!state.peerId) {
      return;
    }
    transport.sendVoice({ ...message, from: state.peerId });
  }

  /**
   * The single answer to "should sound be leaving this machine".
   *
   * Everything that could close the mic is folded in here rather than at each
   * call site, so there is exactly one expression to get right — and so a mode
   * change, a mute, a deafen and a released key all funnel through the same
   * recomputation. Mute and deafen outrank push-to-talk deliberately: holding
   * the key while muted must not transmit, or the mute button would be a lie.
   */
  function micShouldBeOpen(): boolean {
    if (state.isDeafened || state.isMuted) {
      return false;
    }
    return state.inputMode === "voice-activity" || pushToTalkHeld;
  }

  function applyMuteToPipeline() {
    state.isTransmitting = micShouldBeOpen();
    if (!pipeline) {
      return;
    }
    for (const track of pipeline.processedStream.getAudioTracks()) {
      track.enabled = state.isTransmitting;
    }
    for (const track of pipeline.rawStream.getAudioTracks()) {
      track.enabled = state.isTransmitting;
    }
  }

  /**
   * Both transports, every time.
   *
   * Disabling the track is what stops mesh peers hearing anything — an
   * `enabled: false` track sends silence over the existing sender, which is why
   * push-to-talk never renegotiates. LiveKit needs to be told separately: it
   * has its own publication state, and leaving that unmuted would keep sending
   * (silent) packets and, worse, keep the SFU's own speaking indicator lit for
   * everyone else in the room.
   */
  function applyMute() {
    applyMuteToPipeline();
    void sfu?.setMuted(!state.isTransmitting);
  }

  /**
   * Re-capture the mic on the current settings and swap it into the live call.
   *
   * Shared by the device picker and the processing toggles because they are the
   * same operation: both change what `getUserMedia` must be asked for, and
   * neither is allowed to interrupt the call to do it. The old pipeline is only
   * stopped once the new one exists, so a `getUserMedia` that fails (device
   * unplugged, constraint unsatisfiable) leaves the working mic in place and
   * reports the error rather than dropping the user into silence.
   */
  async function swapPipeline(failureMessage: string) {
    if (!pipeline || state.status === "idle") {
      return;
    }
    try {
      const next = await createMicPipeline(
        audioOptions.inputDeviceId || undefined,
        audioOptions.inputVolume,
        audioOptions.processing,
      );
      stopMicPipeline(pipeline);
      pipeline = next;
      // Carries mute, deafen and the push-to-talk gate onto the new track: a
      // swap must never be a way to end up transmitting when you were not.
      applyMuteToPipeline();

      if (manager) {
        await manager.replaceLocalTrack(pipeline.processedStream);
      }
      if (sfu) {
        await sfu.replaceTrack(pipeline.processedStream);
        await sfu.setMuted(!state.isTransmitting);
      }
      emit();
    } catch (err) {
      state.error = err instanceof Error ? err.message : failureMessage;
      emit();
    }
  }

  function disposeRemoteAnalysers() {
    for (const entry of remoteAnalysers.values()) {
      entry.dispose();
    }
    remoteAnalysers.clear();
  }

  function syncRemoteAnalysers(peers: RemotePeer[]) {
    const live = new Set(peers.map((p) => p.peerId));
    for (const [peerId, entry] of remoteAnalysers) {
      if (!live.has(peerId)) {
        entry.dispose();
        remoteAnalysers.delete(peerId);
      }
    }
    for (const peer of peers) {
      if (!peer.stream || remoteAnalysers.has(peer.peerId)) {
        continue;
      }
      const created = createStreamAnalyser(peer.stream);
      if (created) {
        remoteAnalysers.set(peer.peerId, {
          analyser: created.analyser,
          dispose: created.dispose,
        });
      }
    }
  }

  function stopSpeakingLoop() {
    if (speakingRaf) {
      cancelAnimationFrame(speakingRaf);
      speakingRaf = 0;
    }
    speakingTracker.clear();
    if (state.speakingPeerIds.length > 0) {
      state.speakingPeerIds = [];
      emit();
    }
  }

  function startSpeakingLoop() {
    stopSpeakingLoop();
    const tick = () => {
      const next: string[] = [];
      // `isTransmitting`, not `!isMuted`: in push-to-talk between presses the
      // mic is live and the analyser still reads a level, but nobody can hear
      // it. Lighting the speaking ring then would be the panel claiming you are
      // being heard when you are not.
      if (pipeline && state.peerId && state.isTransmitting) {
        const level = readAnalyserLevel(pipeline.analyser);
        if (speakingTracker.update(state.peerId, level, true)) {
          next.push(state.peerId);
        }
      } else if (state.peerId) {
        speakingTracker.update(state.peerId, 0, false);
      }

      for (const [peerId, entry] of remoteAnalysers) {
        const level = readAnalyserLevel(entry.analyser);
        if (speakingTracker.update(peerId, level, true)) {
          next.push(peerId);
        }
      }

      next.sort();
      if (!sameSpeaking(state.speakingPeerIds, next)) {
        state.speakingPeerIds = next;
        emit();
      }
      speakingRaf = requestAnimationFrame(tick);
    };
    speakingRaf = requestAnimationFrame(tick);
  }

  function toIdentity(participant: VoiceParticipant) {
    return {
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
    };
  }

  async function teardownSfu() {
    const session = sfu;
    sfu = null;
    state.usingSfu = false;
    identities.clear();
    if (session) {
      try {
        await session.disconnect();
      } catch {
        // already gone
      }
    }
  }

  /** Stops the capture tracks only — no network call, no peer teardown. */
  function releaseScreenCapture() {
    if (!screenCaptureStream) {
      return;
    }
    for (const track of screenCaptureStream.getTracks()) {
      track.stop();
    }
    screenCaptureStream = null;
    state.isSharingScreen = false;
    state.localScreenStream = null;
    state.isSharingScreenAudio = false;
  }

  /**
   * The stream id to announce for a capture that carries sound, or null.
   *
   * Receivers on the mesh path need it to tell the presentation's audio from
   * the presenter's microphone (see `voiceParticipantSchema.screenAudioStreamId`),
   * and it is re-sent with every `set-sharing-screen` so a reconnect or a lost
   * audio track cannot leave a stale one on the roster.
   */
  function screenAudioStreamId(): string | null {
    if (!screenCaptureStream) {
      return null;
    }
    return screenCaptureStream.getAudioTracks().length > 0
      ? screenCaptureStream.id
      : null;
  }

  /** Announce the share (and whether it has sound) to the room. */
  function announceSharing() {
    transport.sendVoice({
      type: "set-sharing-screen",
      sharing: true,
      audioStreamId: screenAudioStreamId(),
    });
  }

  /**
   * The capture lost its audio but kept its picture.
   *
   * Happens on its own when the shared tab stops producing sound the browser
   * will hand over, and it must not read as "the share ended": the video is
   * still live and still wanted. Only the audio half is withdrawn, from both
   * transports and from the roster.
   */
  async function dropScreenAudio(track: MediaStreamTrack) {
    if (!screenCaptureStream) {
      return;
    }
    screenCaptureStream.removeTrack(track);
    track.stop();
    state.isSharingScreenAudio = false;
    announceSharing();
    await manager?.setLocalScreenStream(screenCaptureStream);
    if (sfu) {
      await sfu.unpublishScreenAudio();
    }
    emit();
  }

  /**
   * Wire the capture's tracks to the two ways a share can end.
   *
   * The video track ending is the browser's own "Stop sharing" bar (and the
   * shared window closing); the audio track can end by itself. Both are events
   * nothing else observes, which is why neither can be left unhandled.
   */
  function watchScreenCapture(stream: MediaStream) {
    const video = stream.getVideoTracks()[0];
    if (video) {
      video.onended = () => {
        void stopScreenShareInternal();
        emit();
      };
    }
    const audio = stream.getAudioTracks()[0];
    if (audio) {
      audio.onended = () => {
        void dropScreenAudio(audio);
      };
    }
  }

  /** Full stop while still in-call: releases the capture and tells everyone. */
  async function stopScreenShareInternal() {
    if (!screenCaptureStream) {
      return;
    }
    releaseScreenCapture();
    transport.sendVoice({
      type: "set-sharing-screen",
      sharing: false,
      audioStreamId: null,
    });
    await manager?.setLocalScreenStream(null);
    if (sfu) {
      await sfu.unpublishScreen();
    }
  }

  // --- conversation calls: camera capture -----------------------------------

  /** Stops the camera tracks only — no network call, no peer teardown. */
  function releaseCameraCapture() {
    if (!cameraCaptureStream) {
      return;
    }
    for (const track of cameraCaptureStream.getTracks()) {
      track.stop();
    }
    cameraCaptureStream = null;
    state.isCameraOn = false;
    state.localCameraStream = null;
  }

  /** Full stop while still in-call: releases the capture and tells everyone. */
  async function stopCameraInternal() {
    if (!cameraCaptureStream) {
      return;
    }
    releaseCameraCapture();
    transport.sendVoice({ type: "set-camera", streamId: null });
    await manager?.setLocalCameraStream(null);
    if (sfu) {
      await sfu.unpublishCamera();
    }
  }

  /**
   * Camera stream ids from the roster → the mesh manager, which uses them to
   * tell an incoming camera track from an incoming screen track. A no-op per
   * peer when nothing changed, and a no-op entirely on the SFU path (null
   * manager), where LiveKit labels tracks itself.
   */
  function applyCameraStreamIds(participants: VoiceParticipant[]) {
    if (!manager) {
      return;
    }
    for (const participant of participants) {
      if (participant.peerId !== state.peerId) {
        manager.setPeerCameraStreamId(
          participant.peerId,
          participant.cameraStreamId ?? null,
        );
      }
    }
  }

  /** The same trip for screen audio, and a no-op on the SFU path for the same reason. */
  function applyScreenAudioStreamIds(participants: VoiceParticipant[]) {
    if (!manager) {
      return;
    }
    for (const participant of participants) {
      if (participant.peerId !== state.peerId) {
        manager.setPeerScreenAudioStreamId(
          participant.peerId,
          participant.screenAudioStreamId ?? null,
        );
      }
    }
  }

  function removeIncomingCall(conversationId: string) {
    const before = state.incomingCalls.length;
    state.incomingCalls = state.incomingCalls.filter(
      (call) => call.conversationId !== conversationId,
    );
    return state.incomingCalls.length !== before;
  }

  // --- end conversation calls -----------------------------------------------

  /**
   * SFU media path. Returns false if the session could not be established —
   * the caller then *leaves the call and says so*. It must never build a mesh
   * instead: the rest of the room is on the SFU and would neither hear this
   * client nor see it drop out.
   */
  async function startSfuSession(
    voiceChannelId: string,
    peerId: string,
    peers: VoiceParticipant[],
  ): Promise<boolean> {
    if (!sessionProvider) {
      return false;
    }
    try {
      const session = await sessionProvider(voiceChannelId, peerId);
      if (!session) {
        return false;
      }
      // A leave() may have landed while the token request was in flight.
      if (state.peerId !== peerId) {
        return true;
      }

      for (const peer of peers) {
        identities.set(peer.peerId, toIdentity(peer));
      }

      sfu = await connectLiveKit({
        session,
        lookupIdentity: (id) => identities.get(id),
        onPeersChanged: (remote) => {
          state.remotePeers = remote;
          syncRemoteAnalysers(remote);
          emit();
        },
        onError: (msg) => {
          state.error = msg;
          emit();
        },
      });

      if (state.peerId !== peerId) {
        await teardownSfu();
        return true;
      }
      if (pipeline) {
        await sfu.publish(pipeline.processedStream);
        // The gate, not the mute flag — a push-to-talk user who joins an SFU
        // room without the key down must be published muted.
        await sfu.setMuted(!state.isTransmitting);
      }
      // A screen share started before a reconnect rebuilds the session — the
      // capture itself survives the WS drop (it's a browser-level grant, not
      // tied to the connection), only the publish needs redoing.
      if (screenCaptureStream) {
        await sfu.publishScreen(screenCaptureStream);
        announceSharing();
      }
      // Same story for the camera in a conversation call.
      if (cameraCaptureStream) {
        await sfu.publishCamera(cameraCaptureStream);
        transport.sendVoice({
          type: "set-camera",
          streamId: cameraCaptureStream.id,
        });
      }
      state.usingSfu = true;
      emit();
      return true;
    } catch (err) {
      console.warn("[pqp] SFU session failed — leaving the call", err);
      await teardownSfu();
      return false;
    }
  }

  function startMeshSession(peerId: string, peers: VoiceParticipant[]) {
    manager = createPeerConnectionManager(peerId, sendRelay, iceServers);
    if (pipeline) {
      manager.setLocalStream(pipeline.processedStream);
    }
    // See the matching comment in startSfuSession: carry an in-progress share
    // forward across a rebuilt mesh (e.g. after a WS reconnect).
    if (screenCaptureStream) {
      void manager.setLocalScreenStream(screenCaptureStream);
      announceSharing();
    }
    // And the camera of a conversation call.
    if (cameraCaptureStream) {
      void manager.setLocalCameraStream(cameraCaptureStream);
      transport.sendVoice({
        type: "set-camera",
        streamId: cameraCaptureStream.id,
      });
    }
    manager.onPeerStateChange((remote) => {
      state.remotePeers = remote;
      syncRemoteAnalysers(remote);
      emit();
    });
    for (const peer of peers) {
      manager.connectToPeer(peer.peerId, toIdentity(peer));
      manager.setPeerCameraStreamId(peer.peerId, peer.cameraStreamId ?? null);
      manager.setPeerScreenAudioStreamId(
        peer.peerId,
        peer.screenAudioStreamId ?? null,
      );
    }
  }

  function handleSignaling(message: VoiceSignalingMessage) {
    switch (message.type) {
      case "voice-roster":
        state.occupancy = {
          ...state.occupancy,
          [message.voiceChannelId]: message.participants,
        };
        if (message.participants.length === 0) {
          const next = { ...state.occupancy };
          delete next[message.voiceChannelId];
          state.occupancy = next;
        }
        // Rebuild the signaling allowlist from the room's authoritative roster
        // snapshot (not just append), so a stale id from a missed/out-of-order
        // peer-left can't linger as a trusted signaling source. Safe against
        // dropping a valid peer: the server sends peer-joined before the roster
        // on the same ordered socket, and only our own room's roster resets it.
        if (message.voiceChannelId === state.voiceChannelId) {
          knownPeerIds.clear();
          for (const participant of message.participants) {
            if (participant.peerId !== state.peerId) {
              knownPeerIds.add(participant.peerId);
            }
          }
          state.screenSharePeerId =
            message.participants.find((p) => p.sharingScreen)?.peerId ?? null;
          // Mesh camera classification rides the roster — see the banner.
          applyCameraStreamIds(message.participants);
          applyScreenAudioStreamIds(message.participants);
        }
        emit();
        break;
      case "screen-share-denied":
        if (message.voiceChannelId !== state.voiceChannelId) {
          return;
        }
        void stopScreenShareInternal();
        state.error = translateMessage("voice.error.shareTaken");
        emit();
        break;
      case "voice-room-full":
        clearJoinTimeout();
        stopMicPipeline(pipeline);
        pipeline = null;
        intendedChannelId = null;
        state.error = translateMessage("voice.error.channelFull", {
          limit: message.limit,
        });
        state.status = "idle";
        state.voiceChannelId = null;
        emit();
        break;
      case "welcome": {
        // Drop a welcome that arrives after we already gave up (join timeout)
        // or left — otherwise it would flip us back to "connected" with no mic.
        if (state.status !== "joining") {
          transport.sendVoice({ type: "leave-voice-room" });
          return;
        }
        knownPeerIds.clear();
        state.peerId = message.peerId;
        state.voiceChannelId = message.voiceChannelId;
        state.self = message.self;
        state.transportFailure = null;

        const welcomePeers = message.peers;
        for (const peer of welcomePeers) {
          knownPeerIds.add(peer.peerId);
        }
        const channelId = message.voiceChannelId;
        const peerId = message.peerId;
        // The server owns this. We never re-derive it, and we never substitute
        // the other transport when ours fails.
        const roomTransport = message.transport ?? legacyRoomTransport;

        // Rejoin/channel-switch: tear the previous session down before building
        // a new one, or its connections and ICE-restart timers leak.
        manager?.dispose();
        manager = null;
        void teardownSfu();

        if (roomTransport === "livekit") {
          if (!sessionProvider) {
            // Only reachable against a server old enough to omit `transport`;
            // a current one refuses this join before minting a peer.
            refuseTransport({
              transport: roomTransport,
              reason: "unsupported",
            });
            break;
          }
          // Still "joining": on the SFU path the call is not up until media is,
          // and the timer bounds how long that can be claimed. A black-holed
          // LiveKit host takes ~15s to reject on its own, which used to be 15s
          // of "Voice connected" with no audio in either direction.
          const generation = armJoinTimeout({
            transport: roomTransport,
            reason: "unreachable",
          });
          void startSfuSession(channelId, peerId, welcomePeers).then((ok) => {
            if (generation !== joinGeneration || state.peerId !== peerId) {
              return;
            }
            clearJoinTimeout();
            if (!ok) {
              refuseTransport({
                transport: roomTransport,
                reason: "unreachable",
              });
              return;
            }
            state.status = "connected";
            // A conversation call rings only once we are genuinely in it —
            // never for a join that is about to be refused.
            if (ringOnWelcomeChannelId === channelId) {
              ringOnWelcomeChannelId = null;
              transport.sendVoice({
                type: "call-ring",
                conversationId: channelId,
              });
            }
            startSpeakingLoop();
            emit();
          });
          emit();
          break;
        }

        clearJoinTimeout();
        state.status = "connected";
        if (ringOnWelcomeChannelId === channelId) {
          ringOnWelcomeChannelId = null;
          transport.sendVoice({ type: "call-ring", conversationId: channelId });
        }
        startMeshSession(peerId, welcomePeers);
        startSpeakingLoop();
        emit();
        break;
      }
      case "voice-transport-unsupported":
        // The server refused before creating a peer: no roster entry of ours
        // ever existed, so there is nothing for anyone else to clean up.
        if (
          state.status === "idle" ||
          message.voiceChannelId !== state.voiceChannelId
        ) {
          return;
        }
        refuseTransport({
          transport: message.transport,
          reason: "unsupported",
        });
        break;
      case "peer-joined":
        knownPeerIds.add(message.peer.peerId);
        identities.set(message.peer.peerId, toIdentity(message.peer));
        manager?.connectToPeer(message.peer.peerId, toIdentity(message.peer));
        manager?.setPeerCameraStreamId(
          message.peer.peerId,
          message.peer.cameraStreamId ?? null,
        );
        manager?.setPeerScreenAudioStreamId(
          message.peer.peerId,
          message.peer.screenAudioStreamId ?? null,
        );
        break;
      case "peer-left":
        knownPeerIds.delete(message.peerId);
        identities.delete(message.peerId);
        manager?.removePeer(message.peerId);
        {
          const entry = remoteAnalysers.get(message.peerId);
          if (entry) {
            entry.dispose();
            remoteAnalysers.delete(message.peerId);
          }
        }
        break;
      case "offer":
        if (!knownPeerIds.has(message.from)) {
          return;
        }
        void manager?.handleOffer(message.from, message.sdp);
        break;
      case "answer":
        if (!knownPeerIds.has(message.from)) {
          return;
        }
        void manager?.handleAnswer(message.from, message.sdp);
        break;
      case "ice-candidate":
        if (!knownPeerIds.has(message.from)) {
          return;
        }
        void manager?.handleIceCandidate(message.from, message.candidate);
        break;
      // --- conversation calls ---
      case "call-incoming":
        // Already in (or joining) this call on this device — nothing to answer.
        if (
          state.voiceChannelId === message.conversationId &&
          state.status !== "idle"
        ) {
          return;
        }
        if (
          state.incomingCalls.some(
            (call) => call.conversationId === message.conversationId,
          )
        ) {
          return;
        }
        state.incomingCalls = [
          ...state.incomingCalls,
          {
            conversationId: message.conversationId,
            kind: message.kind,
            caller: message.caller,
          },
        ];
        emit();
        break;
      case "call-ring-cancelled":
        if (removeIncomingCall(message.conversationId)) {
          emit();
        }
        break;
      case "call-declined":
        if (message.conversationId !== state.voiceChannelId) {
          return;
        }
        if (!state.callDeclinedUserIds.includes(message.userId)) {
          state.callDeclinedUserIds = [
            ...state.callDeclinedUserIds,
            message.userId,
          ];
          emit();
        }
        break;
    }
  }

  return {
    onStateChange(cb: (next: VoiceState) => void) {
      listener = cb;
    },

    getState() {
      return snapshot();
    },

    getAnalyser() {
      return pipeline?.analyser ?? null;
    },

    handleSignaling,

    /**
     * Declare that this client can obtain SFU sessions. Pass `null` for a build
     * that cannot (mesh-forced), which the server is then told about on join.
     *
     * `legacyTransport` is only consulted when the server's `welcome` carries no
     * `transport` field — i.e. a server older than this protocol, where
     * `GET /api/voice/backend` is the best information available.
     */
    setSessionProvider(
      provider: VoiceSessionProvider | null,
      legacyTransport: VoiceRoomTransport = "mesh",
    ) {
      sessionProvider = provider;
      legacyRoomTransport = provider ? legacyTransport : "mesh";
    },

    setIceServers(servers: IceServerConfig[]) {
      if (servers.length === 0) {
        return;
      }
      iceServers = servers as RTCIceServer[];
      manager?.setIceServers(iceServers);
    },

    async retryPeer(peerId: string) {
      await manager?.retryPeer(peerId);
    },

    async join(voiceChannelId: string, options?: VoiceAudioOptions) {
      state.error = null;
      state.transportFailure = null;
      state.status = "joining";
      // Known from the moment we start, not only once the server says welcome —
      // otherwise the UI cannot tell which channel is connecting.
      state.voiceChannelId = voiceChannelId;
      intendedChannelId = voiceChannelId;
      // Joining a conversation that was ringing us IS the acceptance, so the
      // invitation surface for it comes down; declines belong to the last call.
      removeIncomingCall(voiceChannelId);
      state.callDeclinedUserIds = [];
      // A ring armed for a previous join must not fire for this one.
      if (ringOnWelcomeChannelId && ringOnWelcomeChannelId !== voiceChannelId) {
        ringOnWelcomeChannelId = null;
      }
      // Applied before the track exists, so "mute on join" is genuinely muted
      // from the first sample rather than a moment later.
      state.isMuted = options?.startMuted ?? state.isMuted;
      // Never inherit a key held from before the join — there is no keyup owed
      // to us for a press that happened while we were not in a call.
      pushToTalkHeld = false;
      state.inputMode = options?.inputMode ?? state.inputMode;
      state.isTransmitting = micShouldBeOpen();
      emit();

      if (options) {
        audioOptions = {
          inputDeviceId: options.inputDeviceId ?? audioOptions.inputDeviceId,
          inputVolume: options.inputVolume ?? audioOptions.inputVolume,
          processing: options.processing ?? audioOptions.processing,
        };
      }

      const generation = armJoinTimeout();

      try {
        stopMicPipeline(pipeline);
        let next: MicPipeline;
        try {
          next = await createMicPipeline(
            audioOptions.inputDeviceId || undefined,
            audioOptions.inputVolume,
            audioOptions.processing,
          );
        } catch (deviceError) {
          if (!audioOptions.inputDeviceId) {
            throw deviceError;
          }
          next = await createMicPipeline(
            undefined,
            audioOptions.inputVolume,
            audioOptions.processing,
          );
        }

        // Abandoned (left, timed out, or superseded) while the permission
        // prompt was open: never open a mic for a join nobody is waiting on.
        if (generation !== joinGeneration) {
          stopMicPipeline(next);
          return;
        }

        pipeline = next;
        applyMuteToPipeline();
        sendJoin(voiceChannelId);
      } catch (err) {
        if (generation !== joinGeneration) {
          return;
        }
        clearJoinTimeout();
        stopMicPipeline(pipeline);
        pipeline = null;
        intendedChannelId = null;
        state.error = micErrorMessage(err);
        state.status = "idle";
        state.voiceChannelId = null;
        emit();
      }
    },

    leave() {
      clearJoinTimeout();
      joinGeneration++;
      intendedChannelId = null;
      ringOnWelcomeChannelId = null;
      knownPeerIds.clear();
      stopSpeakingLoop();
      disposeRemoteAnalysers();
      transport.sendVoice({ type: "leave-voice-room" });
      manager?.dispose();
      manager = null;
      void teardownSfu();
      stopMicPipeline(pipeline);
      pipeline = null;
      releaseScreenCapture();
      releaseCameraCapture();
      pushToTalkHeld = false;
      state = {
        status: "idle",
        peerId: null,
        remotePeers: [],
        isMuted: false,
        isDeafened: false,
        // The input mode is a user preference, not call state: it survives
        // leaving, exactly as the device and volume choices do.
        inputMode: state.inputMode,
        isTransmitting: false,
        error: null,
        voiceChannelId: null,
        self: null,
        speakingPeerIds: [],
        occupancy: state.occupancy,
        peerVolumes: state.peerVolumes,
        usingSfu: false,
        transportFailure: null,
        isSharingScreen: false,
        screenSharePeerId: null,
        localScreenStream: null,
        isSharingScreenAudio: false,
        // Invitations from OTHER conversations are not our call state and
        // survive hanging up, the way a second phone line keeps ringing.
        incomingCalls: state.incomingCalls,
        isCameraOn: false,
        localCameraStream: null,
        callDeclinedUserIds: [],
      };
      emit();
    },

    /** WS connection lost mid-call: keep the mic + intent, drop the dead mesh. */
    notifyDisconnected() {
      if (state.status === "idle" || !intendedChannelId) {
        return;
      }
      clearJoinTimeout();
      teardownMeshForReconnect();
      // Show "joining" (reconnecting) rather than kicking the user to idle.
      state.status = "joining";
      emit();
    },

    /** WS reconnected: auto-rejoin the room so the call resumes seamlessly. */
    async notifyReconnected() {
      if (!intendedChannelId || state.status === "idle") {
        return;
      }
      if (!pipeline) {
        // Mic was released (e.g. a long outage) — re-acquire via a full join.
        await this.join(intendedChannelId);
        return;
      }
      // Mic still live: re-enter the room; welcome rebuilds the mesh with a
      // fresh peer id and other participants reconnect to us.
      state.status = "joining";
      emit();
      armJoinTimeout();
      sendJoin(intendedChannelId);
    },

    setMuted(muted: boolean) {
      if (!pipeline) {
        return;
      }
      // Undeafening is the only way back to an unmuted mic while deafened.
      state.isMuted = state.isDeafened ? true : muted;
      applyMute();
      emit();
    },

    toggleMute() {
      if (!pipeline) {
        return;
      }
      if (state.isDeafened) {
        state.isDeafened = false;
        state.isMuted = false;
      } else {
        state.isMuted = !state.isMuted;
      }
      applyMute();
      emit();
    },

    toggleDeafen() {
      if (!pipeline) {
        return;
      }
      state.isDeafened = !state.isDeafened;
      // Deafening also mutes; undeafening restores an open mic.
      state.isMuted = state.isDeafened;
      applyMute();
      emit();
    },

    async startScreenShare() {
      if (state.status !== "connected") {
        return;
      }
      // Only one presenter per room (mesh and SFU alike — see the server-side
      // comment in voice.ts). Checking the roster here skips the OS picker
      // when we already know it'll be refused; the server call below is still
      // the authoritative check for the rare simultaneous-click race.
      if (state.screenSharePeerId && state.screenSharePeerId !== state.peerId) {
        state.error = translateMessage("voice.error.shareTaken");
        emit();
        return;
      }

      // Defensive: the UI already hides the affordance where this is missing
      // (see components/voice/capabilities.ts), so reaching here means a
      // programmatic call, not a user tapping a button we should not have shown.
      if (!supportsScreenShare()) {
        state.error = screenShareUnsupportedMessage();
        emit();
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(
          SCREEN_CAPTURE_OPTIONS,
        );
      } catch (err) {
        // A browser that refuses the *shape* of the request rather than the
        // request itself would otherwise cost the user their screen share
        // entirely, so ask again the old way. Only for the two names that mean
        // "I do not understand this request", because only those are thrown
        // before the picker opens. Everything else (the person cancelling,
        // the OS refusing the capture, the chosen surface failing to start)
        // happens *after* they already chose something, and asking again there
        // would put a second picker on screen with nothing to explain it.
        const shapeRefused =
          err instanceof Error &&
          (err.name === "TypeError" || err.name === "NotSupportedError");
        if (!shapeRefused) {
          state.error = screenShareErrorMessage(err);
          emit();
          return;
        }
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        } catch {
          state.error = screenShareErrorMessage(err);
          emit();
          return;
        }
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        state.error = translateMessage("voice.error.noVideoTrack");
        emit();
        return;
      }
      // The single most effective line in this feature. A capture track carries
      // no content hint by default and the encoder then optimises a screen for
      // sharpness, holding resolution and dropping frames the moment bandwidth
      // tightens. That is right for a spreadsheet and wrong for everything
      // people actually share here: a film, a match, a game. "motion" flips the
      // trade to framerate, which is what makes a share look live rather than
      // like a series of stills. Text loses a little crispness; a film stops
      // stuttering. Guarded because the property is read-only on some older
      // implementations rather than merely ignored.
      try {
        track.contentHint = "motion";
      } catch {
        // Encoder defaults, working share.
      }
      // Empty on Safari and Firefox, on a macOS screen or window share, and
      // whenever the "share audio" box was left unticked. It is the common
      // case, not a failure: the share goes ahead silent, exactly as every
      // share did before this existed.
      const hasAudio = stream.getAudioTracks().length > 0;
      watchScreenCapture(stream);
      screenCaptureStream = stream;
      state.isSharingScreen = true;
      state.localScreenStream = stream;
      state.isSharingScreenAudio = hasAudio;
      emit();
      announceSharing();

      try {
        await manager?.setLocalScreenStream(stream);
        if (sfu) {
          await sfu.publishScreen(stream);
        }
      } catch (err) {
        state.error = screenShareErrorMessage(err);
        await stopScreenShareInternal();
        emit();
      }
    },

    async stopScreenShare() {
      await stopScreenShareInternal();
      emit();
    },

    // --- conversation calls -----------------------------------------------

    /**
     * Start a conversation call: join its room and, once the server welcomes
     * us in, ring the absent participants. Ringing waits for `welcome` because
     * the join is where access, blocks and the room's transport are enforced —
     * a refused join must ring nobody.
     */
    async joinConversationCall(
      conversationId: string,
      options?: VoiceAudioOptions,
    ) {
      ringOnWelcomeChannelId = conversationId;
      await this.join(conversationId, options);
    },

    /** Accepting an incoming call is joining its room — no extra frame. */
    async acceptIncomingCall(
      conversationId: string,
      options?: VoiceAudioOptions,
    ) {
      await this.join(conversationId, options);
    },

    /** Refuse the ring. The caller is told; our other devices stop ringing. */
    declineIncomingCall(conversationId: string) {
      transport.sendVoice({ type: "call-decline", conversationId });
      if (removeIncomingCall(conversationId)) {
        emit();
      }
    },

    /**
     * Dismiss the surface on this device only — no frame is sent, the other
     * participants keep ringing, and the call stays joinable from the panel.
     */
    dismissIncomingCall(conversationId: string) {
      if (removeIncomingCall(conversationId)) {
        emit();
      }
    },

    /**
     * Camera on/off. Off by default, always; nothing turns it on but this.
     *
     * Mesh publishes it as a second video track alongside any screen share
     * (the roster's `cameraStreamId` is what lets receivers tell them apart);
     * LiveKit publishes it as a `Camera`-source track. Both are told about
     * every transition, and the capture is released the moment it stops being
     * sent — a webcam light with nothing behind it is not acceptable.
     */
    async toggleCamera() {
      if (state.status !== "connected") {
        return;
      }
      if (cameraCaptureStream) {
        await stopCameraInternal();
        emit();
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      } catch (err) {
        state.error =
          err instanceof Error && err.name === "NotAllowedError"
            ? translateMessage("voice.error.cameraBlocked", desktopContext())
            : err instanceof Error && err.message
              ? err.message
              : translateMessage("voice.error.cameraFailed");
        emit();
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) {
          t.stop();
        }
        state.error = translateMessage("voice.error.cameraFailed");
        emit();
        return;
      }
      // The camera being unplugged (or revoked by the OS) must read as "off",
      // not as a frozen tile.
      track.onended = () => {
        void stopCameraInternal();
        emit();
      };
      cameraCaptureStream = stream;
      state.isCameraOn = true;
      state.localCameraStream = stream;
      emit();
      // Announced before the track is added so receivers can classify the
      // incoming video on arrival; the manager re-checks on the roster anyway.
      transport.sendVoice({ type: "set-camera", streamId: stream.id });
      try {
        await manager?.setLocalCameraStream(stream);
        if (sfu) {
          await sfu.publishCamera(stream);
        }
      } catch (err) {
        state.error =
          err instanceof Error && err.message
            ? err.message
            : translateMessage("voice.error.cameraFailed");
        await stopCameraInternal();
        emit();
      }
    },

    // --- end conversation calls ---------------------------------------------

    /**
     * Per-peer playback level. Keyed by user id, not peer id: the server mints a
     * fresh peer id on every join, so a peer-keyed setting would reset whenever
     * that person reconnected.
     */
    setPeerVolume(userId: string, volume: number) {
      state.peerVolumes = {
        ...state.peerVolumes,
        [userId]: Math.min(1, Math.max(0, volume)),
      };
      emit();
    },

    setInputVolume(volume: number) {
      audioOptions.inputVolume = clampVolume(volume);
      if (pipeline) {
        pipeline.gainNode.gain.value = audioOptions.inputVolume;
      }
    },

    /**
     * The input mode is a preference, not a renegotiation.
     *
     * Switching mid-call touches nothing but `track.enabled` and the SFU's
     * publication flag, so the call does not so much as flicker: no new
     * `getUserMedia`, no `replaceTrack`, no SDP. That is the whole reason the
     * gate lives in `micShouldBeOpen()` rather than in how the track is built.
     */
    setInputMode(mode: VoiceInputMode) {
      if (state.inputMode === mode) {
        return;
      }
      state.inputMode = mode;
      // A key held while the mode changes is owed a keyup that may never be
      // recognised as ours. Drop it and start closed.
      pushToTalkHeld = false;
      applyMute();
      emit();
    },

    /**
     * The push-to-talk key (or the hold button) going down or up.
     *
     * Idempotent, and a no-op outside push-to-talk mode — a stray release from
     * a listener that has not been torn down yet must never be able to close a
     * voice-activity mic, and a stray press must never open one.
     */
    setPushToTalkActive(active: boolean) {
      if (state.inputMode !== "push-to-talk") {
        pushToTalkHeld = false;
        return;
      }
      if (pushToTalkHeld === active) {
        return;
      }
      pushToTalkHeld = active;
      applyMute();
      emit();
    },

    async setInputDevice(deviceId: string) {
      const previousDeviceId = audioOptions.inputDeviceId ?? "";
      if (previousDeviceId === deviceId) {
        return;
      }
      audioOptions.inputDeviceId = deviceId;
      await swapPipeline("Failed to switch microphone");
    },

    /**
     * Echo cancellation / noise suppression / auto gain.
     *
     * These are `getUserMedia` constraints, so the track has to be captured
     * again — but the *call* does not have to notice. `replaceTrack` on the
     * existing senders swaps the media under a live `RTCRtpSender` without
     * touching the SDP, so there is no renegotiation, no ICE, and no gap where
     * a peer sees us leave. The same is true of LiveKit's `replaceTrack`.
     * Applying these by rejoining would have been visible to the whole room.
     */
    async setMicProcessing(processing: MicProcessing) {
      if (sameMicProcessing(audioOptions.processing, processing)) {
        return;
      }
      audioOptions.processing = processing;
      await swapPipeline("Failed to apply microphone processing");
    },

    hasMeshWarning() {
      return state.remotePeers.length >= MESH_VOICE_WARNING;
    },
  };
}

export type { PeerConnectionState, RemotePeer };
