import { describe, expect, it } from "vitest";
import { codecOfMoov, sniffVideoCodec } from "./video-codec";

const text = (value: string) => Uint8Array.from([...value].map((char) => char.charCodeAt(0)));
const u32 = (value: number) => Uint8Array.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const box = (type: string, ...body: Uint8Array[]) => {
  const inner = concat(...body);
  return concat(u32(8 + inner.length), text(type), inner);
};
/** stsd with one sample entry of the given type. */
const stsd = (entry: string) => box("stsd", u32(0), u32(1), box(entry, new Uint8Array(8)));
const moov = (...entries: string[]) => box("moov", ...entries.map((entry) => box("trak", box("mdia", box("minf", box("stbl", stsd(entry)))))));
const ftyp = (brand: string) => box("ftyp", text(brand), u32(0), text(brand));

describe("codecOfMoov", () => {
  it("reads H.264 and the codecs the server refuses", () => {
    expect(codecOfMoov(moov("avc1"))).toBe("h264");
    expect(codecOfMoov(moov("hvc1"))).toBe("unsupported");
    expect(codecOfMoov(moov("hev1"))).toBe("unsupported");
    expect(codecOfMoov(moov("apch"))).toBe("unsupported");
  });
  it("skips an audio track to the video one", () => {
    expect(codecOfMoov(moov("mp4a", "hvc1"))).toBe("unsupported");
    expect(codecOfMoov(moov("mp4a", "avc1"))).toBe("h264");
  });
  it("answers null when it cannot tell", () => {
    expect(codecOfMoov(moov("mp4a"))).toBeNull();
    expect(codecOfMoov(new Uint8Array(40))).toBeNull();
  });
});

describe("sniffVideoCodec", () => {
  it("finds a moov at the END of the file, as an iPhone writes it, after a big mdat", async () => {
    const file = new Blob([concat(ftyp("qt  "), box("wide"), box("mdat", new Uint8Array(5000)), moov("hvc1"))]);
    expect(await sniffVideoCodec(file)).toBe("unsupported");
  });
  it("finds a moov up front (a faststart MP4)", async () => {
    const file = new Blob([concat(ftyp("isom"), moov("avc1"), box("mdat", new Uint8Array(100)))]);
    expect(await sniffVideoCodec(file)).toBe("h264");
  });
  it("does not guess about a file with no moov, a broken box, or nothing at all", async () => {
    expect(await sniffVideoCodec(new Blob([concat(ftyp("isom"), box("mdat", new Uint8Array(10)))]))).toBeNull();
    expect(await sniffVideoCodec(new Blob([new Uint8Array(30)]))).toBeNull();
    expect(await sniffVideoCodec(new Blob([]))).toBeNull();
  });
});
