/**
 * What an image's own first bytes say about it: its real format and its size
 * in pixels, read from the header with no decoder and no dependency.
 *
 * It exists for the share card. `og:image:width` / `height` / `type` are what
 * let an unfurler decide, before it downloads anything, whether the picture is
 * big enough for a large card, and the stored `Content-Type` is only what the
 * uploader CLAIMED (the claim `HEAD`s the size, not the format). Four formats,
 * because they are the four X accepts for a card (jpeg, png, webp, gif);
 * anything else answers null and the caller treats the picture as "unknown",
 * never as "wrong".
 *
 * Every read is bounds-checked: the buffer is a prefix of an object from a
 * bucket, which is to say attacker-shaped, and a truncated or lying header
 * must come back as null rather than throw or loop.
 */

export type SniffedImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface ImageInfo {
  type: SniffedImageType;
  width: number;
  height: number;
}

/** A 0x0 or an absurd size is a corrupt header, not a picture. */
function sane(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 65_535 && height <= 65_535;
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function png(bytes: Uint8Array): ImageInfo | null {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
  if (bytes.length < 24 || !ascii(bytes, 12, "IHDR")) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return sane(width, height) ? { type: "image/png", width, height } : null;
}

function gif(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  return sane(width, height) ? { type: "image/gif", width, height } : null;
}

function webp(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 30) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width: number;
  let height: number;
  if (ascii(bytes, 12, "VP8 ")) {
    // Lossy: a 3-byte frame tag, the 9d 01 2a start code, then 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    width = view.getUint16(26, true) & 0x3fff;
    height = view.getUint16(28, true) & 0x3fff;
  } else if (ascii(bytes, 12, "VP8L")) {
    // Lossless: signature 0x2f, then two 14-bit (size - 1) fields in 28 bits.
    if (bytes[20] !== 0x2f) {
      return null;
    }
    const bits = view.getUint32(21, true);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (ascii(bytes, 12, "VP8X")) {
    // Extended: canvas size minus one, 24 bits each.
    width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
  } else {
    return null;
  }
  return sane(width, height) ? { type: "image/webp", width, height } : null;
}

/** Start-of-frame markers, the ones that carry a size (not DHT, JPG, DAC). */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function jpeg(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  // Each segment is 0xFF, a marker byte, a 2-byte length that includes itself.
  // A bounded walk: a header that never reaches a frame is simply "unknown".
  for (let steps = 0; steps < 256 && at + 4 <= bytes.length; steps += 1) {
    if (bytes[at] !== 0xff) {
      return null;
    }
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      // Fill byte before a marker.
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2);
    if (length < 2) {
      return null;
    }
    if (isStartOfFrame(marker)) {
      if (at + 9 > bytes.length) {
        return null;
      }
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      return sane(width, height) ? { type: "image/jpeg", width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}

/** The format and pixel size an image's first bytes declare, or null. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return jpeg(bytes);
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) {
    return png(bytes);
  }
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) {
    return gif(bytes);
  }
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    return webp(bytes);
  }
  return null;
}
