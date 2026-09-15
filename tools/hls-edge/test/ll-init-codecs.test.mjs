import { strict as assert } from "node:assert";
import test from "node:test";

import { AAC_LC_CODEC, extractAvc1VideoInfo } from "../src/ll-init-codecs.js";

/** Big-endian uint32 as 4 bytes. */
function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Big-endian uint16 as 2 bytes. */
function u16(n) {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function ascii(s) {
  return Array.from(s).map((c) => c.charCodeAt(0));
}

/** size(4) + type(4) + payload, size computed automatically. */
function box(type, payloadBytes) {
  const body = [...ascii(type), ...payloadBytes];
  return [...u32(body.length + 4), ...body];
}

/**
 * A minimal `moov > trak > mdia > minf > stbl > stsd > avc1 > avcC` tree,
 * just deep/wide enough for `extractAvc1VideoInfo`'s fixed box walk —
 * every irrelevant sibling box (`mvhd`, `tkhd`, etc.) is omitted since the
 * walker only ever looks for the ONE named child at each level.
 *
 * @param {{ profile: number, compat: number, level: number, width: number, height: number }} opts
 */
function buildInitSegment({ profile, compat, level, width, height }) {
  const avcC = box("avcC", [
    1, // configurationVersion
    profile,
    compat,
    level,
    0xff, // lengthSizeMinusOne (top 6 bits reserved) | 3 -> 4-byte NAL length
    0xe1, // numOfSequenceParameterSets (top 3 bits reserved) | 1
    ...u16(4),
    0xaa,
    0xbb,
    0xcc,
    0xdd, // a fake (but present) SPS, contents irrelevant to this parser
    1, // numOfPictureParameterSets
    ...u16(2),
    0xee,
    0xff, // a fake PPS
  ]);

  // VisualSampleEntry fixed fields: SampleEntry (8 bytes: 6 reserved + 2
  // data_reference_index) + 16 bytes (pre_defined/reserved/pre_defined[3])
  // + width(2) + height(2) + horiz/vert resolution(4+4) + reserved(4) +
  // frame_count(2) + compressorname(32) + depth(2) + pre_defined(2) = 78
  // bytes total, then avcC.
  const visualSampleEntryFixed = [
    ...new Array(8).fill(0), // SampleEntry: reserved[6] + data_reference_index[2]
    ...new Array(16).fill(0), // pre_defined + reserved + pre_defined[3]
    ...u16(width),
    ...u16(height),
    ...u32(0x00480000), // horizresolution
    ...u32(0x00480000), // vertresolution
    ...u32(0), // reserved
    ...u16(1), // frame_count
    ...new Array(32).fill(0), // compressorname
    ...u16(0x0018), // depth
    ...u16(0xffff), // pre_defined
  ];
  assert.equal(visualSampleEntryFixed.length, 78);

  const avc1 = box("avc1", [...visualSampleEntryFixed, ...avcC]);
  const stsd = box("stsd", [
    0,
    0,
    0,
    0, // FullBox: version + flags
    ...u32(1), // entry_count
    ...avc1,
  ]);
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", minf);
  const trak = box("trak", mdia);
  const moov = box("moov", trak);
  const ftyp = box("ftyp", [...ascii("iso5"), ...u32(0), ...ascii("iso5"), ...ascii("dash")]);
  return new Uint8Array([...ftyp, ...moov]);
}

test("extracts profile/compat/level as an RFC 6381 avc1.PPCCLL codec string", () => {
  const bytes = buildInitSegment({ profile: 0x64, compat: 0x00, level: 0x28, width: 1920, height: 1080 });
  const info = extractAvc1VideoInfo(bytes);
  assert.ok(info);
  assert.equal(info.codec, "avc1.640028");
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
});

test("a different profile/level produces a different codec string", () => {
  const bytes = buildInitSegment({ profile: 0x4d, compat: 0x40, level: 0x1f, width: 1280, height: 720 });
  const info = extractAvc1VideoInfo(bytes);
  assert.ok(info);
  assert.equal(info.codec, "avc1.4d401f");
  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
});

test("accepts a plain ArrayBuffer, not just a Uint8Array", () => {
  const bytes = buildInitSegment({ profile: 0x64, compat: 0x00, level: 0x28, width: 640, height: 480 });
  const info = extractAvc1VideoInfo(bytes.buffer);
  assert.ok(info);
  assert.equal(info.codec, "avc1.640028");
});

test("returns null for bytes with no moov box at all", () => {
  const info = extractAvc1VideoInfo(new Uint8Array([...ascii("junk"), 1, 2, 3, 4]));
  assert.equal(info, null);
});

test("returns null when the box tree is missing avcC (e.g. no trak inside moov)", () => {
  const moov = box("moov", []);
  const bytes = new Uint8Array(moov);
  assert.equal(extractAvc1VideoInfo(bytes), null);
});

test("returns null when stsd's first entry is not avc1", () => {
  const otherEntry = box("mp4v", new Array(78).fill(0));
  const stsd = box("stsd", [0, 0, 0, 0, ...u32(1), ...otherEntry]);
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", minf);
  const trak = box("trak", mdia);
  const moov = box("moov", trak);
  assert.equal(extractAvc1VideoInfo(new Uint8Array(moov)), null);
});

test("AAC_LC_CODEC is the fixed mp4a.40.2 string", () => {
  assert.equal(AAC_LC_CODEC, "mp4a.40.2");
});
