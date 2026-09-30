/**
 * What the last native share-sound attempt did, stage by stage, kept for one
 * paste.
 *
 * WHY. A field failure (2026-09-30, a Windows 11 PC, the box ticked, the
 * viewers told "no sound") could not be diagnosed: every stage between the
 * tick and the published track (the flag, the shell's self-test, the audio
 * graph, the arm, the claim, the port, the first samples) can fail on its own
 * machine and every one of them used to end in the same silent share. This
 * records the outcome of each, and `describeNativeShareAudio()` folds it into
 * a single line that `pqpShareAudioProbe.measure()` prints with its row, so the
 * next one is one console paste instead of an afternoon.
 *
 * Plain data, no imports, so the probe can read it without pulling the whole
 * handshake in.
 */

export interface NativeShareAudioDiagnostics {
  /** `ensureNativeShareAudio`: the per-server flag and the shell's self-test. */
  flag: boolean | null;
  shell: string | null;
  /** The audio graph built BEFORE the picker (context, worklet, resume). */
  graph: string | null;
  contextState: string | null;
  sampleRate: number | null;
  armed: boolean | null;
  /** `active`, `none` (box unticked), or `failed:<reason>/<stage>/<hr>`. */
  claim: string | null;
  port: boolean | null;
  attached: boolean | null;
  /** Chunks the worklet received from the shell, and the loudest sample seen. */
  chunks: number;
  frames: number;
  peak: number;
  underflows: number;
  /** The capture ended on its own, and why. */
  endedReason: string | null;
  /** The first stage that failed, which is the answer to "why no sound". */
  failedStage: string | null;
  failure: string | null;
}

function blank(): NativeShareAudioDiagnostics {
  return {
    flag: null,
    shell: null,
    graph: null,
    contextState: null,
    sampleRate: null,
    armed: null,
    claim: null,
    port: null,
    attached: null,
    chunks: 0,
    frames: 0,
    peak: 0,
    underflows: 0,
    endedReason: null,
    failedStage: null,
    failure: null,
  };
}

let current: NativeShareAudioDiagnostics = blank();

/** A new share attempt: the last attempt's answers are not this one's. */
export function startNativeShareAudioAttempt(): void {
  const { flag, shell } = current;
  // The flag and the self-test are per page, not per attempt: keep them.
  current = { ...blank(), flag, shell };
}

export function noteNativeShareAudio(patch: Partial<NativeShareAudioDiagnostics>): void {
  current = { ...current, ...patch };
}

/** Records the FIRST failure only: later ones are consequences of it. */
export function noteNativeShareAudioFailure(stage: string, failure: string): void {
  if (current.failedStage === null) {
    current = { ...current, failedStage: stage, failure };
  }
}

export function nativeShareAudioDiagnostics(): Readonly<NativeShareAudioDiagnostics> {
  return current;
}

export function resetNativeShareAudioDiagnosticsForTests(): void {
  current = blank();
}

const show = (value: string | number | boolean | null): string =>
  value === null ? "-" : String(value);

/**
 * One line, every stage, `-` for one that never ran. Reads left to right in
 * the order the stages happen, so the first `-` or `fail` is where it stopped.
 */
export function describeNativeShareAudio(d: Readonly<NativeShareAudioDiagnostics> = current): string {
  const parts = [
    `flag=${show(d.flag)}`,
    `shell=${show(d.shell)}`,
    `graph=${show(d.graph)}`,
    `ctx=${show(d.contextState)}@${show(d.sampleRate)}`,
    `armed=${show(d.armed)}`,
    `claim=${show(d.claim)}`,
    `port=${show(d.port)}`,
    `attached=${show(d.attached)}`,
    `chunks=${d.chunks}`,
    `frames=${d.frames}`,
    `peak=${d.peak.toFixed(3)}`,
    `underflows=${d.underflows}`,
  ];
  if (d.endedReason) {
    parts.push(`ended=${d.endedReason}`);
  }
  parts.push(d.failedStage ? `FAILED at ${d.failedStage}: ${d.failure ?? "?"}` : "no failure recorded");
  return `native share audio: ${parts.join(" ")}`;
}
