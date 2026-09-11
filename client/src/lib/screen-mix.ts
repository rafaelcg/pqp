/**
 * The host's voice in the stream.
 *
 * THE PROBLEM. The HLS transcode is bound to two tracks, the screen share and
 * that share's own audio, so a host talking over a film was heard by the
 * seated room and by nobody watching from outside. `docs/plans/
 * WATCH_PARTY_STREAM_AUDIO.md` weighs the ways out; this is the one it
 * recommends: the browser mixes the microphone INTO the screen-share audio
 * track before publishing, and the egress never learns anything changed.
 * Zero cost on the media box, client-only, rolls back with a Pages deploy.
 *
 * WHAT IS MIXED. The display capture's audio, if it had any, plus the
 * microphone's PROCESSED stream (the pipeline's output, after gain and the
 * mute gate), so the host's mute button mutes the stream too, and a capture
 * with no audio of its own becomes the mic alone, which beats the silence it
 * produced before.
 *
 * The AudioContext is injectable so the mix is testable in Node.
 */

export interface AudioContextLike {
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createMediaStreamDestination(): { stream: MediaStream } & AudioNodeLike;
  close(): Promise<void> | void;
}

export interface AudioNodeLike {
  connect(target: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface ScreenMix {
  /** The display's video track plus one mixed audio track. Publish this. */
  stream: MediaStream;
  /** Swap the microphone branch (device change), or drop it with null. */
  setMic(stream: MediaStream | null): void;
  /** True while a microphone is in the mix. */
  micIn(): boolean;
  close(): void;
}

export function createScreenMix(
  display: MediaStream,
  mic: MediaStream | null,
  makeContext: () => AudioContextLike = () => new AudioContext(),
): ScreenMix {
  const context = makeContext();
  const destination = context.createMediaStreamDestination();

  const displayAudio = display.getAudioTracks();
  let displaySource: AudioNodeLike | null = null;
  if (displayAudio.length > 0) {
    displaySource = context.createMediaStreamSource(
      new MediaStream(displayAudio),
    );
    displaySource.connect(destination);
  }

  let micSource: AudioNodeLike | null = null;
  const setMic = (stream: MediaStream | null) => {
    micSource?.disconnect();
    micSource = null;
    if (stream && stream.getAudioTracks().length > 0) {
      micSource = context.createMediaStreamSource(
        new MediaStream(stream.getAudioTracks()),
      );
      micSource.connect(destination);
    }
  };
  setMic(mic);

  const stream = new MediaStream([
    ...display.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  return {
    stream,
    setMic,
    micIn: () => micSource !== null,
    close: () => {
      micSource?.disconnect();
      displaySource?.disconnect();
      micSource = null;
      displaySource = null;
      for (const track of destination.stream.getAudioTracks()) {
        track.stop();
      }
      void context.close();
    },
  };
}
