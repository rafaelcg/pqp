/**
 * Moving an MPEG-TS stream along its own clock, packet by packet, without
 * changing a single byte's position: every PES header's PTS/DTS and every
 * adaptation field's PCR/OPCR gets the same offset (modulo 2^33, the width of
 * the 90 kHz clock), and nothing else is touched. Same length in, same length
 * out, so a download that shifts some of its objects still knows its exact
 * `Content-Length` before the first byte goes out.
 *
 * WHY. A watch party's presenter camera is one egress per camera run
 * (`cameraRunNames` in hls-egress.ts), and every egress starts its clock at
 * the same place. Concatenating two runs as they are gives a file whose time
 * jumps backwards at the join, which a player stalls on and an editor reads
 * as the second run being the whole file. Shifted, the second run sits after
 * the first at the moment it really started, and the file plays straight
 * through, holding the last picture of the first run across the gap.
 */
import { Transform, type TransformCallback } from "node:stream";

export const TS_PACKET_BYTES = 188;
const CLOCK_MOD = 2 ** 33;

function mod33(value: number): number {
  const r = value % CLOCK_MOD;
  return r < 0 ? r + CLOCK_MOD : r;
}

/** A PES timestamp (PTS or DTS): 5 bytes, 33 bits with marker bits. */
function readTimestamp(buf: Uint8Array, at: number): number {
  return (
    ((buf[at]! >> 1) & 0x07) * 2 ** 30 +
    buf[at + 1]! * 2 ** 22 +
    (buf[at + 2]! >> 1) * 2 ** 15 +
    buf[at + 3]! * 2 ** 7 +
    (buf[at + 4]! >> 1)
  );
}

function writeTimestamp(buf: Uint8Array, at: number, value: number): void {
  const v = mod33(value);
  const prefix = buf[at]! & 0xf0;
  buf[at] = prefix | ((Math.floor(v / 2 ** 30) & 0x07) << 1) | 0x01;
  buf[at + 1] = Math.floor(v / 2 ** 22) & 0xff;
  buf[at + 2] = ((Math.floor(v / 2 ** 15) & 0x7f) << 1) | 0x01;
  buf[at + 3] = Math.floor(v / 2 ** 7) & 0xff;
  buf[at + 4] = ((v & 0x7f) << 1) | 0x01;
}

/** A PCR/OPCR base: 33 bits over the first 4 bytes and the top bit of the 5th. */
function readClockBase(buf: Uint8Array, at: number): number {
  return (
    buf[at]! * 2 ** 25 +
    buf[at + 1]! * 2 ** 17 +
    buf[at + 2]! * 2 ** 9 +
    buf[at + 3]! * 2 +
    (buf[at + 4]! >> 7)
  );
}

function writeClockBase(buf: Uint8Array, at: number, value: number): void {
  const v = mod33(value);
  buf[at] = Math.floor(v / 2 ** 25) & 0xff;
  buf[at + 1] = Math.floor(v / 2 ** 17) & 0xff;
  buf[at + 2] = Math.floor(v / 2 ** 9) & 0xff;
  buf[at + 3] = Math.floor(v / 2) & 0xff;
  buf[at + 4] = ((v & 0x01) << 7) | (buf[at + 4]! & 0x7f);
}

/** Where a packet's payload starts, or -1 when it has none. */
function payloadStart(pkt: Uint8Array): number {
  const control = (pkt[3]! >> 4) & 0x03;
  if ((control & 0x01) === 0) {
    return -1;
  }
  if (control & 0x02) {
    return 5 + pkt[4]!;
  }
  return 4;
}

/** The byte offset of a PES packet's PTS in `pkt`, and whether a DTS follows. */
function pesTimestamps(pkt: Uint8Array): { pts: number; dts: number | null } | null {
  if ((pkt[1]! & 0x40) === 0) {
    return null; // not the start of a PES packet
  }
  const at = payloadStart(pkt);
  if (at < 0 || at + 14 > TS_PACKET_BYTES) {
    return null;
  }
  if (pkt[at] !== 0x00 || pkt[at + 1] !== 0x00 || pkt[at + 2] !== 0x01) {
    return null; // PSI (PAT/PMT) starts with a pointer field, never 00 00 01
  }
  const streamId = pkt[at + 3]!;
  if (streamId !== 0xbd && (streamId < 0xc0 || streamId > 0xef)) {
    return null; // only audio, video and private stream 1 carry timestamps here
  }
  const flags = pkt[at + 7]! >> 6;
  if (flags === 2) {
    return { pts: at + 9, dts: null };
  }
  if (flags === 3 && at + 19 <= TS_PACKET_BYTES) {
    return { pts: at + 9, dts: at + 14 };
  }
  return null;
}

/** Shifts one 188-byte packet in place. */
export function shiftTsPacket(pkt: Uint8Array, offset: number): void {
  if (pkt[0] !== 0x47) {
    return; // not a packet start: leave it, a byte-exact copy is the safe failure
  }
  const control = (pkt[3]! >> 4) & 0x03;
  if (control & 0x02 && pkt[4]! > 0) {
    const flags = pkt[5]!;
    let at = 6;
    if (flags & 0x10) {
      writeClockBase(pkt, at, readClockBase(pkt, at) + offset);
      at += 6;
    }
    if (flags & 0x08) {
      writeClockBase(pkt, at, readClockBase(pkt, at) + offset);
    }
  }
  const pes = pesTimestamps(pkt);
  if (pes) {
    writeTimestamp(pkt, pes.pts, readTimestamp(pkt, pes.pts) + offset);
    if (pes.dts !== null) {
      writeTimestamp(pkt, pes.dts, readTimestamp(pkt, pes.dts) + offset);
    }
  }
}

/**
 * The first PTS in a stretch of MPEG-TS (the head of a segment is enough), or
 * null when there is none. The earliest of the first video and audio PES, so
 * a run's two tracks are moved by the same amount.
 */
export function firstPts(buf: Uint8Array): number | null {
  let best: number | null = null;
  for (let at = 0; at + TS_PACKET_BYTES <= buf.length; at += TS_PACKET_BYTES) {
    const pkt = buf.subarray(at, at + TS_PACKET_BYTES);
    if (pkt[0] !== 0x47) {
      continue;
    }
    const pes = pesTimestamps(pkt);
    if (pes) {
      const pts = readTimestamp(pkt, pes.pts);
      best = best === null ? pts : Math.min(best, pts);
    }
  }
  return best;
}

/** A stream transform applying `shiftTsPacket` to every whole packet. */
export class TsTimestampShift extends Transform {
  private carry: Buffer = Buffer.alloc(0);

  constructor(private readonly offset: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = data.length - (data.length % TS_PACKET_BYTES);
    // A copy: the chunk may be a view of memory the caller still owns.
    const out = Buffer.from(data.subarray(0, whole));
    for (let at = 0; at < whole; at += TS_PACKET_BYTES) {
      shiftTsPacket(out.subarray(at, at + TS_PACKET_BYTES), this.offset);
    }
    this.carry = Buffer.from(data.subarray(whole));
    done(null, out);
  }

  override _flush(done: TransformCallback): void {
    // A trailing partial packet is passed through untouched rather than
    // dropped: the length promised in Content-Length is kept either way.
    done(null, this.carry);
  }
}
