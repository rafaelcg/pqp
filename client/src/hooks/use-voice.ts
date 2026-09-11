import {
  CAMERA_LIMIT,
  MESH_VOICE_WARNING,
  SCREEN_SHARE_LIMIT,
  meshVideoLimit,
  type ClientRelayMessage,
  type VoiceParticipant,
  type VoiceRoomTransport,
  type LiveHlsStream,
  type VoiceSessionInfo,
  type VoiceSignalingMessage,
  type LiveReactionEmoji,
} from "@pqp/shared";
import { publishLiveReactions } from "@/lib/live-reactions";
import {
  audibleScreenPeerIds,
  isCameraAtCap,
  isScreenShareAtCap,
  nextScreenShareFocus,
  type MeshRoomLink,
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
  type ScreenCaptureIntent,
} from "@/lib/screen-capture-audio";
import {
  canControlShareCursor,
  cursorConstraintFor,
  cursorRidesAlong,
  getShareCursor,
  type ShareCursor,
} from "@/lib/screen-capture-cursor";
import { createScreenMix, type ScreenMix } from "@/lib/screen-mix";
import { getMicInStream, saveMicInStream } from "@/lib/mic-in-stream";
import { translateMessage, type MessageKey } from "@/lib/i18n";
import {
  buildAudioConstraints,
  defaultMicProcessing,
  listAudioDevices,
  sameMicProcessing,
  type MicProcessing,
} from "@/lib/audio-devices";
import { moveOccupantSeat } from "@/lib/voice-occupant-dnd";
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
  remoteAudioPlan,
  sameAudioPlan,
  type RemoteAudioPlan,
} from "@/lib/remote-audio-delivery";
import {
  getReceiveQuality,
  subscribeReceiveQuality,
} from "@/lib/receive-quality";
import { beaconVoiceLeave } from "@/lib/voice-leave-beacon";
import { resolveHlsUrl } from "@/lib/hls-playback";
import {
  applyCameraQuality,
  applyScreenCaptureQuality,
  cameraBitrateFor,
  captureCamera,
  DEFAULT_VIDEO_QUALITY,
  screenCaptureSizeFor,
  watchPartyHostQuality,
  type VideoQuality,
} from "@/lib/video-quality";
import {
  hlsSourceFor,
  readPresenterHlsFeed,
} from "@/lib/hls-source-quality";
import {
  createSpeakingTracker,
  createStreamAnalyser,
  parseVadThreshold,
  readAnalyserLevel,
  SPEAKING_HANGOVER_MS,
  SPEAKING_THRESHOLD,
} from "@/lib/voice-audio";
import { playCue, stopAllSoundLoops, whenCueSettled } from "@/lib/sounds";

export type VoiceStatus = "idle" | "joining" | "connected";

/** Aligned with the server orphan TTL (`VOICE_RESUME_TTL_MS`). */
const VOICE_RESUME_GRACE_MS = 90_000;

/** WebSocket handshake to `welcome`. Signalling only, so 12s is generous. */
const JOIN_TIMEOUT_MS = 12_000;
/**
 * Voice-activity gate poll. `requestAnimationFrame` is frozen on a hidden
 * tab (and on a minimized Electron window), which is exactly when people
 * talk into this app. An interval still fires; Chrome may later clamp it
 * toward 1s, which is a late open, not a stuck one.
 */
const VOICE_ACTIVITY_POLL_MS = 50;
/**
 * `welcome` to media up on an SFU room. This used to share the 12s above,
 * which was sized for a handful of peers. On 2026-09-05 a ~90-person watch
 * party showed what that does on a phone on mobile data: fetch a token, pull
 * the ~530kB livekit-client chunk, connect to a room carrying ninety
 * participants, publish, all inside 12s. Many did not make it, the timer
 * called the SFU unreachable, the client left, the person tapped join again,
 * and LiveKit logged 552 unique participants in 41 minutes for a room of 90.
 * The black-holed-host case this timer exists for still ends, just later.
 */
const SFU_JOIN_TIMEOUT_MS = 45_000;

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
  /**
   * `promoted` is the one that is not this client's fault and not the
   * network's: the room moved to a voice server mid-call so more cameras
   * would fit, and this build could not follow it in place. Rejoining works.
   */
  reason: "unsupported" | "unreachable" | "promoted";
}

const TRANSPORT_FAILURE_KEY: Record<
  VoiceTransportFailure["reason"],
  MessageKey
> = {
  unsupported: "voice.error.transportUnsupported",
  unreachable: "voice.error.transportUnreachable",
  promoted: "voice.error.transportPromoted",
};

/**
 * How the microphone decides whether to transmit.
 *
 * - `voice-activity` — open while the local speaking tracker is above the
 *   sensitivity threshold (plus a short hold-open tail). Mute and deafen
 *   still close it.
 * - `push-to-talk` — closed unless a key (or the hold button) is down.
 */
export type VoiceInputMode = "voice-activity" | "push-to-talk";

export interface VoiceAudioOptions {
  inputDeviceId?: string;
  inputVolume?: number;
  /**
   * Join with the microphone already off. Applied before the track is published
   * so "mute on join" is muted from the very first sample. Ignored when
   * already in a call: a drag or a second join() is not an unmute.
   */
  startMuted?: boolean;
  inputMode?: VoiceInputMode;
  /** Local voice-activity sensitivity. Same 0..1 scale as the speaking tracker. */
  vadThreshold?: number;
  processing?: MicProcessing;
  /**
   * TAKE A SEAT AS AUDIENCE: NO MICROPHONE, AND NO ASKING FOR ONE.
   *
   * Not the same thing as the listen-only fallback below it. That one asks,
   * fails, and explains itself ("Entrou sem microfone, então dá pra ouvir mas
   * não pra falar. O acesso ao microfone foi bloqueado..."). For somebody who
   * only wants to watch a watch party, every word of that is noise about a
   * permission they should never have been asked for, and it frames watching
   * as a broken call. Rafael saw exactly that banner and it is the reason this
   * option exists.
   *
   * So an audience join opens no `getUserMedia` at all: no prompt, no device,
   * no notice, and no permission failure to report because none was possible.
   * Speaking becomes a deliberate second act (`takeTheMicrophone`), which is
   * the only place a microphone question belongs and the only place a
   * permission problem is worth a sentence.
   *
   * Everything downstream already tolerates a null pipeline, because the
   * listen-only path built that tolerance: mesh skips `addTrack`, the SFU
   * skips publish, and the mute controls no-op.
   */
  audienceOnly?: boolean;
}

export interface VoiceState {
  status: VoiceStatus;
  peerId: string | null;
  remotePeers: RemotePeer[];
  /** The user's explicit mute. Independent of push-to-talk. */
  isMuted: boolean;
  /** Deafened silences everyone else and forces your own mic off, as in Discord. */
  isDeafened: boolean;
  /**
   * Whether the room's rules let this person talk: `Permission.SPEAK`, as the
   * server resolved it for this channel. Unlike `isMuted` it is not a choice.
   * False means: joined muted, the unmute control is locked, push-to-talk
   * does not open the mic. Flips mid-call on `voice-speak-changed`. Always
   * true in a conversation call.
   */
  canSpeak: boolean;
  /**
   * In this room as audience, with no microphone open and none requested.
   * The UI shows "Falar" rather than a mute button, and never a permission
   * complaint: nothing was refused, nothing was asked.
   */
  isAudienceSeat: boolean;
  /**
   * Whether the room's rules let this person present: `Permission.STREAM`.
   * False hides camera and screen share. Absent on an older server is
   * treated as `canSpeak`.
   */
  canStream: boolean;
  inputMode: VoiceInputMode;
  /**
   * Whether audio is actually leaving this machine right now — the one thing
   * a push-to-talk or voice-activity user needs to be able to check at a glance.
   *
   * Derived, never set: `!muted && !deafened && (voice-activity speaking ||
   * key held)`. The UI reads this rather than `isMuted` when it wants to say
   * "you are live", because those two answer different questions.
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
  /**
   * When OUR OWN hand went up, in epoch milliseconds, or null when it is down.
   *
   * The room's whole queue is not duplicated here: it is already on the
   * roster, one `handRaisedAt` per participant, and `raisedHandQueue` in
   * @pqp/shared turns `occupancy[voiceChannelId]` into the ordered list
   * wherever one is drawn. Holding a second copy would be a second thing to
   * keep in sync with the first.
   *
   * This one field exists because the raise BUTTON cannot wait for a round
   * trip to look pressed. It is set the moment the person clicks and
   * reconciled against the roster (`applySelfHand`), which is also how a
   * moderator lowering it reaches us: nothing else can change it.
   */
  handRaisedAt: number | null;
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
  /**
   * True when this room is on mesh AND this deployment has a voice server to
   * move it to, so the camera and share caps are the server's to enforce, not
   * this client's.
   *
   * The local caps exist so a button is disabled rather than a claim refused
   * a round trip later. That is still right on a room that cannot move. On a
   * mesh room that can, refusing locally is what made "nao da pra ter mais de
   * 3 cameras" true for everyone: the fourth camera never reached the server,
   * so the server never got to promote the room.
   */
  canPromoteTransport: boolean;
  /**
   * The transport this room ran on before it changed underneath us, or null.
   *
   * Set only from `voice-transport-changed`, which the server sends to the
   * sockets that were already seated. That is exactly the audience for "the
   * limits just went up": somebody who joins after the move gets `welcome`
   * instead, never this, and is told nothing, because nothing changed for
   * them. Cleared with the seat, so it does not follow us into the next room.
   *
   * Whether the change actually RAISED anything is not decided here: that is
   * `lib/voice-capacity.ts`, off the shared limit maps.
   */
  capacityRoseFrom: VoiceRoomTransport | null;
  /** True when this client is the one presenting. */
  isSharingScreen: boolean;
  /**
   * The share going out carries this person's microphone, mixed into its
   * audio track, so the people watching from outside hear them. See
   * `lib/screen-mix.ts`.
   */
  isSharingMic: boolean;
  /** The standing preference behind `isSharingMic` (`lib/mic-in-stream.ts`). */
  micInStream: boolean;
  /** peerIds currently sharing, in roster order. */
  screenSharePeerIds: string[];
  /**
   * LiveKit egress playlist for the room's current screen share, or null.
   * Remote tiles play this instead of the WebRTC screen track.
   */
  liveStream: LiveHlsStream | null;
  /**
   * channelId -> what the server last said about that channel's HLS stream,
   * for every channel this socket may view, seat or no seat (`channel-live`).
   * `liveStream` above is the room we are IN; this is the sidebar's and the
   * seatless watcher's view of every room. `watching` counts the people on
   * the playlist without a seat; the room's own people are in `occupancy`.
   */
  channelLive: Record<string, ChannelLive>;
  /** peerIds whose camera is on, from the roster's `cameraStreamId`. */
  cameraPeerIds: string[];
  /**
   * What this machine's uplink last measured, in bit/s, or null before there
   * has been anything to measure.
   *
   * PREDICTION, NOT ENFORCEMENT. The buttons use it to grey themselves at the
   * number this link can actually carry (`meshVideoLimit`), which is why it is
   * on the state at all. The server holds every seat's report and takes the
   * narrowest of them, so its answer can be smaller than this one, and its
   * answer is the one that decides. Null everywhere on the voice server, where
   * no client number is read.
   */
  uplinkBps: number | null;
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
   * True when the person asked for their mouse to be left out and this
   * capture carries it anyway.
   *
   * Read off the surface the picker returned, for the same reason as the line
   * above: a tab share genuinely has no pointer in it, so saying otherwise
   * would be crying wolf. What can and cannot be done about it on each engine
   * is in `lib/screen-capture-cursor.ts`.
   */
  isShareCursorVisible: boolean;
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

/** One channel's `channel-live` answer. `stream: null` is "nothing live". */
export interface ChannelLive {
  stream: LiveHlsStream | null;
  watching: number;
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

/**
 * Why the camera was refused, in the words that are true for this room.
 *
 * Three shapes, and only one of them names a number. A mesh room with a count
 * to state says the count. A mesh room that has a voice server to move to and
 * was refused anyway was refused on the box's budget, not on a count. A room
 * already on the voice server has no count at all (`CAMERA_LIMIT.livekit` is
 * `null`), so it gets the same sentence: "no room for more cameras right now",
 * which is a fact about the moment rather than a number that is about to
 * change.
 */
function cameraLimitMessage(
  limit: number | null,
  canPromote: boolean,
): string {
  if (limit === null || canPromote) {
    return translateMessage("voice.error.cameraLimitBusy");
  }
  return translateMessage("voice.error.cameraLimit", { limit });
}

/**
 * The same three shapes for a screen share, now that the voice server has no
 * share count either.
 *
 * On a mesh room that cannot move, the number is this room's own measured one
 * and stating it is honest: it is what this call can carry. On a room that CAN
 * move, or on the voice server, a refusal is the box being full rather than a
 * count being reached, and "this call already has 2" would be a lie that a
 * quieter box contradicts a minute later.
 */
function shareLimitMessage(limit: number | null, canPromote: boolean): string {
  if (limit === null || canPromote) {
    return translateMessage("voice.error.shareLimitBusy");
  }
  return translateMessage("voice.error.shareLimit", { limit });
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
 * The sentence for a room that just moved onto the voice server.
 *
 * Five triggers, two sentences. `cameras` and `screens` answer a click the
 * person just made, so they name it. Everything else is the room having grown
 * under them, and an unknown reason from a newer server reads as that too,
 * which is the safe side because it is true of every promotion.
 *
 * `room-size` deliberately does NOT get a sentence of its own. The capacity
 * card in `lib/voice-capacity.ts` already tells this exact person that
 * screens and cameras just went up, with numbers read out of the limits that
 * enforce them. A second, vaguer line saying the same thing at the same
 * moment is noise, and it is the trigger that fires most often.
 *
 * (Do not write a bare PR reference like a three or four digit number after a
 * hash anywhere under `client/src`: `bench/theme-tokens.mjs` reads it as a
 * hex colour literal and fails the build. Name the file instead.)
 */
function promotionNoticeKey(
  reason: "cameras" | "screens" | "room-full" | "room-size" | "stale-pin",
): MessageKey {
  if (reason === "cameras") {
    return "voice.notice.promotedForCameras";
  }
  if (reason === "screens") {
    return "voice.notice.promotedForScreens";
  }
  return "voice.notice.promotedForRoom";
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

/**
 * How often the presenter's uplink is re-read while a watch party is
 * transcoding from their share. The same 2 s the mesh's upload budget uses
 * (`SCREEN_BUDGET_SAMPLE_MS`), for the same reason: often enough to notice a
 * link going bad, rarely enough to cost nothing.
 */
const HLS_SOURCE_SAMPLE_MS = 2_000;

export function createVoiceController(transport: RealtimeTransport) {
  let manager: ReturnType<typeof createPeerConnectionManager> | null = null;
  let sfu: LiveKitSession | null = null;
  // The receive ceiling is a device preference set from the call's menu; the
  // menu writes the store and the live SFU session follows it here, so the
  // choice needs no thread through the stage's props.
  subscribeReceiveQuality((quality) => {
    void sfu?.setReceiveQuality(quality);
  });
  /**
   * The presenter's own picture while a watch party is transcoding from it.
   * Sampled rather than computed once because the uplink is the thing that
   * decides, and it moves. The cadence matches the mesh's own upload-budget
   * sampler, which is the reading this reuses.
   */
  let hlsSourceTimer: ReturnType<typeof setInterval> | null = null;
  async function refreshHlsSource(): Promise<void> {
    const wanted = hlsSourceFor({
      streamTopHeight: state.liveStream?.topHeight,
      isSharingScreen: state.isSharingScreen,
      usingSfu: state.usingSfu,
      uplinkBps: null,
    });
    if (!wanted) {
      if (hlsSourceTimer !== null) {
        clearInterval(hlsSourceTimer);
        hlsSourceTimer = null;
      }
      await sfu?.setHlsSource(null);
      return;
    }
    if (hlsSourceTimer === null) {
      hlsSourceTimer = setInterval(() => {
        void refreshHlsSource();
      }, HLS_SOURCE_SAMPLE_MS);
    }
    const feed = await readPresenterHlsFeed();
    await sfu?.setHlsSource({
      ...wanted,
      uplinkBps: feed.uplinkBps,
      limitedBy: feed.limitedBy,
    });
  }
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
  /**
   * This seat was taken as audience: deliberately no microphone, and none was
   * ever asked for. Distinct from `pipeline === null` after a failed open,
   * which is the listen-only fallback and does owe the person an explanation.
   */
  let audienceSeat = false;
  /** Owns the getDisplayMedia() capture; mirrored into state.localScreenStream. */
  let screenCaptureStream: MediaStream | null = null;
  let joinTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let speakingRaf = 0;
  let voiceActivityPollId = 0;
  let iceServers: RTCIceServer[] = getDefaultIceServers();
  const remoteAnalysers = new Map<
    string,
    { analyser: AnalyserNode; dispose: () => void }
  >();
  const speakingTracker = createSpeakingTracker();
  /**
   * Own tracker for the transmit gate. The speaking-ring tracker above is
   * shared with remote peers and must keep the fixed ring threshold; this one
   * follows the person's sensitivity slider and its own hangover tail.
   */
  const voiceActivityTracker = createSpeakingTracker({
    threshold: SPEAKING_THRESHOLD,
    hangoverMs: SPEAKING_HANGOVER_MS,
  });
  let vadThreshold = SPEAKING_THRESHOLD;
  let voiceActivityOpen = false;
  // Peers the server has told us are in *our* room. Signaling from anyone else
  // is dropped so a stray/cross-room offer can never open a mic connection.
  const knownPeerIds = new Set<string>();
  /**
   * channelId -> the roster sequence this client has applied up to.
   *
   * 0, or absent, means "no baseline", which is also what an empty room
   * restarts from — so the first delta of a fresh call (`seq` 1) is applied by
   * somebody who was not watching the last one, with no extra round trip. See
   * `voiceRosterDeltaMessageSchema` in `@pqp/shared` for the whole rule.
   */
  const rosterSeq = new Map<string, number>();
  let joinGeneration = 0;
  // The room the user means to be in. Kept across a WS drop so we can auto-
  // rejoin on reconnect instead of ejecting them from the call.
  let intendedChannelId: string | null = null;
  /**
   * The channel this socket is watching WITHOUT a seat (`watch-live`), or
   * null. Kept outside `state` for the same reason `intendedChannelId` is: it
   * is what to re-announce after a reconnect, since the server counts sockets
   * and a fresh socket is not on its list until it says so again.
   */
  let watchingChannelId: string | null = null;
  /** Channel switch in flight: keep "Na call" up while WebRTC rebuilds. */
  let switchingRooms = false;
  /**
   * Mute/deafen the person already chose, captured at the start of a room
   * switch. A new `welcome` always arrives with `self.muted: false` (the
   * server resets a seat). That must not unmute them, and it must not win
   * over this snapshot when we publish the next track.
   */
  let preservedSelfVoice: { muted: boolean; deafened: boolean } | null = null;
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
  /** Last fps asked of a live screen capture; Qualidade mid-share reuses it. */
  let screenCaptureFps: 30 | 60 = 30;
  /** Webcam id for the next capture. Empty means the browser default. */
  let cameraDeviceId = "";
  let state: VoiceState = {
    status: "idle",
    peerId: null,
    remotePeers: [],
    isMuted: false,
    isDeafened: false,
    canSpeak: true,
    canStream: true,
    isAudienceSeat: false,
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
    handRaisedAt: null,
    occupancy: {},
    peerVolumes: {},
    screenVolumes: {},
    usingSfu: false,
    transportFailure: null,
    roomTransport: null,
    canPromoteTransport: false,
    capacityRoseFrom: null,
    isSharingScreen: false,
    isSharingMic: false,
    micInStream: getMicInStream(),
    screenSharePeerIds: [],
    liveStream: null,
    channelLive: {},
    cameraPeerIds: [],
    uplinkBps: null,
    focusedScreenPeerId: null,
    dismissedSharePeerIds: [],
    audibleScreenPeerIds: [],
    localScreenStream: null,
    isSharingScreenAudio: false,
    isSharingSystemAudio: false,
    isShareCursorVisible: false,
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

  function applyPreservedSelfVoice() {
    if (!preservedSelfVoice) {
      return;
    }
    if (preservedSelfVoice.deafened) {
      state.isDeafened = true;
      state.isMuted = true;
    } else if (preservedSelfVoice.muted) {
      state.isMuted = true;
    }
    applyMuteToPipeline();
  }

  /**
   * Our own hand as it should be DRAWN, given what we believe and what the
   * roster says.
   *
   * Presence is ours: the click has to move the icon now, and the roster
   * describing us is always at least one round trip behind it. The NUMBER is
   * the server's, because the number is the queue's order and two clients
   * guessing at it is exactly the disagreement `handRaisedAt` exists to
   * prevent. So: down when we believe it is down, and once it is up, the
   * server's instant as soon as there is one.
   */
  function overlaySelfHand(person: VoiceParticipant): number | null {
    if (state.handRaisedAt === null) {
      return null;
    }
    return person.handRaisedAt ?? state.handRaisedAt;
  }

  function overlayLocalSelfVoice(person: VoiceParticipant): VoiceParticipant {
    const userId = state.self?.userId;
    if (!userId || person.userId !== userId) {
      return person;
    }
    const handRaisedAt = overlaySelfHand(person);
    if (
      person.muted === state.isMuted &&
      person.deafened === state.isDeafened &&
      (person.handRaisedAt ?? null) === handRaisedAt
    ) {
      return person;
    }
    return {
      ...person,
      muted: state.isMuted,
      deafened: state.isDeafened,
      handRaisedAt,
    };
  }

  function overlayOccupancy(
    occupancy: Record<string, VoiceParticipant[]>,
  ): Record<string, VoiceParticipant[]> {
    let changed = false;
    const next: Record<string, VoiceParticipant[]> = {};
    for (const [id, people] of Object.entries(occupancy)) {
      const mapped = people.map(overlayLocalSelfVoice);
      if (mapped.some((person, index) => person !== people[index])) {
        changed = true;
      }
      next[id] = mapped;
    }
    return changed ? next : occupancy;
  }

  function redeclareLocalMedia() {
    applyPreservedSelfVoice();
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
      if (
        generation === joinGeneration &&
        (state.status === "joining" || switchingRooms)
      ) {
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
        voiceActivityOpen = false;
        voiceActivityTracker.clear();
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
    }, failure ? SFU_JOIN_TIMEOUT_MS : JOIN_TIMEOUT_MS);
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
    switchingRooms = false;
    preservedSelfVoice = null;
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
    voiceActivityOpen = false;
    voiceActivityTracker.clear();
    state.isTransmitting = false;
    state.status = "idle";
    state.peerId = null;
    state.self = null;
    state.remotePeers = [];
    state.voiceChannelId = null;
    state.speakingPeerIds = [];
    state.serverMutedPeerIds = [];
    discardPendingHand();
    state.handRaisedAt = null;
    state.transportFailure = failure;
    state.error = translateMessage(TRANSPORT_FAILURE_KEY[failure.reason]);
    emit();
  }

  /**
   * A mesh room on a deployment with a voice server behind it: the caps are
   * the server's call, not this client's, because hitting one is what asks
   * the server to move the room. See `isCameraAtCap`.
   */
  function canPromoteTransport(): boolean {
    return state.roomTransport === "mesh" && sessionProvider !== null;
  }

  function snapshot(): VoiceState {
    const self = state.self ? overlayLocalSelfVoice(state.self) : null;
    const occupancy = overlayOccupancy(state.occupancy);
    return {
      ...state,
      // Derived, never stored: it is a fact about the room plus a fact about
      // this build, and both are already here.
      canPromoteTransport: canPromoteTransport(),
      remotePeers: [...state.remotePeers],
      speakingPeerIds: [...state.speakingPeerIds],
      serverMutedPeerIds: [...state.serverMutedPeerIds],
      occupancy: { ...occupancy },
      peerVolumes: { ...state.peerVolumes },
      screenVolumes: { ...state.screenVolumes },
      self: self ? { ...self } : null,
      incomingCalls: [...state.incomingCalls],
      callDeclinedUserIds: [...state.callDeclinedUserIds],
      channelLive: { ...state.channelLive },
    };
  }

  /**
   * The last plan handed to the SFU, so an unchanged one is not pushed again.
   *
   * `emit` runs on every state change, which in a busy room is every speaking
   * ring; the plan changes only when somebody deafens, moves a volume slider
   * to or off zero, is server-muted, or a share's sound starts or stops.
   * Null while there is no SFU session, so the first plan after a connect (or
   * a reconnect, which builds a new session with nothing registered) is
   * always pushed.
   */
  let pushedAudioPlan: RemoteAudioPlan | null = null;

  /**
   * Tell the SFU which remote sounds this listener wants at all.
   *
   * Mesh rooms skip it: there is no server to stop, and a peer connection
   * that stopped sending would have to renegotiate to start again. On the SFU
   * it is one signalling message and the bytes stop leaving Sao Paulo. See
   * `remote-audio-delivery.ts`.
   */
  function pushAudioDelivery() {
    if (!sfu) {
      pushedAudioPlan = null;
      return;
    }
    const plan = remoteAudioPlan({
      peers: state.remotePeers,
      isDeafened: state.isDeafened,
      peerVolumes: state.peerVolumes,
      screenVolumes: state.screenVolumes,
      serverMutedPeerIds: state.serverMutedPeerIds,
      audibleScreenPeerIds: state.audibleScreenPeerIds,
    });
    if (pushedAudioPlan && sameAudioPlan(pushedAudioPlan, plan)) {
      return;
    }
    try {
      sfu.setAudioDelivery(plan);
      pushedAudioPlan = plan;
    } catch (err) {
      // A BANDWIDTH SAVING MUST NEVER BE ABLE TO END A CALL, and this runs
      // inside `emit`, which is on the path of every state change there is.
      // A throw here propagated out of `emit` and took the whole SFU session
      // down with it, which is a hundred times the cost of the bytes it was
      // trying to save. The plan is deliberately not recorded as pushed, so
      // the next emit tries again.
      console.warn("[pqp] could not push the remote audio plan", err);
    }
  }

  function emit() {
    pushAudioDelivery();
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
   * recomputation. Mute and deafen outrank every input mode: holding the key
   * or crossing the voice-activity line while muted must not transmit, or the
   * mute button would be a lie.
   */
  function micShouldBeOpen(): boolean {
    // The rule outranks every choice below it: a held push-to-talk key or a
    // toggled mute button must not open a mic the channel does not allow.
    if (!state.canSpeak) {
      return false;
    }
    if (state.isDeafened || state.isMuted) {
      return false;
    }
    if (state.inputMode === "push-to-talk") {
      return pushToTalkHeld;
    }
    return voiceActivityOpen;
  }

  function applyVadThreshold(value: number) {
    vadThreshold = parseVadThreshold(value);
    voiceActivityTracker.setThreshold(vadThreshold);
  }

  /**
   * Voice activity has to keep hearing the capture to decide when to open.
   * Mute, deafen and a missing SPEAK grant still cut the raw track.
   */
  function captureShouldStayLive(): boolean {
    if (!state.canSpeak || state.isDeafened || state.isMuted) {
      return false;
    }
    return state.inputMode === "voice-activity" || state.isTransmitting;
  }

  /**
   * Read the local analyser and open or close the outgoing track.
   *
   * Called from the speaking loop so the gate and the speaking ring share one
   * clock. Silence fails closed; a short hangover keeps the last syllable.
   */
  function syncVoiceActivityGate() {
    if (state.inputMode !== "voice-activity") {
      voiceActivityOpen = false;
      return;
    }
    if (!pipeline || !state.canSpeak || state.isMuted || state.isDeafened) {
      voiceActivityOpen = false;
      voiceActivityTracker.update("local", 0, false);
      return;
    }
    // Fail closed if the analyser cannot be read (closed context, test stub).
    if (typeof pipeline.analyser.getByteFrequencyData !== "function") {
      voiceActivityOpen = false;
      voiceActivityTracker.update("local", 0, false);
      return;
    }
    const level = readAnalyserLevel(pipeline.analyser);
    voiceActivityOpen = voiceActivityTracker.update("local", level, true);
    if (micShouldBeOpen() !== state.isTransmitting) {
      applyMute();
      emit();
    }
  }

  /**
   * Publish the mic to the SFU once the room lets us.
   *
   * After a grant the server updates our LiveKit permission and tells us over
   * the app WS, and the two arrive in no fixed order. `publishTrack` checks
   * the local copy of the permission and throws when it is still the old
   * one, so a handful of short retries covers the gap without a reconnect.
   */
  async function publishMicWhenAllowed(attempt = 0): Promise<void> {
    if (!sfu || !pipeline || !state.canSpeak || !state.usingSfu) {
      return;
    }
    try {
      applyPreservedSelfVoice();
      applyMuteToPipeline();
      await sfu.publish(pipeline.processedStream);
      sfuPublicationMuted = null;
      await applyPublicationMute();
      preservedSelfVoice = null;
    } catch (err) {
      if (attempt >= 5) {
        state.error = err instanceof Error ? err.message : String(err);
        emit();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      await publishMicWhenAllowed(attempt + 1);
    }
  }

  /**
   * Apply the room's SPEAK rule to this client.
   *
   * `false` mutes, stops any share or camera, and says so once. On the SFU
   * the server has already revoked the publish grant, so this is the UI
   * catching up with a fact; in a mesh room this IS the enforcement, which
   * is documented and accepted (docs/voice-backends.md, "Speak permission").
   * `true` after `false` unlocks the controls and publishes the mic muted,
   * leaving the unmute to the person.
   */
  function applyPublishRules(
    canSpeak: boolean,
    canStream: boolean,
    source: "welcome" | "change",
  ) {
    const wasSpeak = state.canSpeak;
    const wasStream = state.canStream;
    state.canSpeak = canSpeak;
    state.canStream = canStream;
    if (!canSpeak) {
      state.isMuted = true;
      applyMute();
    }
    if (!canStream) {
      if (screenCaptureStream) {
        void stopScreenShareInternal();
      }
      if (cameraCaptureStream) {
        void stopCameraInternal();
      }
    }
    if (source === "welcome") {
      if (!canSpeak) {
        state.notice = translateMessage("voice.notice.speakDenied");
      } else if (!canStream) {
        state.notice = translateMessage("voice.notice.streamDenied");
      }
      return;
    }
    if (wasSpeak && !canSpeak) {
      state.notice = translateMessage("voice.notice.speakDenied");
      return;
    }
    if (!wasSpeak && canSpeak) {
      applyMute();
      state.notice = translateMessage("voice.notice.speakGranted");
      void publishMicWhenAllowed();
      return;
    }
    if (wasStream && !canStream) {
      state.notice = translateMessage("voice.notice.streamDenied");
      return;
    }
    if (!wasStream && canStream) {
      state.notice = translateMessage("voice.notice.streamGranted");
    }
  }

  function publishFlagsFrom(message: {
    canSpeak?: boolean;
    canStream?: boolean;
    self?: { canSpeak?: boolean; canStream?: boolean };
  }): { canSpeak: boolean; canStream: boolean } {
    const canSpeak = message.canSpeak ?? message.self?.canSpeak ?? true;
    const canStream = message.canStream ?? message.self?.canStream ?? canSpeak;
    return { canSpeak, canStream };
  }

  function applyMuteToPipeline() {
    state.isTransmitting = micShouldBeOpen();
    lowerHandOnTransmit();
    if (!pipeline) {
      return;
    }
    for (const track of pipeline.processedStream.getAudioTracks()) {
      track.enabled = state.isTransmitting;
    }
    const captureLive = captureShouldStayLive();
    for (const track of pipeline.rawStream.getAudioTracks()) {
      track.enabled = captureLive;
    }
  }

  /**
   * LiveKit publication mute is the remote-visible mute: user mute, deafen,
   * or SPEAK revoked. Voice-activity word boundaries only flip
   * `track.enabled` — publishing mute on every syllable fans TrackMuted to
   * the whole room.
   */
  function publicationShouldBeMuted(): boolean {
    if (!state.canSpeak || state.isDeafened || state.isMuted) {
      return true;
    }
    // The mic is already in the share's audio track: publishing it a second
    // time would have every seated listener hear the host twice, out of two
    // jitter buffers, which is flanging. Moderation still reaches the mix
    // (`muteSfuUser` walks `type === AUDIO`).
    if (screenMix && state.isSharingMic) {
      return true;
    }
    if (state.inputMode === "voice-activity") {
      return false;
    }
    return !state.isTransmitting;
  }

  /**
   * Both transports, every time.
   *
   * Disabling the track is what stops mesh peers hearing anything — an
   * `enabled: false` track sends silence over the existing sender, which is why
   * push-to-talk never renegotiates. LiveKit still needs `published.mute()`
   * when the person meant to be muted (or is on push-to-talk between presses).
   */
  let sfuPublicationMuted: boolean | null = null;

  function applyPublicationMute() {
    const next = publicationShouldBeMuted();
    if (!sfu || sfuPublicationMuted === next) {
      return Promise.resolve();
    }
    sfuPublicationMuted = next;
    return sfu.setMuted(next).catch((err) => {
      sfuPublicationMuted = null;
      throw err;
    });
  }

  function applyMute() {
    applyMuteToPipeline();
    applyPublicationMute();
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
        sfuPublicationMuted = null;
        await applyPublicationMute();
      }
      // The stream mix follows the room, not the other way round: only once
      // the room is on the new microphone does the audience get it too, so
      // a failed replacement never leaves the two on different devices.
      if (screenMix && state.isSharingMic) {
        screenMix.setMic(pipeline.processedStream);
      }
      emit();
    } catch (err) {
      state.error = err instanceof Error ? err.message : failureMessage;
      if (screenMix && state.isSharingMic && pipeline) {
        screenMix.setMic(pipeline.processedStream);
      }
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

  function stopVoiceActivityPoll() {
    if (voiceActivityPollId) {
      clearInterval(voiceActivityPollId);
      voiceActivityPollId = 0;
    }
  }

  function startVoiceActivityPoll() {
    stopVoiceActivityPoll();
    const id = setInterval(syncVoiceActivityGate, VOICE_ACTIVITY_POLL_MS);
    // Node test runners treat a live interval as an open handle. The browser
    // returns a number, which has no unref; a Timeout does.
    if (typeof id === "object" && id !== null && "unref" in id) {
      (id as { unref: () => void }).unref();
    }
    voiceActivityPollId = id as unknown as number;
  }

  function stopSpeakingLoop() {
    if (speakingRaf) {
      cancelAnimationFrame(speakingRaf);
      speakingRaf = 0;
    }
    stopVoiceActivityPoll();
    speakingTracker.clear();
    voiceActivityTracker.clear();
    voiceActivityOpen = false;
    if (state.speakingPeerIds.length > 0) {
      state.speakingPeerIds = [];
      emit();
    }
  }

  function startSpeakingLoop() {
    stopSpeakingLoop();
    startVoiceActivityPoll();
    const tick = () => {
      const next: string[] = [];
      // The interval keeps the gate alive on a hidden tab. This rAF path is
      // the low-latency one while the tab is visible.
      syncVoiceActivityGate();
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
      applySelfHand(me.handRaisedAt ?? null);
    }
  }

  /**
   * How long a raise or a lower we sent stays believed while the rosters
   * disagree with it.
   *
   * A roster is built from what the server held when it was built, so the one
   * that crosses our own frame on the wire still describes the old hand.
   * Adopting it would snap the button back for a beat and then forward again,
   * which reads as a bug. Believing it forever would be worse: a frame the
   * limiter dropped would leave a hand up on our screen that is up nowhere
   * else. So we hold our belief for a couple of seconds and then let the room
   * win, which is the only side that can be right about a queue.
   */
  const HAND_ECHO_MS = 3_000;
  /**
   * Our last unacknowledged raise/lower. `seen` is the latest roster value
   * that arrived while we were waiting — including a moderator's null —
   * so a mismatch is retained rather than discarded. `previous` is what to
   * revert to if the echo never comes (the frame was dropped).
   */
  let pendingHand: {
    raised: boolean;
    at: number;
    previous: number | null;
    seen: number | null | undefined;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function discardPendingHand() {
    if (!pendingHand) {
      return;
    }
    clearTimeout(pendingHand.timer);
    pendingHand = null;
  }

  function reconcilePendingHand(
    pending: NonNullable<typeof pendingHand>,
  ) {
    if (pendingHand !== pending) {
      return;
    }
    pendingHand = null;
    // A roster we held back (moderator lower, or a late echo of the old
    // state) wins once the window closes. No roster at all means the
    // frame never landed: revert so a quiet room cannot leave the button
    // pressed forever.
    state.handRaisedAt =
      pending.seen !== undefined ? pending.seen : pending.previous;
    emit();
  }

  /**
   * Take our own hand from a roster (`welcome`, `voice-roster`,
   * `peer-updated` about us).
   *
   * This is also the whole of how a MODERATOR lowering our hand reaches us:
   * there is no notice frame for it, because the roster is already the thing
   * everybody in the room is reading, and one of them is us.
   */
  function applySelfHand(serverValue: number | null) {
    if (pendingHand) {
      pendingHand.seen = serverValue;
      const agrees = (serverValue !== null) === pendingHand.raised;
      if (!agrees && Date.now() - pendingHand.at < HAND_ECHO_MS) {
        return;
      }
      discardPendingHand();
    }
    state.handRaisedAt = serverValue;
  }

  /**
   * SPEAKING LOWERS YOUR OWN HAND, and it can only be done here.
   *
   * `speaking` is deliberately not on the roster (see the fan-out note on
   * `voiceParticipantSchema`), so the server cannot see this happen; the one
   * machine that knows is the one the microphone is plugged into. That is not
   * a hole: the only hand this can lower is our own, and a client that
   * declined to run it would be leaving its OWN hand up in a queue it can see.
   *
   * `isTransmitting` and not "unmuted": on voice activity it is the gate
   * opening on an actual syllable, and on push-to-talk it is the key going
   * down. Both are the person taking their turn, which is what the queue was
   * for.
   */
  function lowerHandOnTransmit() {
    if (
      !state.isTransmitting ||
      state.handRaisedAt === null ||
      state.status !== "connected" ||
      !state.voiceChannelId
    ) {
      return;
    }
    sendRaisedHand(false);
  }

  /** Declare our own hand, and believe it until the room says otherwise. */
  function sendRaisedHand(raised: boolean) {
    const previous = state.handRaisedAt;
    discardPendingHand();
    const pending: NonNullable<typeof pendingHand> = {
      raised,
      at: Date.now(),
      previous,
      seen: undefined,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    pending.timer = setTimeout(() => {
      reconcilePendingHand(pending);
    }, HAND_ECHO_MS);
    pendingHand = pending;
    state.handRaisedAt = raised ? Date.now() : null;
    transport.sendVoice({ type: "set-raised-hand", raised });
  }

  /** One peer's flag changed (`peer-joined`, `peer-updated`). */
  function applyPeerServerMute(peer: VoiceParticipant) {
    if (peer.peerId === state.peerId) {
      applySelfServerMute(peer.serverMuted);
      applySelfHand(peer.handRaisedAt ?? null);
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
    sfuPublicationMuted = null;
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
  /** The mic-into-share mix while a watch party share is up. */
  let screenMix: ScreenMix | null = null;
  /** The raw display capture behind `screenMix`, stopped with it. */
  let screenCaptureSource: MediaStream | null = null;
  /** The running share was started for a watch party (`intent.watchParty`). */
  let screenCaptureIsWatchParty = false;

  function releaseScreenCapture() {
    if (!screenCaptureStream) {
      return;
    }
    for (const track of screenCaptureStream.getTracks()) {
      track.stop();
    }
    if (screenCaptureSource) {
      for (const track of screenCaptureSource.getTracks()) {
        track.stop();
      }
      screenCaptureSource = null;
    }
    const hadMix = screenMix !== null;
    screenMix?.close();
    screenMix = null;
    screenCaptureIsWatchParty = false;
    screenCaptureStream = null;
    state.isSharingScreen = false;
    state.isSharingMic = false;
    if (hadMix) {
      // The mic left the share with it: the separate publication comes back
      // now, or the room hears nothing while the pill shows an open mic.
      sfuPublicationMuted = null;
      void applyPublicationMute();
    }
    state.localScreenStream = null;
    state.isSharingScreenAudio = false;
    state.isSharingSystemAudio = false;
    state.isShareCursorVisible = false;
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

  /**
   * Take a fresh reading of this machine's uplink, for the mesh limit.
   *
   * Only on mesh, and only when there is a manager: on the voice server the
   * server reads nothing a client sends about links, and a reading taken there
   * would be a number travelling for no reason. A failed or absent reading
   * keeps the last one rather than clearing it, because "I could not measure
   * just now" is not "my link got smaller".
   */
  async function refreshUplinkMeasurement(): Promise<void> {
    if (state.roomTransport === "livekit") {
      return;
    }
    const measured = await manager?.measureUplinkBps();
    if (measured !== null && measured !== undefined) {
      state.uplinkBps = measured;
    }
  }

  /** What `meshVideoLimit` needs to know about this room, from the state. */
  function meshRoomLink(): MeshRoomLink {
    return {
      // Ourselves plus everyone the roster holds. `remotePeers` is the mesh's
      // own view and is the number the server counts too.
      roomSize: state.remotePeers.length + 1,
      uplinkBps: state.uplinkBps,
    };
  }

  function meshShareLimit(): number | null {
    return state.roomTransport === "livekit"
      ? SCREEN_SHARE_LIMIT.livekit
      : meshVideoLimit({ kind: "screens", ...meshRoomLink() });
  }

  function meshCameraLimit(): number | null {
    return state.roomTransport === "livekit"
      ? CAMERA_LIMIT.livekit
      : meshVideoLimit({ kind: "cameras", ...meshRoomLink() });
  }

  /** Published capture height, for the HLS ladder to refuse an upscale. */
  function screenSourceHeight(): number | undefined {
    const track = screenCaptureStream?.getVideoTracks()[0];
    try {
      const height = track?.getSettings?.().height;
      return typeof height === "number" && height > 0
        ? Math.round(height)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Announce the share (and whether it has sound) to the room. */
  function announceSharing() {
    transport.sendVoice({
      type: "set-sharing-screen",
      sharing: true,
      audioStreamId: screenAudioStreamId(),
      uplinkBps: state.uplinkBps ?? undefined,
      sourceHeight: screenSourceHeight(),
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

      // A fresh session has nothing registered, so the plan it was last told
      // about applies to no publication. Forgetting it makes the next emit
      // push the current one, whatever it is.
      pushedAudioPlan = null;
      sfu = await connectLiveKit({
        session,
        // The list this tab already holds for the mesh, read now so a refresh
        // between calls reaches the next connection and this one is left be.
        iceServers,
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
        // A republished share is a new sid on the SFU. Re-declaring it lets
        // the server notice and restart the HLS egress, which is otherwise
        // left transcoding a track that no longer exists.
        onScreenRepublished: () => {
          if (screenCaptureStream) {
            announceSharing();
          }
        },
      });

      if (state.peerId !== peerId) {
        await teardownSfu();
        return true;
      }
      // No publish for a listener: the token carries no grant for one and
      // LiveKit would refuse it. The mic is published if SPEAK arrives later.
      if (pipeline && state.canSpeak) {
        applyPreservedSelfVoice();
        applyMuteToPipeline();
        await sfu.publish(pipeline.processedStream);
        sfuPublicationMuted = null;
        // Mute the publication after publish, but the track was already
        // disabled above so the first packet is not live.
        await applyPublicationMute();
        preservedSelfVoice = null;
      }
      // Before anything is published, so a camera or a share carried across a
      // reconnect is republished at the chosen quality. Without this a session
      // rebuilt after a WS drop silently reverted both to the defaults, and
      // nothing recomputed them until the user next touched the menu.
      await sfu.setCameraMaxBitrate(cameraBitrateFor(videoQuality));
      await sfu.setScreenQuality(videoQuality);
      // The viewer's half: the largest layer this device wants, remembered
      // per device. Applied before anything is subscribed so the first frame
      // of a share arriving at a phone is already the phone-sized layer.
      await sfu.setReceiveQuality(getReceiveQuality());
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
      applyPreservedSelfVoice();
      applyMuteToPipeline();
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
    switchingRooms = false;
    preservedSelfVoice = null;
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
    voiceActivityOpen = false;
    voiceActivityTracker.clear();
    discardPendingHand();
    state = {
      status: "idle",
      peerId: null,
      remotePeers: [],
      isMuted: false,
      isDeafened: false,
      canSpeak: true,
      canStream: true,
      isAudienceSeat: false,
      inputMode: state.inputMode,
      isTransmitting: false,
      error: null,
      errorKind: null,
      notice: null,
      voiceChannelId: null,
      self: null,
      speakingPeerIds: [],
      serverMutedPeerIds: [],
      // Leaving lowers your hand, on the server and here. The queue is the
      // room's, and we are not in it any more.
      handRaisedAt: null,
      occupancy: state.occupancy,
      peerVolumes: state.peerVolumes,
      screenVolumes: state.screenVolumes,
      usingSfu: false,
      transportFailure: null,
      roomTransport: null,
      canPromoteTransport: false,
      capacityRoseFrom: null,
      isSharingScreen: false,
      isSharingMic: false,
      micInStream: state.micInStream,
      screenSharePeerIds: [],
      liveStream: null,
      // Channel-level, not room-level: hanging up does not make the sidebar
      // forget which rooms are live.
      channelLive: state.channelLive,
      cameraPeerIds: [],
    uplinkBps: null,
      focusedScreenPeerId: null,
      dismissedSharePeerIds: [],
      audibleScreenPeerIds: [],
      localScreenStream: null,
      isSharingScreenAudio: false,
      isSharingSystemAudio: false,
      isShareCursorVisible: false,
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

  /**
   * The room, as the server has just described it, however it described it.
   *
   * Both roster frames end here with the same complete participant list: a
   * snapshot brings its own, a delta produces one by patching the list this
   * client already held. Everything downstream — occupancy badges, moderator
   * mutes, camera and screen state, and the signaling allowlist — therefore
   * reads one code path and cannot drift between the two frames.
   *
   * `authoritative` is the one real difference, and it is about
   * `knownPeerIds`, which is a trust boundary rather than a display:
   *
   *  - A SNAPSHOT rebuilds it from scratch, so a stale id from a missed or
   *    reordered `peer-left` cannot linger as an accepted signaling source.
   *    That is why the periodic keyframe matters even when nothing was wrong.
   *  - A DELTA adds and removes by name and never clears, because absence from
   *    a delta means "unchanged", not "gone". Clearing on one would drop every
   *    peer the delta did not happen to mention.
   *
   * While holding media across a signaling blip, a roster can arrive before
   * the resume welcome (a fresh server process: empty room). Absence is not
   * departure there either: union ids, do not clear, do not tear down peer
   * connections.
   */
  function applyRoster(
    voiceChannelId: string,
    participants: VoiceParticipant[],
    transport: VoiceRoomTransport | undefined,
    authoritative: boolean,
  ) {
    applyPreservedSelfVoice();
    state.occupancy = {
      ...state.occupancy,
      [voiceChannelId]: participants.map(overlayLocalSelfVoice),
    };
    if (participants.length === 0) {
      const next = { ...state.occupancy };
      delete next[voiceChannelId];
      state.occupancy = next;
      // The server forgets an empty room's sequence so the next call in this
      // channel starts at 1; a client that kept the old number would read that
      // first delta as a gap and sit out the whole next call until a keyframe.
      rosterSeq.delete(voiceChannelId);
    }
    if (voiceChannelId !== state.voiceChannelId) {
      return;
    }
    // Moderator mutes are read on every path: a roster that arrives while
    // holding media is still the room's word on who is muted.
    applyServerMutes(participants);
    if (holdingMedia) {
      for (const participant of participants) {
        if (participant.peerId !== state.peerId) {
          knownPeerIds.add(participant.peerId);
        }
      }
      return;
    }
    if (authoritative) {
      knownPeerIds.clear();
    }
    for (const participant of participants) {
      if (participant.peerId !== state.peerId) {
        knownPeerIds.add(participant.peerId);
      }
    }
    if (!authoritative) {
      // A delta's list is this client's whole belief about the room, so an id
      // it no longer contains is one the room no longer has. Removing by
      // difference rather than by the frame's `left` keeps this identical to
      // what the snapshot path computes.
      const present = new Set(participants.map((p) => p.peerId));
      for (const peerId of knownPeerIds) {
        if (!present.has(peerId)) {
          knownPeerIds.delete(peerId);
        }
      }
    }
    if (transport) {
      state.roomTransport = transport;
    }
    applyScreenShareRoster(participants);
    applyCameraRoster(participants);
    applyCameraStreamIds(participants);
    applyScreenAudioStreamIds(participants);
    applySharingScreen(participants);
    pruneFailedGhostPeers();
  }

  function handleSignaling(message: VoiceSignalingMessage) {
    switch (message.type) {
      case "voice-roster":
        // Authoritative by definition: whatever the sequence said, and
        // whatever this client believed, the room is this. That is what makes
        // the periodic snapshot a repair for any delta that went wrong,
        // including one this client had no way to notice was missing.
        rosterSeq.set(message.voiceChannelId, message.seq ?? 0);
        applyRoster(
          message.voiceChannelId,
          message.participants,
          message.transport,
          true,
        );
        emit();
        break;
      case "voice-roster-delta": {
        // The convergence rule, in full. Two independent checks: the sequence
        // must be the next one, and the room size after applying must be the
        // size the server says it is. Failing either, this client stops
        // patching and waits for the next full roster — a wrong badge for a
        // few seconds, never a peer that is invisible until rejoin.
        const held = rosterSeq.get(message.voiceChannelId) ?? 0;
        if (message.seq !== held + 1) {
          break;
        }
        const byId = new Map(
          (state.occupancy[message.voiceChannelId] ?? []).map((participant) => [
            participant.peerId,
            participant,
          ]),
        );
        // In order, and every entry an absolute statement about one peer, so
        // replaying one that a snapshot already folded in changes nothing.
        for (const participant of message.joined ?? []) {
          byId.set(participant.peerId, participant);
        }
        for (const participant of message.updated ?? []) {
          byId.set(participant.peerId, participant);
        }
        for (const peerId of message.left ?? []) {
          byId.delete(peerId);
        }
        if (byId.size !== message.size) {
          break;
        }
        rosterSeq.set(message.voiceChannelId, message.seq);
        applyRoster(
          message.voiceChannelId,
          [...byId.values()],
          message.transport,
          false,
        );
        emit();
        break;
      }
      /**
       * Two different refusals arrive on one frame, and they need different
       * sentences.
       *
       * On a room whose transport cannot move, this is the plain cap: the
       * call already has its four shares and the number is worth stating. On
       * a mesh room that CAN move (`canPromoteTransport`), the client no
       * longer refuses at the cap at all, so a refusal here means the server
       * tried to move the room to the voice server and would not: the box is
       * carrying too much (`VOICE_PROMOTION_MAX_SFU_MBPS`) or it is not
       * answering. "This call already has 2" would be a lie there, because a
       * moment later, on a quieter box, the same click works.
       */
      case "screen-share-denied":
        if (message.voiceChannelId !== state.voiceChannelId) {
          return;
        }
        void stopScreenShareInternal();
        state.error = shareLimitMessage(
          meshShareLimit(),
          canPromoteTransport(),
        );
        emit();
        break;
      case "camera-denied":
        if (message.voiceChannelId !== state.voiceChannelId) {
          return;
        }
        void stopCameraInternal();
        state.error = cameraLimitMessage(
          meshCameraLimit(),
          canPromoteTransport(),
        );
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
          state.roomTransport = roomTransport;
          state.status = "connected";
          applyPublishRules(
            publishFlagsFrom(message).canSpeak,
            publishFlagsFrom(message).canStream,
            "change",
          );
          applyPreservedSelfVoice();
          state.self = overlayLocalSelfVoice(message.self);
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
          switchingRooms = false;
          preservedSelfVoice = null;
          redeclareLocalMedia();
          emit();
          break;
        }

        holdingMedia = false;
        clearResumeGrace();
        if (state.status === "connected" && !switchingRooms) {
          state.status = "joining";
        }
        knownPeerIds.clear();
        state.peerId = message.peerId;
        state.voiceChannelId = message.voiceChannelId;
        state.transportFailure = null;
        // A fresh seat, so there is no "before" to have grown from. This is
        // what keeps the capacity card off the screen of somebody who walks
        // into a room that was already promoted.
        state.capacityRoseFrom = null;
        // Before any media is built, so a listener's SFU session never tries
        // to publish and a mesh listener's track starts disabled.
        applyPublishRules(
          publishFlagsFrom(message).canSpeak,
          publishFlagsFrom(message).canStream,
          "welcome",
        );
        applyPreservedSelfVoice();
        state.self = overlayLocalSelfVoice(message.self);

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
            const wasSwitchingRooms = switchingRooms;
            switchingRooms = false;
            if (wasSwitchingRooms) {
              redeclareLocalMedia();
            }
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
        const wasSwitchingRooms = switchingRooms;
        switchingRooms = false;
        if (ringOnWelcomeChannelId === channelId) {
          ringOnWelcomeChannelId = null;
          transport.sendVoice({ type: "call-ring", conversationId: channelId });
        }
        startMeshSession(peerId, welcomePeers);
        if (wasSwitchingRooms) {
          redeclareLocalMedia();
        }
        preservedSelfVoice = null;
        startSpeakingLoop();
        emit();
        break;
      }
      case "voice-transport-unsupported":
        // Usually the server refused before creating a peer: no roster entry
        // of ours ever existed, so there is nothing for anyone else to clean
        // up. `reason: "promoted"` is the other case: we WERE seated and the
        // room moved to a voice server without us, because this socket never
        // negotiated `voice-transport-changed`. The server has already
        // released the seat; the local teardown and the sentence are the same
        // either way, only the sentence differs.
        if (
          state.status === "idle" ||
          message.voiceChannelId !== state.voiceChannelId
        ) {
          return;
        }
        refuseTransport({
          transport: message.transport,
          reason: message.reason === "promoted" ? "promoted" : "unsupported",
        });
        break;
      /**
       * THE ROOM MOVED UNDER US, ON PURPOSE.
       *
       * Somebody turned on a camera the mesh could not carry, so the server
       * promoted the whole room to the SFU (see the promotion section in
       * `server/src/ws/voice.ts`). Our seat, our peer id, our mute, our
       * camera and our share all survive: only the media path changes.
       *
       * Deliberately NOT a rejoin. A rejoin would mint a new peer id, tell
       * everybody we left and arrived, and cost the room a join cue each; the
       * seat is still ours and the server still holds it. So this is the
       * media half of `welcome`'s SFU branch and nothing else, run against
       * the peer id we already have. `startSfuSession` republishes the mic
       * (muted if we are muted), the camera and the screen capture from the
       * state this hook is already holding, which is what "keeping the
       * intent" means here.
       */
      case "voice-transport-changed": {
        if (
          state.status !== "connected" ||
          message.voiceChannelId !== state.voiceChannelId
        ) {
          return;
        }
        // One-way, and only to a transport this build can actually run.
        // Anything else is ignored and we stay exactly where we are, which is
        // the only safe reading of a frame from a newer server: the room may
        // have moved somewhere we cannot go, and guessing is what produced
        // the split-brain this whole mechanism exists to prevent.
        if (message.transport !== "livekit") {
          return;
        }
        if (state.roomTransport === message.transport) {
          // Already there: a duplicate frame (two publishers, a bus replay)
          // must not tear a live SFU session down and build it again.
          return;
        }
        const peerId = state.peerId;
        if (!peerId) {
          return;
        }
        if (!sessionProvider) {
          // This build cannot run the room's new transport. The server only
          // sends this frame to sockets that declared they can follow it, so
          // reaching here means the two disagree; leaving is the honest
          // answer and matches what the server does to a socket that never
          // declared it at all.
          refuseTransport({ transport: message.transport, reason: "promoted" });
          break;
        }
        // Recorded before the new transport lands: this is the "before" the
        // capacity card compares against (`lib/voice-capacity.ts`). Only the
        // sockets that were seated across the move get this frame, which is
        // exactly who should be told the room grew.
        state.capacityRoseFrom = state.roomTransport ?? "mesh";
        state.roomTransport = message.transport;
        state.notice = translateMessage(promotionNoticeKey(message.reason));
        for (const peer of message.participants) {
          knownPeerIds.add(peer.peerId);
        }
        // The mesh goes first and unconditionally: every peer connection in
        // it is addressed to a room whose signaling the server no longer
        // relays, so leaving one up is a dead connection and a stale tile.
        manager?.dispose();
        manager = null;
        const others = message.participants.filter(
          (peer) => peer.peerId !== peerId,
        );
        void startSfuSession(message.voiceChannelId, peerId, others).then(
          (ok) => {
            if (state.peerId !== peerId) {
              return;
            }
            if (!ok) {
              // Same rule as a join that cannot reach the SFU: leave and say
              // so. Building a mesh back would put us alone in a room that
              // has moved.
              refuseTransport({
                transport: "livekit",
                reason: "unreachable",
              });
              return;
            }
            redeclareLocalMedia();
            emit();
          },
        );
        emit();
        break;
      }
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
      case "voice-speak-changed":
        if (
          state.status === "idle" ||
          message.voiceChannelId !== state.voiceChannelId
        ) {
          return;
        }
        applyPublishRules(
          message.canSpeak,
          message.canStream ?? message.canSpeak,
          "change",
        );
        emit();
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
      // --- live reactions ---
      // Straight out to whoever is drawing, without touching `state`. A
      // coalesced window is an event with a 1.5 second lifetime, not room
      // state, and putting it in the snapshot would re-render the whole call
      // stage four times a second during a burst. See `lib/live-reactions.ts`.
      case "live-reactions":
        publishLiveReactions({
          channelId: message.channelId,
          items: message.items,
          seq: message.seq,
        });
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
      case "voice-stream":
        if (message.channelId !== state.voiceChannelId) {
          return;
        }
        // `hlsUrl` may be API-relative (the signed playlist proxy) rather
        // than a full URL, when `LIVE_HLS_SIGNED_URLS` is on. See
        // `resolveHlsUrl`.
        state.liveStream = message.stream
          ? { ...message.stream, hlsUrl: resolveHlsUrl(message.stream.hlsUrl) }
          : null;
        // An egress that just started (or stopped) changes what the
        // presenter should be publishing: the ladder transcodes from their
        // track, so a 720p share caps every viewer at 720p.
        void refreshHlsSource();
        emit();
        break;
      case "channel-live":
        // Every channel this socket may view, in or out of the room. Same
        // URL treatment as `voice-stream`; the room's own `liveStream` is
        // left to that frame so the two never disagree about the room we
        // are actually in.
        state.channelLive = {
          ...state.channelLive,
          [message.channelId]: {
            stream: message.stream
              ? {
                  ...message.stream,
                  hlsUrl: resolveHlsUrl(message.stream.hlsUrl),
                }
              : null,
            watching: message.watching,
          },
        };
        emit();
        break;
    }
  }

  /**
   * Tell the server we are (or are no longer) on this channel's playlist
   * without a seat. Idempotent: the same answer twice sends nothing, so a
   * stage that re-renders is not a second viewer.
   */
  function sendWatchLive(channelId: string, watching: boolean) {
    if (watching) {
      if (watchingChannelId === channelId) {
        return;
      }
      if (watchingChannelId) {
        transport.sendVoice({
          type: "watch-live",
          channelId: watchingChannelId,
          watching: false,
        });
      }
      watchingChannelId = channelId;
      transport.sendVoice({ type: "watch-live", channelId, watching: true });
      return;
    }
    if (watchingChannelId !== channelId) {
      return;
    }
    watchingChannelId = null;
    transport.sendVoice({ type: "watch-live", channelId, watching: false });
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

  // Named, so `takeTheMicrophone` can call the controller's own `join` rather
  // than a second copy of the join logic.
  const controller = {
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
     * One tap. Silent when there is no room: a reaction is a thing said inside
     * a call, and the server drops it on the same rule.
     */
    sendLiveReaction(emoji: LiveReactionEmoji) {
      if (!state.voiceChannelId || state.status !== "connected") {
        return;
      }
      transport.sendVoice({
        type: "live-reaction",
        channelId: state.voiceChannelId,
        emoji,
      });
    },

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
      if (
        intendedChannelId === voiceChannelId &&
        (switchingRooms || state.voiceChannelId === voiceChannelId) &&
        state.status !== "idle"
      ) {
        return;
      }
      const fromIdle = state.status === "idle";
      const switching =
        state.status !== "idle" &&
        state.voiceChannelId !== null &&
        state.voiceChannelId !== voiceChannelId;
      if (!fromIdle) {
        preservedSelfVoice = {
          muted: state.isMuted,
          deafened: state.isDeafened,
        };
      }
      if (switching) {
        resumeToken = null;
        holdingMedia = false;
        clearResumeGrace();
        switchingRooms = true;
        if (state.self) {
          state.occupancy = overlayOccupancy(
            moveOccupantSeat(
              state.occupancy,
              state.self.userId,
              voiceChannelId,
            ).next,
          );
        }
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
      // A live call that is only changing rooms stays "connected" so the
      // status bar never flashes off "Na call" while WebRTC rebuilds.
      if (!switching) {
        state.status = "joining";
      }
      // A channel switch calls join() without leave(), so the previous room's
      // share ids would otherwise leak into the welcome diff and look like
      // newcomers. Empty previous is the locked "join into live shares" rule.
      state.screenSharePeerIds = [];
      state.liveStream = null;
      state.cameraPeerIds = [];
      state.focusedScreenPeerId = null;
      state.audibleScreenPeerIds = [];
      // A queue belongs to a room. Walking into another one is not a place
      // in its queue, and the welcome will say so anyway.
      state.handRaisedAt = null;
      discardPendingHand();
      // Known from the moment we start, not only once the server says welcome —
      // otherwise the UI cannot tell which channel is connecting.
      state.voiceChannelId = voiceChannelId;
      intendedChannelId = voiceChannelId;
      // A seat is counted on the roster; staying on the watch list too would
      // count this person twice.
      sendWatchLive(voiceChannelId, false);
      // Joining a conversation that was ringing us IS the acceptance, so the
      // invitation surface for it comes down; declines belong to the last call.
      removeIncomingCall(voiceChannelId);
      state.callDeclinedUserIds = [];
      // A ring armed for a previous join must not fire for this one.
      if (ringOnWelcomeChannelId && ringOnWelcomeChannelId !== voiceChannelId) {
        ringOnWelcomeChannelId = null;
      }
      // Fresh join: mute-on-join / crowd mute. Already in a call: never
      // take startMuted. A second join() (Strict Mode, drop+click) is
      // not consent to unmute, and the server seat is born unmuted.
      if (fromIdle) {
        state.isMuted = options?.startMuted ?? state.isMuted;
      } else {
        applyPreservedSelfVoice();
      }
      // Never inherit a key held from before the join — there is no keyup owed
      // to us for a press that happened while we were not in a call.
      if (fromIdle) {
        pushToTalkHeld = false;
        voiceActivityOpen = false;
        voiceActivityTracker.clear();
      }
      state.inputMode = options?.inputMode ?? state.inputMode;
      if (options?.vadThreshold !== undefined) {
        applyVadThreshold(options.vadThreshold);
      }
      state.isTransmitting = micShouldBeOpen();
      applyMuteToPipeline();
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
        if (!switching) {
          await whenCueSettled();
        }
        if (generation !== joinGeneration) {
          return;
        }
        if (!fromIdle) {
          applyPreservedSelfVoice();
          applyMuteToPipeline();
          sendJoin(voiceChannelId);
          return;
        }
        if (options?.audienceOnly) {
          // The audience seat. No prompt, no device, no notice: see
          // `audienceOnly` above. Muted is the truthful state, not a
          // punishment, and `takeTheMicrophone` is how it changes.
          stopMicPipeline(pipeline);
          pipeline = null;
          audienceSeat = true;
          state.isAudienceSeat = true;
          state.isMuted = true;
          applyMuteToPipeline();
          sendJoin(voiceChannelId);
          return;
        }
        audienceSeat = false;
        state.isAudienceSeat = false;
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
        if (!fromIdle) {
          applyPreservedSelfVoice();
          applyMuteToPipeline();
          sendJoin(voiceChannelId);
          return;
        }
        // LISTEN-ONLY JOIN. A microphone that cannot be opened: none plugged
        // in, permission refused, another app holding it — used to abort the
        // whole join with an error. On 2026-09-05 a streamer sent ~170 people
        // into a watch party and a visible share of them never got in, on
        // phones that had not granted the mic and laptops without one. None of
        // them needed to talk. So: join anyway, muted, with no pipeline, and
        // say why in the notice. Everything downstream already tolerates a
        // null pipeline (mesh skips addTrack, the SFU skips publish, the mute
        // controls no-op), so this is the join catching up with the rest.
        stopMicPipeline(pipeline);
        pipeline = null;
        state.isMuted = true;
        applyMuteToPipeline();
        state.notice = translateMessage("voice.notice.listenOnly", {
          reason: micErrorMessage(err),
        });
        sendJoin(voiceChannelId);
      }
    },

    replaceOccupancy(next: Record<string, VoiceParticipant[]>) {
      state.occupancy = next;
      emit();
    },

    leave() {
      audienceSeat = false;
      leaveCall();
    },

    /**
     * GO FROM WATCHING TO TALKING, AND ASK FOR THE MICROPHONE ONLY HERE.
     *
     * The one place in a watch party where a permission prompt is honest:
     * somebody has decided to speak. A refusal here is worth a sentence,
     * because they asked for something and did not get it, which is exactly
     * what was NOT true of the join.
     *
     * IT LEAVES AND REJOINS, AND THAT IS DELIBERATE. Adding a microphone to a
     * seat that has none is not a `replaceTrack`: mesh needs an `addTrack` and
     * a fresh offer to every peer, and the SFU needs a publish. The join path
     * already does both, correctly, on both transports, and has done since
     * before this feature existed. Rebuilding that here as a third negotiation
     * path is how the mesh and the SFU drift apart. The cost is about a second
     * of reconnect at the moment somebody presses a button that says Falar,
     * which is a moment they already expect to take a beat.
     *
     * Refused by the server's rule as well as the browser's: `canSpeak` is
     * SPEAK on the channel, and a party whose stage is closed denies it to
     * @everyone for the length of the show. The button is hidden for an
     * audience the host has not let up; this is the backstop for a shortcut.
     */
    async takeTheMicrophone() {
      const channelId = state.voiceChannelId;
      if (state.status !== "connected" || !audienceSeat || !channelId) {
        return;
      }
      if (!state.canSpeak) {
        state.notice = translateMessage("voice.notice.speakDenied");
        emit();
        return;
      }
      audienceSeat = false;
      state.isAudienceSeat = false;
      leaveCall();
      await controller.join(channelId, {
        ...audioOptions,
        inputMode: state.inputMode,
        // Arriving on the stage unmuted is the point: they pressed a button
        // that says Falar. Mute-on-join is about a room you walked into, not
        // a stage you asked to be on.
        startMuted: false,
      });
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
      // The server counts watchers per socket, and this is a new socket.
      if (watchingChannelId) {
        transport.sendVoice({
          type: "watch-live",
          channelId: watchingChannelId,
          watching: true,
        });
      }
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

    /**
     * "Meu mic vai no stream". Takes effect on the running share at once
     * (the mic branch is connected or dropped) and is remembered for the
     * next one.
     */
    setMicInStream(on: boolean) {
      saveMicInStream(on);
      state.micInStream = on;
      if (screenMix && pipeline) {
        // A mix is up: connect or drop the mic branch in place.
        screenMix.setMic(on ? pipeline.processedStream : null);
        state.isSharingMic = on;
        sfuPublicationMuted = null;
        void applyPublicationMute();
      } else if (
        on &&
        pipeline &&
        screenCaptureStream &&
        screenCaptureIsWatchParty &&
        state.roomTransport === "livekit"
      ) {
        // The share started with the switch off: build the mix now and put
        // the mixed stream on the wire. The SFU republishes the share when
        // audio appears, which a running HLS egress rebinds to; a few
        // seconds of picture, and then the host is heard.
        try {
          const source = screenCaptureStream;
          screenMix = createScreenMix(source, pipeline.processedStream);
          screenCaptureSource = source;
          screenCaptureStream = screenMix.stream;
          state.localScreenStream = screenMix.stream;
          state.isSharingMic = true;
          sfuPublicationMuted = null;
          void applyPublicationMute();
          void (async () => {
            await manager?.setLocalScreenStream(screenMix!.stream);
            if (sfu) {
              await sfu.publishScreen(screenMix!.stream);
            }
          })();
        } catch {
          screenMix = null;
          screenCaptureSource = null;
        }
      }
      emit();
    },
    setMuted(muted: boolean) {
      if (!pipeline) {
        return;
      }
      preservedSelfVoice = null;
      // Undeafening is the only way back to an unmuted mic while deafened,
      // there is no way back at all while the room says listen only, and a
      // moderator's mute is not ours to lift either: the server would refuse
      // the declaration and nobody would play us anyway.
      state.isMuted =
        state.isDeafened || !state.canSpeak || state.self?.serverMuted
          ? true
          : muted;
      applyMute();
      emit();
    },

    toggleMute() {
      if (!pipeline) {
        return;
      }
      preservedSelfVoice = null;
      // Locked, not toggled: the button is disabled for this, and a shortcut
      // or a desktop menu item that reaches here must get the same answer.
      if (!state.canSpeak) {
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

    /**
     * Put our own hand up or take it down.
     *
     * LOWERING IS ALWAYS AVAILABLE. Nothing gates it: not a moderator's mute,
     * not a listen-only room, not push-to-talk. Raising a hand is asking, and
     * a person who has changed their mind about asking must be able to say so
     * without finding a button that has locked itself.
     *
     * Deliberately NOT gated on `canSpeak` in the other direction either: a
     * stage audience with no microphone is the audience this whole feature is
     * for. It is gated on being in the call, since a queue you are not in the
     * room for is not a queue you can be called from.
     */
    toggleRaisedHand() {
      if (state.status !== "connected" || !state.voiceChannelId) {
        return;
      }
      sendRaisedHand(state.handRaisedAt === null);
      emit();
    },

    toggleDeafen() {
      if (!pipeline) {
        return;
      }
      preservedSelfVoice = null;
      state.isDeafened = !state.isDeafened;
      // Deafening also mutes; undeafening restores an open mic, unless the
      // room never allowed one or a moderator has it pinned.
      state.isMuted =
        state.isDeafened || !state.canSpeak || state.self?.serverMuted === true;
      applyMute();
      emit();
    },

    /**
     * @param shareSystemAudio On a Windows desktop shell whose picker cannot
     *   ask yet, the user's opt-in to sending the machine's sound. Ignored in
     *   a browser: Chrome 141+ is offered the box in its own picker, and
     *   `restrictOwnAudio` keeps the call out of that tap. False does NOT mean
     *   a silent share: a Chrome tab share still carries that tab's own audio.
     * @param intent Watch party passes `{ preferBrowserTab: true }` so the
     *   picker steers at a tab. That path never takes `shareSystemAudio`.
     */
    async startScreenShare(
      shareSystemAudio = false,
      intent: ScreenCaptureIntent = {},
    ) {
      if (state.status !== "connected") {
        return;
      }
      // Presenting is speaking. The button is hidden for a listener; this is
      // for the keyboard shortcut and the desktop menu.
      if (!state.canStream) {
        state.notice = translateMessage("voice.notice.streamDenied");
        emit();
        return;
      }
      // Measured before the check, not after: the whole point of the reading
      // is to decide this, and a stale one from the last room would answer for
      // a link that may have changed since.
      await refreshUplinkMeasurement();
      if (
        isScreenShareAtCap(
          state.screenSharePeerIds,
          state.peerId,
          state.roomTransport,
          canPromoteTransport(),
          meshRoomLink(),
        )
      ) {
        state.error = shareLimitMessage(
          meshShareLimit(),
          canPromoteTransport(),
        );
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

      // The standing "leave my mouse out of it" preference, read from its own
      // store rather than passed down four components (it is remembered per
      // person: `lib/screen-capture-cursor.ts`). An explicit `hideCursor` on
      // the intent still wins, so a caller can override it for one share.
      const hideCursor = intent.hideCursor ?? getShareCursor() === "hide";
      const captureQuality =
        intent.watchParty === true
          ? watchPartyHostQuality(videoQuality)
          : videoQuality;
      const captureSize = screenCaptureSizeFor(captureQuality);
      const captureFps =
        intent.watchParty === true
          ? 30
          : intent.maxFrameRate === 60
            ? 60
            : 30;
      screenCaptureFps = captureFps;
      const options = screenCaptureOptions(
        shareSystemAudio,
        screenCaptureEnvironment(
          isDesktopApp(),
          getDesktop()?.platform ?? null,
          {
            sharePickerOffersAudio:
              getDesktop()?.sharePickerOffersAudio === true,
          },
        ),
        {
          ...intent,
          hideCursor,
          maxFrameRate: captureFps,
          maxWidth: captureSize.width,
          maxHeight: captureSize.height,
        },
      );
      // What was actually asked for, not what was ticked. In a browser this is
      // true even unticked, because a tab share carries the tab's own sound and
      // that is a request which can fail on its own; in the shell it is only
      // ever true where the platform can answer it.
      const askedForAudio = options.audio !== false;

      let stream: MediaStream;
      // A stream the caller already opened (the watch party preview) is
      // published as it is. The picker has already run, the host has already
      // looked at the result, and asking again here would broadcast a
      // different capture from the one they approved.
      if (intent.stream) {
        stream = intent.stream;
      } else {
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
          // Size still capped. `{ video: true }` is how a 4K panel stayed
          // 3840×2160 after the picker constraints were refused.
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { max: captureSize.width },
              height: { max: captureSize.height },
              frameRate: { max: captureFps },
            },
          });
        } catch {
          state.error = screenShareErrorMessage(err);
          emit();
          return;
        }
      }
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        state.error = translateMessage("voice.error.noVideoTrack");
        emit();
        return;
      }
      // getDisplayMedia often ignores width/height on a display surface.
      // applyConstraints is what actually caps a 4K panel at the pick.
      await applyScreenCaptureQuality(track, captureQuality, captureFps);
      // The single most effective line in this feature. A capture track carries
      // no content hint by default and the encoder then optimises a screen for
      // sharpness, holding resolution and dropping frames the moment bandwidth
      // tightens. That is right for a spreadsheet and wrong for everything
      // people actually share here: a film, a match, a game. "motion" flips the
      // trade to framerate, which is what makes a share look live rather than
      // like a series of stills. Text loses a little crispness; a film stops
      // stuttering. Guarded because the property is read-only on some older
      // implementations rather than merely ignored.
      // Watch-party measured host fps sawteeth are usually capture surface (tab/YouTube 24fps), not this hint.
      try {
        track.contentHint = "motion";
      } catch {
        // Encoder defaults, working share.
      }
      // Empty on Safari and Firefox, on a macOS screen or window share, and
      // whenever the "share audio" box was left unticked. It is the common
      // case, not a failure: the share goes ahead silent, exactly as every
      // share did before this existed.
      // THE HOST'S VOICE IN THE STREAM. A watch party share (the tab
      // picker, `preferBrowserTab`) on the SFU mixes the microphone into
      // the share's audio track before it is published, so the transcode
      // carries it to the people watching from outside. Scoped to LiveKit:
      // a mesh room hands the share's audio to each peer separately and
      // has no seatless audience to reach. The processed mic stream is
      // tapped, so mute stays mute. `lib/screen-mix.ts`.
      // WHAT THE CAPTURE ITSELF CARRIES, read before any mixing: this is the
      // number the silent-film warning and `capturesSystemAudio` are about,
      // and a mixed track always has audio in it whether or not the tab did.
      const hasAudio = stream.getAudioTracks().length > 0;
      screenCaptureIsWatchParty = intent.watchParty === true;
      if (screenCaptureIsWatchParty && state.micInStream && !pipeline) {
        // Listen-only seat (no mic could be opened): the switch is on and
        // there is nothing to mix. The pill will say muted; this says why.
        console.warn("[watch-party] mic mix skipped: no microphone pipeline");
      }
      if (
        screenCaptureIsWatchParty &&
        state.roomTransport === "livekit" &&
        pipeline &&
        state.micInStream
      ) {
        try {
          screenMix = createScreenMix(stream, pipeline.processedStream);
          screenCaptureSource = stream;
          stream = screenMix.stream;
          state.isSharingMic = true;
          // The mic is in the share now: the separate publication goes quiet
          // at once, not on the next mute toggle.
          sfuPublicationMuted = null;
          void applyPublicationMute();
        } catch (err) {
          // No WebAudio here, or the graph refused: the share goes out as it
          // is, room-only mic. Said out loud, because a pill reading "só a
          // sala ouve" on a host who expected to be heard is a bug report
          // with no diagnosis attached.
          console.warn("[watch-party] mic mix failed, sharing without it", err);
          screenMix = null;
          screenCaptureSource = null;
          state.notice = translateMessage("voice.notice.micMixFailed");
        }
      }
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
      // Same moment, same rule, different consequence: the presenter asked for
      // their pointer to be left out and this surface carries it anyway. Said
      // now, while they can still pick a different surface.
      state.isShareCursorVisible = cursorRidesAlong({
        displaySurface,
        hideCursor,
        canControl: canControlShareCursor(),
      });
      emit();

      try {
        await manager?.setLocalScreenStream(stream);
        if (sfu) {
          await sfu.publishScreen(stream);
        }
        // After the SFU publish, not before. Live HLS looks up the
        // SCREEN_SHARE track the moment this frame lands; announcing first
        // made every staging start miss the track and fall back to WebRTC.
        announceSharing();
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

    /**
     * Push the cursor preference onto a share that is already running.
     *
     * Making somebody stop a film and start it again to get rid of a pointer
     * is a poor answer, and `applyConstraints` is the right one: it changes a
     * live track in place, no renegotiation, nobody's picture drops. It is
     * only called where the engine says it can honour the constraint, because
     * WebKit demonstrated the failure mode this guards against: the promise
     * RESOLVES on an engine that ignores the member entirely, so a successful
     * call proves nothing and would light a green control over an unchanged
     * picture. No engine says yes today (see `lib/screen-capture-cursor.ts`),
     * so today this returns having done nothing and the toggle stays hidden
     * mid-share. It is here so the day one does, a live share follows.
     */
    async applyShareCursor(preference: ShareCursor) {
      const track = screenCaptureStream?.getVideoTracks()[0];
      if (!track || !canControlShareCursor()) {
        return;
      }
      try {
        await track.applyConstraints({
          cursor: cursorConstraintFor(preference),
        } as MediaTrackConstraints);
      } catch {
        // Overconstrained or refused. The share is untouched and still live,
        // which is the outcome that matters; the next share asks again.
        return;
      }
      state.isShareCursorVisible = false;
      emit();
    },

    /**
     * Push a capture fps onto a share that is already running.
     *
     * applyConstraints in place: no picker, no renegotiation, nobody's
     * picture drops. A browser that refuses leaves the share as it was;
     * the next share asks again. Mesh encodings re-read the track's
     * delivered fps so a 60 capture is not still published at 30.
     */
    async applyScreenFrameRate(fps: 30 | 60) {
      const next = screenCaptureIsWatchParty ? 30 : fps;
      screenCaptureFps = next;
      const track =
        screenCaptureSource?.getVideoTracks()[0] ??
        screenCaptureStream?.getVideoTracks()[0];
      if (!track) {
        return;
      }
      await applyScreenCaptureQuality(
        track,
        screenCaptureIsWatchParty ? watchPartyHostQuality(videoQuality) : videoQuality,
        next,
      );
      manager?.setScreenQuality(videoQuality);
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
      if (!state.canStream) {
        state.notice = translateMessage("voice.notice.streamDenied");
        emit();
        return;
      }
      await refreshUplinkMeasurement();
      if (
        isCameraAtCap(
          state.cameraPeerIds,
          state.peerId,
          state.roomTransport,
          canPromoteTransport(),
          meshRoomLink(),
        )
      ) {
        state.error = cameraLimitMessage(
          meshCameraLimit(),
          canPromoteTransport(),
        );
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
      transport.sendVoice({
        type: "set-camera",
        streamId: stream.id,
        uplinkBps: state.uplinkBps ?? undefined,
      });
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
      await sfu?.setScreenQuality(next);
      const screenTrack =
        screenCaptureSource?.getVideoTracks()[0] ??
        screenCaptureStream?.getVideoTracks()[0];
      if (screenTrack) {
        await applyScreenCaptureQuality(
          screenTrack,
          screenCaptureIsWatchParty ? watchPartyHostQuality(next) : next,
          screenCaptureFps,
        );
      }
      const track = cameraCaptureStream?.getVideoTracks()[0];
      if (track) {
        await applyCameraQuality(track, next);
        // The capture is a different size now, and on the SFU the simulcast
        // ladder was solved against the size it used to be. This republishes
        // only when the set of rungs actually changed; see the session.
        await sfu?.reconcileCameraLadder();
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
      // recognised as ours. Drop it and start closed. Voice activity starts
      // closed too: the speaking loop reopens it on the next frame that is
      // actually above the line.
      pushToTalkHeld = false;
      voiceActivityOpen = false;
      voiceActivityTracker.clear();
      applyMute();
      emit();
    },

    /**
     * Sensitivity for voice-activity mode. Mid-call it only changes the
     * tracker threshold — no recapture, no renegotiation.
     */
    setVadThreshold(threshold: number) {
      const next = parseVadThreshold(threshold);
      if (vadThreshold === next) {
        return;
      }
      applyVadThreshold(next);
      syncVoiceActivityGate();
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

    /**
     * Watch mode without a seat: "I am on this channel's HLS playlist"
     * (`true`) or "I stopped" (`false`). The server answers with a
     * `channel-live` carrying the new count. Never sent for the room we are
     * in; a seat is already counted on the roster. Survives a reconnect
     * (`notifyReconnected` re-announces it) and ends on `join`.
     */
    /**
     * `GET /api/channels/:id/live`, for a socket that opened the channel
     * before it received a `channel-live`. Never overwrites what the socket
     * has already been told: the frame is newer than the request by
     * definition, and the seed is only there to cover the gap before it.
     */
    seedChannelLive(channelId: string, live: ChannelLive) {
      if (state.channelLive[channelId]) {
        return;
      }
      state.channelLive = {
        ...state.channelLive,
        [channelId]: {
          stream: live.stream
            ? { ...live.stream, hlsUrl: resolveHlsUrl(live.stream.hlsUrl) }
            : null,
          watching: live.watching,
        },
      };
      emit();
    },

    setWatchingLive(channelId: string, watching: boolean) {
      if (
        watching &&
        state.voiceChannelId === channelId &&
        state.status !== "idle"
      ) {
        return;
      }
      sendWatchLive(channelId, watching);
    },
  };

  return controller;
}

export type { PeerConnectionState, RemotePeer };
