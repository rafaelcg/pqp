/**
 * THE APP'S SOUND, IN A SHARE OF ITS PANE (`share.audio`, D14).
 *
 * Why this exists. A share of the app pane is a picture of a sandboxed frame, and
 * what the page can capture of it is the tab. The tab's sound is the wrong sound:
 * it holds every voice of the call (the people watching would hear themselves
 * come back a moment later) and Chromium offers it only when the person ticks a
 * box in the picker, so the pane share used to ask for none and go out silent
 * (`audio: false` in `pane-share.ts`; a game shared into a call arrived as a
 * picture only). The frame's own output, in contrast, is exactly what the people
 * watching should hear, and only the app can hand it over: it cannot be reached
 * from the page (opaque origin).
 *
 * So the app sends its output as short blocks of float samples (`share.audio`),
 * only while the page asked for them, and `ShareAudioSink` plays them into a
 * `MediaStreamTrack` that rides with the share like any other screen sound. The
 * person's own speakers are not involved: the app taps its output BEFORE its
 * mute switch, so M mutes what the sharer hears and nothing else.
 */

export interface ShareAudioBlock {
  rate: number;
  channels: 1 | 2;
  /** Float32 samples, channels interleaved. */
  samples: ArrayBuffer;
}

/** The slice of the Web Audio API the sink uses, so a test can stand a fake in. */
export interface SinkAudioBuffer {
  copyToChannel(source: Float32Array, channel: number): void;
  readonly duration: number;
}
export interface SinkContext {
  readonly currentTime: number;
  readonly state: string;
  createBuffer(channels: number, frames: number, rate: number): SinkAudioBuffer;
  createBufferSource(): {
    buffer: unknown;
    connect(to: unknown): unknown;
    start(when: number): void;
    onended: (() => void) | null;
  };
  createMediaStreamDestination(): { stream: MediaStream };
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface ShareAudioSinkOptions {
  createContext?: () => SinkContext;
  /**
   * The audio context stopped after the share started and the browser would not start it again: the track the
   * share published now carries silence. Said once; the share's owner takes it from there.
   */
  onLost?: () => void;
}

/** How long a share waits for the audio context to start before it goes out as a picture only. */
export const SINK_START_WAIT_MS = 1500;

/** How far ahead of the clock a block is queued when playback starts or has run dry: the jitter it can absorb. */
export const SINK_LEAD_SECONDS = 0.08;
/** Playback that has fallen this far behind is started over from the lead, never played late. */
export const SINK_BEHIND_SECONDS = 0.01;
/** A queue longer than this means blocks are arriving faster than they play: the excess is dropped, not delayed. */
export const SINK_MAX_QUEUE_SECONDS = 0.5;

function defaultContext(): SinkContext {
  const Ctor =
    (globalThis as { AudioContext?: new (options?: object) => SinkContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: new (options?: object) => SinkContext }).webkitAudioContext;
  if (!Ctor) throw new Error("no Web Audio");
  return new Ctor({ latencyHint: "interactive" });
}

/**
 * Plays the app's blocks, gaplessly while they keep coming, into `track`. A block
 * is queued behind the previous one; after a silence (the app sends nothing while
 * its game is silent) or an underrun, playback starts over a short lead ahead of
 * the clock, so the sound is never played late, only started afresh.
 */
export class ShareAudioSink {
  readonly track: MediaStreamTrack;
  private readonly context: SinkContext;
  private readonly destination: { stream: MediaStream };
  private playhead = 0;
  private closed = false;
  /**
   * Whether the audio context started: false when the browser refused (autoplay policy), and the track would carry
   * silence under a share that says it has sound. The share asks before it publishes the track.
   */
  readonly ready: Promise<boolean>;
  private readonly onLost: (() => void) | undefined;
  private lostReported = false;
  private resuming = false;
  /** Blocks played and dropped: what a test and the logs read. */
  played = 0;
  dropped = 0;

  constructor(options: ShareAudioSinkOptions = {}) {
    this.context = (options.createContext ?? defaultContext)();
    this.onLost = options.onLost;
    let destination: { stream: MediaStream };
    let track: MediaStreamTrack | undefined;
    try {
      destination = this.context.createMediaStreamDestination();
      track = destination.stream.getAudioTracks()[0];
    } catch (error) {
      // the context is ours and nothing else will close it
      void this.context.close().catch(() => {});
      throw error;
    }
    if (!track) {
      void this.context.close().catch(() => {});
      throw new Error("no audio track from the destination");
    }
    this.destination = destination;
    this.track = track;
    // the context may start suspended (autoplay policy); the person has acted on the page by now
    this.ready = this.context.resume().then(
      () => true,
      () => false,
    );
  }

  push(block: ShareAudioBlock): void {
    if (this.closed) return;
    // a context that dropped out of running (the browser suspended it) is asked again with the next block
    if (this.context.state !== "running" && !this.resuming && !this.lostReported) {
      // one ask in flight at a time (a block arrives every few tens of ms), and none once the loss was said
      this.resuming = true;
      this.context.resume().then(
        () => {
          this.resuming = false;
        },
        () => {
          this.resuming = false;
          if (this.lostReported || this.closed) return;
          this.lostReported = true;
          this.onLost?.();
        },
      );
    }
    const { rate, channels } = block;
    const samples = new Float32Array(block.samples);
    const frames = Math.floor(samples.length / channels);
    if (frames === 0) return;
    const now = this.context.currentTime;
    if (this.playhead - now > SINK_MAX_QUEUE_SECONDS) {
      this.dropped += 1;
      return;
    }
    let buffer: SinkAudioBuffer;
    try {
      buffer = this.context.createBuffer(channels, frames, rate);
      for (let channel = 0; channel < channels; channel += 1) {
        const plane = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame += 1) plane[frame] = samples[frame * channels + channel]!;
        buffer.copyToChannel(plane, channel);
      }
    } catch {
      // a rate or size this browser will not make a buffer of: the block is lost, the share goes on
      this.dropped += 1;
      return;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    if (this.playhead < now + SINK_BEHIND_SECONDS) this.playhead = now + SINK_LEAD_SECONDS;
    source.start(this.playhead);
    this.playhead += buffer.duration;
    this.played += 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.track.stop();
    } catch {
      // already ended
    }
    void this.context.close().catch(() => {});
  }
}

/**
 * Between the share flow and the frame. The flow `begin()`s when it publishes a
 * share of the pane (and gets the track to publish with it) and `end()`s when the
 * share stops; the frame's bridge host subscribes to be told when the app should
 * send, and hands every block it receives to `push`.
 */
export class ShareAudioRelay {
  /** The share's sink once its audio started: the only one a frame is told about and blocks are played into. */
  private sink: ShareAudioSink | null = null;
  /** A sink whose audio context is still starting: nobody hears of it until it has started. */
  private starting: ShareAudioSink | null = null;
  private readonly listeners = new Set<(wanted: boolean) => void>();
  private readonly lostListeners = new Set<() => void>();
  private readonly makeSink: (onLost: () => void) => ShareAudioSink;
  private readonly startWaitMs: number;

  constructor(
    makeSink: (onLost: () => void) => ShareAudioSink = (onLost) => new ShareAudioSink({ onLost }),
    startWaitMs = SINK_START_WAIT_MS,
  ) {
    this.makeSink = makeSink;
    this.startWaitMs = startWaitMs;
  }

  /** Called when the audio of the running share stopped and the browser would not start it again: it is silent now. */
  onLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
    };
  }

  get active(): boolean {
    return this.sink !== null;
  }

  /**
   * Starts asking the app for its sound. The track to publish, or null where no sound can be made: no Web Audio, or
   * a browser that would not start it (a track that carries silence must not be published as the share's sound).
   */
  async begin(): Promise<MediaStreamTrack | null> {
    this.end();
    let sink: ShareAudioSink;
    try {
      sink = this.makeSink(() => {
        // the audio stopped mid-share and the browser would not start it again: the track carries silence, so the
        // app is told to stop sending and the track is taken down, and the share's owner says so
        if (this.sink !== sink) return;
        this.end();
        for (const listener of [...this.lostListeners]) {
          try {
            listener();
          } catch {
            // one listener must not stop the others
          }
        }
      });
    } catch {
      return null;
    }
    this.starting = sink;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      sink.ready,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.startWaitMs);
      }),
    ]);
    clearTimeout(timer);
    // ended, or begun again, while the context was starting: this one is not the share's any more
    if (this.starting !== sink) {
      sink.close();
      return null;
    }
    this.starting = null;
    if (!started) {
      sink.close();
      return null;
    }
    // a frame that mounted during the wait was told nothing, so a failed start leaves nobody sending
    this.sink = sink;
    this.emit(true);
    return sink.track;
  }

  end(): void {
    const pending = this.starting;
    if (pending) {
      this.starting = null;
      pending.close();
    }
    const sink = this.sink;
    if (!sink) return;
    this.sink = null;
    this.emit(false);
    sink.close();
  }

  push(block: ShareAudioBlock): void {
    this.sink?.push(block);
  }

  /** Called with `true` and `false` as the want changes, and at once with `true` when one is already running. */
  subscribe(listener: (wanted: boolean) => void): () => void {
    this.listeners.add(listener);
    if (this.sink) listener(true);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(wanted: boolean): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(wanted);
      } catch {
        // one listener must not stop the others
      }
    }
  }
}
