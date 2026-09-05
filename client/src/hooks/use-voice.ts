import {
  CAMERA_LIMIT,
  MESH_VOICE_WARNING,
  SCREEN_SHARE_LIMIT,
  type ClientRelayMessage,
  type VoiceParticipant,
  type VoiceRoomTransport,
  type VoiceSessionInfo,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import {
  audibleScreenPeerIds,
  isCameraAtCap,
  isScreenShareAtCap,
  nextScreenShareFocus,
} from "@/lib/screen-share-roster";
import {
  screenShareUnavailableMessage,
  supportsScreenShare,
} from "@/components/voice/capabilities";
import {
  desktopContext,
  desktopPredatesScreenShare,
  getDesktop,
  isDesktopApp,
} from "@/lib/desktop";
import {
  capturesSystemAudio,
  screenCaptureEnvironment,
  screenCaptureOptions,
} from "@/lib/screen-capture-audio";
import { translateMessage, type MessageKey } from "@/lib/i18n";
import {
  buildAudioConstraints,
  defaultMicProcessing,
  listAudioDevices,
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
import { beaconVoiceLeave } from "@/lib/voice-leave-beacon";
import {
  applyCameraQuality,
  cameraBitrateFor,
  screenBitrateFor,
  captureCamera,
  DEFAULT_VIDEO_QUALITY,
  type VideoQuality,
} from "@/lib/video-quality";
import {
  createSpeakingTracker,
  createStreamAnalyser,
  readAnalyserLevel,
} from "@/lib/voice-audio";
import { playCue, stopAllSoundLoops, whenCueSettled } from "@/lib/sounds";

export type VoiceStatus = "idle" | "joining" | "connected";

/** Aligned with the server orphan TTL (`VOICE_RESUME_TTL_MS`). */
const VOICE_RESUME_GRACE_MS = 90_000;

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
  /**
   * Set when `error` is about the microphone: the stage then offers a way
   * into voice settings next to the message, since picking another device
   * is the fix for every one of those.
   */
  errorKind: "mic" | "connection" | null;
  /**
   * Good news worth a line: the saved microphone could not start and the
   * call went ahead on another one. Says which, so nobody wonders why the
   * headset is silent. Cleared on leave.
   */
  notice: string | null;
  voiceChannelId: string | null;
  self: VoiceParticipant | null;
  speakingPeerIds: string[];
  /**
   * peerIds in OUR room that a moderator has muted for everyone, from the
   * roster's `serverMuted`. Never includes our own peer id: that case is
   * `self.serverMuted`, and it changes what the mute button does rather than
   * what we play.
   *
   * This is the receiving half of the server mute, and it is the same
   * enforcement point as eviction: the server changed the roster, and this
   * client obeys it. The audio sinks play these peers at zero whatever the
   * person's own volume slider says (the slider's value is kept, so it
   * restores the moment the flag clears), and the speaking loop never lights
   * them up, because on a mesh their packets still arrive; only the playback
   * stops. Both transports set the flag, so a LiveKit room reads identically
   * even though its SFU also stopped forwarding the track.
   */
  serverMutedPeerIds: string[];
  /** channelId → participants currently in that voice channel */
  occupancy: Record<string, VoiceParticipant[]>;
  /** userId → 0..1 playback multiplier, persisted for the session. */
  peerVolumes: Record<string, number>;
  /**
   * userId → 0..1 multiplier for that person's SCREEN audio, separate from
   * their voice.
   *
   * Separate because the two are different sounds with different problems. A
   * game is mixed for a living room and a voice is a microphone in a bedroom,
   * so the useful move is almost always "turn the game down and keep hearing
   * the person", and one slider cannot do that. Asked for in the QG on
   * 4 Sep 2026: "a separacao das faixas de audio entre a live do amigo e a voz
   * do amigo".
   *
   * Keyed on userId like `peerVolumes`, and session-scoped the same way.
   */
  screenVolumes: Record<string, number>;
  /** True when media is flowing through an SFU rather than a peer mesh. */
  usingSfu: boolean;
  /**
   * Set when the last join was refused because this client could not use the
   * room's transport. Distinct from `error` so the UI (and tests) can tell this
   * apart from a mic failure or a dropped socket.
   */
  transportFailure: VoiceTransportFailure | null;
  /**
   * The room's media path, as stated on `welcome` / `voice-roster`. Null
   * before the first join. The screen-share cap is keyed off this, not off
   * `usingSfu`, which stays false until LiveKit actually connects.
   */
  roomTransport: VoiceRoomTransport | null;
  /** True when this client is the one presenting. */
  isSharingScreen: boolean;
  /** peerIds currently sharing, in roster order. */
  screenSharePeerIds: string[];
  /** peerIds whose camera is on, from the roster's `cameraStreamId`. */
  cameraPeerIds: string[];
  /**
   * Who occupies the large tile. Hook-owned so the audio sinks (mounted at
   * the app root) and both stage mounts can read the same value.
   */
  focusedScreenPeerId: string | null;
  /**
   * Shares this person has said no to. Peer ids, not user ids, and that is
   * deliberate: a dismissal is about the share in front of you, not a grudge
   * against its presenter. When they stop sharing the id leaves this list, so
   * their next share arrives visible instead of mysteriously blank.
   *
   * Asked for in the QG on 4 Sep 2026: "e se eu apenas nao quiser assistir a
   * transmissao do amigo".
   *
   * HONEST LIMIT: this hides and silences locally. On the mesh the bytes still
   * arrive, because declining them properly means renegotiating with that peer
   * (and on an SFU, unsubscribing). So it buys quiet and screen space, not
   * bandwidth, and the day voice moves to LiveKit this is where the real
   * saving gets wired in.
   */
  dismissedSharePeerIds: string[];
  /**
   * Whose screen audio to play. Derived from the sharing set + focus, not
   * from whether the stage is on screen — navigating to a text channel must
   * not mute a live share.
   */
  audibleScreenPeerIds: string[];
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
  /**
   * Whether our live share is carrying the MACHINE'S output rather than one
   * tab's, i.e. the shape that re-broadcasts everybody's voices back at them.
   *
   * Read off what the picker actually returned (`displaySurface === "monitor"`
   * with an audio track), not off what was asked for: the person may have opted
   * in and then picked a tab, and a warning about a capture that is not
   * happening is how a true warning gets ignored. Only ever true when the user
   * opted in, because nothing else asks for system audio any more.
   */
  isSharingSystemAudio: boolean;
  /**
   * True when the last attempt asked for sound and died AFTER the picker
   * closed, which is the one share failure a person cannot act on by reading:
   * they chose a screen, got nothing, and the culprit is a toggle they armed
   * minutes ago on a different bar.
   *
   * The UI turns this into a button that shares the same screen without sound.
   * It has to be a button and not a silent second attempt: `getDisplayMedia`
   * consumes the click that authorised it, so a retry fired from inside this
   * failure has no user activation left and would be refused on the spot. A
   * click has one, and it also explains itself, which a picker reopening on
   * its own does not.
   */
  screenShareAudioFailed: boolean;
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

/**
 * A saved input device that no longer exists.
 *
 * `buildAudioConstraints` asks for a chosen device with `deviceId: { exact }`,
 * which is right: a person who picked a microphone means that microphone, and
 * silently using a different one is worse than failing. But the id is stored in
 * `localStorage` and the device is not: unplug a USB headset, let a Bluetooth
 * one drop, or reset site permissions and the browser rotates the ids, and the
 * saved id now points at nothing.
 *
 * `exact` then rejects with `NotFoundError` ("Requested device not found") and
 * the whole join fails, every time, until the person happens to open Settings
 * and re-pick a microphone. They did not change anything; their headphones did.
 *
 * The output side already knew this: `applyAudioOutputDevice` swallows the same
 * failure with "Device may have been unplugged; keep default output". The input
 * side did not, which is the whole bug.
 */
function isMissingDeviceError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "NotFoundError" || err.name === "OverconstrainedError")
  );
}

/**
 * The device is there but will not start.
 *
 * `NotReadableError` ("Could not start audio source") is what Chromium and
 * Firefox throw when the microphone exists and permission is granted but the
 * OS will not hand it over: another app holds it exclusively, a driver
 * hiccup, a Bluetooth headset that is paired but asleep, a USB interface
 * that answered enumeration and then died. `AbortError` is the same story
 * from Safari. A person in the QG hit this on 1 Sep 2026 and found the fix
 * themselves: pick a different microphone. So do that for them.
 */
function isUnreadableDeviceError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "NotReadableError" ||
      err.name === "AbortError" ||
      err.name === "TrackStartError")
  );
}

/** Every microphone on the machine failed to start. Carries the first error. */
export class MicUnreadableError extends Error {
  constructor(readonly original: unknown) {
    super("No microphone could be started");
    this.name = "MicUnreadableError";
  }
}

/** How many other microphones to try after the chosen one and the default. */
const MIC_FALLBACK_ATTEMPTS = 3;

async function openMic(
  deviceId: string | undefined,
  processing: MicProcessing,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: buildAudioConstraints(deviceId, processing),
    video: false,
  });
}

/** The label of the microphone behind a live stream, for the notice. */
function micLabel(stream: MediaStream): string | null {
  const track = stream.getAudioTracks()[0];
  const label = track?.label?.trim();
  return label ? label : null;
}

/**
 * Open the microphone, and when the one asked for will not start, walk the
 * others before giving up.
 *
 * The ladder, in order:
 *  1. the chosen device (or the default when none is chosen);
 *  2. a chosen device that no longer exists: the default, and forget the id
 *     (`isMissingDeviceError`, the unplugged-headset case);
 *  3. a device that exists but will not start: the default, then every other
 *     microphone the browser lists, a few at most, and forget the id;
 *  4. nothing started: `MicUnreadableError`, which the stage turns into
 *     "pick another microphone" with a button into voice settings.
 *
 * Permission refusals are never retried: a second prompt right after a
 * refusal is the one thing that makes people block a site for good.
 *
 * `onFallback` fires with the label of whatever did start when it is not the
 * one asked for, so the call can say "using the built-in microphone".
 */
async function createMicPipeline(
  deviceId: string | undefined,
  inputVolume: number,
  processing: MicProcessing,
  onDeviceGone?: () => void,
  onFallback?: (label: string | null) => void,
): Promise<MicPipeline> {
  let rawStream: MediaStream;
  try {
    rawStream = await openMic(deviceId, processing);
  } catch (err) {
    if (err instanceof Error && err.name === "NotAllowedError") {
      throw err;
    }
    const missing = isMissingDeviceError(err);
    const unreadable = isUnreadableDeviceError(err);
    // With no device chosen, NotFoundError means the machine has no
    // microphone at all: a real error worth showing, nothing to fall back to.
    if (!(deviceId && missing) && !unreadable) {
      throw err;
    }

    const tried = new Set<string>(deviceId ? [deviceId] : []);
    const candidates: (string | undefined)[] = [];
    if (deviceId) {
      candidates.push(undefined);
    }
    if (unreadable) {
      try {
        const { inputs } = await listAudioDevices();
        for (const input of inputs) {
          if (input.deviceId && !tried.has(input.deviceId)) {
            candidates.push(input.deviceId);
            tried.add(input.deviceId);
          }
        }
      } catch {
        // No enumeration: the default alone is the whole ladder.
      }
    }

    let opened: MediaStream | null = null;
    for (const candidate of candidates.slice(0, MIC_FALLBACK_ATTEMPTS + 1)) {
      try {
        opened = await openMic(candidate, processing);
        break;
      } catch (next) {
        if (next instanceof Error && next.name === "NotAllowedError") {
          throw next;
        }
      }
    }
    if (!opened) {
      throw unreadable ? new MicUnreadableError(err) : err;
    }
    rawStream = opened;
    // Forget the dead id so the next join does not repeat the round trip, and
    // so Settings stops showing a selection that resolves to nothing.
    onDeviceGone?.();
    onFallback?.(micLabel(rawStream));
  }

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

function stopMicTracks(pipeline: MicPipeline | null) {
  if (!pipeline) {
    return;
  }
  for (const track of pipeline.rawStream.getTracks()) {
    track.stop();
  }
  for (const track of pipeline.processedStream.getTracks()) {
    track.stop();
  }
}

function closeMicContext(pipeline: MicPipeline | null) {
  if (!pipeline) {
    return;
  }
  void pipeline.audioContext.close();
}

function stopMicPipeline(pipeline: MicPipeline | null) {
  stopMicTracks(pipeline);
  closeMicContext(pipeline);
}

function micErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return translateMessage("voice.error.micFailed");
  }
  if (err.name === "NotAllowedError") {
    return translateMessage("voice.error.micBlocked", desktopContext());
  }
  // Reached only when NO device was requested, because a missing *chosen*
  // device is retried on the default before it can get here. So this really
  // does mean the machine has no working microphone at all.
  if (err.name === "NotFoundError") {
    return translateMessage("voice.error.micMissing");
  }
  // Every microphone was tried and none would start (see createMicPipeline).
  // Name the fix, not the error: another app may be holding the mic, or the
  // device needs re-plugging, and Settings is where a different one is picked.
  if (err.name === "MicUnreadableError" || isUnreadableDeviceError(err)) {
    return translateMessage("voice.error.micUnreadable", desktopContext());
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
    // An out-of-date desktop shell lands here too, and it is NOT a platform
    // limit — Chromium hands the renderer a `getDisplayMedia`, then rejects
    // because the shell has no handler to answer with a source. Same error
    // name, opposite meaning: the browser cannot, the old app merely has not
    // been updated. Tell that user to update rather than that it is
    // impossible, which is both false and something they cannot act on.
    if (desktopPredatesScreenShare()) {
      return translateMessage("voice.error.shareNeedsAppUpdate");
    }
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
  if (err.name === "NotReadableError") {
    // "Could not start audio source", verbatim, in English, is what a user hit
    // in the QG on 24 Aug 2026. It is thrown when the picked surface's audio
    // cannot be opened, and it rejects the WHOLE capture: the video was fine
    // and they still got nothing, which is why the same person found that
    // sharing without ticking the audio box works.
    //
    // Almost always the surface, not the machine. Chromium can only hand over
    // audio for a *tab*; a window share has none to give, and a whole-screen
    // share only does on Windows, never on macOS. Ticking "share audio" on a
    // source that has no audio to share is the common way to land here, so the
    // copy names the fix rather than the error.
    // Context, because the browser advice is nonsense in the shell: its picker
    // lists screens and windows and has never had a tab to offer. Telling a
    // desktop user to pick a Chrome tab is telling them to find something that
    // is not there.
    return translateMessage(
      "voice.error.shareAudioUnavailable",
      desktopContext(),
    );
  }
  return err.message;
}

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
  /** HMAC from the last `welcome`. Sent on the next join so the server can reattach. */
  let resumeToken: string | null = null;
  /**
   * True while `/ws` is down (or a resume join is in flight) and we are keeping
   * the mesh / LiveKit session alive. `welcome` must not hang up in this state.
   */
  let holdingMedia = false;
  let resumeGraceId: ReturnType<typeof setTimeout> | null = null;
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
  /**
   * The chosen video quality. A user preference, not call state: it survives
   * leaving exactly as the input device and volume do, and it is what the next
   * `toggleCamera` will ask the hardware for.
   */
  let videoQuality: VideoQuality = DEFAULT_VIDEO_QUALITY;
  /** Webcam id for the next capture. Empty means the browser default. */
  let cameraDeviceId = "";
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
    errorKind: null,
    notice: null,
    voiceChannelId: null,
    self: null,
    speakingPeerIds: [],
    serverMutedPeerIds: [],
    occupancy: {},
    peerVolumes: {},
    screenVolumes: {},
    usingSfu: false,
    transportFailure: null,
    roomTransport: null,
    isSharingScreen: false,
    screenSharePeerIds: [],
    cameraPeerIds: [],
    focusedScreenPeerId: null,
    dismissedSharePeerIds: [],
    audibleScreenPeerIds: [],
    localScreenStream: null,
    isSharingScreenAudio: false,
    isSharingSystemAudio: false,
    screenShareAudioFailed: false,
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
      resume: true,
      ...(state.peerId && resumeToken
        ? { resumePeerId: state.peerId, resumeToken }
        : {}),
    });
  }

  function sendLeave() {
    transport.sendVoice({
      type: "leave-voice-room",
      ...(state.peerId && resumeToken
        ? { resumePeerId: state.peerId, resumeToken }
        : {}),
    });
  }

  function clearResumeGrace() {
    if (resumeGraceId) {
      clearTimeout(resumeGraceId);
      resumeGraceId = null;
    }
  }

  function redeclareLocalMedia() {
    transport.sendVoice({
      type: "set-voice-state",
      muted: state.isMuted,
      deafened: state.isDeafened,
    });
    if (screenCaptureStream) {
      announceSharing();
    } else {
      transport.sendVoice({ type: "set-sharing-screen", sharing: false });
    }
    transport.sendVoice({
      type: "set-camera",
      streamId: cameraCaptureStream?.id ?? null,
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
        sendLeave();
        state.error = translateMessage("voice.error.joinTimeout");
        state.errorKind = "connection";
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
    clearResumeGrace();
    sendLeave();
    holdingMedia = false;
    resumeToken = null;
    joinGeneration++;
    intendedChannelId = null;
    ringOnWelcomeChannelId = null;
    knownPeerIds.clear();
    stopSpeakingLoop();
    disposeRemoteAnalysers();
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
    state.serverMutedPeerIds = [];
    state.transportFailure = failure;
    state.error = translateMessage(TRANSPORT_FAILURE_KEY[failure.reason]);
    emit();
  }

  function snapshot(): VoiceState {
    return {
      ...state,
      remotePeers: [...state.remotePeers],
      speakingPeerIds: [...state.speakingPeerIds],
      serverMutedPeerIds: [...state.serverMutedPeerIds],
      occupancy: { ...state.occupancy },
      peerVolumes: { ...state.peerVolumes },
      screenVolumes: { ...state.screenVolumes },
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
  /**
   * Drop a saved input device that the machine no longer has.
   *
   * Without this the dead id survives in `audioOptions`, so every later join
   * and every processing toggle pays for a `getUserMedia` that is known to
   * fail before falling back. Clearing it in memory also makes the fallback
   * sticky for the rest of the session rather than a per-call accident.
   *
   * NOT persisted: the id also lives in the settings `localStorage` blob, and
   * clearing that needs a callback the hook does not currently receive. The
   * cost of leaving it is one failed probe on the next launch, after which
   * this clears it again. Worth doing properly, not worth blocking this on.
   */
  function forgetInputDevice() {
    audioOptions.inputDeviceId = "";
  }

  async function swapPipeline(failureMessage: string) {
    if (!pipeline || state.status === "idle") {
      return;
    }
    try {
      const next = await createMicPipeline(
        audioOptions.inputDeviceId || undefined,
        audioOptions.inputVolume,
        audioOptions.processing,
        forgetInputDevice,
        (label) => {
          state.notice = label
            ? translateMessage("voice.notice.micFallback", { label })
            : translateMessage("voice.notice.micFallbackUnnamed");
        },
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
        // A server-muted peer's audio may still be arriving (on a mesh it
        // always is), and the analyser still reads a level. Nobody hears it,
        // so nothing may light up: a speaking ring on a person the room
        // muted would be the panel contradicting the moderator.
        if (state.serverMutedPeerIds.includes(peerId)) {
          speakingTracker.update(peerId, 0, false);
          continue;
        }
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

  /**
   * Take the room's server mutes from a full roster (`welcome`, `voice-roster`
   * for our channel). Everyone else lands in `serverMutedPeerIds`; our own
   * entry updates `self.serverMuted` and pins our mic.
   */
  function applyServerMutes(participants: VoiceParticipant[]) {
    const next = participants
      .filter((p) => p.serverMuted && p.peerId !== state.peerId)
      .map((p) => p.peerId)
      .sort();
    if (!sameSpeaking(state.serverMutedPeerIds, next)) {
      state.serverMutedPeerIds = next;
    }
    const me = participants.find((p) => p.peerId === state.peerId);
    if (me) {
      applySelfServerMute(me.serverMuted);
    }
  }

  /** One peer's flag changed (`peer-joined`, `peer-updated`). */
  function applyPeerServerMute(peer: VoiceParticipant) {
    if (peer.peerId === state.peerId) {
      applySelfServerMute(peer.serverMuted);
      return;
    }
    const listed = state.serverMutedPeerIds.includes(peer.peerId);
    if (peer.serverMuted && !listed) {
      state.serverMutedPeerIds = [...state.serverMutedPeerIds, peer.peerId].sort();
    } else if (!peer.serverMuted && listed) {
      state.serverMutedPeerIds = state.serverMutedPeerIds.filter(
        (id) => id !== peer.peerId,
      );
    }
  }

  /**
   * A moderator muted (or unmuted) US.
   *
   * Muting pins `isMuted` and stops the track: the server keeps our roster
   * entry muted and refuses our unmute anyway, and every receiver plays us at
   * zero, so publishing would only spend upload on audio nobody hears. The
   * mute button becomes inert (see `setMuted` / `toggleMute`) until the flag
   * clears. Clearing does not unmute: the mic stays off until the person
   * turns it back on, exactly as after any self-mute.
   */
  function applySelfServerMute(serverMuted: boolean) {
    if (!state.self) {
      return;
    }
    if (state.self.serverMuted !== serverMuted) {
      state.self = { ...state.self, serverMuted };
    }
    // Not gated on the flag having changed: `welcome` and `peer-updated`
    // assign `self` wholesale before this runs, so the flag may already
    // read true while the mic is still open.
    if (serverMuted && !state.isMuted) {
      state.isMuted = true;
      applyMute();
    }
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
    state.isSharingSystemAudio = false;
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
   * Rebuild who is sharing, who is focused, and whose audio plays from a
   * roster snapshot. Stop and disconnect both show up as a missing id, so
   * they share the same fallback.
   */
  function applyScreenShareRoster(participants: VoiceParticipant[]) {
    const nextIds = participants
      .filter((participant) => participant.sharingScreen)
      .map((participant) => participant.peerId);
    const focused = nextScreenShareFocus(
      state.screenSharePeerIds,
      nextIds,
      state.focusedScreenPeerId,
    );
    state.screenSharePeerIds = nextIds;
    state.focusedScreenPeerId = focused;
    // A dismissal only lasts as long as the share it was about.
    state.dismissedSharePeerIds = state.dismissedSharePeerIds.filter((id) =>
      nextIds.includes(id),
    );
    state.audibleScreenPeerIds = audibleScreenPeerIds(
      nextIds.filter((id) => !state.dismissedSharePeerIds.includes(id)),
      focused,
    );
  }

  /** Who has a camera on, from a roster snapshot. */
  function applyCameraRoster(participants: VoiceParticipant[]) {
    state.cameraPeerIds = participants
      .filter((participant) => participant.cameraStreamId)
      .map((participant) => participant.peerId);
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
    state.isSharingSystemAudio = false;
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

  /**
   * Who is presenting, from the roster → the mesh manager.
   *
   * The one incoming media slot with no stream id to null out, so this flag is
   * the only thing that tells a receiver a share ended. Without it the dead
   * capture stays filed as that peer's screen and their *next* share renders
   * black behind it — see `setPeerSharingScreen`.
   *
   * Runs after `applyCameraStreamIds` on purpose: the manager keeps the
   * announced camera stream and drops the rest, so it has to know which one
   * the camera is before it drops anything.
   */
  function applySharingScreen(participants: VoiceParticipant[]) {
    if (!manager) {
      return;
    }
    for (const participant of participants) {
      if (participant.peerId !== state.peerId) {
        manager.setPeerSharingScreen(
          participant.peerId,
          participant.sharingScreen,
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
    if (sfu?.isConnected() && state.usingSfu && state.peerId === peerId) {
      for (const peer of peers) {
        identities.set(peer.peerId, toIdentity(peer));
      }
      if (screenCaptureStream) {
        announceSharing();
      }
      if (cameraCaptureStream) {
        transport.sendVoice({
          type: "set-camera",
          streamId: cameraCaptureStream.id,
        });
      }
      return true;
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
      // Before anything is published, so a camera or a share carried across a
      // reconnect is republished at the chosen quality. Without this a session
      // rebuilt after a WS drop silently reverted both to the defaults, and
      // nothing recomputed them until the user next touched the menu.
      await sfu.setCameraMaxBitrate(cameraBitrateFor(videoQuality));
      await sfu.setScreenMaxBitrate(screenBitrateFor(videoQuality));
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

  /**
   * After a reconstruct, peers who never resume (iOS, Android, an old tab)
   * leave an RTCPeerConnection that goes `failed` and stays on the stage.
   * The new process cannot send `peer-left` for ids it never knew. Drop a
   * PC only when it has already failed *and* the authoritative roster no
   * longer lists it. Healthy or connecting PCs stay: that peer may still
   * be reconstructing inside the 90s window.
   */
  function pruneFailedGhostPeers(): void {
    if (holdingMedia || !manager) {
      return;
    }
    const ghosts = state.remotePeers.filter(
      (peer) =>
        peer.connectionState === "failed" && !knownPeerIds.has(peer.peerId),
    );
    for (const peer of ghosts) {
      knownPeerIds.delete(peer.peerId);
      identities.delete(peer.peerId);
      const entry = remoteAnalysers.get(peer.peerId);
      if (entry) {
        entry.dispose();
        remoteAnalysers.delete(peer.peerId);
      }
      manager.removePeer(peer.peerId);
      playCue("voiceLeave");
    }
  }

  function startMeshSession(peerId: string, peers: VoiceParticipant[]) {
    manager = createPeerConnectionManager(peerId, sendRelay, iceServers);
    // Before any track is published, so a camera carried across a reconnect
    // gets the chosen ceiling on its first tune rather than the default one.
    manager.setCameraMaxBitrate(cameraBitrateFor(videoQuality));
    // Same reason, for the screen: a share carried across a reconnect must be
    // rebuilt at the chosen quality, not at the default one.
    manager.setScreenQuality(videoQuality);
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
      pruneFailedGhostPeers();
      emit();
    });
    attachMeshPeers(peers);
  }

  function attachMeshPeers(peers: VoiceParticipant[]) {
    if (!manager) {
      return;
    }
    for (const peer of peers) {
      manager.connectToPeer(peer.peerId, toIdentity(peer));
      manager.setPeerCameraStreamId(peer.peerId, peer.cameraStreamId ?? null);
      manager.setPeerScreenAudioStreamId(
        peer.peerId,
        peer.screenAudioStreamId ?? null,
      );
      manager.setPeerSharingScreen(peer.peerId, peer.sharingScreen);
    }
  }

  function leaveCall() {
    const wasInLobby =
      state.status === "connected" || state.status === "joining";
    stopAllSoundLoops();
    if (wasInLobby) {
      playCue("voiceLeave");
    }
    clearJoinTimeout();
    clearResumeGrace();
    const hangupPeerId = state.peerId;
    const hangupToken = resumeToken;
    sendLeave();
    // A second flap clears `voiceQueue` before the leave is flushed.
    // The beacon does not depend on `/ws`.
    if (!transport.isConnected() && hangupPeerId && hangupToken) {
      beaconVoiceLeave({
        resumePeerId: hangupPeerId,
        resumeToken: hangupToken,
      });
    }
    holdingMedia = false;
    resumeToken = null;
    joinGeneration++;
    intendedChannelId = null;
    ringOnWelcomeChannelId = null;
    knownPeerIds.clear();
    stopSpeakingLoop();
    const closingAnalysers = [...remoteAnalysers.values()];
    remoteAnalysers.clear();
    manager?.dispose();
    manager = null;
    void teardownSfu();
    const closingPipeline = pipeline;
    pipeline = null;
    stopMicTracks(closingPipeline);
    releaseScreenCapture();
    releaseCameraCapture();
    pushToTalkHeld = false;
    state = {
      status: "idle",
      peerId: null,
      remotePeers: [],
      isMuted: false,
      isDeafened: false,
      inputMode: state.inputMode,
      isTransmitting: false,
      error: null,
      errorKind: null,
      notice: null,
      voiceChannelId: null,
      self: null,
      speakingPeerIds: [],
      serverMutedPeerIds: [],
      occupancy: state.occupancy,
      peerVolumes: state.peerVolumes,
      screenVolumes: state.screenVolumes,
      usingSfu: false,
      transportFailure: null,
      roomTransport: null,
      isSharingScreen: false,
      screenSharePeerIds: [],
      cameraPeerIds: [],
      focusedScreenPeerId: null,
      dismissedSharePeerIds: [],
      audibleScreenPeerIds: [],
      localScreenStream: null,
      isSharingScreenAudio: false,
      isSharingSystemAudio: false,
      screenShareAudioFailed: false,
      incomingCalls: state.incomingCalls,
      isCameraOn: false,
      localCameraStream: null,
      callDeclinedUserIds: [],
    };
    void whenCueSettled().then(() => {
      closeMicContext(closingPipeline);
      for (const entry of closingAnalysers) {
        entry.dispose();
      }
    });
    emit();
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
        //
        // While holding media across a signaling blip, a roster can arrive
        // before resume welcome (fresh process: empty room). Absence is not
        // departure: union ids, do not clear, do not tear down PCs.
        if (message.voiceChannelId === state.voiceChannelId) {
          // Moderator mutes are read in both branches: a roster that arrives
          // while holding media is still the room's word on who is muted.
          applyServerMutes(message.participants);
          if (holdingMedia) {
            for (const participant of message.participants) {
              if (participant.peerId !== state.peerId) {
                knownPeerIds.add(participant.peerId);
              }
            }
          } else {
            knownPeerIds.clear();
            for (const participant of message.participants) {
              if (participant.peerId !== state.peerId) {
                knownPeerIds.add(participant.peerId);
              }
            }
            if (message.transport) {
              state.roomTransport = message.transport;
            }
            applyScreenShareRoster(message.participants);
            applyCameraRoster(message.participants);
            applyCameraStreamIds(message.participants);
            applyScreenAudioStreamIds(message.participants);
            applySharingScreen(message.participants);
            pruneFailedGhostPeers();
          }
        }
        emit();
        break;
      case "screen-share-denied":
        if (message.voiceChannelId !== state.voiceChannelId) {
          return;
        }
        void stopScreenShareInternal();
        state.error = translateMessage("voice.error.shareLimit", {
          limit: SCREEN_SHARE_LIMIT[state.roomTransport ?? "mesh"],
        });
        emit();
        break;
      case "camera-denied":
        if (message.voiceChannelId !== state.voiceChannelId) {
          return;
        }
        void stopCameraInternal();
        state.error = translateMessage("voice.error.cameraLimit", {
          limit: CAMERA_LIMIT[state.roomTransport ?? "mesh"],
        });
        emit();
        break;
      case "voice-room-full": {
        const limit = message.limit;
        leaveCall();
        state.error = translateMessage("voice.error.channelFull", {
          limit,
        });
        emit();
        break;
      }
      case "welcome": {
        // Drop a welcome that arrives after we already gave up (join timeout)
        // or left — otherwise it would flip us back to "connected" with no mic.
        if (state.status === "idle") {
          sendLeave();
          return;
        }
        if (message.resumeToken) {
          resumeToken = message.resumeToken;
        }

        const welcomePeers = message.peers;
        const channelId = message.voiceChannelId;
        const peerId = message.peerId;
        const roomTransport = message.transport ?? legacyRoomTransport;
        const transportChanged =
          state.roomTransport !== null &&
          roomTransport !== state.roomTransport;
        const isResume =
          Boolean(message.resumed) &&
          peerId === state.peerId &&
          !transportChanged;
        const sfuStillUp = Boolean(state.usingSfu && sfu?.isConnected());
        const meshStillUp = Boolean(manager && !state.usingSfu);
        const keepSession =
          isResume &&
          (holdingMedia || state.status === "connected") &&
          (sfuStillUp || meshStillUp);

        if (keepSession) {
          holdingMedia = false;
          clearResumeGrace();
          state.peerId = peerId;
          state.voiceChannelId = channelId;
          state.self = message.self;
          state.roomTransport = roomTransport;
          state.status = "connected";
          for (const peer of welcomePeers) {
            knownPeerIds.add(peer.peerId);
            identities.set(peer.peerId, toIdentity(peer));
          }
          if (meshStillUp) {
            attachMeshPeers(welcomePeers);
          }
          applyScreenShareRoster([message.self, ...welcomePeers]);
          applyCameraRoster([message.self, ...welcomePeers]);
          applyCameraStreamIds([message.self, ...welcomePeers]);
          applyScreenAudioStreamIds([message.self, ...welcomePeers]);
          applySharingScreen([message.self, ...welcomePeers]);
          applyServerMutes([message.self, ...welcomePeers]);
          redeclareLocalMedia();
          emit();
          break;
        }

        holdingMedia = false;
        clearResumeGrace();
        if (state.status === "connected") {
          state.status = "joining";
        }
        knownPeerIds.clear();
        state.peerId = message.peerId;
        state.voiceChannelId = message.voiceChannelId;
        state.self = message.self;
        state.transportFailure = null;

        for (const peer of welcomePeers) {
          knownPeerIds.add(peer.peerId);
        }
        applyScreenShareRoster([message.self, ...welcomePeers]);
        applyCameraRoster([message.self, ...welcomePeers]);
        // A standing moderator mute on us survives the seat (the server keeps
        // it for the room's lifetime), so it can already be true here. Read
        // it now so the very first mic state we publish is the pinned one.
        applyServerMutes([message.self, ...welcomePeers]);
        state.roomTransport = roomTransport;

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
      case "voice-join-refused":
        if (
          message.voiceChannelId !== intendedChannelId &&
          message.voiceChannelId !== state.voiceChannelId
        ) {
          return;
        }
        holdingMedia = false;
        resumeToken = null;
        clearResumeGrace();
        if (state.status !== "idle") {
          leaveCall();
        }
        break;
      case "peer-joined": {
        const alreadyKnown = knownPeerIds.has(message.peer.peerId);
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
        manager?.setPeerSharingScreen(
          message.peer.peerId,
          message.peer.sharingScreen,
        );
        applyPeerServerMute(message.peer);
        if (!alreadyKnown) {
          playCue("voiceJoin");
        }
        break;
      }
      case "peer-updated": {
        // A rename or a new picture, not an arrival: no join cue, no new
        // connection, and the tile keeps whatever media it already has.
        const identity = toIdentity(message.peer);
        identities.set(message.peer.peerId, identity);
        manager?.setPeerIdentity(message.peer.peerId, identity);
        if (state.self?.peerId === message.peer.peerId) {
          state.self = message.peer;
        }
        applyPeerServerMute(message.peer);
        // The SFU path builds `remotePeers` from LiveKit events, which a
        // rename is not one of, so patch the roster we are already holding
        // rather than waiting for the next thing to happen in the room.
        state.remotePeers = state.remotePeers.map((peer) =>
          peer.peerId === message.peer.peerId
            ? {
                ...peer,
                displayName: message.peer.displayName,
                avatarUrl: message.peer.avatarUrl,
              }
            : peer,
        );
        emit();
        break;
      }
      case "peer-left":
        knownPeerIds.delete(message.peerId);
        identities.delete(message.peerId);
        if (state.serverMutedPeerIds.includes(message.peerId)) {
          state.serverMutedPeerIds = state.serverMutedPeerIds.filter(
            (id) => id !== message.peerId,
          );
        }
        manager?.removePeer(message.peerId);
        {
          const entry = remoteAnalysers.get(message.peerId);
          if (entry) {
            entry.dispose();
            remoteAnalysers.delete(message.peerId);
          }
        }
        playCue("voiceLeave");
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

  if (typeof globalThis.window?.addEventListener === "function") {
    globalThis.window.addEventListener("pagehide", () => {
      if (intendedChannelId && state.status !== "idle") {
        sendLeave();
        // Chromium often closes `/ws` before the leave frame lands. The
        // keepalive POST can still retire the orphan after the document dies.
        if (state.peerId && resumeToken) {
          beaconVoiceLeave({
            resumePeerId: state.peerId,
            resumeToken,
          });
        }
      }
    });
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
      const fromIdle = state.status === "idle";
      const switching =
        state.status === "connected" &&
        state.voiceChannelId !== null &&
        state.voiceChannelId !== voiceChannelId;
      if (switching) {
        resumeToken = null;
        holdingMedia = false;
        clearResumeGrace();
      }
      // Rings outrank samples if they overlap; kill them before the click cue.
      stopAllSoundLoops();
      if (switching) {
        playCue("voiceLeave");
      }
      if (fromIdle || switching) {
        playCue("voiceJoin");
      }
      state.error = null;
      state.errorKind = null;
      state.notice = null;
      state.transportFailure = null;
      state.status = "joining";
      // A channel switch calls join() without leave(), so the previous room's
      // share ids would otherwise leak into the welcome diff and look like
      // newcomers. Empty previous is the locked "join into live shares" rule.
      state.screenSharePeerIds = [];
      state.cameraPeerIds = [];
      state.focusedScreenPeerId = null;
      state.audibleScreenPeerIds = [];
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
        await whenCueSettled();
        if (generation !== joinGeneration) {
          return;
        }
        stopMicPipeline(pipeline);
        // The missing-device fallback lives in `createMicPipeline` so that the
        // join path and `swapPipeline` cannot drift apart. This used to be an
        // ad-hoc catch here, which meant joining recovered from an unplugged
        // headset and changing device mid-call did not.
        const next: MicPipeline = await createMicPipeline(
          audioOptions.inputDeviceId || undefined,
          audioOptions.inputVolume,
          audioOptions.processing,
          forgetInputDevice,
          (label) => {
            state.notice = label
              ? translateMessage("voice.notice.micFallback", { label })
              : translateMessage("voice.notice.micFallbackUnnamed");
          },
        );

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
        state.errorKind = "mic";
        state.status = "idle";
        state.voiceChannelId = null;
        emit();
      }
    },

    leave() {
      leaveCall();
    },

    /** WS connection lost mid-call: keep media, reattach on the next welcome. */
    notifyDisconnected() {
      if (state.status === "idle" || !intendedChannelId) {
        return;
      }
      holdingMedia = true;
      clearResumeGrace();
      resumeGraceId = setTimeout(() => {
        resumeGraceId = null;
        if (!holdingMedia) {
          return;
        }
        // Outage lasted longer than the orphan window. Drop the held session
        // but keep the channel so reconnect cold-joins instead of hanging up.
        holdingMedia = false;
        resumeToken = null;
        knownPeerIds.clear();
        stopSpeakingLoop();
        const closingAnalysers = [...remoteAnalysers.values()];
        remoteAnalysers.clear();
        manager?.dispose();
        manager = null;
        void teardownSfu();
        for (const entry of closingAnalysers) {
          entry.dispose();
        }
        state.peerId = null;
        state.self = null;
        state.remotePeers = [];
        state.usingSfu = false;
        state.status = "joining";
        emit();
        // Socket already came back but the resume join was never answered.
        // Nobody else will send a join. Cold-join now, with a timeout.
        if (transport.isConnected() && intendedChannelId) {
          armJoinTimeout();
          sendJoin(intendedChannelId);
        }
      }, VOICE_RESUME_GRACE_MS);
      emit();
    },

    /** WS reconnected: resume the same peer id, or rejoin if we have no token. */
    async notifyReconnected() {
      if (!intendedChannelId || state.status === "idle") {
        return;
      }
      if (!pipeline) {
        await this.join(intendedChannelId);
        return;
      }
      if (holdingMedia || resumeToken) {
        holdingMedia = true;
        sendJoin(intendedChannelId);
        return;
      }
      state.status = "joining";
      emit();
      armJoinTimeout();
      sendJoin(intendedChannelId);
    },

    /** Auth is gone for good (token provider returned null). Hang up held media. */
    notifyAuthLost() {
      if (state.status === "idle" && !holdingMedia) {
        return;
      }
      leaveCall();
    },

    setMuted(muted: boolean) {
      if (!pipeline) {
        return;
      }
      // Undeafening is the only way back to an unmuted mic while deafened,
      // and a moderator's mute is not ours to lift at all: the server would
      // refuse the declaration and nobody would play us anyway.
      state.isMuted = state.isDeafened || state.self?.serverMuted ? true : muted;
      applyMute();
      emit();
    },

    toggleMute() {
      if (!pipeline) {
        return;
      }
      const serverMuted = state.self?.serverMuted === true;
      if (state.isDeafened) {
        state.isDeafened = false;
        state.isMuted = serverMuted;
      } else {
        state.isMuted = serverMuted ? true : !state.isMuted;
      }
      applyMute();
      emit();
    },

    toggleDeafen() {
      if (!pipeline) {
        return;
      }
      state.isDeafened = !state.isDeafened;
      // Deafening also mutes; undeafening restores an open mic, unless a
      // moderator has it pinned.
      state.isMuted = state.isDeafened || state.self?.serverMuted === true;
      applyMute();
      emit();
    },

    /**
     * @param shareSystemAudio The user's explicit opt-in to sending the whole
     *   machine's sound. Defaults to false at every call site, and false does
     *   NOT mean a silent share: a Chrome tab share still carries that tab's
     *   own audio, which is the route that cannot echo. See
     *   `lib/screen-capture-audio.ts` for why the default moved.
     */
    async startScreenShare(shareSystemAudio = false) {
      if (state.status !== "connected") {
        return;
      }
      if (
        isScreenShareAtCap(
          state.screenSharePeerIds,
          state.peerId,
          state.roomTransport,
        )
      ) {
        state.error = translateMessage("voice.error.shareLimit", {
          limit: SCREEN_SHARE_LIMIT[state.roomTransport ?? "mesh"],
        });
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

      // A share that succeeds supersedes the last one that failed, and the
      // offer to retry without sound has to go with it.
      const retryingAfterAudioFailure = state.screenShareAudioFailed;
      state.screenShareAudioFailed = false;

      const options = screenCaptureOptions(
        shareSystemAudio,
        screenCaptureEnvironment(isDesktopApp(), getDesktop()?.platform ?? null),
      );
      // What was actually asked for, not what was ticked. In a browser this is
      // true even unticked, because a tab share carries the tab's own sound and
      // that is a request which can fail on its own; in the shell it is only
      // ever true where the platform can answer it.
      const askedForAudio = options.audio !== false;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(options);
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
          // Everything audio can do to a capture, it does to the whole capture:
          // the video was fine and the person still got nothing. Offer the same
          // share without sound rather than leaving them to work out that the
          // toggle on the other bar is what took their screen away. Cancelling
          // the picker lands here too and is not a failure to recover from.
          state.screenShareAudioFailed =
            askedForAudio &&
            err instanceof Error &&
            err.name !== "NotAllowedError";
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
      // The red strip is ours and it is now answering a question that has been
      // resolved. Only the share failure is cleared: an unrelated error is not
      // this attempt's to dismiss.
      if (retryingAfterAudioFailure) {
        state.error = null;
      }
      state.isSharingScreen = true;
      state.localScreenStream = stream;
      state.isSharingScreenAudio = hasAudio;
      // Decided here, from the surface the picker returned, so the UI can say
      // "this is going out" at the one moment the presenter can still change
      // their mind. `getSettings` is guarded because a track handed over by a
      // shell or an older engine need not implement it.
      let displaySurface: string | undefined;
      try {
        displaySurface = track.getSettings().displaySurface;
      } catch {
        // Unknown surface reads as "not a monitor", which is the quiet answer.
      }
      state.isSharingSystemAudio = capturesSystemAudio({
        displaySurface,
        hasAudio,
      });
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

    /** Promote a share to the large tile. No-op if they are not sharing. */
    focusScreenShare(peerId: string) {
      if (!state.screenSharePeerIds.includes(peerId)) {
        return;
      }
      state.focusedScreenPeerId = peerId;
      state.audibleScreenPeerIds = audibleScreenPeerIds(
        state.screenSharePeerIds,
        peerId,
      );
      emit();
    },

    /** Stop watching one share: no picture, no sound, tile kept as a way back. */
    dismissShare(peerId: string) {
      if (state.dismissedSharePeerIds.includes(peerId)) {
        return;
      }
      state.dismissedSharePeerIds = [...state.dismissedSharePeerIds, peerId];
      state.audibleScreenPeerIds = audibleScreenPeerIds(
        state.screenSharePeerIds.filter(
          (id) => !state.dismissedSharePeerIds.includes(id),
        ),
        state.focusedScreenPeerId,
      );
      emit();
    },

    /** Undo that. */
    watchShare(peerId: string) {
      if (!state.dismissedSharePeerIds.includes(peerId)) {
        return;
      }
      state.dismissedSharePeerIds = state.dismissedSharePeerIds.filter(
        (id) => id !== peerId,
      );
      state.audibleScreenPeerIds = audibleScreenPeerIds(
        state.screenSharePeerIds.filter(
          (id) => !state.dismissedSharePeerIds.includes(id),
        ),
        state.focusedScreenPeerId,
      );
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
      if (
        isCameraAtCap(
          state.cameraPeerIds,
          state.peerId,
          state.roomTransport,
        )
      ) {
        state.error = translateMessage("voice.error.cameraLimit", {
          limit: CAMERA_LIMIT[state.roomTransport ?? "mesh"],
        });
        emit();
        return;
      }
      let stream: MediaStream;
      try {
        // Asks for the chosen quality with `ideal` constraints and falls back
        // to the bare request on refusal — see `lib/video-quality.ts`. It used
        // to be a plain `{ video: true }` here, which is why every call in this
        // product was capped at 640x480.
        stream = await captureCamera(
          (constraints) => navigator.mediaDevices.getUserMedia(constraints),
          videoQuality,
          cameraDeviceId || undefined,
        );
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
      // The same argument the screen share makes, for the same reason: a face
      // on a call is motion, not a document. Without the hint the encoder
      // optimises for sharpness and pays with frame rate, which is what makes a
      // talking head look like a slideshow the moment the link tightens.
      // Guarded because the property is read-only on some older engines.
      try {
        track.contentHint = "motion";
      } catch {
        // Encoder defaults, working camera.
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

    /**
     * Choose what the camera is asked for. `auto` is the default.
     *
     * SAFE BY CONSTRUCTION, because this is a setting a person can change in
     * the middle of a live call. Nothing here can end with a dead camera:
     * `applyCameraQuality` never rejects, `setCameraMaxBitrate` swallows an
     * encoder that refuses, and neither re-captures — the track on the wire is
     * the same track throughout, so the worst outcome is a picture that stayed
     * the size it already was.
     *
     * The capture half only applies to a camera that is already open. A closed
     * one needs nothing: `toggleCamera` reads `videoQuality` when it opens.
     */
    async setVideoQuality(next: VideoQuality) {
      if (next === videoQuality) {
        return;
      }
      videoQuality = next;
      const maxBitrate = cameraBitrateFor(next);
      manager?.setCameraMaxBitrate(maxBitrate);
      await sfu?.setCameraMaxBitrate(maxBitrate);
      // The screen half, on both transports, and unconditionally: the mesh
      // manager and the SFU session each hold the choice for a share that has
      // not started yet, so this is not only about the sender on the wire.
      manager?.setScreenQuality(next);
      await sfu?.setScreenMaxBitrate(screenBitrateFor(next));
      const track = cameraCaptureStream?.getVideoTracks()[0];
      if (track) {
        await applyCameraQuality(track, next);
      }
    },

    getVideoQuality(): VideoQuality {
      return videoQuality;
    },

    /**
     * Which webcam to ask for. Empty is the browser default.
     *
     * Stored even while the camera is off, so the next `toggleCamera` uses it.
     * A change while the camera is already open re-captures and replaces the
     * live track, the same way a mic switch does. The new track is swapped
     * into the original MediaStream so the announced id stays put: mesh
     * `replaceTrack` does not fire `ontrack`, and a late joiner must see the
     * same msid the roster already has. Re-announcing a fresh stream id is
     * what made a switched camera look like a screen share.
     */
    async setCameraDevice(deviceId: string) {
      if (cameraDeviceId === deviceId) {
        return;
      }
      cameraDeviceId = deviceId;
      if (!cameraCaptureStream || state.status !== "connected") {
        return;
      }
      let incoming: MediaStream;
      try {
        incoming = await captureCamera(
          (constraints) => navigator.mediaDevices.getUserMedia(constraints),
          videoQuality,
          cameraDeviceId || undefined,
        );
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
      const track = incoming.getVideoTracks()[0];
      if (!track) {
        for (const t of incoming.getTracks()) {
          t.stop();
        }
        state.error = translateMessage("voice.error.cameraFailed");
        emit();
        return;
      }
      try {
        track.contentHint = "motion";
      } catch {
        // Encoder defaults, working camera.
      }
      track.onended = () => {
        void stopCameraInternal();
        emit();
      };
      const current = cameraCaptureStream;
      for (const old of current.getVideoTracks()) {
        current.removeTrack(old);
        old.stop();
      }
      incoming.removeTrack(track);
      current.addTrack(track);
      for (const leftover of incoming.getTracks()) {
        leftover.stop();
      }
      emit();
      try {
        await manager?.setLocalCameraStream(current);
        if (sfu) {
          await sfu.publishCamera(current);
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

    /** The same knob for a person's screen audio. See `screenVolumes`. */
    setScreenVolume(userId: string, volume: number) {
      state.screenVolumes = {
        ...state.screenVolumes,
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
