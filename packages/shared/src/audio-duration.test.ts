import { describe, expect, it } from "vitest";
import { audioDurationMs, soundboardClipRejection } from "./audio-duration.js";
import {
  SOUNDBOARD_MAX_BYTES,
  SOUNDBOARD_MAX_DURATION_MS,
} from "./soundboard.js";

function mp3Frame(bitrate = 128000, sampleRate = 44100): Uint8Array {
  const frameBytes = Math.floor((144 * bitrate) / sampleRate);
  const frame = new Uint8Array(frameBytes);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return frame;
}

function mp3Seconds(seconds: number): Uint8Array {
  const frame = mp3Frame();
  const frameMs = (1152 / 44100) * 1000;
  const count = Math.round((seconds * 1000) / frameMs);
  const out = new Uint8Array(frame.length * count);
  for (let i = 0; i < count; i += 1) {
    out.set(frame, i * frame.length);
  }
  return out;
}

function oggPage(payload: Uint8Array, granule: number, bos = false): Uint8Array {
  const header = new Uint8Array(27 + 1);
  header.set([0x4f, 0x67, 0x67, 0x53, 0, bos ? 0x02 : 0], 0);
  let left = granule;
  for (let i = 0; i < 8; i += 1) {
    header[6 + i] = left & 0xff;
    left = Math.floor(left / 256);
  }
  header[26] = 1;
  header[27] = payload.length;
  const page = new Uint8Array(header.length + payload.length);
  page.set(header, 0);
  page.set(payload, header.length);
  return page;
}

describe("audioDurationMs", () => {
  it("times an mpeg file from its frames", () => {
    const bytes = mp3Seconds(1);
    const ms = audioDurationMs(bytes, "audio/mpeg");
    expect(ms).toBeGreaterThan(900);
    expect(ms).toBeLessThan(1100);
  });

  it.each([
    { name: "MPEG-2", version: 0xf3, rate: 22050, rateBits: 0x00 },
    { name: "MPEG-2.5", version: 0xe3, rate: 11025, rateBits: 0x00 },
  ])("times a $name layer III file at its lower sample rate", ({ version, rate, rateBits }) => {
    // 64 kbps (index 8 in the MPEG-2 table), 576 samples per frame.
    const bitrate = 64000;
    const frameBytes = Math.floor((72 * bitrate) / rate);
    const frame = new Uint8Array(frameBytes);
    frame[0] = 0xff;
    frame[1] = version;
    frame[2] = 0x80 | rateBits;
    const count = Math.round((1000 * rate) / 576 / 1000);
    const bytes = new Uint8Array(frameBytes * count);
    for (let i = 0; i < count; i += 1) {
      bytes.set(frame, i * frameBytes);
    }
    const ms = audioDurationMs(bytes, "audio/mpeg");
    expect(ms).toBeGreaterThan(950);
    expect(ms).toBeLessThan(1050);
  });

  it("times an opus ogg from the last granule", () => {
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1], 0);
    head[10] = 0x70;
    head[11] = 0x01;
    const preSkip = 0x0170;
    const granule = preSkip + 48000;
    const bytes = concat(oggPage(head, 0), oggPage(new Uint8Array([0]), granule));
    expect(audioDurationMs(bytes, "audio/ogg")).toBe(1000);
  });

  it("adds up the links of a chained ogg", () => {
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1], 0);
    head[10] = 0x70;
    head[11] = 0x01;
    const granule = 0x0170 + 48000 * 3;
    const link = (): Uint8Array =>
      concat(oggPage(head, 0, true), oggPage(new Uint8Array([0]), granule));
    // Two 3 second links are a 6 second clip, past the 5.2 second cap.
    expect(audioDurationMs(concat(link(), link()), "audio/ogg")).toBe(6000);
  });

  it("times a vorbis ogg from the identification header's sample rate", () => {
    const head = new Uint8Array(30);
    head[0] = 0x01;
    head.set([0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 1);
    head[11] = 2;
    head[12] = 0x44;
    head[13] = 0xac;
    const bytes = concat(oggPage(head, 0), oggPage(new Uint8Array([0]), 44100));
    expect(audioDurationMs(bytes, "audio/ogg")).toBe(1000);
  });

  it("refuses a clip past 5.2 seconds and accepts a short one", () => {
    const shortMs = audioDurationMs(mp3Seconds(1), "audio/mp3");
    const longMs = audioDurationMs(mp3Seconds(6), "audio/mpeg");
    expect(
      soundboardClipRejection(
        20_000,
        shortMs,
        SOUNDBOARD_MAX_BYTES,
        SOUNDBOARD_MAX_DURATION_MS,
      ),
    ).toBeNull();
    expect(
      soundboardClipRejection(
        20_000,
        longMs,
        SOUNDBOARD_MAX_BYTES,
        SOUNDBOARD_MAX_DURATION_MS,
      ),
    ).toBe("too_long");
    expect(
      soundboardClipRejection(
        SOUNDBOARD_MAX_BYTES + 1,
        shortMs,
        SOUNDBOARD_MAX_BYTES,
        SOUNDBOARD_MAX_DURATION_MS,
      ),
    ).toBe("too_big");
    expect(
      soundboardClipRejection(
        20,
        null,
        SOUNDBOARD_MAX_BYTES,
        SOUNDBOARD_MAX_DURATION_MS,
      ),
    ).toBe("unreadable");
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe("audioDurationMs refuses files that lie about their length", () => {
  function frameAt(rateIndex: number, rate: number): Uint8Array {
    const frame = new Uint8Array(Math.floor((144 * 128000) / rate));
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = 0x90 | (rateIndex << 2);
    return frame;
  }

  function chain(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  function repeat(frame: Uint8Array, count: number): Uint8Array {
    return chain(...Array.from({ length: count }, () => frame));
  }

  it("times every frame at its own rate when the rate changes mid-file", () => {
    // ~0.5 s at 44.1 kHz, then ~10 s at 32 kHz. The old walk stopped at the
    // change and stored half a second.
    const bytes = chain(repeat(frameAt(0, 44100), 19), repeat(frameAt(2, 32000), 278));
    const ms = audioDurationMs(bytes, "audio/mpeg")!;
    expect(ms).toBeGreaterThan(10_000);
    expect(soundboardClipRejection(bytes.length, ms, 10 * 1024 * 1024, 5200)).toBe("too_long");
  });

  it("refuses a WAV labelled mp3", () => {
    const wav = new Uint8Array(4096);
    wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    // A stray sync-looking word in the samples must not count as a frame.
    wav.set([0xff, 0xfb, 0x90, 0x00], 3000);
    expect(audioDurationMs(wav, "audio/mpeg")).toBeNull();
  });

  it("refuses bytes with sync words that do not chain", () => {
    const junk = new Uint8Array(8192);
    for (let i = 0; i < junk.length; i += 997) {
      junk.set([0xff, 0xfb, 0x90, 0x00], i);
    }
    expect(audioDurationMs(junk, "audio/mpeg")).toBeNull();
  });

  it("refuses a second file glued after the frames", () => {
    const bytes = chain(mp3Seconds(1), new Uint8Array(4096).fill(0x41));
    expect(audioDurationMs(bytes, "audio/mpeg")).toBeNull();
  });

  it("accepts zero padding and an ID3v1 tag after the frames", () => {
    const tag = new Uint8Array(128);
    tag.set([0x54, 0x41, 0x47], 0); // "TAG"
    for (const tail of [new Uint8Array(50_000), tag]) {
      const ms = audioDurationMs(chain(mp3Seconds(1), tail), "audio/mpeg")!;
      expect(ms).toBeGreaterThan(900);
      expect(ms).toBeLessThan(1100);
    }
  });

  it("does not count the Xing frame and drops the LAME tag's delay and padding", () => {
    const xing = frameAt(0, 44100);
    const at = 4 + 32; // MPEG-1 stereo side info
    xing.set([0x49, 0x6e, 0x66, 0x6f], at); // "Info"
    // Delay 576, padding 1000: 12 bits each at 141 bytes in.
    const delay = 576;
    const padding = 1000;
    xing[at + 141] = delay >> 4;
    xing[at + 142] = ((delay & 0x0f) << 4) | (padding >> 8);
    xing[at + 143] = padding & 0xff;
    const audioFrames = 100;
    const bytes = chain(xing, repeat(frameAt(0, 44100), audioFrames));
    const expected = Math.round(((audioFrames * 1152 - delay - padding) * 1000) / 44100);
    expect(audioDurationMs(bytes, "audio/mpeg")).toBe(expected);
  });

  it("lets a clip measured a hair over the cap through, and no further", () => {
    expect(soundboardClipRejection(1000, SOUNDBOARD_MAX_DURATION_MS + 1, SOUNDBOARD_MAX_BYTES, SOUNDBOARD_MAX_DURATION_MS)).toBeNull();
    expect(soundboardClipRejection(1000, SOUNDBOARD_MAX_DURATION_MS + 200, SOUNDBOARD_MAX_BYTES, SOUNDBOARD_MAX_DURATION_MS)).toBe("too_long");
  });
});
