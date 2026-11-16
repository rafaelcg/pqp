/* global registerProcessor, AudioWorkletProcessor, currentFrame -- the worklet scope's own globals */

/**
 * The jam capture processor: copies its input out to the main thread, every
 * block stamped with the context frame it was rendered at.
 *
 * That stamp is the point. This node runs on the SAME AudioContext that plays
 * the backing, so "captured at frame Fc" and "played at frame Fp" are on one
 * clock, and the round trip of a click is Fc - Fp with nothing in between to
 * guess. `currentFrame` (a worklet-scope global) is the frame of the first
 * sample of the render quantum being processed.
 *
 * Loaded two ways, like the voice gate's worklet: as an AudioWorklet module
 * (`?url&no-inline`, then `audioWorklet.addModule`), where it registers
 * `pqp-jam-capture`, and as a plain ES module in vitest, where only
 * `CaptureCollector` is used. So: no imports, no TypeScript.
 *
 * Protocol (port messages):
 *   main -> worklet  { type: "start", atFrame, channels }  begin with the quantum holding atFrame
 *                    { type: "stop" }                      flush and report
 *   worklet -> main  { type: "chunk", frame, channels: Float32Array[] }  (transferred)
 *                    { type: "stopped", frame }            no more chunks follow
 *
 * A quantum with no input (the microphone has not delivered yet, or the
 * source is disconnected) is recorded as SILENCE rather than skipped, so the
 * captured timeline never has a hole and frame arithmetic stays exact.
 */

export const CAPTURE_PROCESSOR = "pqp-jam-capture";

export class CaptureCollector {
  /**
   * @param {{ batchFrames?: number }} [options]
   */
  constructor(options) {
    this.batchFrames = (options && options.batchFrames) || 4096;
    this.armed = false;
    this.atFrame = 0;
    this.channelCount = 1;
    this.batch = null;
    this.batchStart = 0;
    this.filled = 0;
  }

  start(atFrame, channelCount) {
    this.armed = true;
    this.atFrame = atFrame;
    this.channelCount = Math.max(1, Math.min(2, channelCount || 1));
    this.batch = null;
    this.filled = 0;
  }

  /**
   * One render quantum. Returns a finished batch `{ frame, channels }` or null.
   * @param {Float32Array[] | undefined} input
   * @param {number} frame  context frame of input[c][0]
   * @param {number} length quantum length (128)
   */
  push(input, frame, length) {
    if (!this.armed) return null;
    if (frame + length <= this.atFrame) return null;
    if (!this.batch) {
      this.batch = [];
      for (let c = 0; c < this.channelCount; c++) this.batch.push(new Float32Array(this.batchFrames));
      this.batchStart = frame;
      this.filled = 0;
    }
    for (let c = 0; c < this.channelCount; c++) {
      const src = input && input.length ? input[Math.min(c, input.length - 1)] : null;
      if (src && src.length) this.batch[c].set(src.subarray(0, length), this.filled);
      // else: already zero
    }
    this.filled += length;
    if (this.filled + length > this.batchFrames) return this.flush();
    return null;
  }

  flush() {
    if (!this.batch || this.filled === 0) {
      this.batch = null;
      return null;
    }
    const out = {
      frame: this.batchStart,
      channels: this.batch.map((b) => b.slice(0, this.filled)),
    };
    this.batch = null;
    this.filled = 0;
    return out;
  }

  stop() {
    const last = this.flush();
    this.armed = false;
    return last;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor(
    CAPTURE_PROCESSOR,
    class JamCaptureProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.collector = new CaptureCollector({ batchFrames: 4096 });
        this.port.onmessage = (event) => {
          const data = event.data || {};
          if (data.type === "start") {
            this.collector.start(data.atFrame, data.channels);
          } else if (data.type === "stop") {
            const last = this.collector.stop();
            if (last) this.send(last);
            this.port.postMessage({ type: "stopped", frame: currentFrame });
          }
        };
      }

      send(batch) {
        this.port.postMessage(
          { type: "chunk", frame: batch.frame, channels: batch.channels },
          batch.channels.map((c) => c.buffer),
        );
      }

      process(inputs) {
        const input = inputs[0];
        const length = input && input[0] ? input[0].length : 128;
        const batch = this.collector.push(input, currentFrame, length);
        if (batch) this.send(batch);
        return true;
      }
    },
  );
}
