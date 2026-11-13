export interface VoiceGateConfig {
  lookaheadMs: number;
  confirmMs: number;
  decayRejectDb: number;
  closeSmoothMs: number;
  holdMs: number;
  openMarginDb: number;
  closeMarginDb: number;
  minOpenDb: number;
  initialFloorDb: number;
  minFloorDb: number;
  maxFloorDb: number;
  warmupMaxFloorDb: number;
  warmupMs: number;
  floorWindowMs: number;
  levelSmoothMs: number;
  floorBiasDb: number;
  silenceDb: number;
  rangeDb: number;
  attackMs: number;
  releaseMs: number;
  floorFallMs: number;
  floorRiseMs: number;
  initialOpenMs: number;
}

export const VOICE_GATE_DEFAULTS: Readonly<VoiceGateConfig>;

export class VoiceGate {
  constructor(options: { sampleRate: number } & Partial<VoiceGateConfig>);
  readonly sampleRate: number;
  readonly config: VoiceGateConfig;
  /** Samples of delay this adds, whatever the gain is doing. */
  readonly latencySamples: number;
  readonly isOpen: boolean;
  readonly floorDb: number;
  readonly openThresholdDb: number;
  readonly closeThresholdDb: number;
  readonly gain: number;
  /** Pin the gate open and stop it expanding. */
  setBypass(bypass: boolean): void;
  /**
   * `sidechain`, when it matches `inputs` in length, is what the detector reads
   * instead of `inputs`; the audio gained and delayed is always `inputs`.
   */
  process(
    inputs: Float32Array[],
    outputs: Float32Array[],
    sidechain?: Float32Array[],
  ): void;
}
