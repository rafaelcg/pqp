import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  firstPts,
  shiftTsPacket,
  TS_PACKET_BYTES,
  TsTimestampShift,
} from "./ts-timestamp-shift.js";

/** One TS packet starting a video PES with PTS+DTS, and a PCR. */
function pesPacket(pts: number, dts: number, pcr: number): Uint8Array {
  const pkt = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = 0x40 | 0x01; // payload_unit_start, PID 0x100
  pkt[2] = 0x00;
  pkt[3] = 0x30; // adaptation + payload
  pkt[4] = 7; // adaptation length: flags + PCR
  pkt[5] = 0x10; // PCR flag
  writeBase(pkt, 6, pcr);
  let at = 12;
  pkt.set([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0xc0, 10], at);
  writeTs(pkt, at + 9, 0x3, pts);
  writeTs(pkt, at + 14, 0x1, dts);
  at += 19;
  return pkt;
}

function writeTs(buf: Uint8Array, at: number, prefix: number, v: number) {
  buf[at] = (prefix << 4) | ((Math.floor(v / 2 ** 30) & 7) << 1) | 1;
  buf[at + 1] = Math.floor(v / 2 ** 22) & 0xff;
  buf[at + 2] = ((Math.floor(v / 2 ** 15) & 0x7f) << 1) | 1;
  buf[at + 3] = Math.floor(v / 2 ** 7) & 0xff;
  buf[at + 4] = ((v & 0x7f) << 1) | 1;
}

function readTs(buf: Uint8Array, at: number): number {
  return (
    ((buf[at]! >> 1) & 7) * 2 ** 30 +
    buf[at + 1]! * 2 ** 22 +
    (buf[at + 2]! >> 1) * 2 ** 15 +
    buf[at + 3]! * 2 ** 7 +
    (buf[at + 4]! >> 1)
  );
}

function writeBase(buf: Uint8Array, at: number, v: number) {
  buf[at] = Math.floor(v / 2 ** 25) & 0xff;
  buf[at + 1] = Math.floor(v / 2 ** 17) & 0xff;
  buf[at + 2] = Math.floor(v / 2 ** 9) & 0xff;
  buf[at + 3] = Math.floor(v / 2) & 0xff;
  buf[at + 4] = ((v & 1) << 7) | 0x7e;
  buf[at + 5] = 0x00;
}

function readBase(buf: Uint8Array, at: number): number {
  return (
    buf[at]! * 2 ** 25 +
    buf[at + 1]! * 2 ** 17 +
    buf[at + 2]! * 2 ** 9 +
    buf[at + 3]! * 2 +
    (buf[at + 4]! >> 7)
  );
}

describe("MPEG-TS timestamp shift", () => {
  it("moves PTS, DTS and PCR by the offset and nothing else", () => {
    const pkt = pesPacket(324_000_000, 323_997_000, 323_990_000);
    const before = Uint8Array.from(pkt);
    shiftTsPacket(pkt, 9_000_000);
    expect(readTs(pkt, 21)).toBe(333_000_000);
    expect(readTs(pkt, 26)).toBe(332_997_000);
    expect(readBase(pkt, 6)).toBe(332_990_000);
    // The prefix nibbles and the PCR's reserved bits survive.
    expect(pkt[21]! >> 4).toBe(3);
    expect(pkt[26]! >> 4).toBe(1);
    expect(pkt[10]! & 0x7f).toBe(0x7e);
    // Everything outside the timestamps is byte-identical.
    const touched = new Set([6, 7, 8, 9, 10, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    for (let i = 0; i < TS_PACKET_BYTES; i += 1) {
      if (!touched.has(i)) {
        expect(pkt[i]).toBe(before[i]);
      }
    }
  });

  it("wraps at 2^33 like the clock does", () => {
    const pkt = pesPacket(2 ** 33 - 90_000, 2 ** 33 - 90_000, 0);
    shiftTsPacket(pkt, 180_000);
    expect(readTs(pkt, 21)).toBe(90_000);
  });

  it("leaves PSI alone", () => {
    const pat = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
    pat.set([0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xb0, 0x0d]);
    const before = Uint8Array.from(pat);
    shiftTsPacket(pat, 12_345);
    expect(pat).toEqual(before);
  });

  it("reads the first PTS of a segment head", () => {
    const buf = new Uint8Array(TS_PACKET_BYTES * 2);
    buf.set(pesPacket(900_000, 897_000, 890_000), 0);
    buf.set(pesPacket(810_000, 810_000, 800_000), TS_PACKET_BYTES);
    expect(firstPts(buf)).toBe(810_000);
  });

  it("shifts across chunk boundaries and keeps the length", async () => {
    const packets = Buffer.concat(
      [0, 1, 2].map((i) => Buffer.from(pesPacket(1_000 + i * 3_000, 1_000 + i * 3_000, 0))),
    );
    const chunks = [packets.subarray(0, 100), packets.subarray(100, 400), packets.subarray(400)];
    const out: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      Readable.from(chunks)
        .pipe(new TsTimestampShift(90_000))
        .on("data", (c: Buffer) => out.push(c))
        .on("end", resolve)
        .on("error", reject);
    });
    const joined = Buffer.concat(out);
    expect(joined.length).toBe(packets.length);
    expect(readTs(joined, 21)).toBe(91_000);
    expect(readTs(joined, TS_PACKET_BYTES * 2 + 21)).toBe(97_000);
  });

  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  it.skipIf(!hasFfmpeg)("joins two egress runs into one file that plays straight through", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-shift-"));
    const make = (name: string, seconds: number) => {
      execFileSync("ffmpeg", [
        "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${seconds}`,
        "-c:v", "libx264", "-g", "30", "-f", "mpegts", join(dir, name),
      ]);
      return readFileSync(join(dir, name));
    };
    // Two runs that both start on the same clock, as two egresses do.
    const a = make("a.ts", 4);
    const b = make("b.ts", 3);
    const ptsA = firstPts(a)!;
    const ptsB = firstPts(b)!;
    // The second run started 10 s after the first on the wall clock.
    const offset = ptsA + 10 * 90_000 - ptsB;
    const shifted = Buffer.from(b);
    for (let at = 0; at + TS_PACKET_BYTES <= shifted.length; at += TS_PACKET_BYTES) {
      shiftTsPacket(shifted.subarray(at, at + TS_PACKET_BYTES), offset);
    }
    writeFileSync(join(dir, "joined.ts"), Buffer.concat([a, shifted]));
    const duration = Number(
      execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, "joined.ts"),
      ]).toString(),
    );
    // 10 s to the second run's start plus its 3 s.
    expect(duration).toBeGreaterThan(12.5);
    expect(duration).toBeLessThan(13.5);
    // And it decodes end to end.
    const decode = spawnSync("ffmpeg", ["-v", "error", "-i", join(dir, "joined.ts"), "-f", "null", "-"]);
    expect(decode.status).toBe(0);
    expect(decode.stderr.toString()).toBe("");
  });
});
