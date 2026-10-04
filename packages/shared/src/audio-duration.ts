/**
 * How long an mp3 or ogg clip is, from its header. No decode and no
 * ffmpeg: a soundboard upload is at most half a megabyte, and walking
 * that is enough to refuse a file that is longer than the cap.
 *
 * Returns null when the bytes are not a clip we can time. Callers treat
 * null as "do not store this", never as "duration zero".
 */

const MPEG1_L3_BITRATES = [
  0, 32000, 40000, 48000, 56000, 64000, 80000, 96000, 112000, 128000, 160000,
  192000, 224000, 256000, 320000, 0,
];

const MPEG1_RATES = [44100, 48000, 32000];

export function audioDurationMs(
  bytes: Uint8Array,
  contentType: string,
): number | null {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "audio/mpeg" || type === "audio/mp3") {
    return mp3DurationMs(bytes);
  }
  if (type === "audio/ogg") {
    return oggDurationMs(bytes);
  }
  return null;
}

/**
 * Why a clip cannot be stored, or null when it can.
 *
 * Size and duration are both checked here so the upload route and the
 * client say the same word for the same file.
 */
export function soundboardClipRejection(
  byteLength: number,
  durationMs: number | null,
  maxBytes: number,
  maxDurationMs: number,
): "too_big" | "too_long" | "unreadable" | null {
  if (byteLength <= 0 || byteLength > maxBytes) {
    return "too_big";
  }
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 40) {
    return "unreadable";
  }
  if (durationMs > maxDurationMs) {
    return "too_long";
  }
  return null;
}

function mp3DurationMs(bytes: Uint8Array): number | null {
  let offset = skipId3(bytes);
  let samples = 0;
  let rate = 0;
  let frames = 0;
  while (offset + 4 < bytes.length && frames < 20_000) {
    const header = readMp3Header(bytes, offset);
    if (!header) {
      offset += 1;
      continue;
    }
    if (rate === 0) {
      rate = header.sampleRate;
    }
    if (header.sampleRate !== rate) {
      break;
    }
    samples += 1152;
    frames += 1;
    offset += header.frameBytes;
  }
  if (frames === 0 || rate === 0) {
    return null;
  }
  return Math.round((samples * 1000) / rate);
}

function skipId3(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return 0;
  }
  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  const next = 10 + size;
  return next < bytes.length ? next : 0;
}

function readMp3Header(
  bytes: Uint8Array,
  offset: number,
): { frameBytes: number; sampleRate: number } | null {
  if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) {
    return null;
  }
  const version = (bytes[offset + 1]! >> 3) & 0x03;
  const layer = (bytes[offset + 1]! >> 1) & 0x03;
  // MPEG1, Layer 3 only. That is what a person exports. Other layers
  // are refused rather than guessed.
  if (version !== 0x03 || layer !== 0x01) {
    return null;
  }
  const bitrateIndex = (bytes[offset + 2]! >> 4) & 0x0f;
  const rateIndex = (bytes[offset + 2]! >> 2) & 0x03;
  const padding = (bytes[offset + 2]! >> 1) & 0x01;
  const bitrate = MPEG1_L3_BITRATES[bitrateIndex] ?? 0;
  const sampleRate = MPEG1_RATES[rateIndex] ?? 0;
  if (bitrate === 0 || sampleRate === 0) {
    return null;
  }
  const frameBytes = Math.floor((144 * bitrate) / sampleRate) + padding;
  if (frameBytes < 4 || offset + frameBytes > bytes.length) {
    return null;
  }
  return { frameBytes, sampleRate };
}

function oggDurationMs(bytes: Uint8Array): number | null {
  let offset = 0;
  let lastGranule = 0;
  let preSkip = 0;
  let sampleRate = 0;
  let codec: "opus" | "vorbis" | null = null;

  while (offset + 27 <= bytes.length) {
    if (
      bytes[offset] !== 0x4f ||
      bytes[offset + 1] !== 0x67 ||
      bytes[offset + 2] !== 0x67 ||
      bytes[offset + 3] !== 0x53
    ) {
      break;
    }
    const granule = readU64(bytes, offset + 6);
    if (granule > 0) {
      lastGranule = granule;
    }
    const segments = bytes[offset + 26] ?? 0;
    if (offset + 27 + segments > bytes.length) {
      break;
    }
    let body = 0;
    for (let i = 0; i < segments; i += 1) {
      body += bytes[offset + 27 + i] ?? 0;
    }
    const start = offset + 27 + segments;
    const end = start + body;
    if (end > bytes.length) {
      break;
    }
    const head = identifyOgg(bytes.subarray(start, end));
    if (head) {
      codec = head.codec;
      if (head.codec === "opus") {
        preSkip = head.preSkip;
        sampleRate = 48000;
      } else {
        sampleRate = head.sampleRate;
      }
    }
    offset = end;
  }

  if (!codec || sampleRate <= 0 || lastGranule <= 0) {
    return null;
  }
  const samples = codec === "opus" ? lastGranule - preSkip : lastGranule;
  if (samples <= 0) {
    return null;
  }
  return Math.round((samples * 1000) / sampleRate);
}

function identifyOgg(
  body: Uint8Array,
):
  | { codec: "opus"; preSkip: number }
  | { codec: "vorbis"; sampleRate: number }
  | null {
  const opus = indexOfAscii(body, "OpusHead");
  if (opus >= 0 && opus + 12 <= body.length) {
    const preSkip = body[opus + 10]! | (body[opus + 11]! << 8);
    return { codec: "opus", preSkip };
  }
  const vorbis = indexOfAscii(body, "vorbis");
  // Identification header is 0x01 + "vorbis", sample rate at byte 12 of that packet.
  if (vorbis >= 1 && body[vorbis - 1] === 0x01 && vorbis + 11 <= body.length) {
    const sampleRate =
      body[vorbis + 7]! |
      (body[vorbis + 8]! << 8) |
      (body[vorbis + 9]! << 16) |
      (body[vorbis + 10]! << 24);
    if (sampleRate > 0) {
      return { codec: "vorbis", sampleRate };
    }
  }
  return null;
}

function indexOfAscii(bytes: Uint8Array, needle: string): number {
  const first = needle.charCodeAt(0);
  for (let i = 0; i <= bytes.length - needle.length; i += 1) {
    if (bytes[i] !== first) {
      continue;
    }
    let match = true;
    for (let j = 1; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }
  return -1;
}

function readU64(bytes: Uint8Array, offset: number): number {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    value += (bytes[offset + i] ?? 0) * 2 ** (8 * i);
  }
  return value;
}
