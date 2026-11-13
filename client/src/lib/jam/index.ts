/**
 * The jam audio engine. Read docs/JAM_ENGINE.md first: the API, the latency
 * model and what has and has not been measured.
 */
export { JamEngine, type LatencyStatus } from "./engine";
export {
  JamPlayer,
  type JamClockTick,
  type JamStemInit,
  type JamStemPatch,
  type JamStemState,
  type TransportState,
} from "./player";
export { JamInput, currentDevicePair, instrumentConstraints, listInputs } from "./input";
export { calibrateLoopback, calibrateTapAlong, type LoopbackOptions, type TapAlongOptions } from "./calibrate";
export {
  type DevicePair,
  type LatencyConfidence,
  type LatencyEstimate,
  type LatencyMethod,
  type LatencyResult,
  type OutputAssessment,
  LatencyStore,
  assessOutput,
  chooseLatency,
  devicePairKey,
  estimateFromReported,
} from "./latency";
export { startRecording, takeToBuffer, type JamTake, type RecordOptions, type RecordingHandle } from "./recorder";
export { prepareStemUpload, STEM_AUDIO_MIME, type JamStemUpload } from "./upload";
export { exportMixdown, renderMixdown, type MixdownStem } from "./mixdown";
export { computePeaks, MAX_PEAKS } from "./peaks";
export { encodeFlac, encodeFlacAsync } from "./flac";
export { encodeWav } from "./pcm";
export { tapTempo, type CountIn } from "./tempo";
export { decideVideo } from "./video-sync";
export { type LoopRegion, type StemTiming, audibleSpan, songDurationMs } from "./timeline";
