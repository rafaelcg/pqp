/**
 * Joining a watch party's voice archive runs into ONE Ogg Opus file.
 *
 * The host's voice is a LiveKit Track Egress per run (`-mic.ogg`, then
 * `-mic-r<start ms>.ogg` for every restart in place, see `micArchiveRunKey`
 * in hls-egress.ts). Each run is a complete Ogg Opus stream of its own: its
 * own serial number, its own OpusHead and OpusTags, page sequence from 0,
 * granule positions on its own clock, and an end-of-stream flag on its last
 * page. Handing the runs back concatenated would be a "chained" Ogg file,
 * which players treat as separate songs and editors read as the first one
 * only, and the time between two runs would vanish.
 *
 * So later runs are rewritten page by page into the first run's logical
 * stream: their header pages are dropped, every kept page takes the first
 * run's serial, the next page sequence number and its granule position moved
 * by a per-run offset, only the very last page keeps its end-of-stream flag,
 * and the CRC is recomputed. Nothing inside a page changes length, so a
 * download still knows its exact `Content-Length` before its first byte.
 *
 * THE GAP IS SILENCE, NOT A GRANULE JUMP. A jump in granule position is read
 * differently by every demuxer (some pad, some ignore it and slide the rest of
 * the file earlier, which is exactly the desync this exists to prevent). A
 * run of Opus silence packets is played as silence by all of them, so the
 * voice after a restart lands where it happened on the wall clock.
 */
import { Transform, type TransformCallback } from "node:stream";

/** A 20 ms CELT frame that decodes to digital silence (TOC 0xF8, code 0). */
export const OPUS_SILENCE_PACKET = Uint8Array.of(0xf8, 0xff, 0xfe);
/** Samples per silence packet, at Opus's fixed 48 kHz granule rate. */
export const OPUS_SILENCE_SAMPLES = 960;

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const HEADER_BYTES = 27;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
const NO_GRANULE = 0xffffffffffffffffn;
const MAX_PACKETS_PER_PAGE = 255;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32 (polynomial 0x04c11db7, unreflected, no final xor). */
export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

function crcHolds(page: Uint8Array): boolean {
  const copy = page.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const stated = view.getUint32(22, true);
  view.setUint32(22, 0, true);
  return oggCrc32(copy) === stated;
}

export interface OggPageInfo {
  offset: number;
  length: number;
  flags: number;
  /** `NO_GRANULE` (all ones) when no packet ends on this page. */
  granule: bigint;
  serial: number;
  /** Each packet that ENDS on this page, as [start, end) inside the page body,
   * plus whether it began on this page (false: continued from the last one). */
  packets: { start: number; end: number; startsHere: boolean }[];
}

function isCapture(buf: Uint8Array, at: number): boolean {
  return (
    buf[at] === CAPTURE[0] &&
    buf[at + 1] === CAPTURE[1] &&
    buf[at + 2] === CAPTURE[2] &&
    buf[at + 3] === CAPTURE[3]
  );
}

/** Total length of the page starting at `at`, or null when `buf` does not
 * hold all of it (or it is not a page). */
function pageLength(buf: Uint8Array, at: number): number | null {
  if (buf.length < at + HEADER_BYTES || !isCapture(buf, at)) {
    return null;
  }
  const segments = buf[at + 26]!;
  if (buf.length < at + HEADER_BYTES + segments) {
    return null;
  }
  let body = 0;
  for (let i = 0; i < segments; i += 1) {
    body += buf[at + HEADER_BYTES + i]!;
  }
  const length = HEADER_BYTES + segments + body;
  return buf.length < at + length ? null : length;
}

function readPage(buf: Uint8Array, at: number, length: number): OggPageInfo {
  const view = new DataView(buf.buffer, buf.byteOffset + at, length);
  const segments = buf[at + 26]!;
  const packets: OggPageInfo["packets"] = [];
  let cursor = 0;
  let packetStart = 0;
  let startsHere = !(buf[at + 5]! & 0x01);
  for (let i = 0; i < segments; i += 1) {
    const lacing = buf[at + HEADER_BYTES + i]!;
    cursor += lacing;
    if (lacing < 255) {
      packets.push({ start: packetStart, end: cursor, startsHere });
      packetStart = cursor;
      startsHere = true;
    }
  }
  return {
    offset: at,
    length,
    flags: buf[at + 5]!,
    granule: view.getBigUint64(6, true),
    serial: view.getUint32(14, true),
    packets,
  };
}

/** Every complete page at the front of `buf`, stopping at the first thing
 * that is not one (a torn tail, or the end of a range read). */
export function parseOggPages(buf: Uint8Array): OggPageInfo[] {
  const pages: OggPageInfo[] = [];
  let at = 0;
  for (;;) {
    const length = pageLength(buf, at);
    if (length === null) {
      return pages;
    }
    pages.push(readPage(buf, at, length));
    at += length;
  }
}

/** Samples (48 kHz) one Opus packet decodes to, from its TOC (RFC 6716 3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) {
    return 0;
  }
  const toc = packet[0]!;
  const config = toc >> 3;
  let frameSamples: number;
  if (config < 12) {
    frameSamples = [480, 960, 1920, 2880][config % 4]!;
  } else if (config < 16) {
    frameSamples = [480, 960][config % 2]!;
  } else {
    frameSamples = [120, 240, 480, 960][config % 4]!;
  }
  const code = toc & 0x03;
  const frames =
    code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frameSamples * frames;
}

/** What a download needs to know about the front of one run. */
export interface OggRunHead {
  serial: number;
  /** Bytes of the header pages (OpusHead and OpusTags) a later run drops. */
  headerBytes: number;
  /** How many pages those are. */
  headerPages: number;
  /** The granule position of this run's first audio sample. */
  origin: bigint;
}

/**
 * Read the header pages and the start of the audio from the first bytes of a
 * run. Null when the probe does not reach the first audio granule (a run so
 * short it has none, or a file that is not Ogg Opus at all).
 */
export function readOggRunHead(head: Uint8Array): OggRunHead | null {
  const pages = parseOggPages(head);
  const first = pages[0];
  if (!first) {
    return null;
  }
  let packetsSeen = 0;
  let headerBytes = 0;
  let headerPages = 0;
  let samples = 0n;
  let carried: Uint8Array | null = null;
  for (const page of pages) {
    if (page.serial !== first.serial) {
      return null;
    }
    if (packetsSeen < 2) {
      packetsSeen += page.packets.length;
      headerBytes += page.length;
      headerPages += 1;
      continue;
    }
    const bodyAt = page.offset + HEADER_BYTES + head[page.offset + 26]!;
    let completedTo = 0;
    for (const packet of page.packets) {
      const bytes = head.subarray(bodyAt + packet.start, bodyAt + packet.end);
      // A packet continued from the previous page has its TOC there.
      samples += BigInt(
        opusPacketSamples(
          packet.startsHere
            ? bytes
            : Uint8Array.from([...(carried ?? []), ...bytes.subarray(0, 2)]),
        ),
      );
      carried = null;
      completedTo = packet.end;
    }
    const bodyEnd = page.offset + page.length;
    if (bodyAt + completedTo < bodyEnd) {
      // A packet that goes on onto the next page: keep its first two bytes.
      carried ??= head.slice(bodyAt + completedTo, Math.min(bodyEnd, bodyAt + completedTo + 2));
    }
    if (page.granule !== NO_GRANULE) {
      const origin = page.granule - samples;
      return {
        serial: first.serial,
        headerBytes,
        headerPages,
        origin: origin < 0n ? 0n : origin,
      };
    }
  }
  return null;
}

/**
 * The granule position of the last page in `tail` (the end of a run), or null
 * when there is none. `tail` is any suffix of the file: the scan starts at
 * the first capture pattern it can parse a whole page from.
 */
export function readOggRunEnd(
  tail: Uint8Array,
  serial: number | null = null,
): bigint | null {
  let last: bigint | null = null;
  for (let at = 0; at + HEADER_BYTES <= tail.length; ) {
    const length = isCapture(tail, at) ? pageLength(tail, at) : null;
    // Only a page whose CRC holds: "OggS" can occur inside Opus data, and
    // the scan starts at an arbitrary byte of the file.
    if (length === null || !crcHolds(tail.subarray(at, at + length))) {
      at += 1;
      continue;
    }
    const page = readPage(tail, at, length);
    if (serial !== null && page.serial !== serial) {
      at += length;
      continue;
    }
    if (page.granule !== NO_GRANULE) {
      last = page.granule;
    }
    at += length;
  }
  return last;
}

/** Shared by every run of one download: the output's one logical stream. */
export interface OggStitchState {
  serial: number | null;
  nextSequence: number;
}

export function newOggStitchState(): OggStitchState {
  return { serial: null, nextSequence: 0 };
}

export interface OggRunRewrite {
  /** Leading pages to drop (a later run's OpusHead and OpusTags). */
  dropPages: number;
  /** Added to every real granule position (48 kHz samples). */
  granuleDelta: number;
  /** Clear the end-of-stream flag: true for every run but the last. */
  clearEos: boolean;
}

function finishPage(page: Uint8Array, state: OggStitchState): void {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  view.setUint32(14, state.serial!, true);
  view.setUint32(18, state.nextSequence, true);
  state.nextSequence = (state.nextSequence + 1) >>> 0;
  view.setUint32(22, 0, true);
  view.setUint32(22, oggCrc32(page), true);
}

/**
 * One run through the rewrite. Same bytes out as in, minus the dropped
 * header pages, which the caller already subtracted from the plan's size.
 * Anything that is not a page (a torn last page) is passed through as it is,
 * so the count never disagrees with what was promised.
 */
export class OggRunRewriter extends Transform {
  private pending: Uint8Array = new Uint8Array(0);
  private dropped = 0;
  private raw = false;

  constructor(
    private readonly state: OggStitchState,
    private readonly rewrite: OggRunRewrite,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    if (this.raw) {
      done(null, chunk);
      return;
    }
    const buf = new Uint8Array(this.pending.length + chunk.length);
    buf.set(this.pending, 0);
    buf.set(chunk, this.pending.length);
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < buf.length) {
      if (buf.length - at >= 4 && !isCapture(buf, at)) {
        // Not a page where one should be: give up rewriting this run and
        // hand the rest over untouched.
        this.raw = true;
        out.push(buf.subarray(at));
        at = buf.length;
        break;
      }
      const length = pageLength(buf, at);
      if (length === null) {
        break;
      }
      if (this.dropped < this.rewrite.dropPages) {
        this.dropped += 1;
        at += length;
        continue;
      }
      const page = buf.slice(at, at + length);
      const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
      if (this.state.serial === null) {
        this.state.serial = view.getUint32(14, true);
      }
      const granule = view.getBigUint64(6, true);
      if (granule !== NO_GRANULE && this.rewrite.granuleDelta !== 0) {
        const moved = granule + BigInt(this.rewrite.granuleDelta);
        view.setBigUint64(6, moved < 0n ? 0n : moved, true);
      }
      let flags = page[5]!;
      if (this.state.nextSequence !== 0) {
        flags &= ~FLAG_BOS;
      }
      if (this.rewrite.clearEos) {
        flags &= ~FLAG_EOS;
      }
      page[5] = flags;
      finishPage(page, this.state);
      out.push(page);
      at += length;
    }
    this.pending = buf.slice(at);
    done(null, out.length > 0 ? Buffer.concat(out) : undefined);
  }

  override _flush(done: TransformCallback): void {
    done(null, this.pending.length > 0 ? Buffer.from(this.pending) : undefined);
  }
}

/** Exact size of `packets` silence packets as pages. */
export function oggSilenceBytes(packets: number): number {
  const full = Math.floor(packets / MAX_PACKETS_PER_PAGE);
  const rest = packets % MAX_PACKETS_PER_PAGE;
  const perPacket = OPUS_SILENCE_PACKET.length;
  return (
    full * (HEADER_BYTES + MAX_PACKETS_PER_PAGE * (1 + perPacket)) +
    (rest > 0 ? HEADER_BYTES + rest * (1 + perPacket) : 0)
  );
}

/**
 * `packets` silence packets as pages on the shared stream, the first one
 * ending at granule `startGranule + 960`. Yields a page at a time so a long
 * gap never sits in memory whole.
 */
export function* oggSilencePages(
  state: OggStitchState,
  packets: number,
  startGranule: number,
): Generator<Buffer> {
  if (state.serial === null) {
    throw new Error("oggSilencePages before the stream's first page");
  }
  let written = 0;
  while (written < packets) {
    const count = Math.min(MAX_PACKETS_PER_PAGE, packets - written);
    const page = Buffer.alloc(
      HEADER_BYTES + count * (1 + OPUS_SILENCE_PACKET.length),
    );
    page.set(CAPTURE, 0);
    page[4] = 0; // version
    page[5] = 0; // fresh packet, not first, not last
    written += count;
    page.writeBigUInt64LE(
      BigInt(startGranule) + BigInt(written * OPUS_SILENCE_SAMPLES),
      6,
    );
    page[26] = count;
    for (let i = 0; i < count; i += 1) {
      page[HEADER_BYTES + i] = OPUS_SILENCE_PACKET.length;
      page.set(
        OPUS_SILENCE_PACKET,
        HEADER_BYTES + count + i * OPUS_SILENCE_PACKET.length,
      );
    }
    finishPage(page, state);
    yield page;
  }
}
