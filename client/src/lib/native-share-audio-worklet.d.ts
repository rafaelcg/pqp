/** Types for `native-share-audio-worklet.js`, which stays plain JavaScript. */

export const NATIVE_SHARE_AUDIO_CHANNELS: 2;

export interface JitterOptions {
  capacityFrames: number;
  startFrames: number;
  maxFrames: number;
  targetFrames: number;
}

export const JITTER_DEFAULTS: Readonly<JitterOptions>;

export class PcmJitterBuffer {
  constructor(options?: Partial<JitterOptions>);
  readonly bufferedFrames: number;
  playing: boolean;
  underflows: number;
  skippedFrames: number;
  push(chunk: Float32Array): void;
  pull(left: Float32Array, right: Float32Array): void;
}
