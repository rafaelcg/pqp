import { quantize } from "./pcm";

/**
 * A small FLAC encoder: lossless, so a stem's round trip moves no sample.
 *
 * WHY HAND-WRITTEN. The browsers' own encoders do not do FLAC (WebCodecs
 * `AudioEncoder` offers Opus and AAC; MediaRecorder offers Opus and AAC in a
 * container whose start is wherever the recorder happened to begin). The
 * libFLAC ports are 300 kB+ of wasm for a feature that needs the easy 90 % of
 * FLAC. This file writes a valid subset of the format that every decoder
 * reads: CONSTANT subframes (silence costs a few bytes per block), FIXED
 * predictors of order 0..4 with partitioned Rice residuals, and VERBATIM when
 * nothing beats raw. No LPC, so it compresses a few percent worse than
 * `flac -5`; the measured numbers are in `docs/JAM_ENGINE.md`.
 *
 * Format reference: RFC 9639 (FLAC). Every frame carries its CRC-8 and
 * CRC-16, STREAMINFO carries the real min/max frame sizes; the MD5 is left
 * zero, which the format defines as "not computed".
 */

export interface FlacOptions {
  bitsPerSample?: 16 | 24;
  blockSize?: number;
}

class BitWriter {
  buf: Uint8Array;
  len = 0;
  private cur = 0;
  private free = 8;

  constructor(capacity: number) {
    this.buf = new Uint8Array(Math.max(64, capacity));
  }

  private push(byte: number) {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = byte;
  }

  /** Low `n` bits of `v` (n <= 31), most significant first. */
  bits(v: number, n: number) {
    while (n > 0) {
      const take = n < this.free ? n : this.free;
      const shift = n - take;
      const chunk = (v >>> shift) & ((1 << take) - 1);
      this.cur |= chunk << (this.free - take);
      this.free -= take;
      n -= take;
      if (this.free === 0) {
        this.push(this.cur);
        this.cur = 0;
        this.free = 8;
      }
    }
  }

  /** `q` zeros and a one. */
  unary(q: number) {
    while (q > 0) {
      const take = q < this.free ? q : this.free;
      this.free -= take;
      q -= take;
      if (this.free === 0) {
        this.push(this.cur);
        this.cur = 0;
        this.free = 8;
      }
    }
    this.bits(1, 1);
  }

  align() {
    if (this.free !== 8) {
      this.push(this.cur);
      this.cur = 0;
      this.free = 8;
    }
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

export function crc8(bytes: Uint8Array, start: number, end: number): number {
  let c = 0;
  for (let i = start; i < end; i++) c = CRC8[c ^ bytes[i]];
  return c;
}

export function crc16(bytes: Uint8Array, start: number, end: number): number {
  let c = 0;
  for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ bytes[i]];
  return c;
}

const SAMPLE_RATE_CODES: Record<number, number> = {
  88200: 0b0001,
  176400: 0b0010,
  192000: 0b0011,
  8000: 0b0100,
  16000: 0b0101,
  22050: 0b0110,
  24000: 0b0111,
  32000: 0b1000,
  44100: 0b1001,
  48000: 0b1010,
  96000: 0b1011,
};

/** FLAC's UTF-8-style variable-length frame number. */
function writeFrameNumber(w: BitWriter, n: number) {
  if (n < 0x80) {
    w.bits(n, 8);
    return;
  }
  const bytes: number[] = [];
  let lead: number;
  let v = n;
  if (n < 0x800) lead = 2;
  else if (n < 0x10000) lead = 3;
  else if (n < 0x200000) lead = 4;
  else if (n < 0x4000000) lead = 5;
  else lead = 6;
  for (let i = 0; i < lead - 1; i++) {
    bytes.unshift(0x80 | (v & 0x3f));
    v = Math.floor(v / 64);
  }
  const prefix = (0xff << (8 - lead)) & 0xff;
  w.bits(prefix | v, 8);
  for (const b of bytes) w.bits(b, 8);
}

/** Residual of the fixed predictor of `order` at index i (i >= order). */
function fixedResidual(x: Int32Array, i: number, order: number): number {
  switch (order) {
    case 0:
      return x[i];
    case 1:
      return x[i] - x[i - 1];
    case 2:
      return x[i] - 2 * x[i - 1] + x[i - 2];
    case 3:
      return x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
    default:
      return x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
  }
}

interface RicePlan {
  partitionOrder: number;
  params: number[];
  /** 0 = 4-bit parameters, 1 = 5-bit. */
  method: 0 | 1;
  bits: number;
}

/** Estimated cost of a Rice partition with `count` folded values summing to `sum`. */
function riceEstimate(sum: number, count: number): { k: number; bits: number } {
  if (count === 0) return { k: 0, bits: 0 };
  const mean = sum / count;
  const k0 = mean > 1 ? Math.floor(Math.log2(mean)) : 0;
  let best = { k: 0, bits: Infinity };
  for (let k = Math.max(0, k0 - 1); k <= Math.min(30, k0 + 1); k++) {
    // sum(u >> k) is about sum / 2^k - count / 2 (the dropped bits average half)
    const q = Math.max(0, sum / 2 ** k - (k > 0 ? count / 2 : 0));
    const bits = count * (k + 1) + q;
    if (bits < best.bits) best = { k, bits };
  }
  return best;
}

function planRice(folded: Uint32Array, blockSize: number, order: number): RicePlan {
  // largest partition order allowed: divides the block, and the first
  // partition still holds at least one residual after the warm-up
  let maxP = 0;
  while (maxP < 8 && blockSize % (1 << (maxP + 1)) === 0 && blockSize >> (maxP + 1) > order) maxP++;
  // folded[] holds residuals for sample indices order..blockSize-1
  const parts = 1 << maxP;
  const plen = blockSize >> maxP;
  let sums = new Float64Array(parts);
  let counts = new Int32Array(parts);
  for (let p = 0; p < parts; p++) {
    const s = p === 0 ? order : p * plen;
    const e = (p + 1) * plen;
    let acc = 0;
    for (let i = s; i < e; i++) acc += folded[i - order];
    sums[p] = acc;
    counts[p] = e - s;
  }
  let best: RicePlan | null = null;
  for (let po = maxP; po >= 0; po--) {
    const n = 1 << po;
    if (po < maxP) {
      const ns = new Float64Array(n);
      const nc = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        ns[i] = sums[2 * i] + sums[2 * i + 1];
        nc[i] = counts[2 * i] + counts[2 * i + 1];
      }
      sums = ns;
      counts = nc;
    }
    const params: number[] = [];
    let bits = 6; // method + partition order
    let needFive = false;
    for (let i = 0; i < n; i++) {
      const est = riceEstimate(sums[i], counts[i]);
      params.push(est.k);
      bits += est.bits;
      if (est.k > 14) needFive = true;
    }
    bits += n * (needFive ? 5 : 4);
    if (!best || bits < best.bits) best = { partitionOrder: po, params, method: needFive ? 1 : 0, bits };
  }
  return best!;
}

function encodeSubframe(w: BitWriter, x: Int32Array, bps: number) {
  const n = x.length;
  let constant = true;
  for (let i = 1; i < n; i++) {
    if (x[i] !== x[0]) {
      constant = false;
      break;
    }
  }
  if (constant) {
    w.bits(0b00000000, 8); // pad, CONSTANT, no wasted bits
    w.bits(x[0] & ((1 << bps) - 1), bps);
    return;
  }

  const maxOrder = Math.min(4, n - 1);
  let bestOrder = 0;
  let bestSum = Infinity;
  for (let order = 0; order <= maxOrder; order++) {
    let s = 0;
    for (let i = order; i < n; i++) s += Math.abs(fixedResidual(x, i, order));
    if (s < bestSum) {
      bestSum = s;
      bestOrder = order;
    }
  }
  const order = bestOrder;
  const folded = new Uint32Array(n - order);
  for (let i = order; i < n; i++) {
    const r = fixedResidual(x, i, order);
    folded[i - order] = r >= 0 ? r * 2 : -r * 2 - 1;
  }
  const plan = planRice(folded, n, order);
  // exact cost of that plan, so the verbatim fallback compares like with like
  let exact = 8 + order * bps + 6 + (1 << plan.partitionOrder) * (plan.method ? 5 : 4);
  const plen = n >> plan.partitionOrder;
  for (let p = 0; p < 1 << plan.partitionOrder; p++) {
    const k = plan.params[p];
    const s = p === 0 ? order : p * plen;
    const e = (p + 1) * plen;
    for (let i = s; i < e; i++) exact += (folded[i - order] >>> k) + 1 + k;
  }
  if (exact >= 8 + n * bps) {
    w.bits(0b00000010, 8); // VERBATIM
    const mask = (1 << bps) - 1;
    for (let i = 0; i < n; i++) w.bits(x[i] & mask, bps);
    return;
  }

  w.bits(0b00010000 | (order << 1), 8); // pad, FIXED 001xxx, no wasted bits
  const mask = (1 << bps) - 1;
  for (let i = 0; i < order; i++) w.bits(x[i] & mask, bps);
  w.bits(plan.method, 2);
  w.bits(plan.partitionOrder, 4);
  const paramBits = plan.method ? 5 : 4;
  for (let p = 0; p < 1 << plan.partitionOrder; p++) {
    const k = plan.params[p];
    w.bits(k, paramBits);
    const s = p === 0 ? order : p * plen;
    const e = (p + 1) * plen;
    const lowMask = k > 0 ? (1 << k) - 1 : 0;
    for (let i = s; i < e; i++) {
      const u = folded[i - order];
      w.unary(u >>> k);
      if (k > 0) w.bits(u & lowMask, k);
    }
  }
}

/**
 * Encode float channels (all the same length) to a FLAC file. `yieldEvery`
 * frames the async form hands the main thread back, so a five-minute stem
 * (a second or two of work) does not freeze a playhead.
 */
export async function encodeFlacAsync(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: FlacOptions = {},
  yieldEvery = 64,
): Promise<Uint8Array> {
  const enc = flacFrames(channels, sampleRate, options);
  let step = enc.next();
  let i = 0;
  while (!step.done) {
    if (++i % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
    step = enc.next();
  }
  return step.value;
}

export function encodeFlac(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: FlacOptions = {},
): Uint8Array {
  const enc = flacFrames(channels, sampleRate, options);
  let step = enc.next();
  while (!step.done) step = enc.next();
  return step.value;
}

function* flacFrames(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: FlacOptions,
): Generator<void, Uint8Array, void> {
  const bps = options.bitsPerSample ?? 16;
  const blockSize = options.blockSize ?? 4096;
  const nch = channels.length;
  if (nch < 1 || nch > 8) throw new Error("flac: 1 to 8 channels");
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate >= 1 << 20) {
    throw new Error("flac: unsupported sample rate");
  }
  const total = channels[0].length;
  for (const c of channels) if (c.length !== total) throw new Error("flac: channel lengths differ");
  const ints = channels.map((c) => quantize(c, bps));

  const w = new BitWriter(Math.ceil((total * nch * bps) / 8 / 1.5) + 1024);
  // "fLaC" + STREAMINFO (last metadata block)
  for (const ch of "fLaC") w.bits(ch.charCodeAt(0), 8);
  w.bits(0x80, 8); // last block, type 0
  w.bits(34, 24);
  const streaminfoAt = w.len;
  const declaredBlock = Math.max(16, Math.min(blockSize, total || blockSize));
  w.bits(declaredBlock, 16);
  w.bits(declaredBlock, 16);
  w.bits(0, 24); // min frame size, patched below
  w.bits(0, 24); // max frame size, patched below
  w.bits(sampleRate, 20);
  w.bits(nch - 1, 3);
  w.bits(bps - 1, 5);
  w.bits(Math.floor(total / 2 ** 32), 4);
  w.bits(Math.floor(total / 65536) & 0xffff, 16);
  w.bits(total & 0xffff, 16);
  for (let i = 0; i < 16; i++) w.bits(0, 8); // MD5 not computed

  const srCode = SAMPLE_RATE_CODES[sampleRate] ?? 0;
  const bpsCode = bps === 16 ? 0b100 : 0b110;
  let minFrame = Infinity;
  let maxFrame = 0;
  let frame = 0;
  for (let start = 0; start < total; start += blockSize, frame++) {
    const n = Math.min(blockSize, total - start);
    const frameStart = w.len;
    w.bits(0b11111111111110, 14);
    w.bits(0, 1);
    w.bits(0, 1); // fixed blocksize stream
    let bsCode: number;
    if (n === 4096) bsCode = 0b1100;
    else if (n <= 256) bsCode = 0b0110;
    else bsCode = 0b0111;
    w.bits(bsCode, 4);
    w.bits(srCode, 4);
    w.bits(nch - 1, 4); // independent channels
    w.bits(bpsCode, 3);
    w.bits(0, 1);
    writeFrameNumber(w, frame);
    if (bsCode === 0b0110) w.bits(n - 1, 8);
    else if (bsCode === 0b0111) w.bits(n - 1, 16);
    w.bits(crc8(w.buf, frameStart, w.len), 8);
    for (let c = 0; c < nch; c++) encodeSubframe(w, ints[c].subarray(start, start + n), bps);
    w.align();
    w.bits(crc16(w.buf, frameStart, w.len), 16);
    const size = w.len - frameStart;
    if (size < minFrame) minFrame = size;
    if (size > maxFrame) maxFrame = size;
    yield;
  }
  const out = w.buf.slice(0, w.len);
  if (maxFrame > 0) {
    const put24 = (at: number, v: number) => {
      out[at] = (v >> 16) & 0xff;
      out[at + 1] = (v >> 8) & 0xff;
      out[at + 2] = v & 0xff;
    };
    put24(streaminfoAt + 4, minFrame);
    put24(streaminfoAt + 7, maxFrame);
  }
  return out;
}
