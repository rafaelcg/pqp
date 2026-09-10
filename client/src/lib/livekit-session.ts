import type { VoiceSessionInfo } from "@pqp/shared";
import type { PeerConnectionState, RemotePeer } from "./peer-connection-manager";
import type { ReceiveQuality } from "./receive-quality";
import { registerRemoteVideoBinding } from "./remote-video-binding";
import { sfuIceServers } from "./sfu-ice-servers";
import {
  createRemoteAudioDelivery,
  type RemoteAudioPlan,
} from "./remote-audio-delivery";
import {
  createRemoteVideoDelivery,
  type DeliveryPublication,
} from "./remote-video-delivery";
import {
  cameraBitrateFor,
  cameraProfileFor,
  cameraSimulcastRungs,
  DEFAULT_VIDEO_QUALITY,
  hlsSourceTopHeight,
  HLS_HELD_720_BITRATE,
  LARGE_ROOM_SCREEN_BITRATE,
  LARGE_ROOM_SCREEN_HEIGHT,
  screenBitrateFor,
  screenSimulcastPlan,
  clampScreenPlanToCapture,
  type CameraLayer,
  type HlsSourceInput,
  type ScreenSimulcastPlan,
  type VideoQuality,
} from "./video-quality";
import { publishMaxFrameRateFromTrack } from "./hls-capture-rate";
import {
  qualityFromLiveKit,
  type LiveKitConnectionQuality,
  type VoiceLinkQuality,
} from "./voice-link-quality";
import {
  measureKbps,
  pickActiveVideoSenderLayer,
  registerVoiceStatsSource,
  statRows,
  summariseStats,
  type CandidatePairSample,
  type VideoReceiverSample,
  type VideoSenderRole,
  type VideoSenderSample,
  type VoiceStatsSnapshot,
} from "./voice-stats-probe";

export const HLS_SOURCE_DROP_SAMPLES = 3;
export const HLS_SOURCE_RAISE_SAMPLES = 3;
/** After a capture-height change, ignore further height moves for this long. */
export const HLS_SOURCE_HEIGHT_DWELL_MS = 30_000;

function asLiveKitQuality(value: unknown): LiveKitConnectionQuality {
  if (
    value === "excellent" ||
    value === "good" ||
    value === "poor" ||
    value === "lost" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

/**
 * The shape of the two stats calls `livekit-client` puts on its video tracks,
 * spelled locally so the sampler can duck-type a publication's track rather
 * than `instanceof` a class that only exists after the dynamic import.
 */
interface ReceiverStatsLike {
  timestamp: number;
  bytesReceived?: number;
  framesDecoded?: number;
  frameWidth?: number;
  frameHeight?: number;
  decoderImplementation?: string;
  packetsLost?: number;
}
interface SenderStatsLike {
  timestamp: number;
  bytesSent?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesSent?: number;
  targetBitrate?: number;
  qualityLimitationReason?: string;
  qualityLimitationDurations?: Record<string, number>;
  pliCount?: number;
  nackCount?: number;
  rid?: string;
}

/** Where a session starts before anybody has chosen a quality. */
const DEFAULT_CAMERA_MAX_BITRATE_BPS = cameraBitrateFor(DEFAULT_VIDEO_QUALITY);
const DEFAULT_SCREEN_MAX_BITRATE_BPS = screenBitrateFor(DEFAULT_VIDEO_QUALITY);

/** Both video senders hold 30 fps and pay in resolution. See `video-quality.ts`. */
const VIDEO_MAX_FRAMERATE = 30;

/**
 * LiveKit SFU media path (Phase 5).
 *
 * Presence still rides the app WebSocket — the SFU only replaces the *media*
 * transport. Participant identity is the WS-assigned peer id, so the roster,
 * speaking rings, and occupancy UI work unchanged against `RemotePeer[]`.
 *
 * `livekit-client` is imported dynamically so mesh deployments never download it.
 */

export interface LiveKitSession {
  /** Publish (or re-publish) the processed mic track. */
  publish(stream: MediaStream): Promise<void>;
  /** Swap the published track after a mic device change. */
  replaceTrack(stream: MediaStream): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  /**
   * Publish a screen share: its video track, plus the system-audio track when
   * the capture came with one (Chrome tab shares, mostly). Both go up under
   * their own LiveKit source, so receivers never have to guess.
   */
  publishScreen(stream: MediaStream): Promise<void>;
  /** Stop publishing the screen share, audio half included. */
  unpublishScreen(): Promise<void>;
  /** Withdraw only the screen's audio, leaving the picture published. */
  unpublishScreenAudio(): Promise<void>;
  /** Publish a camera video track (conversation calls). */
  publishCamera(stream: MediaStream): Promise<void>;
  /**
   * Republish a live camera when its capture size moved across a rung of the
   * simulcast ladder. A no-op when the ladder is unchanged, which is the
   * common case; see the implementation for why a blink is only spent on a
   * genuine change.
   */
  reconcileCameraLadder(): Promise<void>;
  /**
   * Change the camera's bitrate ceiling on an already-published track.
   *
   * The SFU twin of the mesh manager's method of the same name, so the quality
   * selector means the same thing on both transports. Publishing is what
   * carries the ceiling for a camera turned on *after* the choice; this is for
   * one turned on before it.
   */
  setCameraMaxBitrate(maxBitrate: number): Promise<void>;
  /**
   * Change the screen share's bitrate ceiling on an already-published track.
   *
   * NO BUDGET SPLIT HERE, DELIBERATELY, and it is the difference that matters
   * between the transports. A mesh presenter uploads one copy of the screen per
   * peer, so its ceiling has to be divided by the room; an SFU presenter
   * uploads exactly one copy however many people are watching, and dividing it
   * would throw away the single biggest thing the SFU buys. The chosen ceiling
   * therefore applies whole. What the *user* asked for means the same thing on
   * both transports; what the room costs does not, because it genuinely is not
   * the same.
   */
  setScreenMaxBitrate(maxBitrate: number): Promise<void>;
  /**
   * The presenter's chosen quality, as a ladder rather than a number.
   *
   * `setScreenMaxBitrate` moves the top layer's ceiling and nothing else. This
   * also decides the top layer's *size* and which smaller layers go up under
   * it (`screenSimulcastPlan`), and it is where the large-room cap lives: a
   * room past `LARGE_ROOM_PARTICIPANTS` holds the top at 720p unless 1080p
   * was chosen by name. A share already on the wire is republished only when
   * its top height changes; a ceiling-only change moves the sender in place.
   */
  setScreenQuality(quality: VideoQuality): Promise<void>;
  /**
   * The live HLS ladder transcoding from this share, or null. Raises the
   * published top layer past the large-room cap when the ladder's top rung
   * needs a bigger source than 720p and the measured uplink can feed it.
   */
  setHlsSource(next: HlsSourceInput | null): Promise<void>;
  /**
   * The largest layer this viewer accepts from every remote video publication,
   * applied to what is subscribed now and to whatever arrives later.
   */
  setReceiveQuality(quality: ReceiveQuality): Promise<void>;
  /**
   * Which remote sounds this listener wants at all.
   *
   * Deafen, a person turned to zero, a moderator's mute and a share whose
   * sound is off are all states in which the `<audio>` element already plays
   * nothing; this is what stops the server sending the bytes as well. See
   * `remote-audio-delivery.ts`, which owns the rule and the reasoning.
   */
  setAudioDelivery(plan: RemoteAudioPlan): void;
  /** Stop publishing the camera video track. */
  unpublishCamera(): Promise<void>;
  disconnect(): Promise<void>;
  /** True while the LiveKit room is actually connected (not merely constructed). */
  isConnected(): boolean;
}

export interface LiveKitIdentity {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

interface ConnectOptions {
  session: VoiceSessionInfo;
  /** Identity metadata from the WS roster, keyed by peer id. */
  lookupIdentity: (peerId: string) => LiveKitIdentity | undefined;
  onPeersChanged: (peers: RemotePeer[]) => void;
  onError: (message: string) => void;
  /**
   * The list `/api/ice-servers` gave this tab, as stored for the mesh path.
   * Forwarded to both of the SDK's peer connections when it carries a relay;
   * see `sfuIceServers` for why a list without one is not forwarded at all.
   */
  iceServers?: readonly RTCIceServer[];
  /**
   * The share on the wire is a new publication (new track sid) while the
   * capture is the same. Fires after a quality pick or a room-size change
   * republished under a different layer set, and after `publishScreen`
   * replaced a live share. The HLS egress is bound to a sid, so the server
   * needs to hear about this to restart it on the new one.
   */
  onScreenRepublished?: () => void;
}

function connectionStateFor(subscribed: boolean): PeerConnectionState {
  return subscribed ? "connected" : "connecting";
}

export async function connectLiveKit({
  session,
  lookupIdentity,
  onPeersChanged,
  onError,
  iceServers,
  onScreenRepublished,
}: ConnectOptions): Promise<LiveKitSession> {
  const {
    Room,
    RoomEvent,
    Track,
    LocalAudioTrack,
    ConnectionState,
    VideoPreset,
    VideoQuality: LayerQuality,
  } = await import("livekit-client");

  /**
   * ADAPTIVE STREAM IS ON, AND HOW IT MEETS AN EXPLICIT CHOICE. Verified
   * against livekit-client 2.21.0 (`RemoteTrackPublication.emitTrackUpdate`):
   * with `adaptiveStream` the library measures each attached element and asks
   * the SFU for the smallest layer that covers it; a manual
   * `setVideoQuality(q)` names the highest layer this side accepts; and when
   * both are set the library sends the SMALLER of the two (the adaptive
   * dimensions, or the dimensions of layer `q`, whichever is less). So the
   * two do not fight: the explicit pick is a ceiling, adaptive still saves
   * below it, and "Auto" is simply no ceiling (`VideoQuality.HIGH`). This is
   * a little tighter than the docs' "manual overrides adaptive", and it is
   * the behaviour this product wants, because the point is bandwidth.
   *
   * The library only measures elements it has been given through
   * `RemoteVideoTrack.attach`, and the tiles set `srcObject` themselves, so
   * every video stream handed out below carries a binding that introduces the
   * element. See `remote-video-binding.ts`; without it adaptive streaming
   * would stop the picture after the first tab switch.
   */
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  /** The largest layer this viewer asks for. Applied to every subscription. */
  let receiveQuality: ReceiveQuality = "auto";

  /**
   * One screen lifecycle op at a time (publish, unpublish, reconcile). A second
   * request waits its turn. Declared here, ahead of the `room.on(...)`
   * registrations below, rather than beside `reconcileScreenPlan` further down:
   * Firefox can fire `ParticipantConnected` synchronously inside
   * `room.connect()`, before this function has finished running past its own
   * later statements, and that handler calls `reconcileScreenPlan`, which reads
   * this variable. A `let` declared after that point would still be in its
   * temporal dead zone when the handler fires, throwing `ReferenceError: can't
   * access lexical declaration 'reconciling' before initialization` and
   * dropping the connection. Chromium happens not to fire the event that early,
   * so this only showed up in Firefox. See the regression test in
   * `livekit-session-firefox-join.test.ts`.
   */
  let reconciling: Promise<void> | null = null;

  function enqueueScreenOp<T>(fn: () => Promise<T>): Promise<T> {
    const result = (reconciling ?? Promise.resolve())
      .catch(() => undefined)
      .then(fn);
    reconciling = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  /** Track we published, kept so we can replace/mute it later. */
  let published: InstanceType<typeof LocalAudioTrack> | null = null;
  /** Raw screen-share track we published, kept so we can unpublish it later. */
  let publishedScreenTrack: MediaStreamTrack | null = null;
  /** Raw camera track we published, kept so we can unpublish it later. */
  let publishedCameraTrack: MediaStreamTrack | null = null;
  /** The ladder the camera on the wire went up under. Null while off. */
  let publishedCameraRungs: readonly CameraLayer[] | null = null;
  /** The ceiling the next camera publish will carry. See `setCameraMaxBitrate`. */
  let cameraMaxBitrate = DEFAULT_CAMERA_MAX_BITRATE_BPS;
  /** The ceiling the next screen publish will carry. See `setScreenMaxBitrate`. */
  let screenMaxBitrate = DEFAULT_SCREEN_MAX_BITRATE_BPS;
  /** The presenter's chosen quality; with the room size it makes the plan. */
  let screenQuality: VideoQuality = DEFAULT_VIDEO_QUALITY;
  /**
   * The live HLS ladder transcoding from this presenter's share, and the
   * uplink measurement that says whether it can be fed at the ladder's top.
   * Null unless an egress is actually running on this channel.
   */
  let hlsSource: HlsSourceInput | null = null;
  /** The plan the share on the wire was published under. Null while not sharing. */
  let publishedScreenPlan: ScreenSimulcastPlan | null = null;
  /**
   * THE DECLARED LAYERS ARE DECIDED ONCE PER BROADCAST AND THEN HELD.
   *
   * Set the moment `setHlsSource` first sees a live ladder (and kept through
   * the restart gap when that source goes null), and cleared when the share
   * stops. While it is set, `reconcileScreenPlan` refuses to republish: it
   * moves the ceiling in place instead, which no viewer sees, and leaves the
   * layer set alone.
   *
   * WHY, and it is a production incident rather than a precaution. A republish
   * is a new track sid, a new Track Composite egress, a new `startedAt` and a
   * new playlist URL, so it rebuffers EVERY seatless viewer. The plan depends
   * on `participantCount()` and on `hlsSource`, and `use-voice.ts` resamples
   * the presenter's uplink into `setHlsSource` every two seconds, so once
   * `hlsSourceTopHeight` started requiring a MEASURED uplink (the right fix
   * for a starved 1080p layer) any measurement wobbling across the threshold
   * could republish the track. Production on 2026-09-09 logged six teardowns
   * in sixteen minutes on one continuous party, two of them
   * `screen-track-replaced` with nobody touching the share, and Rafael saw the
   * stream stop every few seconds to minutes on web and iOS.
   *
   * THE RESTART GAP IS THE SAME INCIDENT, STILL OPEN ON 2026-09-10. Every
   * `screen-track-replaced` stop clears `liveStream` for a few seconds while
   * egress rebuilds. The client then calls `setHlsSource(null)`, which used
   * to make `broadcastIsLive()` false and **skip the pin guard entirely**,
   * so a large-room (or weak-uplink) plan immediately republished 1080→720
   * (new sid) the moment the previous egress had died — and the next
   * `hlsStarted` saw that new sid and tore down again. PQPTV looped that
   * for minutes; viewers 404'd on the previous `startedAt` while the LIVE
   * pill stayed up. The pin therefore does NOT ask whether the ladder is
   * still reported live: it holds until the share itself stops.
   *
   * A better decision arriving later is not worth a rebuffer for the whole
   * audience, and certainly not repeatedly.
   *
   * RAISES AND DROPS DO NOT REPUBLISH WHILE PINNED. 2026-09-10 production
   * proved the "sustained streak then republish" escape was the stall loop
   * itself: three 2 s uplink ticks (~4–6 s after `hlsStarted`) unpublished
   * the share, LiveKit minted a new sid, the API tore the ladder down with
   * `screen-track-replaced`, viewers 404'd the old `startedAt`, and the
   * next raise/drop did it again. Ceiling moves in place; layers stay put
   * until the host stops sharing. Quality by name (`force`) used to be the
   * one allowed blink; that minting a new sid is the stall, so it also
   * moves capture and bitrate in place.
   */
  let screenPlanPinned = false;
  /**
   * Height last applied to the capture via `constrainScreenCapture` while the
   * LiveKit layers stay pinned. Separate from `publishedScreenPlan.topHeight`,
   * which is the declared layer set and must not move without a new sid.
   * Farol: without this we either never restore 1080 after a weak-uplink dip,
   * or we re-`applyConstraints` every two-second `setHlsSource` tick.
   */
  let appliedScreenCaptureHeight: number | null = null;
  /**
   * Pixels the capture actually has, read from getSettings BEFORE the first
   * `height.max` constrain. After a constrain, getSettings reports the
   * limited size, so using that as the ceiling would make a 1080 display
   * that dipped to 720 unable to climb back, and would make a 480 window
   * look like 1080 if we asked for 1080 first. Reset when the share stops
   * or a new track is published.
   */
  let nativeScreenCaptureHeight: number | null = null;
  /**
   * Pending capture height while pinned, and how many consecutive
   * `setHlsSource` ticks have asked for it. Three ticks (≈6 s) before we
   * `applyConstraints` — uplink wobble must not thrash the capture pipeline
   * every two seconds (Farol on PR 460).
   */
  let pendingCaptureHeight: number | null = null;
  let captureHeightStreak = 0;
  let lastCaptureHeightChangeAt = 0;
  let hlsLayersTrimmed = false;
  /**
   * Bumped when the share stops or a new one is published. A reconcile that
   * awaited `applyConstraints` must not write height/bitrate onto the next
   * share (Farol: stale state after stop/replace).
   */
  let screenShareEpoch = 0;
  /**
   * The capture's constraints as the browser handed them over, so the plan's
   * height can be laid over them and lifted again without losing the frame
   * rate or width the capture was asked for.
   */
  let screenCaptureConstraints: MediaTrackConstraints | null = null;
  /** The screen share's audio track, when the capture had one. Usually null. */
  let publishedScreenAudioTrack: MediaStreamTrack | null = null;

  /**
   * Pauses delivery of video nobody is drawing (no bound element, or the tab
   * hidden for a while) with `setEnabled(false)`. See `remote-video-delivery.ts`.
   *
   * LIFTING A PAUSE CLEARS THE MANUAL REQUEST RATHER THAN SETTING ONE.
   * Verified against livekit-client 2.21.0 (`RemoteTrackPublication.isEnabled`):
   * `setEnabled(true)` records `requestedDisabled = false`, and from then on
   * the publication is enabled whatever the adaptive-stream visibility says,
   * so the library's own pause for an attached element that scrolls out of
   * view, and its five-second background pause, would be switched off for
   * that track for the rest of the call. Resetting the field to `undefined`
   * hands the decision back to the library. The field is private in the
   * typings and plain on the object, reached by name like
   * `stopObservingElement` below; a build without it gets `setEnabled(true)`.
   */
  const delivery = createRemoteVideoDelivery({
    release(publication) {
      const internal = publication as unknown as {
        requestedDisabled?: boolean;
        emitTrackUpdate?: () => void;
      };
      if (
        "requestedDisabled" in internal &&
        typeof internal.emitTrackUpdate === "function"
      ) {
        internal.requestedDisabled = undefined;
        internal.emitTrackUpdate();
        return;
      }
      publication.setEnabled(true);
    },
  });

  /**
   * The same idea for the sounds nobody is listening to.
   *
   * NO `release` OVERRIDE HERE, and the asymmetry is the point. The video
   * module has to hand its pause back to `adaptiveStream`, which has its own
   * opinion about the same publication; nothing else in the library has an
   * opinion about whether an audio track is enabled, so a plain
   * `setEnabled(true)` is the whole of resuming. `isEnabled` reads
   * `requestedDisabled` for a non-video publication and nothing overwrites it.
   */
  const audioDelivery = createRemoteAudioDelivery();

  function onVisibilityChange() {
    delivery.setTabHidden(document.visibilityState === "hidden");
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();
  }

  /**
   * `remoteVideoTrack.stopObservingElement` is the half of `detach` that stops
   * measuring without touching `srcObject`. It is marked private in the
   * typings and public on the object; reached by name so a build where it has
   * gone simply stops measuring on unmount, which costs nothing.
   *
   * The same two calls are how the delivery rule learns whether anything is
   * drawing the track: each bound element counts, and a track with none
   * pauses after a short grace.
   */
  function bindingFor(
    track: { attach(el: HTMLMediaElement): HTMLMediaElement },
    publication: DeliveryPublication,
  ) {
    return {
      attach(element: HTMLVideoElement) {
        track.attach(element);
        delivery.attached(publication);
      },
      detach(element: HTMLVideoElement) {
        const stop = (
          track as unknown as {
            stopObservingElement?: (el: HTMLMediaElement) => void;
          }
        ).stopObservingElement;
        if (typeof stop === "function") {
          stop.call(track, element);
        }
        delivery.detached(publication);
      },
    };
  }

  function layerQualityFor(quality: ReceiveQuality) {
    switch (quality) {
      case "360p":
        return LayerQuality.LOW;
      case "720p":
        return LayerQuality.MEDIUM;
      case "1080p":
      case "auto":
        // HIGH is the library's resting value, so under adaptive stream it
        // means "the element decides", which is what auto promises.
        return LayerQuality.HIGH;
    }
  }

  /** Ask the SFU for at most the chosen layer of one publication. */
  function applyReceiveQuality(publication: {
    setVideoQuality?: (quality: number) => void;
  }) {
    if (typeof publication.setVideoQuality !== "function") {
      return;
    }
    try {
      publication.setVideoQuality(layerQualityFor(receiveQuality));
    } catch (err) {
      console.warn("[pqp] SFU receive quality rejected; keeping the current layer", err);
    }
  }

  /** peerId → MediaStream assembled from that participant's audio tracks. */
  const streams = new Map<string, MediaStream>();
  /** peerId → MediaStream for whoever is currently screen-sharing. */
  const screenStreams = new Map<string, MediaStream>();
  /** peerId → MediaStream for that participant's camera, when it is on. */
  const cameraStreams = new Map<string, MediaStream>();
  /** peerId → MediaStream for the audio of that participant's screen share. */
  const screenAudioStreams = new Map<string, MediaStream>();
  /**
   * LiveKit's own reading of each participant, keyed by peer id.
   *
   * The mesh quality meter reads `getStats()`. An SFU room has one connection
   * to the server, so that reading would say the same thing about everybody.
   * The library already classifies Excellent / Good / Poor per participant
   * (`ConnectionQualityChanged`); we just keep the last event so a tile can
   * draw the same three bars the mesh uses.
   */
  const qualities = new Map<string, VoiceLinkQuality>();

  function snapshot() {
    const peers: RemotePeer[] = [];
    for (const participant of room.remoteParticipants.values()) {
      const peerId = participant.identity;
      const identity = lookupIdentity(peerId);
      peers.push({
        peerId,
        connectionState: connectionStateFor(streams.has(peerId)),
        stream: streams.get(peerId) ?? null,
        screenStream: screenStreams.get(peerId) ?? null,
        cameraStream: cameraStreams.get(peerId) ?? null,
        screenAudioStream: screenAudioStreams.get(peerId) ?? null,
        userId: identity?.userId,
        displayName: identity?.displayName ?? participant.name ?? undefined,
        avatarUrl: identity?.avatarUrl ?? null,
        quality: qualities.get(peerId),
      });
    }
    onPeersChanged(peers);
  }

  room
    .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Video) {
        // The SFU labels every video publication with its source, so camera
        // and screen never need the stream-id dance the mesh path does.
        const stream = new MediaStream([track.mediaStreamTrack]);
        registerRemoteVideoBinding(stream, bindingFor(track, pub));
        // Delivered until the rule says otherwise: a tile binds within a
        // frame, and one that never does is what the rule is for.
        delivery.register(pub);
        // The viewer's ceiling rides on every subscription, including the
        // ones that arrive after the choice: a share that starts mid-call
        // must not come in at 1080p on a phone that asked for 720p.
        applyReceiveQuality(pub);
        if (pub.source === Track.Source.ScreenShare) {
          screenStreams.set(participant.identity, stream);
          snapshot();
        } else if (pub.source === Track.Source.Camera) {
          cameraStreams.set(participant.identity, stream);
          snapshot();
        }
        return;
      }
      if (track.kind !== Track.Kind.Audio) {
        return;
      }
      const stream = new MediaStream([track.mediaStreamTrack]);
      // Audio is labelled by source too, so the presentation's sound never
      // lands in the slot the participant's voice is played and metered from.
      const screenAudio = pub.source === Track.Source.ScreenShareAudio;
      if (screenAudio) {
        screenAudioStreams.set(participant.identity, stream);
      } else {
        streams.set(participant.identity, stream);
      }
      // Delivered until the listener's plan says otherwise. Registered after
      // the stream is filed so a plan that arrives in the same tick finds a
      // consistent room.
      audioDelivery.register(
        pub,
        participant.identity,
        screenAudio ? "screen" : "voice",
      );
      snapshot();
    })
    .on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Video) {
        delivery.unregister(pub);
        if (pub.source === Track.Source.ScreenShare) {
          screenStreams.delete(participant.identity);
          snapshot();
        } else if (pub.source === Track.Source.Camera) {
          cameraStreams.delete(participant.identity);
          snapshot();
        }
        return;
      }
      if (track.kind !== Track.Kind.Audio) {
        return;
      }
      audioDelivery.unregister(pub);
      if (pub.source === Track.Source.ScreenShareAudio) {
        screenAudioStreams.delete(participant.identity);
      } else {
        streams.delete(participant.identity);
      }
      snapshot();
    })
    .on(RoomEvent.ParticipantConnected, () => {
      snapshot();
      // The room just grew. If it crossed the large-room line the top layer
      // comes down to 720p; see `reconcileScreenPlan`.
      void reconcileScreenPlan();
    })
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      streams.delete(participant.identity);
      screenStreams.delete(participant.identity);
      cameraStreams.delete(participant.identity);
      screenAudioStreams.delete(participant.identity);
      qualities.delete(participant.identity);
      snapshot();
      void reconcileScreenPlan();
    })
    .on(RoomEvent.Disconnected, () => {
      streams.clear();
      screenStreams.clear();
      cameraStreams.clear();
      screenAudioStreams.clear();
      qualities.clear();
      snapshot();
    })
    .on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Disconnected) {
        streams.clear();
        screenStreams.clear();
        cameraStreams.clear();
        screenAudioStreams.clear();
        qualities.clear();
        snapshot();
      }
    })
    .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      const peerId =
        participant && typeof participant === "object"
          ? String(
              (participant as { identity?: unknown }).identity ?? "",
            )
          : "";
      if (!peerId || peerId === session.identity) {
        return;
      }
      qualities.set(
        peerId,
        qualityFromLiveKit(asLiveKitQuality(quality)),
      );
      snapshot();
    })
    .on(RoomEvent.MediaDevicesError, (err: Error) => {
      onError(err.message);
    });

  /**
   * OUR RELAYS, NOT THE MEDIA BOX'S. `rtcConfig` is a connect option in
   * livekit-client 2.21.0 (`RoomConnectOptions.rtcConfig`, copied onto the
   * engine in `Room.connect` and handed to the `PCTransportManager`, so the
   * publisher and the subscriber peer connection both get it). When
   * `rtcConfig.iceServers` is set the SDK skips the join response's list
   * (`RTCEngine.makeRTCConfiguration`), which is the point: the hosted
   * LiveKit advertises its own box as the relay, and its TLS relay is dead.
   * The list is read here, at connect time, so a rotated credential reaches
   * the next call and never disturbs this one. `iceTransportPolicy` is left
   * at its default; the SDK still flips it to `relay` if the server asks.
   */
  const relays = sfuIceServers(iceServers);
  await room.connect(
    session.url,
    session.token,
    relays ? { rtcConfig: { iceServers: relays } } : undefined,
  );

  /**
   * The peer id this participant joined under. Sender rows need one, and on
   * this transport the only connection is ours.
   */
  const localPeerId = session.identity;

  function roleOfSource(source: unknown): VideoSenderRole {
    if (source === Track.Source.ScreenShare) {
      return "screen";
    }
    if (source === Track.Source.Camera) {
      return "camera";
    }
    return "unknown";
  }

  /** Decoded-frame marks, so a receiver's fps is measured rather than guessed. */
  const frameMarks = new Map<string, { frames: number; timestamp: number }>();

  function measureFps(
    key: string,
    frames: number | null,
    timestamp: number | null,
  ): number | null {
    const mark = frameMarks.get(key);
    let fps: number | null = null;
    if (mark && frames !== null && timestamp !== null && timestamp > mark.timestamp) {
      fps = ((frames - mark.frames) * 1000) / (timestamp - mark.timestamp);
    }
    if (frames !== null && timestamp !== null) {
      frameMarks.set(key, { frames, timestamp });
    }
    return fps;
  }

  /**
   * What is arriving, straight off the room.
   *
   * WHY THE ROOM AND NOT `getStats()`. The readout under the quality menu
   * reads one sampler for both transports, and that sampler used to know only
   * about mesh peer connections. In a LiveKit room it therefore found nothing
   * and said "nobody is sending you video right now" under a screen share
   * that a hundred people were watching. The SFU already labels every
   * publication with its source and its owner, so it is the authority on the
   * two things the readout is for: what this is, and whose it is. The size,
   * rate and decoder come off the track's own receiver stats when the
   * library has them, and the row is present either way, because a subscribed
   * video publication is the server's word that the picture is flowing.
   */
  async function sampleReceivers(): Promise<VideoReceiverSample[]> {
    const rows: VideoReceiverSample[] = [];
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.videoTrackPublications.values()) {
        const role = roleOfSource(publication.source);
        const track = publication.videoTrack;
        if (role === "unknown" || !track || !publication.isSubscribed || publication.isMuted) {
          continue;
        }
        let stats: ReceiverStatsLike | undefined;
        const reader = (
          track as unknown as {
            getReceiverStats?: () => Promise<ReceiverStatsLike | undefined>;
          }
        ).getReceiverStats;
        if (typeof reader === "function") {
          try {
            stats = await reader.call(track);
          } catch {
            stats = undefined;
          }
        }
        const key = `sfu:in:${participant.identity}:${publication.trackSid}`;
        const timestamp = stats?.timestamp ?? null;
        const framesDecoded = stats?.framesDecoded ?? null;
        const identity = lookupIdentity(participant.identity);
        rows.push({
          peerId: participant.identity,
          displayName: identity?.displayName ?? participant.name ?? null,
          role,
          width: stats?.frameWidth ?? null,
          height: stats?.frameHeight ?? null,
          fps: measureFps(key, framesDecoded, timestamp),
          kbps: measureKbps(key, stats?.bytesReceived ?? null, timestamp),
          framesDecoded,
          decoder: stats?.decoderImplementation ?? null,
          freezeCount: null,
          packetsLost: stats?.packetsLost ?? null,
          attached: true,
        });
      }
    }
    return rows;
  }

  /**
   * What is leaving, for the presenter's half of the same menu.
   *
   * One row per published video source. The library reports one entry per
   * simulcast layer; the camera publishes one and the screen publishes up to
   * three. "Busiest" is the layer currently producing frames, not the one
   * with the most lifetime bytes: a paused 1080p encoding keeps its
   * cumulative counter and reads as 0 fps / 0 kbps / `bandwidth` forever
   * while 720 is still leaving the machine. The ceiling is the published
   * top's, which is what lets `describeLimitation` tell "sitting on your
   * setting" from "starved by your link" exactly as it does on the mesh.
   */
  async function sampleSenders(): Promise<VideoSenderSample[]> {
    const rows: VideoSenderSample[] = [];
    const sources: [unknown, VideoSenderRole, number][] = [
      [Track.Source.Camera, "camera", cameraMaxBitrate],
      [
        Track.Source.ScreenShare,
        "screen",
        publishedScreenPlan?.topBitrate ?? screenMaxBitrate,
      ],
    ];
    for (const [source, role, ceiling] of sources) {
      const publication = room.localParticipant.getTrackPublication(
        source as Parameters<typeof room.localParticipant.getTrackPublication>[0],
      );
      const track = publication?.videoTrack;
      const reader = (
        track as unknown as
          | { getSenderStats?: () => Promise<SenderStatsLike[]> }
          | undefined
      )?.getSenderStats;
      if (!track || typeof reader !== "function") {
        continue;
      }
      let layers: SenderStatsLike[] = [];
      try {
        layers = (await reader.call(track)) ?? [];
      } catch {
        layers = [];
      }
      // Touch every rid every poll, not only the one we display. A layer
      // that sat paused would otherwise keep a stale byte mark, and on
      // return its new bytes would be divided by the whole gap — a fake
      // trickle, or a first sample of zero. Measuring the quiet ones
      // here only advances the mark; the row below still uses the live
      // layer.
      const rates = new Map<string, number | null>();
      for (const layer of layers) {
        const layerKey = `sfu:out:${localPeerId}:${role}:${layer.rid || "0"}`;
        rates.set(
          layerKey,
          measureKbps(layerKey, layer.bytesSent ?? null, layer.timestamp),
        );
      }
      const stats = pickActiveVideoSenderLayer(layers);
      if (!stats) {
        continue;
      }
      const key = `sfu:out:${localPeerId}:${role}:${stats.rid || "0"}`;
      rows.push({
        peerId: localPeerId,
        role,
        width: stats.frameWidth ?? null,
        height: stats.frameHeight ?? null,
        fps: stats.framesPerSecond ?? null,
        kbps: rates.get(key) ?? null,
        targetKbps:
          typeof stats.targetBitrate === "number"
            ? Math.round(stats.targetBitrate / 1000)
            : null,
        limitedBy: stats.qualityLimitationReason ?? null,
        ceilingKbps: Math.round(ceiling / 1000),
        limitDurations: stats.qualityLimitationDurations ?? null,
        encoder: null,
        framesEncoded: null,
        framesSent: stats.framesSent ?? null,
        keyFramesEncoded: null,
        pliCount: stats.pliCount ?? null,
        nackCount: stats.nackCount ?? null,
      });
    }
    return rows;
  }

  async function samplePublisherPaths(): Promise<CandidatePairSample[]> {
    const kinds = [
      Track.Source.ScreenShare,
      Track.Source.Camera,
      Track.Source.Microphone,
    ];
    for (const source of kinds) {
      const publication = room.localParticipant.getTrackPublication(
        source as Parameters<
          typeof room.localParticipant.getTrackPublication
        >[0],
      );
      const media = (
        publication as
          | { track?: { sender?: RTCRtpSender }; videoTrack?: { sender?: RTCRtpSender } }
          | undefined
      );
      const sender = media?.track?.sender ?? media?.videoTrack?.sender;
      if (!sender || typeof sender.getStats !== "function") {
        continue;
      }
      try {
        const report = await sender.getStats();
        const snapshot = summariseStats(
          localPeerId,
          statRows(report),
          () => "unknown",
          new Map(),
        );
        if (snapshot.paths.length > 0) {
          return snapshot.paths;
        }
      } catch {
        // Sender went away mid-sample.
      }
    }
    return [];
  }

  async function sampleRoom(): Promise<VoiceStatsSnapshot> {
    if (room.state !== ConnectionState.Connected) {
      return { senders: [], receivers: [], paths: [] };
    }
    const [senders, receivers, paths] = await Promise.all([
      sampleSenders(),
      sampleReceivers(),
      samplePublisherPaths(),
    ]);
    if (hlsSource !== null && hlsSource.ladderTopHeight !== null) {
      const screen = senders.find((row) => row.role === "screen");
      const path = paths[0];
      console.debug("[pqp] hls-uplink", {
        height: screen?.height ?? null,
        fps: screen?.fps ?? null,
        targetKbps: screen?.targetKbps ?? null,
        ceilingKbps: screen?.ceilingKbps ?? null,
        limitedBy: screen?.limitedBy ?? null,
        availableOutgoingKbps: path?.availableOutgoingKbps ?? null,
      });
    }
    return { senders, receivers, paths };
  }

  const unregisterStats = registerVoiceStatsSource(sampleRoom);

  /**
   * Move one published source's ceiling without republishing it.
   *
   * Shared by the camera and the screen because they are the same six lines and
   * the same promise: a browser that refuses the new ceiling leaves the track
   * publishing at the ceiling it already had, never a dead one. Republishing
   * would be the obvious alternative and is much worse: it drops the track from
   * every subscriber's view for as long as renegotiation takes, and for a screen
   * share it can put the OS picker back on screen.
   *
   * ONLY THE TOP LAYER MOVES when the source is simulcast. The lower layers
   * are the small copies a phone asks for and their cost is what makes them
   * useful; a 360p layer given a 4 Mbps ceiling stops being a small copy.
   * `livekit-client` orders encodings smallest first, so the top is the last.
   */
  async function setSourceMaxBitrate(
    source: Parameters<typeof room.localParticipant.getTrackPublication>[0],
    maxBitrate: number,
    label: string,
  ): Promise<void> {
    const publication = room.localParticipant.getTrackPublication(source);
    const sender = publication?.track?.sender;
    if (!sender) {
      return;
    }
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const encodings = params.encodings;
      const top = encodings[encodings.length - 1]!;
      top.maxBitrate = maxBitrate;
      // HLS always takes the top layer. A 720p mid-rung sitting next to a
      // 1080 top eats BWE bottom-up and the egress transcodes 480p. Keep
      // 360p (first) for a seated phone; deactivate everything in between.
      const feedingHls =
        source === Track.Source.ScreenShare &&
        hlsSource !== null &&
        hlsSource.ladderTopHeight !== null;
      if (feedingHls && encodings.length > 2) {
        for (let i = 1; i < encodings.length - 1; i += 1) {
          encodings[i]!.active = false;
        }
      }
      await sender.setParameters(params);
    } catch (err) {
      console.warn(
        `[pqp] SFU ${label} ceiling rejected; keeping the published one`,
        err,
      );
    }
  }

  /** Everybody in the room, this participant included. */
  function participantCount(): number {
    return room.remoteParticipants.size + 1;
  }

  /**
   * The plan for this room right now. The ceiling comes from
   * `screenMaxBitrate` rather than from the quality's ladder, so a ceiling set
   * directly (`setScreenMaxBitrate`) is what a later publish carries, exactly
   * as that method promises; the two agree whenever the quality was the last
   * thing set. The cap still binds it.
   */
  function currentScreenPlan(): ScreenSimulcastPlan {
    const hls =
      hlsSource === null
        ? null
        : {
            ...hlsSource,
            currentHeight:
              appliedScreenCaptureHeight ??
              publishedScreenPlan?.topHeight ??
              null,
            currentCeilingBps: publishedScreenPlan?.topBitrate ?? null,
          };
    const plan = screenSimulcastPlan(
      screenQuality,
      participantCount(),
      hls,
    );
    const hlsTop = hlsSourceTopHeight(screenQuality, hls);
    if (hlsTop !== null && hlsTop > LARGE_ROOM_SCREEN_HEIGHT) {
      // The share is the ladder's source: the egress transcodes from this
      // track, so holding it at the large-room ceiling would cap every
      // playlist viewer too. `screenSimulcastPlan` already decided the
      // height; the ceiling has to follow, or a `screenMaxBitrate` set
      // directly while the cap DID apply would silently keep it at
      // 1.5 Mbit/s. Only this branch: everywhere else `screenMaxBitrate`
      // stays exactly what a caller set, which is what it promises.
      return {
        ...plan,
        topBitrate: Math.max(plan.topBitrate, screenMaxBitrate),
      };
    }
    if (plan.heldForHls) {
      return {
        ...plan,
        topBitrate: Math.min(screenMaxBitrate, HLS_HELD_720_BITRATE),
      };
    }
    return {
      ...plan,
      topBitrate: plan.capped
        ? Math.min(screenMaxBitrate, LARGE_ROOM_SCREEN_BITRATE)
        : screenMaxBitrate,
    };
  }

  function trackCaptureHeight(track: MediaStreamTrack): number | null {
    try {
      const height =
        typeof track.getSettings === "function"
          ? track.getSettings().height
          : undefined;
      return typeof height === "number" && height > 0
        ? Math.round(height)
        : null;
    } catch {
      return null;
    }
  }

  function rememberNativeCapture(track: MediaStreamTrack): number | null {
    const height = trackCaptureHeight(track);
    if (height) {
      nativeScreenCaptureHeight = height;
    }
    return nativeScreenCaptureHeight;
  }

  function planForTrack(track: MediaStreamTrack): ScreenSimulcastPlan {
    return clampScreenPlanToCapture(
      currentScreenPlan(),
      nativeScreenCaptureHeight ?? trackCaptureHeight(track),
    );
  }

  /**
   * Ask the capture for the plan's height. Resolves whether it took.
   *
   * A display capture accepts `height.max` in every browser this product
   * supports and scales its output down to it, and it climbs back up when the
   * limit is raised again, because the source is the whole screen. A browser
   * that refuses leaves the capture where it was, and the layers the library
   * declares are still true, because it reads them off the track; the only
   * cost is that the top stays at the capture size.
   */
  async function constrainScreenCapture(
    track: MediaStreamTrack,
    height: number,
  ): Promise<boolean> {
    if (typeof track.applyConstraints !== "function") {
      return false;
    }
    if (!screenCaptureConstraints) {
      screenCaptureConstraints =
        typeof track.getConstraints === "function"
          ? { ...track.getConstraints() }
          : {};
    }
    const previousHeight = screenCaptureConstraints.height;
    try {
      await track.applyConstraints({
        ...screenCaptureConstraints,
        height: {
          ...(typeof previousHeight === "object" ? previousHeight : {}),
          max: height,
        },
      });
      return true;
    } catch (err) {
      console.warn(
        "[pqp] screen capture refused the planned height; keeping its size",
        err,
      );
      return false;
    }
  }

  /**
   * Put the screen's picture on the wire under the current plan.
   *
   * `screenShareEncoding`, NOT `videoEncoding`. The library reads the screen's
   * ceiling from a field of its own (`computeVideoEncodings` in
   * livekit-client 2.21.0 swaps `videoEncoding` for `screenShareEncoding`
   * whenever the source is a screen share), and this session used to set the
   * other one. With no ceiling and no simulcast the library returns an empty
   * encoding, so every SFU share went up with no bitrate cap at all, whatever
   * the menu said. That is the single-layer, full-rate stream a hundred phones
   * were each receiving on 5 Sep 2026.
   *
   * The lower layers go up as `VideoPreset`s under `screenShareSimulcastLayers`;
   * the library scales each from the capture size, keeps the top layer at the
   * capture size with this ceiling, and declares all of them to the SFU.
   */
  async function publishScreenVideo(
    track: MediaStreamTrack,
    plan: ScreenSimulcastPlan,
  ): Promise<boolean> {
    const epoch = screenShareEpoch;
    const options = {
      source: Track.Source.ScreenShare,
      simulcast: true,
      screenShareSimulcastLayers: plan.lowerLayers.map(
        (layer) =>
          new VideoPreset(
            layer.width,
            layer.height,
            layer.maxBitrate,
            layer.maxFramerate,
          ),
      ),
      // The SFU half of the same argument as the mesh path: without these the
      // encoder holds resolution and spends framerate, which turns a film
      // into stills. `degradationPreference` is the lever; the encoding is a
      // ceiling, not a target, so a still screen still costs almost nothing.
      degradationPreference: "maintain-framerate" as const,
      screenShareEncoding: {
        maxBitrate: plan.topBitrate,
        maxFramerate: publishMaxFrameRateFromTrack(track),
      },
    };
    // VP8 software encode is what we measured sawtoothing on Chromium. H.264
    // can use hardware on many Macs and is what egress already re-encodes
    // toward for HLS. AV1 is skipped: too heavy on host CPU for screen publish.
    try {
      await room.localParticipant.publishTrack(track, {
        ...options,
        videoCodec: "h264",
      });
    } catch (err) {
      console.warn(
        "[pqp] H.264 screen publish refused; retrying without a codec pin",
        err,
      );
      await room.localParticipant.publishTrack(track, options);
    }
    // Stop/disconnect bump the epoch before they await. A publish that
    // finished after that must not stay on the wire or write the plan.
    if (screenShareEpoch !== epoch) {
      // A newer publish of the same track already owns it — do not tear that
      // one down. Only drop a ghost this call created after stop cleared us.
      if (publishedScreenTrack !== track) {
        await room.localParticipant.unpublishTrack(track, false);
      }
      return false;
    }
    publishedScreenPlan = plan;
    appliedScreenCaptureHeight = plan.topHeight;
    screenShareEpoch += 1;
    // If the ladder is already live (share restarted mid-party), pin now —
    // do not wait for the next setHlsSource tick. Farol caught the window
    // where a room-size change could still republish before that tick.
    if (hlsSource !== null && hlsSource.ladderTopHeight !== null) {
      screenPlanPinned = true;
    }
    return true;
  }

  /**
   * Bring the share on the wire in line with the plan the room now calls for.
   *
   * Runs on every quality change, every time the room grows or shrinks, and
   * every two seconds while a watch party is transcoding from this share
   * (`use-voice.ts` resamples the uplink into `setHlsSource` on that cadence).
   * That last caller is why the pin below exists.
   *
   * A different top HEIGHT means a different set of declared layers, and the
   * only honest way to change those is to publish again, so the track is
   * unpublished without being stopped and published under the new plan; the
   * viewers see the picture blink once. A different top CEILING at the same
   * height is moved in place, with no blink.
   *
   * **While pinned, height never republishes.** Bitrate ceiling only. The pin
   * outlives a brief `setHlsSource(null)` during an egress restart on purpose.
   * `force` (host quality menu) used to be the exception; that minting a new
   * sid is the stall, so quality by name also moves in place.
   */
  function screenShareStill(
    track: MediaStreamTrack,
    epoch: number,
  ): ScreenSimulcastPlan | null {
    if (
      publishedScreenTrack !== track ||
      screenShareEpoch !== epoch ||
      publishedScreenPlan === null
    ) {
      return null;
    }
    return publishedScreenPlan;
  }

  function reconcileScreenPlan(): Promise<void> {
    const run = async () => {
      const track = publishedScreenTrack;
      const published = publishedScreenPlan;
      if (!track || !published) {
        return;
      }
      const epoch = screenShareEpoch;
      const plan = planForTrack(track);
      const heightChanged = plan.topHeight !== published.topHeight;
      // FREEZE. Any unpublish+publish is a new LiveKit sid and a torn-down
      // watch party. Uplink / ladder / room-size opinion changes reach the
      // encoder as a ceiling only. `force` used to republish; that is the
      // stall. Quality by name moves capture and bitrate in place.
      if (screenPlanPinned) {
        // Same sid: shrink or restore capture without touching declared layers.
        // Never ask the capture for more than the pinned layer set. Wait for a
        // stable target before applyConstraints (uplink wobble). After every
        // await, the epoch must still match: a stop mid-constrain must not
        // write onto the next share.
        const captureTarget = Math.min(
          plan.topHeight,
          published.topHeight,
          nativeScreenCaptureHeight ?? Number.POSITIVE_INFINITY,
        );
        if (captureTarget === appliedScreenCaptureHeight) {
          pendingCaptureHeight = null;
          captureHeightStreak = 0;
        } else if (captureTarget === pendingCaptureHeight) {
          captureHeightStreak += 1;
        } else {
          pendingCaptureHeight = captureTarget;
          captureHeightStreak = 1;
        }
        const needed =
          (pendingCaptureHeight ?? 0) > (appliedScreenCaptureHeight ?? 0)
            ? HLS_SOURCE_RAISE_SAMPLES
            : HLS_SOURCE_DROP_SAMPLES;
        const dwellOk =
          lastCaptureHeightChangeAt === 0 ||
          Date.now() - lastCaptureHeightChangeAt >= HLS_SOURCE_HEIGHT_DWELL_MS;
        if (
          pendingCaptureHeight !== null &&
          pendingCaptureHeight !== appliedScreenCaptureHeight &&
          captureHeightStreak >= needed &&
          dwellOk
        ) {
          const want = pendingCaptureHeight;
          await constrainScreenCapture(track, want);
          const liveAfterConstrain = screenShareStill(track, epoch);
          if (!liveAfterConstrain) {
            return;
          }
          // Uplink moved while we awaited: do not lock the superseded height.
          const liveTarget = Math.min(
            planForTrack(track).topHeight,
            liveAfterConstrain.topHeight,
          );
          if (liveTarget !== want) {
            pendingCaptureHeight = liveTarget;
            captureHeightStreak = 1;
          } else {
            appliedScreenCaptureHeight = want;
            pendingCaptureHeight = null;
            captureHeightStreak = 0;
            lastCaptureHeightChangeAt = Date.now();
          }
        }
        const livePublished = screenShareStill(track, epoch);
        if (!livePublished) {
          return;
        }
        const livePlan = currentScreenPlan();
        const feedingHls =
          hlsSource !== null && hlsSource.ladderTopHeight !== null;
        if (
          livePlan.topBitrate !== livePublished.topBitrate ||
          (feedingHls && !hlsLayersTrimmed)
        ) {
          await setSourceMaxBitrate(
            Track.Source.ScreenShare,
            livePlan.topBitrate,
            "screen",
          );
          if (feedingHls) {
            hlsLayersTrimmed = true;
          }
          const liveAfterBitrate = screenShareStill(track, epoch);
          if (!liveAfterBitrate) {
            return;
          }
          publishedScreenPlan = {
            ...liveAfterBitrate,
            topBitrate: livePlan.topBitrate,
          };
        }
        return;
      }
      if (heightChanged) {
        await constrainScreenCapture(track, plan.topHeight);
        if (!screenShareStill(track, epoch)) {
          return;
        }
        appliedScreenCaptureHeight = plan.topHeight;
        // `false`: the capture stays alive; it is the same track going back up.
        await room.localParticipant.unpublishTrack(track, false);
        if (!screenShareStill(track, epoch)) {
          return;
        }
        const kept = await publishScreenVideo(track, plan);
        if (kept) {
          onScreenRepublished?.();
        }
        return;
      }
      if (plan.topBitrate !== published.topBitrate) {
        await setSourceMaxBitrate(
          Track.Source.ScreenShare,
          plan.topBitrate,
          "screen",
        );
        const liveAfterBitrate = screenShareStill(track, epoch);
        if (!liveAfterBitrate) {
          return;
        }
        publishedScreenPlan = {
          ...liveAfterBitrate,
          topBitrate: plan.topBitrate,
        };
      }
    };
    const next = enqueueScreenOp(run).catch((err) => {
      console.warn("[pqp] SFU screen plan could not be applied", err);
    });
    return next;
  }

  /**
   * What the camera's capture is producing right now, in picture lines.
   *
   * A track that has not settled reports nothing, and the honest guess is the
   * size the capture was asked for, exactly as `screenScaleFactor` guesses the
   * screen's. Guessing "no ladder" instead would publish one layer to a camera
   * that turns out to be 720p, and nothing would ever revisit it.
   */
  function cameraCaptureHeight(track: MediaStreamTrack): number {
    // Duck-typed rather than called outright. `getSettings` is on every real
    // `MediaStreamTrack`, but this path also sees the tracks a virtual camera
    // or a test hands over, and a camera that will not turn on because a shim
    // is missing a method is a much worse failure than a ladder built on the
    // size we asked for.
    const settings =
      typeof track.getSettings === "function" ? track.getSettings() : null;
    const height = settings?.height;
    return height && height > 0
      ? height
      : cameraProfileFor(DEFAULT_VIDEO_QUALITY).height;
  }

  function sameRungs(
    a: readonly CameraLayer[],
    b: readonly CameraLayer[] | null,
  ): boolean {
    return (
      b !== null &&
      a.length === b.length &&
      a.every((rung, at) => rung.height === b[at]!.height)
    );
  }

  /**
   * Put a camera on the wire under the ladder its capture size calls for.
   *
   * THE CAMERA PUBLISHES A LADDER. It published `simulcast: false` until
   * 2026-09-08, so there was exactly one copy of a face on the server and
   * every viewer received it whatever size their tile was. `adaptiveStream`
   * has been on the whole time and had nothing to choose from: it can only ask
   * the SFU for a layer the publisher actually encodes. The rungs, and why
   * they are these rungs, are in `video-quality.ts`.
   *
   * `videoEncoding`, NOT `screenShareEncoding`: `computeVideoEncodings` swaps
   * the two by source, and this is the source the *other* one belongs to.
   * Getting it backwards is what shipped an uncapped screen share to a hundred
   * phones on 5 Sep 2026; the same mistake in this direction would put the
   * camera's ceiling in a field nothing reads.
   */
  async function publishCameraVideo(track: MediaStreamTrack): Promise<void> {
    const rungs = cameraSimulcastRungs(cameraCaptureHeight(track));
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.Camera,
      simulcast: true,
      videoSimulcastLayers: rungs.map(
        (layer) =>
          new VideoPreset(
            layer.width,
            layer.height,
            layer.maxBitrate,
            layer.maxFramerate,
          ),
      ),
      // The camera half of the argument the screen share has been making since
      // it was written: without these the encoder holds resolution and spends
      // framerate, and a face is motion. The encoding is a ceiling, not a
      // target, so a still person still costs almost nothing.
      degradationPreference: "maintain-framerate",
      videoEncoding: {
        maxBitrate: cameraMaxBitrate,
        maxFramerate: VIDEO_MAX_FRAMERATE,
      },
    });
    publishedCameraRungs = rungs;
  }

  /**
   * Bring a live camera's ladder in line with the size its capture is now.
   *
   * WHY IT IS NEEDED AT ALL. `livekit-client` solves each rung's
   * `scaleResolutionDownBy` against the capture's dimensions **at publish
   * time** and declares the resulting sizes to the SFU, which routes a
   * viewer's request against that declaration. Changing the quality mid-call
   * resizes the same track in place (`applyCameraQuality`), so a camera
   * published at 360p and moved to 1080p would keep a divisor solved for 360
   * and hand viewers layers whose declared size is a fiction. Same argument,
   * and the same fix, as `reconcileScreenPlan`.
   *
   * WHY ONLY ON A RUNG CHANGE. Republishing blinks the picture for every
   * viewer, so it is spent only when the SET of layers actually changes: 720p
   * to 1080p keeps all three rungs and moves nothing, 360p to 720p gains one
   * and is worth a blink. A ceiling change alone never comes through here; it
   * moves the top layer in place through `setCameraMaxBitrate`.
   */
  async function reconcileCameraLadder(): Promise<void> {
    const track = publishedCameraTrack;
    if (!track) {
      return;
    }
    const wanted = cameraSimulcastRungs(cameraCaptureHeight(track));
    if (sameRungs(wanted, publishedCameraRungs)) {
      return;
    }
    try {
      // `false`: the capture stays alive; it is the same track going back up.
      await room.localParticipant.unpublishTrack(track, false);
      if (publishedCameraTrack !== track) {
        // The camera was turned off while this was in flight.
        return;
      }
      await publishCameraVideo(track);
    } catch (err) {
      console.warn("[pqp] SFU camera ladder could not be applied", err);
    }
  }

  async function publish(stream: MediaStream) {
    const [audioTrack] = stream.getAudioTracks();
    if (!audioTrack) {
      throw new Error("No audio track to publish");
    }
    if (published) {
      await room.localParticipant.unpublishTrack(published);
      published = null;
    }
    published = new LocalAudioTrack(audioTrack);
    // publishTrack starts the sender live. If the capture is already
    // closed (user mute, deafen, SPEAK denied), mute the publication
    // before the first packet, then again if the library re-opened it.
    if (!audioTrack.enabled) {
      await published.mute();
    }
    await room.localParticipant.publishTrack(published, {
      // NOT OPTIONAL, and leaving it off was a live production bug.
      // `new LocalAudioTrack(raw)` starts at `Track.Source.Unknown` and
      // `publishTrack` only overwrites that when `source` is passed, so every
      // microphone this client ever published reached the SFU tagged
      // `SOURCE_UNKNOWN`. The camera and the screen share were always tagged,
      // which is why nothing looked wrong.
      //
      // What that broke: `liveKitPublishGrant` (server/src/voice/backends.ts)
      // sends `canPublishSources: ["microphone"]` for a member who holds SPEAK
      // and not STREAM, and LiveKit refuses any publish whose source is not in
      // that list (`VideoGrant.GetCanPublishSource`: a non-empty list is an
      // allowlist and UNKNOWN is not in it). In a `watch_party` channel the
      // stream bit is START_WATCH_PARTY, which no ordinary member holds, so
      // exactly that grant is what an invited speaker gets: the microphone was
      // refused by the media server and the app showed a live, unmuted person
      // nobody could hear.
      source: Track.Source.Microphone,
      dtx: true,
      red: true,
    });
    if (!audioTrack.enabled && !published.isMuted) {
      await published.mute();
    }
  }

  snapshot();

  return {
    publish,

    async replaceTrack(stream: MediaStream) {
      await publish(stream);
    },

    async setMuted(muted: boolean) {
      if (published) {
        await (muted ? published.mute() : published.unmute());
      }
    },

    async publishScreen(stream: MediaStream) {
      return enqueueScreenOp(async () => {
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        throw new Error("No video track to publish");
      }
      const replacing = publishedScreenTrack !== null;
      const [audioTrack] = stream.getAudioTracks();
      const hadAudio = publishedScreenAudioTrack !== null;
      const hasAudio = Boolean(audioTrack);
      const audioChanged = replacing && hadAudio !== hasAudio;
      const plan = currentScreenPlan();
      const epoch = screenShareEpoch;
      // Read native size before height.max, which makes getSettings lie.
      rememberNativeCapture(videoTrack);
      await constrainScreenCapture(videoTrack, plan.topHeight);
      if (!nativeScreenCaptureHeight) {
        rememberNativeCapture(videoTrack);
      }
      if (screenShareEpoch !== epoch) {
        return;
      }
      const publishPlan = planForTrack(videoTrack);
      if (publishPlan.topHeight !== plan.topHeight) {
        await constrainScreenCapture(videoTrack, publishPlan.topHeight);
        if (screenShareEpoch !== epoch) {
          return;
        }
      }

      // Same sid, same egress, same playlist. A host who picks a different
      // window should not rebuffer every viewer. Gaining or losing the
      // share's audio is a different pair of tracks and HAS to republish:
      // a running Track Composite egress is bound to the sids it started
      // with, and an audio track published afterwards never reaches it.
      const publication = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShare,
      );
      const local = publication?.track as
        | { replaceTrack?: (track: MediaStreamTrack) => Promise<void> }
        | undefined;
      if (
        replacing &&
        !audioChanged &&
        local &&
        typeof local.replaceTrack === "function"
      ) {
        await local.replaceTrack(videoTrack);
        if (screenShareEpoch !== epoch) {
          if (publishedScreenTrack !== videoTrack) {
            await room.localParticipant.unpublishTrack(videoTrack, false);
          }
          return;
        }
        publishedScreenTrack = videoTrack;
        if (audioTrack && publishedScreenAudioTrack) {
          const audioPub = room.localParticipant.getTrackPublication(
            Track.Source.ScreenShareAudio,
          );
          const audioLocal = audioPub?.track as
            | { replaceTrack?: (track: MediaStreamTrack) => Promise<void> }
            | undefined;
          if (audioLocal && typeof audioLocal.replaceTrack === "function") {
            await audioLocal.replaceTrack(audioTrack);
            publishedScreenAudioTrack = audioTrack;
          }
        }
        return;
      }

      if (replacing && screenPlanPinned && !audioChanged) {
        // No replaceTrack on this publication. Keep the live sid rather
        // than unpublish; a new sid tears the party down.
        return;
      }

      if (publishedScreenTrack) {
        await room.localParticipant.unpublishTrack(publishedScreenTrack);
        if (screenShareEpoch !== epoch) {
          return;
        }
      }
      publishedScreenTrack = videoTrack;
      screenCaptureConstraints = null;
      // The plan for THIS room at THIS size, applied to the capture before
      // the library reads its dimensions, so the layers it declares are the
      // layers that exist. See `screenSimulcastPlan` for why height and not
      // a divisor.
      const kept = await publishScreenVideo(videoTrack, publishPlan);
      if (!kept) {
        return;
      }
      if (replacing) {
        onScreenRepublished?.();
      }

      // The audio half. Absent from most captures, so its absence is not an
      // error, but a re-publish (after a reconnect) must not leave the previous
      // one up either, hence the unpublish before the guard.
      if (publishedScreenAudioTrack) {
        await room.localParticipant.unpublishTrack(publishedScreenAudioTrack);
        publishedScreenAudioTrack = null;
      }
      if (!audioTrack) {
        return;
      }
      publishedScreenAudioTrack = audioTrack;
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
        // A film is not a phone call: DTX would gate the quiet passages and
        // the SFU's own noise handling has no business on a music track.
        dtx: false,
        red: false,
      });
      });
    },

    async unpublishScreenAudio() {
      return enqueueScreenOp(async () => {
        if (!publishedScreenAudioTrack) {
          return;
        }
        await room.localParticipant.unpublishTrack(publishedScreenAudioTrack);
        publishedScreenAudioTrack = null;
      });
    },

    async unpublishScreen() {
      return enqueueScreenOp(async () => {
        // Invalidate in-flight reconcile before any await so it cannot write
        // height/bitrate onto a share that no longer exists.
        screenShareEpoch += 1;
        if (publishedScreenAudioTrack) {
          await room.localParticipant.unpublishTrack(publishedScreenAudioTrack);
          publishedScreenAudioTrack = null;
        }
        if (!publishedScreenTrack) {
          return;
        }
        await room.localParticipant.unpublishTrack(publishedScreenTrack);
        publishedScreenTrack = null;
        publishedScreenPlan = null;
        screenCaptureConstraints = null;
        // A new share is a new decision. The pin is per broadcast, not per
        // session: somebody who stops and shares a different window gets the
        // plan that window and that room call for.
        screenPlanPinned = false;
        appliedScreenCaptureHeight = null;
        nativeScreenCaptureHeight = null;
        pendingCaptureHeight = null;
        captureHeightStreak = 0;
        lastCaptureHeightChangeAt = 0;
        hlsLayersTrimmed = false;
      });
    },

    async publishCamera(stream: MediaStream) {
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        throw new Error("No video track to publish");
      }
      if (publishedCameraTrack) {
        await room.localParticipant.unpublishTrack(publishedCameraTrack);
      }
      publishedCameraTrack = videoTrack;
      await publishCameraVideo(videoTrack);
    },

    reconcileCameraLadder,

    async setCameraMaxBitrate(maxBitrate: number) {
      cameraMaxBitrate = maxBitrate;
      await setSourceMaxBitrate(Track.Source.Camera, maxBitrate, "camera");
    },

    async setScreenMaxBitrate(maxBitrate: number) {
      // Stored first and applied second, in that order, because the two halves
      // answer different questions: the field is what a *later* publish will
      // carry (a share started after the choice, or republished after a
      // reconnect), and the call is what the share already on the wire gets.
      screenMaxBitrate = maxBitrate;
      await setSourceMaxBitrate(Track.Source.ScreenShare, maxBitrate, "screen");
      if (publishedScreenPlan) {
        publishedScreenPlan = { ...publishedScreenPlan, topBitrate: maxBitrate };
      }
    },

    async setScreenQuality(quality: VideoQuality) {
      screenQuality = quality;
      screenMaxBitrate = screenBitrateFor(quality);
      // Capture and bitrate move in place. Republishing here used to be
      // how a quality pick took effect; that minting a new sid is the stall.
      await reconcileScreenPlan();
    },

    /**
     * "A live HLS ladder is transcoding from my screen share, and this is
     * what my uplink can carry." Null when no egress is running on this
     * channel, which is every ordinary call and the case whose large-room
     * cap must not move.
     *
     * Idempotent on purpose: `use-voice.ts` calls it whenever the stream
     * frame or the uplink sample changes, and only a plan that actually
     * differs reaches `reconcileScreenPlan`'s republish.
     */
    async setHlsSource(next: HlsSourceInput | null) {
      hlsSource = next;
      if (publishedScreenPlan && next && next.ladderTopHeight !== null) {
        // Pin the layers already on the wire the moment a broadcast appears.
        // Height never republishes after this — see reconcileScreenPlan.
        screenPlanPinned = true;
      }
      await reconcileScreenPlan();
    },

    async setReceiveQuality(quality: ReceiveQuality) {
      receiveQuality = quality;
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.videoTrackPublications.values()) {
          if (publication.isSubscribed) {
            applyReceiveQuality(publication);
          }
        }
      }
    },

    setAudioDelivery(plan: RemoteAudioPlan) {
      audioDelivery.setPlan(plan);
    },

    async unpublishCamera() {
      if (!publishedCameraTrack) {
        return;
      }
      await room.localParticipant.unpublishTrack(publishedCameraTrack);
      publishedCameraTrack = null;
      publishedCameraRungs = null;
    },

    async disconnect() {
      unregisterStats();
      delivery.dispose();
      audioDelivery.dispose();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      frameMarks.clear();
      streams.clear();
      screenStreams.clear();
      cameraStreams.clear();
      screenAudioStreams.clear();
      qualities.clear();
      // Do not wait on the screen queue: a stalled publishTrack would leave
      // the room unable to close. Epoch bump is enough for in-flight ops to
      // drop their result; the LiveKit room going away drops the rest.
      screenShareEpoch += 1;
      published = null;
      publishedScreenTrack = null;
      publishedScreenPlan = null;
      screenCaptureConstraints = null;
      appliedScreenCaptureHeight = null;
      nativeScreenCaptureHeight = null;
      pendingCaptureHeight = null;
      captureHeightStreak = 0;
      lastCaptureHeightChangeAt = 0;
      hlsLayersTrimmed = false;
      publishedCameraTrack = null;
      publishedScreenAudioTrack = null;
      await room.disconnect();
    },

    isConnected() {
      return room.state === ConnectionState.Connected;
    },
  };
}
