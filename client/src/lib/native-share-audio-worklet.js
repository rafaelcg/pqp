/**
 * The AudioWorklet that turns the desktop shell's PCM into a share's sound.
 *
 * Loaded with `?url` and `audioWorklet.addModule`, the same way the RNNoise
 * worklet is: plain JavaScript with no imports, because a worklet scope has
 * no bundler behind it and this file is served as written. The jitter buffer
 * is exported so `native-share-audio-worklet.test.ts` can run it in Node.
 *
 * WHERE THE PCM COMES FROM. The Windows shell captures one process tree with
 * WASAPI process loopback in a utility process and posts 10 ms chunks,
 * interleaved stereo float32 at 48 kHz, on a MessagePort. The page hands that
 * port to this node (`{ type: "port", port }`), so the chunks reach the
 * audio thread without ever touching the page's main thread, which is where a
 * busy React render would otherwise turn into a click in the film.
 *
 * WHY A JITTER BUFFER. Chunks arrive in bursts (the capture wakes per device
 * period, IPC batches) and this thread pulls 128 frames at a steady clock. A
 * small cushion absorbs the bursts; the bounds keep the cushion from turning
 * into lag behind the picture, which is what A/V offset on a share is made of.
 */

export const NATIVE_SHARE_AUDIO_CHANNELS = 2;

/** 48 kHz frames. */
export const JITTER_DEFAULTS = Object.freeze({
  // Hard bound on memory: half a second.
  capacityFrames: 24000,
  // Play once 20 ms is in hand, and again after running dry.
  startFrames: 960,
  // Past 150 ms buffered the capture clock is running ahead of ours (or the
  // page stalled); skip forward to 40 ms rather than stay late forever.
  maxFrames: 7200,
  targetFrames: 1920,
});

export class PcmJitterBuffer {
  constructor(options = {}) {
    const settings = { ...JITTER_DEFAULTS, ...options };
    this.capacityFrames = settings.capacityFrames;
    this.startFrames = settings.startFrames;
    this.maxFrames = settings.maxFrames;
    this.targetFrames = settings.targetFrames;
    this.data = new Float32Array(this.capacityFrames * NATIVE_SHARE_AUDIO_CHANNELS);
    this.readFrame = 0;
    this.size = 0;
    this.playing = false;
    this.underflows = 0;
    this.skippedFrames = 0;
  }

  get bufferedFrames() {
    return this.size;
  }

  /** Drop the oldest `frames`: late audio is worth less than current audio. */
  skip(frames) {
    const count = Math.min(frames, this.size);
    this.readFrame = (this.readFrame + count) % this.capacityFrames;
    this.size -= count;
    this.skippedFrames += count;
  }

  /** One chunk of interleaved stereo. A trailing odd sample is ignored. */
  push(chunk) {
    const frames = Math.floor(chunk.length / NATIVE_SHARE_AUDIO_CHANNELS);
    if (frames === 0) {
      return;
    }
    const overflow = this.size + frames - this.capacityFrames;
    if (overflow > 0) {
      this.skip(overflow);
    }
    let writeFrame = (this.readFrame + this.size) % this.capacityFrames;
    // A chunk larger than the whole buffer keeps only its newest frames.
    const first = Math.max(0, frames - this.capacityFrames);
    for (let frame = first; frame < frames; frame += 1) {
      const at = writeFrame * NATIVE_SHARE_AUDIO_CHANNELS;
      this.data[at] = chunk[frame * NATIVE_SHARE_AUDIO_CHANNELS];
      this.data[at + 1] = chunk[frame * NATIVE_SHARE_AUDIO_CHANNELS + 1];
      writeFrame = (writeFrame + 1) % this.capacityFrames;
    }
    this.size += frames - first;
  }

  /** Fill one render quantum. Silence while priming or dry, never garbage. */
  pull(left, right) {
    const frames = left.length;
    if (!this.playing) {
      if (this.size < this.startFrames) {
        left.fill(0);
        right.fill(0);
        return;
      }
      this.playing = true;
    }
    if (this.size > this.maxFrames) {
      this.skip(this.size - this.targetFrames);
    }
    const available = Math.min(frames, this.size);
    for (let i = 0; i < available; i += 1) {
      const at = this.readFrame * NATIVE_SHARE_AUDIO_CHANNELS;
      left[i] = this.data[at];
      right[i] = this.data[at + 1];
      this.readFrame = (this.readFrame + 1) % this.capacityFrames;
    }
    this.size -= available;
    if (available < frames) {
      left.fill(0, available);
      right.fill(0, available);
      // Ran dry: the target went quiet (process loopback sends nothing at
      // all for silence) or the capture stalled. Prime again before playing,
      // so what comes back is not a stutter of single chunks.
      this.underflows += 1;
      this.playing = false;
    }
  }
}

const scope = globalThis;

if (typeof scope.registerProcessor === "function" && typeof scope.AudioWorkletProcessor === "function") {
  class NativeShareAudioProcessor extends scope.AudioWorkletProcessor {
    constructor() {
      super();
      this.buffer = new PcmJitterBuffer();
      this.source = null;
      this.scratch = new Float32Array(128);
      this.port.onmessage = (event) => {
        const message = event.data;
        if (message?.type === "port" && message.port) {
          this.source?.close();
          this.source = message.port;
          this.source.onmessage = (chunkEvent) => {
            const chunk = chunkEvent.data;
            if (ArrayBuffer.isView(chunk)) {
              this.buffer.push(
                chunk instanceof Float32Array
                  ? chunk
                  : new Float32Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 4)),
              );
            }
          };
        } else if (message?.type === "close") {
          this.source?.close();
          this.source = null;
        }
      };
    }

    process(_inputs, outputs) {
      const output = outputs[0];
      if (!output || output.length === 0) {
        return true;
      }
      const left = output[0];
      let right = output[1];
      if (!right) {
        if (this.scratch.length !== left.length) {
          this.scratch = new Float32Array(left.length);
        }
        right = this.scratch;
      }
      this.buffer.pull(left, right);
      return true;
    }
  }

  scope.registerProcessor("pqp-native-share-audio", NativeShareAudioProcessor);
}
