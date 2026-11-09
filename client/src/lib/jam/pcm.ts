/**
 * PCM helpers shared by the encoders: float to integer, and the WAV writer
 * (the mixdown export and the fallback when a stem must not be FLAC).
 */

/**
 * Float (-1..1) to signed integers of `bits` bits. Scales by 2^(bits-1) and
 * clamps, so a decoder that divides by 2^(bits-1) (every browser does) gets
 * back exactly the float it was given whenever that float was already on the
 * grid. No dither: at 16 bits the truncation floor is -96 dBFS, under any
 * guitar amp's hiss.
 */
export function quantize(samples: Float32Array, bits: 16 | 24): Int32Array {
  const scale = bits === 16 ? 32768 : 8388608;
  const max = scale - 1;
  const min = -scale;
  const out = new Int32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * scale);
    out[i] = v > max ? max : v < min ? min : v;
  }
  return out;
}

/** A canonical 44-byte-header PCM WAV, 16 or 24 bit, any channel count. */
export function encodeWav(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  bits: 16 | 24 = 16,
): Uint8Array {
  const n = channels[0]?.length ?? 0;
  const nch = channels.length;
  const bytesPer = bits / 8;
  const dataLen = n * nch * bytesPer;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * bytesPer, true);
  dv.setUint16(32, nch * bytesPer, true);
  dv.setUint16(34, bits, true);
  tag(36, "data");
  dv.setUint32(40, dataLen, true);
  // quantised inline, sample by sample: no full-length integer copies
  const scale = bits === 16 ? 32768 : 8388608;
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const q = Math.round(channels[c][i] * scale);
      const v = q > scale - 1 ? scale - 1 : q < -scale ? -scale : q;
      buf[o++] = v & 0xff;
      buf[o++] = (v >> 8) & 0xff;
      if (bits === 24) buf[o++] = (v >> 16) & 0xff;
    }
  }
  return buf;
}
