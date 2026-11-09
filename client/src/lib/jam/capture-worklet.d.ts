export const CAPTURE_PROCESSOR: "pqp-jam-capture";

export interface CaptureBatch {
  /** Context frame of channels[c][0]. */
  frame: number;
  channels: Float32Array[];
}

export class CaptureCollector {
  constructor(options?: { batchFrames?: number });
  start(atFrame: number, channelCount: number): void;
  push(input: Float32Array[] | undefined, frame: number, length: number): CaptureBatch | null;
  flush(): CaptureBatch | null;
  stop(): CaptureBatch | null;
}
