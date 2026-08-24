import type { VoiceSessionInfo } from "@pqp/shared";
import type { PeerConnectionState, RemotePeer } from "./peer-connection-manager";
import {
  cameraBitrateFor,
  DEFAULT_VIDEO_QUALITY,
  screenBitrateFor,
} from "./video-quality";

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
  /** Stop publishing the camera video track. */
  unpublishCamera(): Promise<void>;
  disconnect(): Promise<void>;
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
  } = await import("livekit-client");

  const room = new Room({
    adaptiveStream: false,
    dynacast: true,
  });

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
        if (pub.source === Track.Source.ScreenShare) {
          screenStreams.set(
            participant.identity,
            new MediaStream([track.mediaStreamTrack]),
          );
          snapshot();
        } else if (pub.source === Track.Source.Camera) {
          cameraStreams.set(
            participant.identity,
            new MediaStream([track.mediaStreamTrack]),
          );
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
    .on(RoomEvent.ParticipantConnected, snapshot)
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      streams.delete(participant.identity);
      screenStreams.delete(participant.identity);
      cameraStreams.delete(participant.identity);
      screenAudioStreams.delete(participant.identity);
      snapshot();
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
      for (const encoding of params.encodings) {
        encoding.maxBitrate = maxBitrate;
      }
      await sender.setParameters(params);
    } catch (err) {
      console.warn(
        `[pqp] SFU ${label} ceiling rejected; keeping the published one`,
        err,
      );
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
      await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: false,
        // The SFU half of the same argument as the mesh path: without these the
        // encoder holds resolution and spends framerate, which turns a film
        // into stills. `degradationPreference` is the lever; the encoding is a
        // ceiling, not a target, so a still screen still costs almost nothing.
        degradationPreference: "maintain-framerate",
        videoEncoding: {
          // The chosen quality, not a constant. This used to be a hard-coded
          // 2.5 Mbps that no setting could reach, which is why picking 1080p
          // did nothing for a share on either transport.
          maxBitrate: screenMaxBitrate,
          maxFramerate: VIDEO_MAX_FRAMERATE,
        },
      });

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
    },

    async unpublishCamera() {
      if (!publishedCameraTrack) {
        return;
      }
      await room.localParticipant.unpublishTrack(publishedCameraTrack);
      publishedCameraTrack = null;
    },

    async disconnect() {
      streams.clear();
      screenStreams.clear();
      cameraStreams.clear();
      screenAudioStreams.clear();
      published = null;
      publishedScreenTrack = null;
      publishedCameraTrack = null;
      publishedScreenAudioTrack = null;
      await room.disconnect();
    },
  };
}
