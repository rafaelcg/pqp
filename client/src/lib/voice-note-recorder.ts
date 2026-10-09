import {
  VOICE_NOTE_MAX_DURATION_MS,
  VOICE_NOTE_MIN_DURATION_MS,
  VOICE_NOTE_WAVEFORM_PEAKS,
  noteByteBudget,
  type AttachmentContentType,
} from "@pqp/shared";
import { buildAudioConstraints, type MicProcessing } from "@/lib/audio-devices";

/**
 * Recording a voice note in the browser: pick a container the server takes,
 * capture the microphone, sample a waveform while it runs, and hand back bytes
 * the claim will verify.
 *
 * Three rules from the voice notes contract (the shared schema) live here:
 *
 * 1. The format is chosen by FEATURE DETECTION, never by user agent: AAC-LC in
 *    MP4 when `MediaRecorder.isTypeSupported` says so (Safari, recent Chrome),
 *    else Opus in WebM (Chrome, Firefox, Electron).
 * 2. The upload carries the BARE content type. The claim HEADs the object and
 *    compares its stored type to the signed one exactly, so `audio/webm;
 *    codecs=opus` would never verify.
 * 3. Chrome's WebM has no Duration in its header, so a player shows `Infinity`
 *    and cannot seek. `patchWebmDuration` writes it before the upload.
 */

// ------------------------------------------------------------------ format

export interface VoiceNoteFormat {
  /** What `MediaRecorder` is asked for, codecs and all. */
  recorderMimeType: string;
  /** What the mint and the PUT carry. Always bare. */
  contentType: AttachmentContentType;
  extension: "m4a" | "webm" | "ogg";
}

/**
 * In order of preference. MP4/AAC first because it is the one container every
 * client plays, iOS included, without a second decoder; Opus in WebM is the
 * fallback Chrome and Firefox have always had. Ogg is last: only an old
 * Firefox records it and nothing else needs it.
 */
const CANDIDATES: readonly VoiceNoteFormat[] = [
  {
    recorderMimeType: "audio/mp4;codecs=mp4a.40.2",
    contentType: "audio/mp4",
    extension: "m4a",
  },
  {
    recorderMimeType: "audio/webm;codecs=opus",
    contentType: "audio/webm",
    extension: "webm",
  },
  {
    recorderMimeType: "audio/ogg;codecs=opus",
    contentType: "audio/ogg",
    extension: "ogg",
  },
];

/**
 * The first container this browser can record, or null when it can record
 * none of them (no `MediaRecorder`, or one that only does video). Null hides
 * the mic: offering a button that can only fail is worse than not offering it.
 */
export function pickVoiceNoteFormat(
  isTypeSupported: ((type: string) => boolean) | null | undefined = defaultIsTypeSupported(),
): VoiceNoteFormat | null {
  if (!isTypeSupported) {
    return null;
  }
  for (const candidate of CANDIDATES) {
    try {
      if (isTypeSupported(candidate.recorderMimeType)) {
        return candidate;
      }
    } catch {
      // A throwing probe is a browser saying no.
    }
  }
  return null;
}

function defaultIsTypeSupported(): ((type: string) => boolean) | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }
  return (type) => MediaRecorder.isTypeSupported(type);
}

/** `audio/webm;codecs=opus` → `audio/webm`. Lower case, no parameters. */
export function bareContentType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** Whether recording can work here at all: a recorder, a format, a mic API. */
export function canRecordVoiceNotes(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    pickVoiceNoteFormat() !== null
  );
}

// ----------------------------------------------------------------- waveform

/**
 * Reduce a run of per-tick peaks (0..1, one per sampling tick, as long as the
 * recording) to exactly `count` bars. Each bar is the loudest tick in its
 * slice, because a mean flattens speech into a ribbon and the point of the
 * waveform is to show where the words are. A recording shorter than `count`
 * ticks stretches by repetition rather than padding with silence.
 */
export function resamplePeaks(
  ticks: readonly number[],
  count: number = VOICE_NOTE_WAVEFORM_PEAKS,
): number[] {
  if (ticks.length === 0) {
    return new Array<number>(count).fill(0);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * ticks.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * ticks.length) / count));
    let max = 0;
    for (let j = start; j < end && j < ticks.length; j += 1) {
      const value = ticks[j]!;
      if (value > max) {
        max = value;
      }
    }
    out.push(Math.min(1, Math.max(0, max)));
  }
  return out;
}

/**
 * Peaks normalised so the loudest bar is full height. A quiet microphone would
 * otherwise draw a flat line for a perfectly audible note. A floor keeps
 * silence from being blown up into noise.
 */
export function normalisePeaks(peaks: readonly number[]): number[] {
  const max = Math.max(0, ...peaks);
  if (max < 0.02) {
    return peaks.map(() => 0);
  }
  return peaks.map((peak) => Math.min(1, peak / max));
}

/** 64 peaks (0..1) as 64 bytes, base64: the shape `voiceNoteWaveformSchema` wants. */
export function encodeWaveform(peaks: readonly number[]): string {
  const bytes = resamplePeaks(peaks, VOICE_NOTE_WAVEFORM_PEAKS).map((peak) =>
    Math.round(Math.min(1, Math.max(0, peak)) * 255),
  );
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * The stored waveform back to 0..1 bars. Anything unreadable is a flat line of
 * `VOICE_NOTE_WAVEFORM_PEAKS` bars: a card with no waveform still plays.
 */
export function decodeWaveform(base64: string | null | undefined): number[] {
  if (base64) {
    try {
      const binary = atob(base64);
      if (binary.length > 0) {
        return Array.from(binary, (char) => char.charCodeAt(0) / 255);
      }
    } catch {
      // Fall through to the flat line.
    }
  }
  return new Array<number>(VOICE_NOTE_WAVEFORM_PEAKS).fill(0);
}

/** The loudest absolute sample in one analyser frame, 0..1. */
export function framePeak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]!);
    if (value > max) {
      max = value;
    }
  }
  return Math.min(1, max);
}

// ------------------------------------------------------- WebM Duration patch

const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_INFO = 0x1549a966;
const EBML_ID_TIMECODE_SCALE = 0x2ad7b1;
const EBML_ID_DURATION = 0x4489;

interface Vint {
  value: number;
  length: number;
  /** All value bits set: the "unknown size" marker. */
  unknown: boolean;
}

/** An element ID: the VINT with its length marker kept, as IDs are written. */
function readId(bytes: Uint8Array, offset: number): Vint | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) {
    return null;
  }
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 4 || offset + length > bytes.length) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = value * 256 + bytes[offset + i]!;
  }
  return { value, length, unknown: false };
}

/** A data size: the VINT with its length marker stripped. */
function readSize(bytes: Uint8Array, offset: number): Vint | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) {
    return null;
  }
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8 || offset + length > bytes.length) {
    return null;
  }
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    const byte = bytes[offset + i]!;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }
  return { value, length, unknown: allOnes };
}

/** A size as an 8-byte VINT, which holds anything a voice note can be. */
function writeSize8(value: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let rest = value;
  for (let i = 7; i >= 1; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** A size in exactly `length` bytes, or null when it does not fit. */
function writeSizeIn(value: number, length: number): Uint8Array | null {
  if (value >= 2 ** (7 * length) - 1) {
    return null;
  }
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

function readUint(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = value * 256 + bytes[offset + i]!;
  }
  return value;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Write `durationMs` into a WebM's Segment Info as its Duration.
 *
 * Chrome's `MediaRecorder` streams WebM and never goes back to fill the header,
 * so the file has no Duration and every player reports `Infinity` until it has
 * read to the end: no seeking, and a scrub bar that cannot draw. This inserts
 * the element (or overwrites one that is present), rewrites Info's size, and
 * leaves the Segment's size alone when it is the "unknown" marker Chrome
 * writes, which is the only case that matters. A known Segment size is grown
 * in place when it fits its own width.
 *
 * Returns the input untouched whenever the bytes are not the WebM this
 * expects. A note that plays with an unknown length is better than one that
 * does not play.
 */
export function patchWebmDuration(input: Uint8Array, durationMs: number): Uint8Array {
  if (!(durationMs > 0)) {
    return input;
  }
  // EBML header first; the Segment follows it.
  const headerId = readId(input, 0);
  const headerSize = headerId ? readSize(input, headerId.length) : null;
  if (!headerId || !headerSize || headerSize.unknown || headerId.value !== 0x1a45dfa3) {
    return input;
  }
  const segmentAt = headerId.length + headerSize.length + headerSize.value;
  const segmentId = readId(input, segmentAt);
  if (!segmentId || segmentId.value !== EBML_ID_SEGMENT) {
    return input;
  }
  const segmentSizeAt = segmentAt + segmentId.length;
  const segmentSize = readSize(input, segmentSizeAt);
  if (!segmentSize) {
    return input;
  }
  const segmentDataAt = segmentSizeAt + segmentSize.length;

  // Walk the Segment's children to Info. Chrome writes it right after
  // SeekHead (or first), well inside the first kilobyte.
  let at = segmentDataAt;
  while (at < input.length) {
    const id = readId(input, at);
    const size = id ? readSize(input, at + id.length) : null;
    if (!id || !size || size.unknown) {
      return input;
    }
    const dataAt = at + id.length + size.length;
    const end = dataAt + size.value;
    if (end > input.length) {
      return input;
    }
    if (id.value === EBML_ID_INFO) {
      return rewriteInfo(input, {
        infoAt: at,
        infoDataAt: dataAt,
        infoEnd: end,
        segmentSizeAt,
        segmentSize,
        durationMs,
      });
    }
    // Clusters come after Info; reaching one means there is no Info at all.
    if (id.value === 0x1f43b675) {
      return input;
    }
    at = end;
  }
  return input;
}

function rewriteInfo(
  input: Uint8Array,
  where: {
    infoAt: number;
    infoDataAt: number;
    infoEnd: number;
    segmentSizeAt: number;
    segmentSize: Vint;
    durationMs: number;
  },
): Uint8Array {
  // Info's children, without any Duration already there; note the scale.
  let timecodeScale = 1_000_000;
  const kept: Uint8Array[] = [];
  let at = where.infoDataAt;
  while (at < where.infoEnd) {
    const id = readId(input, at);
    const size = id ? readSize(input, at + id.length) : null;
    if (!id || !size || size.unknown) {
      return input;
    }
    const dataAt = at + id.length + size.length;
    const end = dataAt + size.value;
    if (end > where.infoEnd) {
      return input;
    }
    if (id.value === EBML_ID_TIMECODE_SCALE && size.value > 0 && size.value <= 6) {
      timecodeScale = readUint(input, dataAt, size.value) || timecodeScale;
    }
    if (id.value !== EBML_ID_DURATION) {
      kept.push(input.subarray(at, end));
    }
    at = end;
  }

  // Duration is a float in TimecodeScale units (nanoseconds per tick).
  const duration = new Uint8Array(11);
  duration[0] = 0x44;
  duration[1] = 0x89;
  duration[2] = 0x88; // size 8
  new DataView(duration.buffer).setFloat64(3, (where.durationMs * 1_000_000) / timecodeScale);

  const infoData = concat([...kept, duration]);
  const infoId = input.subarray(where.infoAt, where.infoAt + 4);
  const newInfo = concat([infoId, writeSize8(infoData.length), infoData]);
  const delta = newInfo.length - (where.infoEnd - where.infoAt);

  let segmentSizeBytes = input.subarray(
    where.segmentSizeAt,
    where.segmentSizeAt + where.segmentSize.length,
  );
  if (!where.segmentSize.unknown) {
    const grown = writeSizeIn(where.segmentSize.value + delta, where.segmentSize.length);
    if (!grown) {
      return input;
    }
    segmentSizeBytes = grown;
  }

  return concat([
    input.subarray(0, where.segmentSizeAt),
    segmentSizeBytes,
    input.subarray(where.segmentSizeAt + where.segmentSize.length, where.infoAt),
    newInfo,
    input.subarray(where.infoEnd),
  ]);
}

/** The Duration a WebM declares, in ms, or null. For tests and diagnostics. */
export function readWebmDurationMs(input: Uint8Array): number | null {
  const headerId = readId(input, 0);
  const headerSize = headerId ? readSize(input, headerId.length) : null;
  if (!headerId || !headerSize) {
    return null;
  }
  const segmentAt = headerId.length + headerSize.length + headerSize.value;
  const segmentId = readId(input, segmentAt);
  const segmentSize = segmentId ? readSize(input, segmentAt + segmentId.length) : null;
  if (!segmentId || !segmentSize) {
    return null;
  }
  let at = segmentAt + segmentId.length + segmentSize.length;
  while (at < input.length) {
    const id = readId(input, at);
    const size = id ? readSize(input, at + id.length) : null;
    if (!id || !size || size.unknown) {
      return null;
    }
    const dataAt = at + id.length + size.length;
    if (id.value === EBML_ID_INFO) {
      let scale = 1_000_000;
      let raw: number | null = null;
      let child = dataAt;
      while (child < dataAt + size.value) {
        const cid = readId(input, child);
        const csize = cid ? readSize(input, child + cid.length) : null;
        if (!cid || !csize) {
          return null;
        }
        const cdata = child + cid.length + csize.length;
        if (cid.value === EBML_ID_TIMECODE_SCALE) {
          scale = readUint(input, cdata, csize.value);
        }
        if (cid.value === EBML_ID_DURATION) {
          const view = new DataView(input.buffer, input.byteOffset + cdata, csize.value);
          raw = csize.value === 4 ? view.getFloat32(0) : view.getFloat64(0);
        }
        child = cdata + csize.value;
      }
      return raw === null ? null : (raw * scale) / 1_000_000;
    }
    at = dataAt + size.value;
  }
  return null;
}

// ----------------------------------------------------------------- recorder

export type VoiceNoteErrorCode =
  | "mic-blocked"
  | "mic-missing"
  | "mic-busy"
  | "unsupported"
  | "too-short"
  | "too-large"
  | "failed";

export class VoiceNoteError extends Error {
  constructor(readonly code: VoiceNoteErrorCode, cause?: unknown) {
    super(code);
    this.name = "VoiceNoteError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** A `getUserMedia` rejection as one of the codes the UI has a sentence for. */
export function voiceNoteErrorFromMedia(error: unknown): VoiceNoteError {
  if (error instanceof VoiceNoteError) {
    return error;
  }
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new VoiceNoteError("mic-blocked", error);
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new VoiceNoteError("mic-missing", error);
  }
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
    return new VoiceNoteError("mic-busy", error);
  }
  return new VoiceNoteError("failed", error);
}

export interface RecordedVoiceNote {
  blob: Blob;
  contentType: AttachmentContentType;
  filename: string;
  durationMs: number;
  /** 64 bytes, base64. */
  waveform: string;
  /** The same 64 peaks, 0..1, for the preview to draw without decoding. */
  peaks: number[];
}

export interface VoiceNoteRecorderOptions {
  /** The call's own device and processing, so a second capture does not
   * reconfigure the microphone a live call is using. */
  deviceId?: string;
  processing?: MicProcessing;
  /** Called about 20 times a second with the newest peak, for the live bars. */
  onLevel?: (peak: number) => void;
  /** Called once when the five minute cap stops the recording by itself. */
  onCap?: () => void;
  /** For tests. */
  now?: () => number;
}

const TICK_MS = 50;
/** Opus mono speech is clear at 32 kbps; AAC wants a little more. Both stay
 * far under the 64 kbps the contract allows and the mint's byte budget. */
const BITRATE: Record<VoiceNoteFormat["contentType"], number> = {
  "audio/mp4": 48_000,
  "audio/webm": 32_000,
  "audio/ogg": 32_000,
} as Record<VoiceNoteFormat["contentType"], number>;

async function openMic(options: VoiceNoteRecorderOptions): Promise<MediaStream> {
  const constraints = buildAudioConstraints(options.deviceId || undefined, options.processing);
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  } catch (error) {
    // A chosen device that went away: the default is a fine second choice.
    const name = error instanceof Error ? error.name : "";
    if (options.deviceId && (name === "NotFoundError" || name === "OverconstrainedError")) {
      return navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(undefined, options.processing),
        video: false,
      });
    }
    throw error;
  }
}

/**
 * One recording, start to finish. Not reusable: make a new one per note.
 *
 * The microphone is opened with its OWN `getUserMedia` and closed when the
 * note ends. That is what keeps a live call alone: stopping these tracks never
 * touches the call's, and asking for the same device with the same processing
 * means the browser has nothing to reconfigure under it.
 */
function createAudioContext(): AudioContext | null {
  try {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) {
      return null;
    }
    const context = new Context();
    void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

export class VoiceNoteRecorder {
  readonly format: VoiceNoteFormat;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private ticks: number[] = [];
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private finished = false;
  private readonly now: () => number;

  constructor(private readonly options: VoiceNoteRecorderOptions = {}) {
    const format = pickVoiceNoteFormat();
    if (!format) {
      throw new VoiceNoteError("unsupported");
    }
    this.format = format;
    this.now = options.now ?? (() => performance.now());
  }

  /** Opens the mic and starts recording. Rejects with a `VoiceNoteError`. */
  async start(): Promise<void> {
    // The audio context is made BEFORE the permission prompt, while the click
    // that started this is still a user gesture. Made after the await, a
    // browser that has not seen another gesture keeps it suspended and the
    // waveform records nothing but silence.
    this.context = createAudioContext();
    let stream: MediaStream;
    try {
      stream = await openMic(this.options);
    } catch (error) {
      this.release();
      throw voiceNoteErrorFromMedia(error);
    }
    if (this.finished) {
      // Cancelled while the permission prompt was up.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    try {
      this.recorder = new MediaRecorder(stream, {
        mimeType: this.format.recorderMimeType,
        audioBitsPerSecond: BITRATE[this.format.contentType] ?? 32_000,
      });
    } catch (error) {
      this.release();
      throw new VoiceNoteError("unsupported", error);
    }
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    this.startAnalyser(stream);
    this.recorder.start(1000);
    this.startedAt = this.now();
  }

  private startAnalyser(stream: MediaStream) {
    try {
      this.context ??= createAudioContext();
      if (!this.context) {
        throw new Error("no audio context");
      }
      const source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);
      this.samples = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      void this.context.resume().catch(() => {});
    } catch {
      // No waveform is a flat line, not a failed note.
      this.analyser = null;
    }
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    if (this.pausedAt !== null || this.finished) {
      return;
    }
    let peak = 0;
    if (this.analyser && this.samples) {
      this.analyser.getFloatTimeDomainData(this.samples);
      peak = framePeak(this.samples);
    }
    this.ticks.push(peak);
    this.options.onLevel?.(peak);
    if (this.elapsedMs() >= VOICE_NOTE_MAX_DURATION_MS) {
      this.pause();
      this.options.onCap?.();
    }
  }

  /** Recorded time so far, paused stretches excluded. */
  elapsedMs(): number {
    if (!this.startedAt) {
      return 0;
    }
    const until = this.pausedAt ?? this.now();
    return Math.min(VOICE_NOTE_MAX_DURATION_MS, Math.max(0, until - this.startedAt - this.pausedTotal));
  }

  get isPaused(): boolean {
    return this.pausedAt !== null;
  }

  /** The peaks so far, 0..1, newest last. The live bars read the tail. */
  livePeaks(): readonly number[] {
    return this.ticks;
  }

  pause(): void {
    if (this.pausedAt !== null || !this.recorder || this.recorder.state !== "recording") {
      return;
    }
    this.recorder.pause();
    this.pausedAt = this.now();
  }

  resume(): void {
    if (this.pausedAt === null || !this.recorder || this.recorder.state !== "paused") {
      return;
    }
    if (this.elapsedMs() >= VOICE_NOTE_MAX_DURATION_MS) {
      return;
    }
    this.pausedTotal += this.now() - this.pausedAt;
    this.pausedAt = null;
    this.recorder.resume();
  }

  /** Throws the note away and closes the mic. Safe to call more than once. */
  cancel(): void {
    this.finished = true;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.ondataavailable = null;
      try {
        this.recorder.stop();
      } catch {
        // Already stopping.
      }
    }
    this.release();
  }

  /**
   * Stops, closes the mic, and returns the finished note: bytes with the
   * WebM duration patched in, the duration the card shows, and the waveform.
   */
  async stop(): Promise<RecordedVoiceNote> {
    const recorder = this.recorder;
    if (!recorder || this.finished) {
      throw new VoiceNoteError("failed");
    }
    const durationMs = Math.round(this.elapsedMs());
    this.finished = true;
    await new Promise<void>((resolve) => {
      if (recorder.state === "inactive") {
        resolve();
        return;
      }
      recorder.addEventListener("stop", () => resolve(), { once: true });
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
    this.release();

    if (durationMs < VOICE_NOTE_MIN_DURATION_MS) {
      throw new VoiceNoteError("too-short");
    }
    let blob = new Blob(this.chunks, { type: this.format.contentType });
    if (this.format.contentType === "audio/webm") {
      const patched = patchWebmDuration(new Uint8Array(await blob.arrayBuffer()), durationMs);
      blob = new Blob([patched as Uint8Array<ArrayBuffer>], { type: this.format.contentType });
    }
    if (blob.size === 0) {
      throw new VoiceNoteError("failed");
    }
    if (blob.size > noteByteBudget(durationMs)) {
      throw new VoiceNoteError("too-large");
    }
    const peaks = normalisePeaks(resamplePeaks(this.ticks));
    return {
      blob,
      contentType: this.format.contentType,
      filename: `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.${this.format.extension}`,
      durationMs,
      waveform: encodeWaveform(peaks),
      peaks,
    };
  }

  private release() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
    this.analyser = null;
  }
}
