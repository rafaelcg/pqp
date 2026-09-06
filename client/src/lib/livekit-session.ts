import type { VoiceSessionInfo } from "@pqp/shared";
import type { PeerConnectionState, RemotePeer } from "./peer-connection-manager";
import type { ReceiveQuality } from "./receive-quality";
import { registerRemoteVideoBinding } from "./remote-video-binding";
import {
  createRemoteVideoDelivery,
  type DeliveryPublication,
} from "./remote-video-delivery";
import {
  cameraBitrateFor,
  DEFAULT_VIDEO_QUALITY,
  LARGE_ROOM_SCREEN_BITRATE,
  screenBitrateFor,
  screenSimulcastPlan,
  type ScreenSimulcastPlan,
  type VideoQuality,
} from "./video-quality";
import {
  measureKbps,
  registerVoiceStatsSource,
  type VideoReceiverSample,
  type VideoSenderRole,
  type VideoSenderSample,
  type VoiceStatsSnapshot,
} from "./voice-stats-probe";

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
   * The largest layer this viewer accepts from every remote video publication,
   * applied to what is subscribed now and to whatever arrives later.
   */
  setReceiveQuality(quality: ReceiveQuality): Promise<void>;
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
}

function connectionStateFor(subscribed: boolean): PeerConnectionState {
  return subscribed ? "connected" : "connecting";
}

export async function connectLiveKit({
  session,
  lookupIdentity,
  onPeersChanged,
  onError,
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
      if (pub.source === Track.Source.ScreenShareAudio) {
        screenAudioStreams.set(participant.identity, stream);
      } else {
        streams.set(participant.identity, stream);
      }
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
      snapshot();
      void reconcileScreenPlan();
    })
    .on(RoomEvent.Disconnected, () => {
      streams.clear();
      screenStreams.clear();
      cameraStreams.clear();
      screenAudioStreams.clear();
      snapshot();
    })
    .on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Disconnected) {
        streams.clear();
        screenStreams.clear();
        cameraStreams.clear();
        screenAudioStreams.clear();
        snapshot();
      }
    })
    .on(RoomEvent.MediaDevicesError, (err: Error) => {
      onError(err.message);
    });

  await room.connect(session.url, session.token);

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
   * three, and the busiest layer is the one a person means by "what am I
   * sending". The ceiling is the top layer's, which is what lets
   * `describeLimitation` tell "sitting on your setting" from "starved by your
   * link" exactly as it does on the mesh.
   */
  async function sampleSenders(): Promise<VideoSenderSample[]> {
    const rows: VideoSenderSample[] = [];
    const sources: [unknown, VideoSenderRole, number][] = [
      [Track.Source.Camera, "camera", cameraMaxBitrate],
      [Track.Source.ScreenShare, "screen", screenMaxBitrate],
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
      const stats = layers.reduce<SenderStatsLike | null>(
        (best, layer) =>
          best === null || (layer.bytesSent ?? 0) > (best.bytesSent ?? 0)
            ? layer
            : best,
        null,
      );
      if (!stats) {
        continue;
      }
      const key = `sfu:out:${localPeerId}:${role}`;
      rows.push({
        peerId: localPeerId,
        role,
        width: stats.frameWidth ?? null,
        height: stats.frameHeight ?? null,
        fps: stats.framesPerSecond ?? null,
        kbps: measureKbps(key, stats.bytesSent ?? null, stats.timestamp),
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

  async function sampleRoom(): Promise<VoiceStatsSnapshot> {
    if (room.state !== ConnectionState.Connected) {
      return { senders: [], receivers: [], paths: [] };
    }
    const [senders, receivers] = await Promise.all([
      sampleSenders(),
      sampleReceivers(),
    ]);
    return { senders, receivers, paths: [] };
  }

  const unregisterStats = registerVoiceStatsSource(sampleRoom);

  /** Track we published, kept so we can replace/mute it later. */
  let published: InstanceType<typeof LocalAudioTrack> | null = null;
  /** Raw screen-share track we published, kept so we can unpublish it later. */
  let publishedScreenTrack: MediaStreamTrack | null = null;
  /** Raw camera track we published, kept so we can unpublish it later. */
  let publishedCameraTrack: MediaStreamTrack | null = null;
  /** The ceiling the next camera publish will carry. See `setCameraMaxBitrate`. */
  let cameraMaxBitrate = DEFAULT_CAMERA_MAX_BITRATE_BPS;
  /** The ceiling the next screen publish will carry. See `setScreenMaxBitrate`. */
  let screenMaxBitrate = DEFAULT_SCREEN_MAX_BITRATE_BPS;
  /** The presenter's chosen quality; with the room size it makes the plan. */
  let screenQuality: VideoQuality = DEFAULT_VIDEO_QUALITY;
  /** The plan the share on the wire was published under. Null while not sharing. */
  let publishedScreenPlan: ScreenSimulcastPlan | null = null;
  /**
   * The capture's constraints as the browser handed them over, so the plan's
   * height can be laid over them and lifted again without losing the frame
   * rate or width the capture was asked for.
   */
  let screenCaptureConstraints: MediaTrackConstraints | null = null;
  /** One reconcile at a time; a second request waits its turn. */
  let reconciling: Promise<void> | null = null;
  /** The screen share's audio track, when the capture had one. Usually null. */
  let publishedScreenAudioTrack: MediaStreamTrack | null = null;

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
    // Spelled off the method rather than as `Track.Source`, because `Track` is
    // destructured from a dynamic import in this scope: it is a local value,
    // not a namespace, so it cannot be used in a type position.
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
      const top = params.encodings[params.encodings.length - 1]!;
      top.maxBitrate = maxBitrate;
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
    const plan = screenSimulcastPlan(screenQuality, participantCount());
    return {
      ...plan,
      topBitrate: plan.capped
        ? Math.min(screenMaxBitrate, LARGE_ROOM_SCREEN_BITRATE)
        : screenMaxBitrate,
    };
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
  ): Promise<void> {
    await room.localParticipant.publishTrack(track, {
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
      degradationPreference: "maintain-framerate",
      screenShareEncoding: {
        maxBitrate: plan.topBitrate,
        maxFramerate: VIDEO_MAX_FRAMERATE,
      },
    });
    publishedScreenPlan = plan;
  }

  /**
   * Bring the share on the wire in line with the plan the room now calls for.
   *
   * Runs on every quality change and every time the room grows or shrinks. A
   * different top HEIGHT means a different set of declared layers, and the
   * only honest way to change those is to publish again, so the track is
   * unpublished without being stopped and published under the new plan; the
   * viewers see the picture blink once, at the moment the room crosses twenty
   * people or the presenter picks 1080p by name. A different top CEILING at
   * the same height is moved in place, with no blink, exactly as before.
   */
  function reconcileScreenPlan(): Promise<void> {
    const run = async () => {
      const track = publishedScreenTrack;
      const published = publishedScreenPlan;
      if (!track || !published) {
        return;
      }
      const plan = currentScreenPlan();
      if (plan.topHeight !== published.topHeight) {
        await constrainScreenCapture(track, plan.topHeight);
        // `false`: the capture stays alive; it is the same track going back up.
        await room.localParticipant.unpublishTrack(track, false);
        if (publishedScreenTrack !== track) {
          // The share ended while the capture was being resized.
          return;
        }
        await publishScreenVideo(track, plan);
        return;
      }
      if (plan.topBitrate !== published.topBitrate) {
        await setSourceMaxBitrate(
          Track.Source.ScreenShare,
          plan.topBitrate,
          "screen",
        );
        publishedScreenPlan = plan;
      }
    };
    const next = (reconciling ?? Promise.resolve())
      .then(run)
      .catch((err) => {
        console.warn("[pqp] SFU screen plan could not be applied", err);
      })
      .finally(() => {
        if (reconciling === next) {
          reconciling = null;
        }
      });
    reconciling = next;
    return next;
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
    await room.localParticipant.publishTrack(published, {
      dtx: true,
      red: true,
    });
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
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        throw new Error("No video track to publish");
      }
      if (publishedScreenTrack) {
        await room.localParticipant.unpublishTrack(publishedScreenTrack);
      }
      publishedScreenTrack = videoTrack;
      screenCaptureConstraints = null;
      // The plan for THIS room at THIS size, applied to the capture before
      // the library reads its dimensions, so the layers it declares are the
      // layers that exist. See `screenSimulcastPlan` for why height and not
      // a divisor.
      const plan = currentScreenPlan();
      await constrainScreenCapture(videoTrack, plan.topHeight);
      await publishScreenVideo(videoTrack, plan);

      // The audio half. Absent from most captures, so its absence is not an
      // error, but a re-publish (after a reconnect) must not leave the previous
      // one up either, hence the unpublish before the guard.
      if (publishedScreenAudioTrack) {
        await room.localParticipant.unpublishTrack(publishedScreenAudioTrack);
        publishedScreenAudioTrack = null;
      }
      const [audioTrack] = stream.getAudioTracks();
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
    },

    async unpublishScreenAudio() {
      if (!publishedScreenAudioTrack) {
        return;
      }
      await room.localParticipant.unpublishTrack(publishedScreenAudioTrack);
      publishedScreenAudioTrack = null;
    },

    async unpublishScreen() {
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
      await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.Camera,
        simulcast: false,
        // The camera half of the argument the screen share has been making
        // since it was written: without these the encoder holds resolution and
        // spends framerate, and a face is motion. The encoding is a ceiling,
        // not a target, so a still person still costs almost nothing.
        degradationPreference: "maintain-framerate",
        videoEncoding: {
          maxBitrate: cameraMaxBitrate,
          maxFramerate: VIDEO_MAX_FRAMERATE,
        },
      });
    },

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

    async unpublishCamera() {
      if (!publishedCameraTrack) {
        return;
      }
      await room.localParticipant.unpublishTrack(publishedCameraTrack);
      publishedCameraTrack = null;
    },

    async disconnect() {
      unregisterStats();
      delivery.dispose();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      frameMarks.clear();
      streams.clear();
      screenStreams.clear();
      cameraStreams.clear();
      screenAudioStreams.clear();
      published = null;
      publishedScreenTrack = null;
      publishedScreenPlan = null;
      screenCaptureConstraints = null;
      publishedCameraTrack = null;
      publishedScreenAudioTrack = null;
      await room.disconnect();
    },

    isConnected() {
      return room.state === ConnectionState.Connected;
    },
  };
}
