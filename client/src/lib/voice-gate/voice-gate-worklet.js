/* global registerProcessor, AudioWorkletProcessor, sampleRate -- the worklet scope's own globals */

/**
 * The voice gate: a small adaptive downward expander that sits AFTER the
 * suppressor in Voz limpa, so what is left between two sentences (the residue
 * RNNoise leaves, a breath, a chair, a key that got through) is turned down
 * instead of sent.
 *
 * This file is loaded two ways and has to stay valid in both:
 *
 *   - as an AudioWorklet module (`audioWorklet.addModule`), where it
 *     registers `pqp-voice-gate`, and
 *   - as a plain ES module in Node and vitest, where only `VoiceGate` is used
 *     and the registration below is skipped.
 *
 * So: no imports, no TypeScript, nothing that needs a bundler. Vite serves it
 * as an asset (`?url&no-inline`, see `../noise-suppression.ts`).
 *
 * HOW IT DECIDES, in the order the audio meets it
 *
 *  1. LOOKAHEAD. The signal is delayed by `lookaheadMs` (8 ms) before the gain
 *     is applied, and the detector reads the signal BEFORE the delay. The gate
 *     therefore knows a word is starting about 8 ms before that word reaches
 *     the output, and has already finished opening when it does. This is what
 *     keeps the first consonant: the usual gate opens after it hears the word
 *     and eats the front of it.
 *  2. LEVEL. Every millisecond the detector takes the RMS of that block, in
 *     dB. A block counts as "voice" when it is above the OPEN threshold.
 *  3. CONFIRMATION. The gate opens only after `confirmMs` (5 ms) of
 *     consecutive voice blocks. A key click rings for 2 to 4 ms and fails
 *     this; a vowel or a fricative does not. The confirmation fits inside the
 *     lookahead (8 ms minus 5 ms leaves 3 ms for the gain to ramp up), which
 *     is why those two numbers are what they are.
 *     A run that has already fallen 15 dB below its own peak by then is a
 *     click's decay, not a voice, and is refused (`decayRejectDb`).
 *  4. HYSTERESIS AND HOLD. Once open the gate closes only when the level has
 *     been under the CLOSE threshold (lower than the open one) for `holdMs`.
 *     A word's soft tail, or the dip between two syllables, stays open.
 *  5. THE FLOOR. Both thresholds are the room's noise floor plus a margin.
 *     The floor is a minimum-statistics estimate: the quietest stretch of the
 *     last ~3 seconds of the (30 ms smoothed) level, which is the room
 *     between the words however loud the words are. It follows a quieter room
 *     down fast and a noisier one up within a second or so, needs no "is this
 *     speech" decision to learn (so a fan louder than the prior cannot lock
 *     it out), starts from a prior, and is clamped so that a loud room cannot
 *     push the threshold into the speaking level.
 *  6. THE EXPANDER. A closed gate does not mute. It settles at `rangeDb`
 *     below unity (-20 dB), reached with a 60 ms release, and opens with a
 *     sub-millisecond attack. Anything that leaks through is quieter, nothing
 *     chops: no walkie-talkie dead air and no pumping noise floor.
 *
 * THE SIDECHAIN. In Voz limpa the audio the gate gains is RNNoise's output, and
 * RNNoise delays it by about 20 ms. The node therefore has a second input, wired
 * straight from the microphone, and the detector reads that one: it learns the
 * REAL room (RNNoise's output is silent in a gap, which would teach it a floor
 * of -75 dBFS and a threshold that a breath crosses), it hears a key click as
 * the sharp transient it is (RNNoise smears one into something voice-like), and
 * it hears a word about 15 ms before the same word reaches the audio path, so
 * the extra lookahead delay is 0. Without that second input (`lookaheadMs`
 * left at its 8 ms default) the gate judges its own input and delays it by the
 * lookahead.
 *
 * It starts OPEN, so the first words of a call are never held back while it
 * learns the room, and `setBypass(true)` pins it open (the runtime kill
 * switch, applied live without rebuilding the chain).
 *
 * Added latency is exactly `lookaheadMs`: `latencySamples` says how many.
 */

/** Everything tunable, in one place. dB are dBFS of the block RMS. */
export const VOICE_GATE_DEFAULTS = Object.freeze({
  /** Delay on the signal path; the detector reads the undelayed signal. */
  lookaheadMs: 8,
  /** Consecutive voice milliseconds required before the gate opens. */
  confirmMs: 5,
  /**
   * A run that is already this far below its own peak when the confirmation
   * ends is a transient dying away (a key click), not a voice starting: it
   * does not open the gate. Voice holds its level or climbs; a click falls
   * several dB a millisecond. 0 turns the rule off.
   */
  decayRejectDb: 15,
  /** The close decision reads the level smoothed over this long. */
  closeSmoothMs: 8,
  /** Time the level must stay under the close threshold before it closes. */
  holdMs: 150,
  /** Open threshold above the floor. */
  openMarginDb: 10,
  /** Close threshold above the floor (hysteresis: lower than the open one). */
  closeMarginDb: 6,
  /**
   * The open threshold never goes below this. After RNNoise the floor can sit
   * at -75 dBFS, and a threshold that close to digital silence would open on
   * every breath.
   */
  minOpenDb: -56,
  /** Where the floor starts, before it has heard the room. */
  initialFloorDb: -62,
  /** The floor is kept inside this range. */
  minFloorDb: -80,
  maxFloorDb: -42,
  /** During the first `warmupMs` the floor may not be taught above this. */
  warmupMaxFloorDb: -50,
  warmupMs: 1000,
  /** The floor is the minimum of the smoothed level over this window... */
  floorWindowMs: 3000,
  /** ...smoothed over this long, so one deep zero-crossing is not the room. */
  levelSmoothMs: 30,
  /** Blocks quieter than this are digital silence and teach the floor nothing. */
  silenceDb: -100,
  /** The minimum of a noisy level reads low; this puts it back at the mean. */
  floorBiasDb: 1.5,
  /** How far a closed gate turns the signal down. */
  rangeDb: -20,
  /** Gain time constants. */
  attackMs: 0.6,
  releaseMs: 60,
  /** How fast the floor follows its target down and up. */
  floorFallMs: 100,
  floorRiseMs: 400,
  /** How long it stays open at the start whatever it hears. */
  initialOpenMs: 400,
});

const dbToGain = (db) => Math.pow(10, db / 20);

export class VoiceGate {
  /**
   * @param {{ sampleRate: number } & Partial<typeof VOICE_GATE_DEFAULTS>} options
   */
  constructor(options) {
    const c = { ...VOICE_GATE_DEFAULTS, ...options };
    const sr = options.sampleRate;
    this.config = c;
    this.sampleRate = sr;
    this.blockLen = Math.max(1, Math.round(sr / 1000));
    this.lookahead = Math.max(0, Math.round((c.lookaheadMs * sr) / 1000));
    this.confirmBlocks = Math.max(1, Math.round(c.confirmMs));
    this.holdBlocks = Math.max(1, Math.round(c.holdMs));
    this.warmupBlocks = Math.round(c.warmupMs);
    this.rangeGain = dbToGain(c.rangeDb);
    this.attackCoef = 1 - Math.exp(-1 / ((sr * c.attackMs) / 1000));
    this.releaseCoef = 1 - Math.exp(-1 / ((sr * c.releaseMs) / 1000));
    // Block rate is 1 kHz, so a time constant in ms is its own block count.
    this.floorFall = 1 - Math.exp(-1 / c.floorFallMs);
    this.floorRise = 1 - Math.exp(-1 / c.floorRiseMs);
    this.smoothCoef = 1 - Math.exp(-1 / c.levelSmoothMs);
    this.smoothPower = 0;
    this.smoothSeeded = false;
    this.closeCoef = 1 - Math.exp(-1 / c.closeSmoothMs);
    this.closePower = 0;
    // The window is kept as 250 ms buckets, each holding the minimum seen in it.
    this.bucketBlocks = 250;
    this.buckets = new Float64Array(
      Math.max(2, Math.round(c.floorWindowMs / this.bucketBlocks)),
    ).fill(Infinity);
    this.bucketAt = 0;
    this.bucketFill = 0;

    this.floorDb = c.initialFloorDb;
    this.open = true;
    this.holdLeft = Math.max(this.holdBlocks, Math.round(c.initialOpenMs));
    this.aboveRun = 0;
    this.runPeakDb = -120;
    this.blocksSeen = 0;
    this.blockSumSq = 0;
    this.blockCount = 0;
    this.gain = 1;
    this.bypass = false;
    /** Per channel ring buffers for the lookahead, created on first use. */
    this.rings = [];
    this.ringAt = 0;
    this.lastLevelDb = -120;
  }

  /** Samples of delay this adds, whatever the gain is doing. */
  get latencySamples() {
    return this.lookahead;
  }

  get isOpen() {
    return this.open;
  }

  get openThresholdDb() {
    return Math.max(this.floorDb + this.config.openMarginDb, this.config.minOpenDb);
  }

  get closeThresholdDb() {
    return Math.max(
      this.floorDb + this.config.closeMarginDb,
      this.config.minOpenDb - 4,
    );
  }

  /** Pin the gate open (and stop it expanding). The live kill switch. */
  setBypass(bypass) {
    this.bypass = bypass === true;
  }

  /** One millisecond block finished: learn the floor, move the state machine. */
  endBlock() {
    const c = this.config;
    const level = 10 * Math.log10(this.blockSumSq / this.blockCount + 1e-12);
    this.lastLevelDb = level;
    this.blockSumSq = 0;
    this.blockCount = 0;
    this.blocksSeen += 1;

    // The floor: minimum of the smoothed level over the window, so it is the
    // room between words whatever the words do, and learns with no decision
    // about what is speech.
    const blockPower = Math.pow(10, level / 10);
    // Digital silence (a muted or hardware-gated microphone) is not a room: it
    // would teach a floor of -80 dBFS and keep the gate open for the whole
    // window once sound returns. It teaches nothing.
    if (level > this.config.silenceDb) {
      // Seed the smoother with the first real block so it does not climb from
      // zero and report a room quieter than any room has been.
      this.smoothPower = this.smoothSeeded
        ? this.smoothPower + (blockPower - this.smoothPower) * this.smoothCoef
        : blockPower;
      this.smoothSeeded = true;
      const smoothed = 10 * Math.log10(this.smoothPower + 1e-12);
      if (smoothed < this.buckets[this.bucketAt]) {
        this.buckets[this.bucketAt] = smoothed;
      }
    }
    this.bucketFill += 1;
    if (this.bucketFill >= this.bucketBlocks) {
      this.bucketFill = 0;
      this.bucketAt = (this.bucketAt + 1) % this.buckets.length;
      this.buckets[this.bucketAt] = Infinity;
    }
    let windowMin = Infinity;
    for (let k = 0; k < this.buckets.length; k++) {
      windowMin = Math.min(windowMin, this.buckets[k]);
    }
    if (windowMin !== Infinity) {
      const warming = this.blocksSeen < this.warmupBlocks;
      const ceiling = warming
        ? Math.min(c.warmupMaxFloorDb, c.maxFloorDb)
        : c.maxFloorDb;
      const goal = Math.min(
        Math.max(windowMin + c.floorBiasDb, c.minFloorDb),
        ceiling,
      );
      this.floorDb +=
        (goal - this.floorDb) *
        (goal < this.floorDb ? this.floorFall : this.floorRise);
    }

    const openThr = this.openThresholdDb;
    const closeThr = this.closeThresholdDb;

    if (level > openThr) {
      this.runPeakDb = this.aboveRun === 0 ? level : Math.max(this.runPeakDb, level);
      this.aboveRun += 1;
    } else {
      this.aboveRun = 0;
    }

    // The close decision uses a short smoothing of the level: raw 1 ms blocks
    // of low-frequency room noise swing several dB and would keep re-arming
    // the hold on a fan that is merely a few dB over the floor.
    this.closePower =
      this.blocksSeen === 1
        ? blockPower
        : this.closePower + (blockPower - this.closePower) * this.closeCoef;
    const closeLevel = 10 * Math.log10(this.closePower + 1e-12);

    if (this.open) {
      if (closeLevel > closeThr) {
        this.holdLeft = this.holdBlocks;
      } else if (--this.holdLeft <= 0) {
        this.open = false;
      }
    } else if (
      this.aboveRun >= this.confirmBlocks &&
      (c.decayRejectDb <= 0 || level >= this.runPeakDb - c.decayRejectDb)
    ) {
      this.open = true;
      this.holdLeft = this.holdBlocks;
    }
  }

  /**
   * One render quantum, any length. `inputs` and `outputs` are arrays of
   * channels, as a worklet receives them. Output channels beyond the input's
   * are left alone.
   *
   * `sidechain`, when it has the same length as `inputs`, is what the DETECTOR
   * reads instead of `inputs` (see "THE SIDECHAIN" above). The audio that is
   * delayed and gained is always `inputs`.
   */
  process(inputs, outputs, sidechain) {
    const channels = Math.min(inputs.length, outputs.length);
    if (channels === 0) {
      return;
    }
    const length = inputs[0].length;
    const detector =
      sidechain && sidechain.length > 0 && sidechain[0] && sidechain[0].length === length
        ? sidechain
        : inputs;
    const detectorChannels = detector.length;
    while (this.rings.length < channels) {
      this.rings.push(new Float32Array(Math.max(1, this.lookahead)));
    }
    const delayed = this.lookahead > 0;
    const ringSize = this.lookahead;

    for (let i = 0; i < length; i++) {
      // Detector: the undelayed signal. Mean power over channels, so a stereo
      // microphone is judged as a whole and every channel gets the same gain.
      let power = 0;
      for (let ch = 0; ch < detectorChannels; ch++) {
        const v = detector[ch][i];
        power += v * v;
      }
      // A NaN or infinity in the input must not become the detector's state:
      // one bad block would otherwise leave every threshold NaN and the gate
      // shut for the rest of the call.
      this.blockSumSq += Number.isFinite(power) ? power / detectorChannels : 0;
      this.blockCount += 1;
      if (this.blockCount >= this.blockLen) {
        this.endBlock();
      }

      const target = this.bypass || this.open ? 1 : this.rangeGain;
      this.gain +=
        (target - this.gain) *
        (target > this.gain ? this.attackCoef : this.releaseCoef);

      for (let ch = 0; ch < channels; ch++) {
        const x = inputs[ch][i];
        let y = x;
        if (delayed) {
          const ring = this.rings[ch];
          y = ring[this.ringAt];
          ring[this.ringAt] = x;
        }
        outputs[ch][i] = y * this.gain;
      }
      if (delayed) {
        this.ringAt = this.ringAt + 1 === ringSize ? 0 : this.ringAt + 1;
      }
    }
  }
}

if (
  typeof registerProcessor === "function" &&
  typeof AudioWorkletProcessor === "function"
) {
  registerProcessor(
    "pqp-voice-gate",
    class VoiceGateProcessor extends AudioWorkletProcessor {
      constructor(init) {
        super();
        const options = (init && init.processorOptions) || {};
        // `sampleRate` is a global of the worklet scope.
        this.gate = new VoiceGate({ ...options, sampleRate });
        this.failed = false;
        this.port.onmessage = (event) => {
          const data = event.data;
          if (data && typeof data === "object" && "bypass" in data) {
            this.gate.setBypass(data.bypass);
          }
        };
      }

      process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
          return true;
        }
        if (!this.failed) {
          try {
            this.gate.process(input, output, inputs[1]);
            return true;
          } catch {
            // Whatever went wrong, the microphone is not allowed to go quiet
            // over it: from here on this is a wire.
            this.failed = true;
          }
        }
        const channels = Math.min(input.length, output.length);
        for (let ch = 0; ch < channels; ch++) {
          output[ch].set(input[ch]);
        }
        return true;
      }
    },
  );
}
