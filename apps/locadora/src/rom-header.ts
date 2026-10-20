/**
 * Reading a cartridge's own title out of the file the person picked.
 *
 * Why: the shelf draws a box for every tape, and a name read from the header is
 * a better label than a file name like "game (1).gb". Everything here is local:
 * the bytes are the ones already in memory, nothing is sent anywhere.
 *
 * Where the title lives, by platform:
 *   - Game Boy / Color: 0x134, up to 16 bytes (15 on a Color cart that uses the
 *     last byte as its CGB flag).
 *   - Game Boy Advance: 0xA0, 12 bytes, and the 4 byte game code at 0xAC.
 *   - SNES: 21 bytes at 0x7FC0 (LoROM) or 0xFFC0 (HiROM), shifted by 512 when a
 *     copier header leads the file (the file size is 512 past a multiple of 1024).
 *   - NES: iNES carries no title at all, so there is nothing to read.
 *
 * A header is untrusted input. The result is always printable ASCII, trimmed,
 * at most `MAX_TITLE_LENGTH` characters, and never throws on a short file.
 */

export type RomPlatform = "nes" | "snes" | "gb" | "gbc" | "gba";

export const MAX_TITLE_LENGTH = 24;

export interface RomHeaderInfo {
  /** Sanitised title, 1 to 24 printable characters. */
  title: string;
  /** GBA only: the four character game code, sanitised. */
  gameCode?: string;
}

/**
 * Keep printable ASCII (0x20 to 0x7E), stop at the first NUL, turn any other
 * byte into a space, collapse runs of spaces, trim, cap at 24. Accepts bytes or a string.
 */
export function sanitiseTitle(raw: Uint8Array | string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = typeof raw === "string" ? raw.charCodeAt(i) : (raw[i] as number);
    if (code === 0) break;
    out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : " ";
  }
  return out.replace(/ +/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
}

/** A title from a file name: no folder, no extension, underscores as spaces, same sanitising. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return sanitiseTitle(base.replace(/_+/g, " "));
}

/** True when the byte at 0x143 marks a Game Boy Color cartridge. */
export function isGameBoyColor(bytes: Uint8Array): boolean {
  const flag = bytes[0x143];
  return flag === 0x80 || flag === 0xc0;
}

function readGameBoy(bytes: Uint8Array): RomHeaderInfo | null {
  if (bytes.length < 0x150) return null;
  const end = isGameBoyColor(bytes) ? 0x143 : 0x144;
  const title = sanitiseTitle(bytes.subarray(0x134, end));
  return title ? { title } : null;
}

function readGba(bytes: Uint8Array): RomHeaderInfo | null {
  if (bytes.length < 0xb0) return null;
  const title = sanitiseTitle(bytes.subarray(0xa0, 0xac));
  const code = sanitiseTitle(bytes.subarray(0xac, 0xb0));
  const gameCode = code.length === 4 ? code : undefined;
  const shown = title || gameCode || "";
  if (!shown) return null;
  return gameCode ? { title: shown, gameCode } : { title: shown };
}

/**
 * How much 32 bytes at `at` look like a SNES header. The checksum complement
 * pair is the strong signal; the map mode agreeing with the address and an
 * all-printable title are the weak ones. -1 means out of range.
 */
function snesScore(bytes: Uint8Array, at: number, hiRom: boolean): number {
  if (at + 0x20 > bytes.length) return -1;
  let score = 0;
  const complement = (bytes[at + 0x1c] as number) | ((bytes[at + 0x1d] as number) << 8);
  const checksum = (bytes[at + 0x1e] as number) | ((bytes[at + 0x1f] as number) << 8);
  if ((complement ^ checksum) === 0xffff && checksum !== 0) score += 4;
  const mapMode = (bytes[at + 0x15] as number) & 0x0f;
  if (hiRom ? mapMode === 1 || mapMode === 5 : mapMode === 0 || mapMode === 2) score += 2;
  let printable = 0;
  for (let i = 0; i < 21; i++) {
    const c = bytes[at + i] as number;
    if (c >= 0x20 && c <= 0x7e) printable++;
  }
  if (printable === 21) score += 1;
  return score;
}

function readSnes(bytes: Uint8Array): RomHeaderInfo | null {
  const shift = bytes.length % 1024 === 512 ? 512 : 0;
  const candidates = [
    { at: 0x7fc0 + shift, hiRom: false },
    { at: 0xffc0 + shift, hiRom: true },
  ];
  let bestAt = -1;
  let bestScore = 0;
  for (const c of candidates) {
    const score = snesScore(bytes, c.at, c.hiRom);
    if (score > bestScore) {
      bestScore = score;
      bestAt = c.at;
    }
  }
  if (bestAt < 0) return null;
  const title = sanitiseTitle(bytes.subarray(bestAt, bestAt + 21));
  return title ? { title } : null;
}

/** The cartridge's own title, or null when the platform has none or the header is blank or out of range. */
export function readRomHeader(bytes: Uint8Array, platform: RomPlatform): RomHeaderInfo | null {
  switch (platform) {
    case "gb":
    case "gbc":
      return readGameBoy(bytes);
    case "gba":
      return readGba(bytes);
    case "snes":
      return readSnes(bytes);
    case "nes":
      return null;
  }
}

/* ---- is this a cartridge at all? ---- */

/** Why a picked file is not taken for a cartridge of its system. */
export type RomRefusal = "empty" | "size" | "header";

export type RomVerdict = { ok: true } | { ok: false; reason: RomRefusal };

/** The largest image each system ever shipped (GBA: 32 MB, the biggest game pak; the others 8 MB, with room to spare). */
export const MAX_ROM_BYTES: Readonly<Record<RomPlatform, number>> = {
  nes: 8 * 1024 * 1024,
  snes: 8 * 1024 * 1024,
  gb: 8 * 1024 * 1024,
  gbc: 8 * 1024 * 1024,
  gba: 32 * 1024 * 1024,
};

/** The smallest a file can be and still hold what the console reads first: the iNES header and one bank, the 0x150 header, the GBA's 192 bytes. */
export const MIN_ROM_BYTES: Readonly<Record<RomPlatform, number>> = {
  nes: 16 + 16 * 1024,
  snes: 0x8000,
  gb: 0x150,
  gbc: 0x150,
  gba: 0xc0,
};

/** The Nintendo logo every Game Boy header carries at 0x104: the hardware refuses a cartridge without it, so any real homebrew has it. */
const GAME_BOY_LOGO = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
] as const;

/**
 * Whether the bytes look like a cartridge of `platform`, judged from what the console reads first: the iNES magic,
 * the Game Boy logo, the GBA's fixed 0x96 byte. Header CHECKSUMS are not demanded (a homebrew tool that skipped one
 * still runs); an empty file, a text file, a file of zeros and a file of the wrong size never pass. It reads a few
 * dozen bytes and keeps nothing.
 */
export function checkRom(bytes: Uint8Array, platform: RomPlatform): RomVerdict {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length < MIN_ROM_BYTES[platform] || bytes.length > MAX_ROM_BYTES[platform]) return { ok: false, reason: "size" };
  const header = (ok: boolean): RomVerdict => (ok ? { ok: true } : { ok: false, reason: "header" });
  switch (platform) {
    case "nes":
      return header(bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a);
    case "gb":
    case "gbc":
      return header(GAME_BOY_LOGO.every((byte, i) => bytes[0x104 + i] === byte));
    case "gba":
      return header(bytes[0xb2] === 0x96);
    case "snes":
      return header(readSnes(bytes) !== null);
  }
}

/** Header title when there is one, else the file name's, else the fallback the caller supplies. */
export function resolveRomTitle(
  bytes: Uint8Array,
  platform: RomPlatform,
  fileName: string,
  fallback: string,
): string {
  return readRomHeader(bytes, platform)?.title || titleFromFileName(fileName) || fallback;
}
