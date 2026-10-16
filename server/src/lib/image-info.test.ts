import { describe, expect, it } from "vitest";
import { sniffImage } from "./image-info.js";

/**
 * The share card trusts these numbers to choose a large card or a small one, so
 * each format is built by hand from its published header layout (not from a
 * fixture a decoder produced) and the hostile cases are pinned: a header that
 * lies, is cut short, or never reaches a size must answer null, not throw.
 */

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpeg(width: number, height: number, leading: number[][] = []): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  for (const segment of leading) {
    parts.push(0xff, segment[0]!, (segment.length + 1) >> 8, (segment.length + 1) & 0xff, ...segment.slice(1));
  }
  parts.push(0xff, 0xc2, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  return new Uint8Array(parts);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  // A real file is never under 30 bytes, and the reader refuses one that is.
  const bytes = new Uint8Array(12 + 4 + 4 + Math.max(payload.length, 14));
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  bytes.set([...chunk].map((c) => c.charCodeAt(0)), 12);
  bytes.set(payload, 20);
  return bytes;
}

describe("sniffImage", () => {
  it("reads a PNG's size from IHDR", () => {
    expect(sniffImage(png(1200, 630))).toEqual({ type: "image/png", width: 1200, height: 630 });
  });

  it("reads a GIF's logical screen", () => {
    expect(sniffImage(gif(480, 270))).toEqual({ type: "image/gif", width: 480, height: 270 });
  });

  it("reads a JPEG's frame, walking past other segments first (baseline and progressive)", () => {
    expect(sniffImage(jpeg(1920, 1080))).toEqual({ type: "image/jpeg", width: 1920, height: 1080 });
    // An APP1 (EXIF) segment of 300 bytes ahead of the frame, as a phone writes it.
    const exif = [0xe1, ...new Array<number>(299).fill(0x45)];
    expect(sniffImage(jpeg(4032, 3024, [exif]))).toEqual({
      type: "image/jpeg",
      width: 4032,
      height: 3024,
    });
  });

  it("reads WebP in its three flavours", () => {
    // Lossy: frame tag (3), start code, then 14-bit sizes.
    const lossy = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x06, 0xb0, 0x04]);
    expect(sniffImage(lossy)).toEqual({ type: "image/webp", width: 1600, height: 1200 });

    // Lossless: signature byte, then (width - 1) and (height - 1) in 14 bits each.
    const width = 800;
    const height = 600;
    const bits = (width - 1) | ((height - 1) << 14);
    const lossless = riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
    expect(sniffImage(lossless)).toEqual({ type: "image/webp", width: 800, height: 600 });

    // Extended: flags (4), then canvas size minus one in 24 bits each.
    const extended = riff("VP8X", [0, 0, 0, 0, 0x1f, 0x04, 0, 0x6d, 0x02, 0]);
    expect(sniffImage(extended)).toEqual({ type: "image/webp", width: 1056, height: 622 });
  });

  it("answers null for what it does not read, never a guess", () => {
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<!doctype html><title>x"))).toBeNull();
    expect(sniffImage(new Uint8Array(500).fill(7))).toBeNull();
    // AVIF / HEIC: an ISO box, not one of the four.
    const avif = new Uint8Array(40);
    avif.set([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(sniffImage(avif)).toBeNull();
  });

  it("survives a header that is cut short or lies", () => {
    expect(sniffImage(png(10, 10).subarray(0, 20))).toBeNull();
    expect(sniffImage(gif(10, 10).subarray(0, 8))).toBeNull();
    expect(sniffImage(jpeg(10, 10).subarray(0, 10))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    // A zero or absurd size is a corrupt header, not a picture.
    expect(sniffImage(png(0, 100))).toBeNull();
    expect(sniffImage(png(100, 0))).toBeNull();
    expect(sniffImage(png(70_000, 100))).toBeNull();
    expect(sniffImage(gif(0, 0))).toBeNull();
    // A JPEG whose segment length is nonsense must not loop or read out of bounds.
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0]))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0, 0, 0]))).toBeNull();
    // A thousand fill bytes where markers should be: bounded, and null.
    const fill = new Uint8Array(1000).fill(0xff);
    fill.set([0xff, 0xd8, 0xff], 0);
    expect(sniffImage(fill)).toBeNull();
  });

  it("works on a subarray with a byte offset (a prefix of a bigger buffer)", () => {
    const big = new Uint8Array(100);
    big.set(png(640, 360), 17);
    expect(sniffImage(big.subarray(17))).toEqual({ type: "image/png", width: 640, height: 360 });
  });
});
