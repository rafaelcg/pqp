/**
 * Just-enough cartridges for the unit tests: bytes with the header each console reads first and nothing else.
 * Written from scratch, no game and no part of one. Test code only: nothing in the app imports this file.
 */

const LOGO = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

export function nesCartridge(): Uint8Array {
  const bytes = new Uint8Array(16 + 16 * 1024 + 8 * 1024);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 1], 0);
  return bytes;
}

export function gameBoyCartridge(): Uint8Array {
  const bytes = new Uint8Array(0x8000);
  bytes.set(LOGO, 0x104);
  return bytes;
}

export function gbaCartridge(): Uint8Array {
  const bytes = new Uint8Array(0x200);
  bytes[0xb2] = 0x96;
  return bytes;
}

/** 32 KB of LoROM with a header at 0x7FC0: a title, map mode 0x20 and a checksum pair that agree. */
export function snesCartridge(): Uint8Array {
  const bytes = new Uint8Array(0x8000);
  bytes.set(Array.from("PQP TEST CARTRIDGE".padEnd(21, " "), (c) => c.charCodeAt(0)), 0x7fc0);
  bytes[0x7fd5] = 0x20;
  // checksum 0x1234, complement 0xEDCB
  bytes.set([0xcb, 0xed, 0x34, 0x12], 0x7fdc);
  return bytes;
}

/** A valid cartridge for the extension (with its dot), as the buffer the host's picker hands over. */
export function cartridgeFor(ext: string): ArrayBuffer {
  const bytes =
    ext === ".nes"
      ? nesCartridge()
      : ext === ".gba"
        ? gbaCartridge()
        : ext === ".sfc" || ext === ".smc"
          ? snesCartridge()
          : gameBoyCartridge();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
