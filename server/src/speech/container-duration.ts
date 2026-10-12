/**
 * How long a recording is, read from its container headers without decoding
 * a single frame. The recorder states a duration at mint (the card shows it,
 * the byte budget is checked against it); this is the worker's check of that
 * claim once it has the bytes, and the number the speech budget is charged
 * by, because a client can lie and a container cannot (not cheaply).
 *
 * Three containers, the ones a voice note may arrive in:
 *
 *   * MP4 (`audio/mp4`): `moov/mvhd` duration over its timescale. A
 *     fragmented file (Safari's MediaRecorder, `empty_moov`) has 0 there, so
 *     the sample durations in every `moof/traf/trun` are summed instead, over
 *     the track's `mdhd` timescale, with `tfhd` and `trex` defaults.
 *   * WebM (`audio/webm`): `Segment/Info/Duration` times `TimecodeScale`.
 *     Chrome's MediaRecorder writes no Duration at all (and unknown-size
 *     Segment and Cluster elements), so the last block's timestamp plus one
 *     frame is the fallback.
 *   * Ogg (`audio/ogg`): the last page's granule position, less Opus's
 *     pre-skip, over 48 kHz (Opus) or the Vorbis sample rate.
 *
 * Every parser is bounded by the buffer and returns null rather than throwing
 * on anything it does not understand: a note whose length cannot be read is
 * still a note, it just keeps the duration its sender stated.
 */

export interface ContainerInfo {
  container: "mp4" | "webm" | "ogg";
  durationMs: number;
  /** `aac`, `opus`, `vorbis`, or whatever four-character code the file named. */
  codec: string | null;
}

export function readContainerDuration(bytes: Uint8Array): ContainerInfo | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (b.length >= 4 && b.toString("latin1", 0, 4) === "OggS") {
      return readOgg(b);
    }
    if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
      return readWebm(b);
    }
    if (b.length >= 8 && b.toString("latin1", 4, 8) === "ftyp") {
      return readMp4(b);
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------- MP4

interface Box {
  type: string;
  /** Start of the payload (after the header). */
  start: number;
  /** End of the box, exclusive. */
  end: number;
}

function* boxes(b: Buffer, from: number, to: number): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = b.readUInt32BE(at);
    const type = b.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = Number(b.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) {
      // A truncated last box (an upload cut short) still has a usable header
      // when it is a container we only need the start of.
      yield { type, start: at + header, end: to };
      return;
    }
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function child(b: Buffer, parent: Box, type: string): Box | undefined {
  for (const box of boxes(b, parent.start, parent.end)) {
    if (box.type === type) return box;
  }
  return undefined;
}

function path(b: Buffer, parent: Box, ...types: string[]): Box | undefined {
  let at: Box | undefined = parent;
  for (const type of types) {
    if (!at) return undefined;
    at = child(b, at, type);
  }
  return at;
}

/** `version` (1 byte) + `flags` (3 bytes) at the start of a full box. */
function fullBox(b: Buffer, box: Box): { version: number; flags: number } {
  const word = b.readUInt32BE(box.start);
  return { version: word >>> 24, flags: word & 0xffffff };
}

function readMp4(b: Buffer): ContainerInfo | null {
  const file: Box = { type: "file", start: 0, end: b.length };
  const moov = child(b, file, "moov");
  if (!moov) return null;

  const trak = child(b, moov, "trak");
  const mdhd = trak ? path(b, trak, "mdia", "mdhd") : undefined;
  const stsd = trak ? path(b, trak, "mdia", "minf", "stbl", "stsd") : undefined;
  const codec = stsd && stsd.end - stsd.start >= 16 ? fourCcCodec(b.toString("latin1", stsd.start + 12, stsd.start + 16)) : null;

  // EVERY ANSWER THE FILE GIVES, AND THE LONGEST WINS. The movie header is a
  // declaration; the sample table and the fragments are the timeline. A
  // crafted file can declare two seconds over five minutes of samples, and
  // the duration is what the speech budget is charged by, so the declaration
  // is never allowed to be shorter than the samples it describes.
  const candidates: number[] = [];

  const mvhd = child(b, moov, "mvhd");
  if (mvhd) {
    const { version } = fullBox(b, mvhd);
    const timescale = b.readUInt32BE(mvhd.start + (version === 1 ? 20 : 12));
    const duration =
      version === 1 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : b.readUInt32BE(mvhd.start + 16);
    const unknown = version === 1 ? duration >= Number.MAX_SAFE_INTEGER : duration === 0xffffffff;
    if (timescale > 0 && duration > 0 && !unknown) {
      candidates.push((duration / timescale) * 1000);
    }
  }

  if (!mdhd) {
    return candidates.length > 0 ? { container: "mp4", durationMs: Math.round(Math.max(...candidates)), codec } : null;
  }
  const mdhdVersion = fullBox(b, mdhd).version;
  const trackTimescale = b.readUInt32BE(mdhd.start + (mdhdVersion === 1 ? 20 : 12));
  if (trackTimescale <= 0) {
    return candidates.length > 0 ? { container: "mp4", durationMs: Math.round(Math.max(...candidates)), codec } : null;
  }

  // The sample table of a progressive file: `stts` is (count, delta) pairs.
  const stts = trak ? path(b, trak, "mdia", "minf", "stbl", "stts") : undefined;
  if (stts) {
    const entries = b.readUInt32BE(stts.start + 4);
    let ticks = 0;
    for (let i = 0, at = stts.start + 8; i < entries && at + 8 <= stts.end; i++, at += 8) {
      ticks += b.readUInt32BE(at) * b.readUInt32BE(at + 4);
    }
    if (ticks > 0) candidates.push((ticks / trackTimescale) * 1000);
  }
  const trex = path(b, moov, "mvex", "trex");
  const trexDefaultDuration = trex ? b.readUInt32BE(trex.start + 12) : 0;

  let total = 0;
  let sawFragment = false;
  for (const top of boxes(b, 0, b.length)) {
    if (top.type !== "moof") continue;
    for (const traf of boxes(b, top.start, top.end)) {
      if (traf.type !== "traf") continue;
      let defaultDuration = trexDefaultDuration;
      const tfhd = child(b, traf, "tfhd");
      if (tfhd) {
        const { flags } = fullBox(b, tfhd);
        let at = tfhd.start + 8; // version/flags + track_ID
        if (flags & 0x01) at += 8; // base_data_offset
        if (flags & 0x02) at += 4; // sample_description_index
        if (flags & 0x08) defaultDuration = b.readUInt32BE(at);
      }
      for (const trun of boxes(b, traf.start, traf.end)) {
        if (trun.type !== "trun") continue;
        sawFragment = true;
        const { flags } = fullBox(b, trun);
        const count = b.readUInt32BE(trun.start + 4);
        let at = trun.start + 8;
        if (flags & 0x01) at += 4; // data_offset
        if (flags & 0x04) at += 4; // first_sample_flags
        const perSample =
          (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
        if (!(flags & 0x100)) {
          total += count * defaultDuration;
          continue;
        }
        for (let i = 0; i < count && at + 4 <= trun.end; i++, at += perSample) {
          total += b.readUInt32BE(at);
        }
      }
    }
  }
  if (sawFragment && total > 0) candidates.push((total / trackTimescale) * 1000);
  if (candidates.length === 0) return null;
  return { container: "mp4", durationMs: Math.round(Math.max(...candidates)), codec };
}

function fourCcCodec(fourCc: string): string {
  if (fourCc === "mp4a") return "aac";
  if (fourCc === "Opus") return "opus";
  return fourCc.trim().toLowerCase();
}

// --------------------------------------------------------------------- WebM

const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_TIMECODE_SCALE = 0x2ad7b1;
const EBML_DURATION = 0x4489;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_CODEC_ID = 0x86;
const EBML_CLUSTER = 0x1f43b675;
const EBML_CLUSTER_TIMECODE = 0xe7;
const EBML_SIMPLE_BLOCK = 0xa3;
const EBML_BLOCK_GROUP = 0xa0;
const EBML_BLOCK = 0xa1;
const EBML_BLOCK_DURATION = 0x9b;

/** Masters walked into rather than skipped. Everything else is skipped by size. */
const DESCEND = new Set([EBML_SEGMENT, EBML_INFO, EBML_TRACKS, EBML_TRACK_ENTRY, EBML_CLUSTER, EBML_BLOCK_GROUP]);

/** An element ID keeps its length marker bits; 1 to 4 bytes. */
function readId(b: Buffer, at: number): { id: number; len: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const len = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (len === 0 || at + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[at + i]!;
  return { id, len };
}

/** A size drops its marker bit; all ones means "unknown" (null). */
function readSize(b: Buffer, at: number): { size: number | null; len: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || at + len > b.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const byte = b[at + i]!;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }
  return { size: allOnes ? null : value, len };
}

function readUint(b: Buffer, at: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + b[at + i]!;
  return value;
}

/**
 * One flat pass over the file. Masters in `DESCEND` are entered by reading
 * their children in line instead of recursing, which is what lets an
 * unknown-size Segment or Cluster (a live recording) parse at all: nothing
 * here ever needs to know where one ends, because every element read is only
 * ever found inside the one master that can hold it.
 */
function readWebm(b: Buffer): ContainerInfo | null {
  let scale = 1_000_000; // ns per tick, the Matroska default
  let duration: number | null = null;
  let codec: string | null = null;
  let clusterTime = 0;
  let lastBlockEnd = 0;
  let lastBlockStart: number | null = null;
  const gaps: number[] = [];

  let at = 0;
  while (at < b.length) {
    const id = readId(b, at);
    if (!id) break;
    const size = readSize(b, at + id.len);
    if (!size) break;
    const body = at + id.len + size.len;
    if (DESCEND.has(id.id)) {
      at = body;
      continue;
    }
    if (size.size === null || body + size.size > b.length) {
      // An unknown-size element we do not walk into, or a truncated tail.
      break;
    }
    const end = body + size.size;
    switch (id.id) {
      case EBML_TIMECODE_SCALE:
        scale = readUint(b, body, size.size) || scale;
        break;
      case EBML_DURATION:
        duration = size.size === 4 ? b.readFloatBE(body) : size.size === 8 ? b.readDoubleBE(body) : null;
        break;
      case EBML_CODEC_ID:
        codec ??= b.toString("latin1", body, end).replace(/^A_/, "").toLowerCase();
        break;
      case EBML_CLUSTER_TIMECODE:
        clusterTime = readUint(b, body, size.size);
        break;
      case EBML_SIMPLE_BLOCK:
      case EBML_BLOCK: {
        const track = readSize(b, body);
        if (!track) break;
        const relative = b.readInt16BE(body + track.len);
        const start = clusterTime + relative;
        if (lastBlockStart !== null && start > lastBlockStart) gaps.push(start - lastBlockStart);
        lastBlockStart = start;
        lastBlockEnd = Math.max(lastBlockEnd, start);
        break;
      }
      case EBML_BLOCK_DURATION:
        if (lastBlockStart !== null) {
          lastBlockEnd = Math.max(lastBlockEnd, lastBlockStart + readUint(b, body, size.size));
        }
        break;
      default:
        break;
    }
    at = end;
  }

  const msPerTick = scale / 1_000_000;
  const declared =
    duration !== null && Number.isFinite(duration) && duration > 0 ? duration * msPerTick : 0;
  // The timeline: the last block's start plus one frame, the frame being the
  // most common gap between blocks (20 ms for Opus at its default). The only
  // answer Chrome's recordings give (they carry no Duration), and a floor
  // under a declared one, which a crafted file could set to anything.
  let timeline = 0;
  if (lastBlockStart !== null) {
    const frame = gaps.length > 0 ? mode(gaps) : 0;
    timeline = Math.max(lastBlockEnd, lastBlockStart + frame) * msPerTick;
  }
  const longest = Math.max(declared, timeline);
  if (longest <= 0) return null;
  return { container: "webm", durationMs: Math.round(longest), codec };
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0]!;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > (counts.get(best) ?? 0)) best = value;
  }
  return best;
}

// ---------------------------------------------------------------------- Ogg

function readOgg(b: Buffer): ContainerInfo | null {
  let at = 0;
  let serial: number | null = null;
  let codec: string | null = null;
  let rate = 48_000;
  let preSkip = 0;
  let lastGranule: bigint | null = null;

  while (at + 27 <= b.length && b.toString("latin1", at, at + 4) === "OggS") {
    const granule = b.readBigInt64LE(at + 6);
    const pageSerial = b.readUInt32LE(at + 14);
    const segments = b[at + 26]!;
    if (at + 27 + segments > b.length) break;
    let bodyLength = 0;
    for (let i = 0; i < segments; i++) bodyLength += b[at + 27 + i]!;
    const body = at + 27 + segments;
    if (body + bodyLength > b.length) break;

    if (serial === null) {
      // The first page of the first stream carries the codec's ID header.
      serial = pageSerial;
      if (b.toString("latin1", body, body + 8) === "OpusHead") {
        codec = "opus";
        preSkip = b.readUInt16LE(body + 10);
        rate = 48_000; // Opus granules are always 48 kHz, whatever the input rate
      } else if (b[body] === 0x01 && b.toString("latin1", body + 1, body + 7) === "vorbis") {
        codec = "vorbis";
        rate = b.readUInt32LE(body + 12) || rate;
      }
    }
    if (pageSerial === serial && granule >= 0n) {
      lastGranule = granule;
    }
    at = body + bodyLength;
  }

  if (lastGranule === null || codec === null) return null;
  const samples = Number(lastGranule) - preSkip;
  if (samples <= 0) return null;
  return { container: "ogg", durationMs: Math.round((samples / rate) * 1000), codec };
}
