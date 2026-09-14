/**
 * Reads a CMAF video init segment's `avcC` box (ISO/IEC 14496-15) to build
 * the RFC 6381 `avc1.PPCCLL` codec string an LL multivariant playlist's
 * `CODECS` attribute needs (`docs/plans/LL_HLS.md` task `L2.2`, "CODECS from
 * the init segments (avc1 profile string from SPS...)"), plus the sample
 * entry's own width/height for `RESOLUTION`.
 *
 * HAND-ROLLED BOX WALKING, NOT AN MP4 LIBRARY. Same reasoning
 * `tools/pqp-remux/README.md`'s R2 writer section gives for hand-rolling
 * SigV4 instead of pulling in `aws-sdk-go-v2`: this needs exactly one path
 * through one well-documented box tree
 * (`moov > trak > mdia > minf > stbl > stsd > avc1 > avcC`) out of a segment
 * this codebase's own pipeline wrote (`tools/pqp-remux/internal/cmaf`), not
 * general MP4 parsing.
 *
 * `mp4a.40.2` (AAC-LC) needs no such walk: `tools/pqp-remux/README.md`'s
 * audio section names `internal/aacenc` as LC-only, so that half of
 * `CODECS` is a constant, exported below rather than read from
 * `audio-init.mp4`'s `esds` box.
 *
 * Plain JS, `Uint8Array` only, no Workers-only or Node-only API — testable
 * with a synthetic init segment the test itself builds (`extractAvc1VideoInfo`
 * takes only bytes and returns only numbers/strings), no fixture file and no
 * real encoder needed.
 */

/** AAC-LC, the only profile `tools/pqp-remux`'s audio pipeline produces — see this file's header. */
export const AAC_LC_CODEC = "mp4a.40.2";

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readU32(bytes, offset) {
  // Built with multiplication rather than `<< 24` for the top byte: a
  // signed 32-bit shift would turn a box size at or above 0x80000000 into a
  // negative number, and while no init segment this pipeline writes gets
  // anywhere near 2 GiB, a corrupt or hostile response should fail the
  // bounds checks below rather than wrap into a bogus-but-valid-looking box.
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

/**
 * @typedef {{ type: string, headerEnd: number, end: number }} Mp4Box
 */

/**
 * One level of ISO-BMFF boxes between `start` and `end`. Does not recurse —
 * callers walk one level at a time, which is all the fixed path below needs
 * and keeps this function trivially bounded (a box's `end` is always
 * clamped to the parent's `end`, so a malformed size can shrink a box, never
 * grow one past its container).
 *
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {Mp4Box[]}
 */
function readBoxes(bytes, start, end) {
  /** @type {Mp4Box[]} */
  const result = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = readU32(bytes, offset);
    if (size < 8) {
      // A 64-bit "largesize" box (size field == 1) or a malformed one —
      // neither is expected anywhere in this pipeline's own init segments,
      // and stopping here (rather than mis-reading eight more bytes as a
      // size) is the safe failure.
      break;
    }
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const boxEnd = Math.min(offset + size, end);
    result.push({ type, headerEnd: offset + 8, end: boxEnd });
    offset = boxEnd;
  }
  return result;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {Mp4Box | null}
 */
function findBox(bytes, start, end, type) {
  return readBoxes(bytes, start, end).find((box) => box.type === type) ?? null;
}

/**
 * @param {number} value
 * @returns {string}
 */
function toHex2(value) {
  return value.toString(16).padStart(2, "0");
}

/**
 * @param {ArrayBuffer | Uint8Array} initMp4
 * @returns {{ codec: string, width: number, height: number } | null} `null`
 *   when the expected box path is not found — a malformed or unexpected
 *   init segment, which the caller treats as "could not build the LL master
 *   this time", never a crash.
 */
export function extractAvc1VideoInfo(initMp4) {
  const bytes = initMp4 instanceof Uint8Array ? initMp4 : new Uint8Array(initMp4);
  const moov = findBox(bytes, 0, bytes.length, "moov");
  if (!moov) return null;
  const trak = findBox(bytes, moov.headerEnd, moov.end, "trak");
  if (!trak) return null;
  const mdia = findBox(bytes, trak.headerEnd, trak.end, "mdia");
  if (!mdia) return null;
  const minf = findBox(bytes, mdia.headerEnd, mdia.end, "minf");
  if (!minf) return null;
  const stbl = findBox(bytes, minf.headerEnd, minf.end, "stbl");
  if (!stbl) return null;
  const stsd = findBox(bytes, stbl.headerEnd, stbl.end, "stsd");
  if (!stsd) return null;

  // `stsd` is a FullBox: 1 byte version + 3 bytes flags, then a 4-byte
  // entry_count, THEN the sample entries — each one box-shaped in its own
  // right (size + 4-char type, here "avc1"), so `readBoxes` walks it the
  // same way as any other container.
  const entriesStart = stsd.headerEnd + 4 /* version+flags */ + 4 /* entry_count */;
  const avc1 = readBoxes(bytes, entriesStart, stsd.end)[0];
  if (!avc1 || avc1.type !== "avc1") return null;

  // VisualSampleEntry's fixed fields before any child box: SampleEntry's
  // 6-byte reserved + 2-byte data_reference_index (8), then 2-byte
  // pre_defined + 2-byte reserved + 12-byte pre_defined[3] (16), THEN
  // width (2) and height (2) at +24/+26, then horiz/vert resolution (4+4),
  // reserved (4), frame_count (2), compressorname (32), depth (2),
  // pre_defined (2) — 78 bytes total before the first child box (`avcC`).
  const fixedStart = avc1.headerEnd;
  const width = (bytes[fixedStart + 24] << 8) | bytes[fixedStart + 25];
  const height = (bytes[fixedStart + 26] << 8) | bytes[fixedStart + 27];
  const childStart = fixedStart + 78;
  const avcC = findBox(bytes, childStart, avc1.end, "avcC");
  if (!avcC) return null;

  const payload = bytes.subarray(avcC.headerEnd, avcC.end);
  // AVCDecoderConfigurationRecord: [0] configurationVersion (always 1),
  // [1] AVCProfileIndication, [2] profile_compatibility, [3] AVCLevelIndication.
  if (payload.length < 4) return null;
  const codec = `avc1.${toHex2(payload[1])}${toHex2(payload[2])}${toHex2(payload[3])}`;

  return { codec, width, height };
}
