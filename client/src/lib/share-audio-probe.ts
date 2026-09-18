/**
 * Hear whether the call leaked into a screen-share's audio track.
 *
 * Unit tests pin the Goertzel math. The console handle
 * (`window.pqpShareAudioProbe`) is how a real Windows box prints a row: play
 * 440 Hz from this document (the call), 880 Hz from another document
 * (Pocket Bard), then read the share-audio track that would be published.
 *
 * CI, Docker, and this Mac cannot hear WASAPI. Do not treat a headed run here
 * as the echo gate. See `client/e2e/share-audio-echo/README.md`.
 */

export const CALL_TONE_HZ = 440;
export const GAME_TONE_HZ = 880;
export const HISS_TONE_HZ = 1320;

/** Call is at the noise floor. */
export const CALL_STRIPPED_SNR_DB = 6;
/** Pocket Bard (or the 880 stand-in) is clearly in the track. */
export const GAME_PRESENT_SNR_DB = 20;
/** Published track still carries the call. */
export const LEAK_SNR_DB = 12;

const FLOOR_HZ = [200, 300, 520, 640, 1000, 1500, 2000] as const;
const MAGNITUDE_FLOOR = 1e-12;

export type ShareAudioProbeVerdict =
  | "PASS"
  | "FAIL_LEAK"
  | "FAIL_NO_GAME"
  | "CONTROL_OK"
  | "CONTROL_DEAF"
  | "NO_TRACK";

export interface ShareAudioToneLevels {
  floor: number;
  call440: number;
  game880: number;
  hiss1320: number;
  snr440: number;
  snr880: number;
  snr1320: number;
}

export interface ShareAudioProbeRow extends ShareAudioToneLevels {
  os: string;
  build: string;
  client: string;
  surface: string;
  restrictOwnAudio: string;
  caps: string;
  verdict: ShareAudioProbeVerdict;
  note: string;
}

export interface ShareAudioTrackLabels {
  os?: string;
  build?: string;
  client?: string;
  surface?: string;
  restrictOwnAudio?: string | boolean;
  caps?: readonly boolean[] | string;
  control?: boolean;
  hasTrack?: boolean;
}

/**
 * One-bin Goertzel magnitude, normalised by frame length so a longer FFT
 * does not look louder.
 */
export function goertzelMagnitude(
  samples: ArrayLike<number>,
  sampleRate: number,
  frequency: number,
): number {
  const n = samples.length;
  if (n === 0 || sampleRate <= 0 || frequency <= 0) {
    return 0;
  }
  const k = Math.round((n * frequency) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const coeff = 2 * cosine;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s0 = (samples[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * cosine;
  const imag = s2 * sine;
  return Math.hypot(real, imag) / n;
}

export function dbFromMagnitude(magnitude: number): number {
  return 20 * Math.log10(Math.max(magnitude, MAGNITUDE_FLOOR));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function analyseToneFrame(
  samples: ArrayLike<number>,
  sampleRate: number,
): ShareAudioToneLevels {
  const floor = dbFromMagnitude(
    median(FLOOR_HZ.map((hz) => goertzelMagnitude(samples, sampleRate, hz))),
  );
  const call440 = dbFromMagnitude(
    goertzelMagnitude(samples, sampleRate, CALL_TONE_HZ),
  );
  const game880 = dbFromMagnitude(
    goertzelMagnitude(samples, sampleRate, GAME_TONE_HZ),
  );
  const hiss1320 = dbFromMagnitude(
    goertzelMagnitude(samples, sampleRate, HISS_TONE_HZ),
  );
  return {
    floor,
    call440,
    game880,
    hiss1320,
    snr440: call440 - floor,
    snr880: game880 - floor,
    snr1320: hiss1320 - floor,
  };
}

export function summariseToneFrames(
  frames: readonly ShareAudioToneLevels[],
): ShareAudioToneLevels {
  const pick = (key: keyof ShareAudioToneLevels) =>
    median(frames.map((frame) => frame[key]));
  if (frames.length === 0) {
    return {
      floor: Number.NEGATIVE_INFINITY,
      call440: Number.NEGATIVE_INFINITY,
      game880: Number.NEGATIVE_INFINITY,
      hiss1320: Number.NEGATIVE_INFINITY,
      snr440: 0,
      snr880: 0,
      snr1320: 0,
    };
  }
  return {
    floor: pick("floor"),
    call440: pick("call440"),
    game880: pick("game880"),
    hiss1320: pick("hiss1320"),
    snr440: pick("snr440"),
    snr880: pick("snr880"),
    snr1320: pick("snr1320"),
  };
}

export function judgeShareAudioRow(
  levels: ShareAudioToneLevels,
  labels: ShareAudioTrackLabels = {},
): { verdict: ShareAudioProbeVerdict; note: string } {
  if (labels.hasTrack === false) {
    return {
      verdict: "NO_TRACK",
      note: "no share-audio track (fail-closed or silent share)",
    };
  }
  if (labels.control) {
    if (levels.snr440 >= LEAK_SNR_DB) {
      return {
        verdict: "CONTROL_OK",
        note: "control: 440 is in the track, probe is not deaf",
      };
    }
    return {
      verdict: "CONTROL_DEAF",
      note: "control: 440 missing. Speakers muted, or this OS never mixes document audio into the tap. Later PASS is meaningless.",
    };
  }
  if (levels.snr440 >= LEAK_SNR_DB) {
    return {
      verdict: "FAIL_LEAK",
      note: "call is in the published share-audio track",
    };
  }
  if (levels.snr880 < GAME_PRESENT_SNR_DB) {
    return {
      verdict: "FAIL_NO_GAME",
      note: "game tone missing. 880 document not playing, or windowAudio did not isolate it.",
    };
  }
  if (levels.snr440 <= CALL_STRIPPED_SNR_DB) {
    return {
      verdict: "PASS",
      note: "game present, call at floor",
    };
  }
  return {
    verdict: "FAIL_NO_GAME",
    note: "440 between strip and leak gates; treat as unheard, not a pass",
  };
}

export function formatShareAudioRow(row: ShareAudioProbeRow): string {
  const n = (value: number) =>
    Number.isFinite(value) ? value.toFixed(1) : "n/a";
  return [
    `os=${row.os}  build=${row.build}  client=${row.client}  surface=${row.surface}`,
    `restrictOwnAudio settings=${row.restrictOwnAudio}  caps=${row.caps}`,
    `floor=${n(row.floor)}  call440=${n(row.call440)}  game880=${n(row.game880)}  hiss1320=${n(row.hiss1320)}`,
    `snr440=${n(row.snr440)}  snr880=${n(row.snr880)}`,
    `${row.verdict}  ${row.note}`,
  ].join("\n");
}

export function sineFrame(
  frequency: number,
  sampleRate = 48_000,
  length = 2048,
  amplitude = 0.5,
): Float32Array {
  const samples = new Float32Array(length);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < length; i += 1) {
    samples[i] = amplitude * Math.sin(omega * i);
  }
  return samples;
}

export async function collectTimeDomainFrames(
  track: MediaStreamTrack,
  opts: { frameCount?: number; frameMs?: number } = {},
): Promise<{ sampleRate: number; frames: Float32Array[] }> {
  const frameCount = opts.frameCount ?? 50;
  const frameMs = opts.frameMs ?? 100;
  const context = new AudioContext();
  const sampleRate = context.sampleRate || 48_000;
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const frames: Float32Array[] = [];
  try {
    for (let i = 0; i < frameCount; i += 1) {
      await sleep(frameMs);
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      frames.push(samples);
    }
  } finally {
    source.disconnect();
    await context.close();
  }
  return { sampleRate, frames };
}

export async function measureShareAudioTrack(
  track: MediaStreamTrack | null | undefined,
  labels: ShareAudioTrackLabels = {},
): Promise<ShareAudioProbeRow> {
  const hasTrack = Boolean(track) && labels.hasTrack !== false;
  if (!track || !hasTrack) {
    const empty = summariseToneFrames([]);
    const judged = judgeShareAudioRow(empty, { ...labels, hasTrack: false });
    return rowFrom(empty, labels, judged);
  }
  const { sampleRate, frames } = await collectTimeDomainFrames(track);
  const levels = summariseToneFrames(
    frames.map((frame) => analyseToneFrame(frame, sampleRate)),
  );
  const judged = judgeShareAudioRow(levels, { ...labels, hasTrack: true });
  return rowFrom(levels, labels, judged);
}

function rowFrom(
  levels: ShareAudioToneLevels,
  labels: ShareAudioTrackLabels,
  judged: { verdict: ShareAudioProbeVerdict; note: string },
): ShareAudioProbeRow {
  return {
    ...levels,
    os: labels.os ?? "unknown",
    build: labels.build ?? "unknown",
    client: labels.client ?? "unknown",
    surface: labels.surface ?? "unknown",
    restrictOwnAudio: stringifyLabel(labels.restrictOwnAudio),
    caps: Array.isArray(labels.caps)
      ? `[${labels.caps.join(",")}]`
      : stringifyLabel(
          typeof labels.caps === "string" ? labels.caps : undefined,
        ),
    verdict: judged.verdict,
    note: judged.note,
  };
}

function stringifyLabel(value: string | boolean | undefined): string {
  if (value === undefined) {
    return "undefined";
  }
  return String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let lastShareAudio: MediaStreamTrack | null = null;

export function rememberShareAudioTrack(
  track: MediaStreamTrack | null | undefined,
): void {
  lastShareAudio = track ?? null;
}

export interface ShareAudioProbeConsole {
  playCallTone: () => string;
  stopCallTone: () => string;
  measure: (
    track?: MediaStreamTrack | null,
    labels?: ShareAudioTrackLabels,
  ) => Promise<ShareAudioProbeRow>;
  controlCapture: () => Promise<ShareAudioProbeRow>;
  help: () => string;
}

let callTone: { context: AudioContext; stop: () => void } | null = null;

function playCallTone(): string {
  stopCallTone();
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = CALL_TONE_HZ;
  gain.gain.value = 0.2;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  callTone = {
    context,
    stop: () => {
      oscillator.stop();
      oscillator.disconnect();
      gain.disconnect();
    },
  };
  return `playing ${CALL_TONE_HZ} Hz from this document — leave speakers up. Open /share-audio-tone.html for 880 Hz.`;
}

function stopCallTone(): string {
  if (!callTone) {
    return "call tone already stopped";
  }
  callTone.stop();
  void callTone.context.close();
  callTone = null;
  return "call tone stopped";
}

async function controlCapture(): Promise<ShareAudioProbeRow> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("getDisplayMedia is missing");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    // The control must NOT send restrictOwnAudio. That is the whole point.
    systemAudio: "include",
  } as DisplayMediaStreamOptions);
  try {
    const audio = stream.getAudioTracks()[0];
    const video = stream.getVideoTracks()[0];
    let restrictOwnAudio: boolean | undefined;
    let caps: boolean[] | undefined;
    let surface = "unknown";
    try {
      const settings = audio?.getSettings() as
        | { restrictOwnAudio?: boolean }
        | undefined;
      if (settings && "restrictOwnAudio" in settings) {
        restrictOwnAudio = settings.restrictOwnAudio;
      }
    } catch {
      // Older engines omit getSettings.
    }
    try {
      const capabilities = audio?.getCapabilities?.() as
        | { restrictOwnAudio?: boolean[] }
        | undefined;
      if (Array.isArray(capabilities?.restrictOwnAudio)) {
        caps = capabilities.restrictOwnAudio;
      }
    } catch {
      // Same.
    }
    try {
      surface = (video?.getSettings().displaySurface as string) ?? "unknown";
    } catch {
      // Same.
    }
    return await measureShareAudioTrack(audio, {
      control: true,
      hasTrack: Boolean(audio),
      surface,
      restrictOwnAudio,
      caps,
      client: "control-no-restrictOwnAudio",
    });
  } finally {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

const HELP = [
  "pqpShareAudioProbe — is the call in the share-audio track?",
  "1. Speakers UP (mute fakes a pass).",
  "2. pqpShareAudioProbe.playCallTone()  // 440 Hz from this document",
  "3. Open /share-audio-tone.html in another window  // 880 Hz",
  "4. Share the whole screen or the 880 window, with computer sound.",
  "5. await pqpShareAudioProbe.measure(audioTrack, { surface, restrictOwnAudio, caps })",
  "Control row first: await pqpShareAudioProbe.controlCapture()",
  "  440 must show, or later PASS is the probe being deaf.",
].join("\n");

const api: ShareAudioProbeConsole = {
  playCallTone,
  stopCallTone,
  async measure(track, labels) {
    const row = await measureShareAudioTrack(
      track ?? lastShareAudio,
      labels,
    );
    // eslint-disable-next-line no-console
    console.log(formatShareAudioRow(row));
    return row;
  },
  async controlCapture() {
    const row = await controlCapture();
    // eslint-disable-next-line no-console
    console.log(formatShareAudioRow(row));
    return row;
  },
  help: () => HELP,
};

export function installShareAudioProbe(): void {
  if (typeof window === "undefined" || window.pqpShareAudioProbe) {
    return;
  }
  window.pqpShareAudioProbe = api;
}
