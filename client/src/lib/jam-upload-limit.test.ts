import { JAM_AUDIO_MAX_BYTES, JAM_ERRORS } from "@pqp/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { JamStemUpload } from "@/lib/jam/upload";
import { jamErrorKind } from "./jam-api";
import { prepareStemWithinLimit, type StemSource } from "./jam-upload";

/**
 * A take near the ten-minute ceiling can exceed the 32 MiB audio limit (the FLAC
 * runs 2.5 to 5 MB a minute). The server answers 413 `jam_upload_too_large` when
 * the ticket is asked for, and nothing on the client handled it: no clear
 * message, and a trim could not have helped, because a trim hides audio at play
 * time and the uploaded file stayed whole. The fake encoder here makes one byte
 * per sample so the sizes are exact.
 */

const SAMPLE_RATE = 1000; // 1 sample per ms: head and tail counts equal their ms
const LIMIT = 10_000;

function source(over: Partial<StemSource> = {}): StemSource {
  return {
    samples: new Float32Array(12_000),
    sampleRate: SAMPLE_RATE,
    offsetMs: -2000,
    trimStartMs: 0,
    trimEndMs: 0,
    video: null,
    ...over,
  };
}

function prepared(): { prepare: (take: StemSource, options?: { gain?: number }) => Promise<JamStemUpload>; calls: StemSource[] } {
  const calls: StemSource[] = [];
  return {
    calls,
    prepare: async (take, options = {}) => {
      calls.push(take);
      return {
        audio: new Blob([new Uint8Array(take.samples.length)], { type: "audio/flac" }),
        video: take.video?.blob ?? null,
        offsetMs: take.offsetMs,
        trimStartMs: take.trimStartMs,
        trimEndMs: take.trimEndMs,
        durationMs: (take.samples.length / take.sampleRate) * 1000,
        sampleRate: take.sampleRate,
        gain: options.gain ?? 1,
        peaks: [],
      };
    },
  };
}

describe("a take that is too large to send", () => {
  it("is sent as it is when it fits, and encoded once", async () => {
    const fake = prepared();
    const out = await prepareStemWithinLimit(source({ samples: new Float32Array(9000) }), {}, { prepare: fake.prepare, limitBytes: LIMIT });
    expect(out.audio.size).toBe(9000);
    expect(fake.calls).toHaveLength(1);
  });

  it("says 413 jam_upload_too_large, with no request, when it does not fit and nothing is hidden to cut", async () => {
    const fake = prepared();
    const failure = await prepareStemWithinLimit(source(), {}, { prepare: fake.prepare, limitBytes: LIMIT }).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(413);
    expect(failure.message).toBe(JAM_ERRORS.uploadTooLarge);
    // read by the studio exactly like the server's own answer: a message, the take kept
    expect(jamErrorKind(failure)).toBe("tooLarge");
  });

  it("is cut down to what is heard when the person trimmed it, and plays at the same song time", async () => {
    const fake = prepared();
    const out = await prepareStemWithinLimit(
      source({ trimStartMs: 1500, trimEndMs: 700 }),
      { gain: 0.8 },
      { prepare: fake.prepare, limitBytes: LIMIT },
    );
    // 12 000 samples, 1 500 off the head and 700 off the tail
    expect(out.audio.size).toBe(9800);
    const cut = fake.calls[1]!;
    expect(cut.samples.length).toBe(9800);
    // the file's first sample moved by exactly the head that went, and no trim is left to apply twice
    expect(cut.offsetMs).toBe(-2000 + 1500);
    expect(cut.trimStartMs).toBe(0);
    expect(cut.trimEndMs).toBe(0);
    expect(out.gain).toBe(0.8);
  });

  it("keeps the real samples of the heard part, not a re-recording", async () => {
    const samples = Float32Array.from({ length: 12_000 }, (_, index) => index);
    const fake = prepared();
    await prepareStemWithinLimit(source({ samples, trimStartMs: 1500, trimEndMs: 700 }), {}, { prepare: fake.prepare, limitBytes: LIMIT });
    const cut = fake.calls[1]!.samples;
    expect(cut[0]).toBe(1500);
    expect(cut[cut.length - 1]).toBe(12_000 - 700 - 1);
  });

  it("still says 413 when the trim is not enough", async () => {
    const fake = prepared();
    const failure = await prepareStemWithinLimit(
      source({ trimStartMs: 500, trimEndMs: 500 }),
      {},
      { prepare: fake.prepare, limitBytes: LIMIT },
    ).catch((error) => error);
    expect(failure.status).toBe(413);
    expect(fake.calls).toHaveLength(2);
  });

  it("never cuts a take that has a picture: the camera file cannot be cut to match", async () => {
    const fake = prepared();
    const video = { blob: new Blob([new Uint8Array(10)]), mimeType: "video/webm", alignment: {} } as unknown as StemSource["video"];
    const failure = await prepareStemWithinLimit(
      source({ trimStartMs: 3000, video }),
      {},
      { prepare: fake.prepare, limitBytes: LIMIT },
    ).catch((error) => error);
    expect(failure.status).toBe(413);
    expect(fake.calls).toHaveLength(1);
  });

  it("uses the server's own ceiling by default", async () => {
    expect(JAM_AUDIO_MAX_BYTES).toBe(32 * 1024 * 1024);
    const spy = vi.fn();
    const fake = prepared();
    await prepareStemWithinLimit(source({ samples: new Float32Array(5) }), {}, { prepare: async (...args) => (spy(), fake.prepare(...args)), limitBytes: JAM_AUDIO_MAX_BYTES });
    expect(spy).toHaveBeenCalledOnce();
  });
});
