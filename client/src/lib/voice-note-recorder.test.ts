import { VOICE_NOTE_WAVEFORM_PEAKS, voiceNoteWaveformSchema } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  bareContentType,
  decodeWaveform,
  encodeWaveform,
  framePeak,
  normalisePeaks,
  patchWebmDuration,
  pickVoiceNoteFormat,
  readWebmDurationMs,
  resamplePeaks,
  voiceNoteErrorFromMedia,
} from "./voice-note-recorder";

describe("pickVoiceNoteFormat", () => {
  it("prefers AAC in MP4 when the recorder can make it (Safari, recent Chrome)", () => {
    const format = pickVoiceNoteFormat(() => true);
    expect(format).toEqual({
      recorderMimeType: "audio/mp4;codecs=mp4a.40.2",
      contentType: "audio/mp4",
      extension: "m4a",
    });
  });

  it("falls back to Opus in WebM (Firefox, older Chrome, Electron)", () => {
    const format = pickVoiceNoteFormat((type) => type.startsWith("audio/webm"));
    expect(format?.recorderMimeType).toBe("audio/webm;codecs=opus");
    expect(format?.contentType).toBe("audio/webm");
  });

  it("takes Ogg only when nothing else is offered", () => {
    expect(pickVoiceNoteFormat((type) => type.startsWith("audio/ogg"))?.contentType).toBe(
      "audio/ogg",
    );
  });

  it("returns null with no recorder, or one that records none of them", () => {
    expect(pickVoiceNoteFormat(null)).toBeNull();
    expect(pickVoiceNoteFormat(() => false)).toBeNull();
    expect(
      pickVoiceNoteFormat(() => {
        throw new Error("nope");
      }),
    ).toBeNull();
  });

  it("uploads the BARE type, because the claim HEAD compares it exactly", () => {
    for (const probe of [() => true, (type: string) => type.startsWith("audio/webm")]) {
      const format = pickVoiceNoteFormat(probe)!;
      expect(format.contentType).not.toContain(";");
      expect(bareContentType(format.recorderMimeType)).toBe(format.contentType);
    }
    expect(bareContentType("Audio/WebM; codecs=opus")).toBe("audio/webm");
  });
});

describe("waveform", () => {
  it("reduces any number of ticks to exactly 64 bars, loudest tick per slice", () => {
    const ticks = Array.from({ length: 640 }, (_, i) => (i % 10 === 3 ? 0.8 : 0.1));
    const peaks = resamplePeaks(ticks);
    expect(peaks).toHaveLength(VOICE_NOTE_WAVEFORM_PEAKS);
    expect(peaks.every((peak) => peak === 0.8)).toBe(true);
  });

  it("stretches a short recording instead of padding it with silence", () => {
    const peaks = resamplePeaks([0.2, 0.9]);
    expect(peaks).toHaveLength(64);
    expect(peaks.slice(0, 32).every((p) => p === 0.2)).toBe(true);
    expect(peaks.slice(32).every((p) => p === 0.9)).toBe(true);
  });

  it("draws nothing for no ticks, and keeps silence flat when normalising", () => {
    expect(resamplePeaks([])).toEqual(new Array(64).fill(0));
    expect(normalisePeaks([0.001, 0.002])).toEqual([0, 0]);
    expect(normalisePeaks([0.25, 0.5])).toEqual([0.5, 1]);
  });

  it("encodes to the 88 characters the shared schema accepts, and back", () => {
    const peaks = Array.from({ length: 64 }, (_, i) => i / 63);
    const encoded = encodeWaveform(peaks);
    expect(encoded).toHaveLength(88);
    expect(voiceNoteWaveformSchema.safeParse(encoded).success).toBe(true);
    const decoded = decodeWaveform(encoded);
    expect(decoded).toHaveLength(64);
    decoded.forEach((value, i) => expect(Math.abs(value - peaks[i]!)).toBeLessThan(1 / 255));
  });

  it("reads an unreadable waveform as a flat line, never a throw", () => {
    expect(decodeWaveform("%%%")).toEqual(new Array(64).fill(0));
    expect(decodeWaveform(null)).toEqual(new Array(64).fill(0));
  });

  it("takes the loudest absolute sample of a frame", () => {
    expect(framePeak(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
    expect(framePeak(new Float32Array([2, -3]))).toBe(1);
  });
});

// ------------------------------------------------------------- WebM fixture

function vint(value: number, length: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

function element(id: number[], data: number[], sizeLength = 1): number[] {
  return [...id, ...vint(data.length, sizeLength), ...data];
}

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/** What Chrome's MediaRecorder writes: an unknown-size Segment, Info with no
 * Duration, then clusters. */
function chromeLikeWebm({ knownSegmentSize = false } = {}): Uint8Array {
  const header = element(
    [0x1a, 0x45, 0xdf, 0xa3],
    element([0x42, 0x82], [...new TextEncoder().encode("webm")]),
  );
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    [
      ...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), // TimecodeScale 1,000,000
      ...element([0x4d, 0x80], [...new TextEncoder().encode("Chrome")]),
    ],
  );
  const tracks = element([0x16, 0x54, 0xae, 0x6b], [0xae, 0x80]);
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00, 0xa3, 0x82, 0x81, 0x00]);
  const body = [...info, ...tracks, ...cluster];
  const segment = [
    0x18,
    0x53,
    0x80,
    0x67,
    ...(knownSegmentSize ? vint(body.length, 4) : UNKNOWN_SIZE),
    ...body,
  ];
  return new Uint8Array([...header, ...segment]);
}

describe("patchWebmDuration", () => {
  it("writes the Duration Chrome leaves out", () => {
    const input = chromeLikeWebm();
    expect(readWebmDurationMs(input)).toBeNull();
    const patched = patchWebmDuration(input, 12_345);
    expect(readWebmDurationMs(patched)).toBeCloseTo(12_345);
    // Tracks and the cluster after Info (19 bytes) are carried over untouched.
    const tail = input.subarray(input.length - 19);
    expect([...patched.subarray(patched.length - 19)]).toEqual([...tail]);
  });

  it("overwrites a Duration already there instead of writing a second one", () => {
    const once = patchWebmDuration(chromeLikeWebm(), 1000);
    const twice = patchWebmDuration(once, 4200);
    expect(readWebmDurationMs(twice)).toBeCloseTo(4200);
    expect(twice.length).toBe(once.length);
  });

  it("grows a known Segment size by what it added", () => {
    const input = chromeLikeWebm({ knownSegmentSize: true });
    const patched = patchWebmDuration(input, 3000);
    expect(readWebmDurationMs(patched)).toBeCloseTo(3000);
    // Segment size field (4 bytes after the 4-byte ID that follows the header).
    const headerLength = 4 + 1 + 7;
    const sizeAt = headerLength + 4;
    const declared =
      ((patched[sizeAt]! & 0x0f) << 24) |
      (patched[sizeAt + 1]! << 16) |
      (patched[sizeAt + 2]! << 8) |
      patched[sizeAt + 3]!;
    expect(declared).toBe(patched.length - sizeAt - 4);
  });

  it("leaves bytes it does not understand alone", () => {
    const mp4ish = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    expect(patchWebmDuration(mp4ish, 1000)).toBe(mp4ish);
    expect(patchWebmDuration(new Uint8Array(), 1000).length).toBe(0);
    const input = chromeLikeWebm();
    expect(patchWebmDuration(input, 0)).toBe(input);
  });
});

describe("voiceNoteErrorFromMedia", () => {
  it("names a blocked, a missing and a busy microphone apart", () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(voiceNoteErrorFromMedia(named("NotAllowedError")).code).toBe("mic-blocked");
    expect(voiceNoteErrorFromMedia(named("NotFoundError")).code).toBe("mic-missing");
    expect(voiceNoteErrorFromMedia(named("NotReadableError")).code).toBe("mic-busy");
    expect(voiceNoteErrorFromMedia("??").code).toBe("failed");
  });
});
