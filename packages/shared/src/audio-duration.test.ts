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

function oggPage(payload: Uint8Array, granule: number): Uint8Array {
  const header = new Uint8Array(27 + 1);
  header.set([0x4f, 0x67, 0x67, 0x53, 0, 0], 0);
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
