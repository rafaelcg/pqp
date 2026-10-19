/**
 * What the emulator room can run, by the picked file's extension.
 *
 * Two cores ship (`lib/emulator-assets.ts`): FCEUmm for the NES and mGBA for
 * Game Boy, Game Boy Color and Game Boy Advance. SNES (Snes9x) and Mega Drive
 * (Genesis Plus GX, PicoDrive) were evaluated and are NOT here, because their
 * licenses forbid commercial use and AGPL-3.0 cannot carry that; the reasons
 * and what could replace them are in `docs/EMULATOR_ROOM.md`.
 *
 * Archives (`.zip` and the like) are refused on purpose: one file, one system,
 * nothing unpacked.
 */

export type EmulatorSystem = "nes" | "gb" | "gbc" | "gba";

const SYSTEM_BY_EXTENSION: Readonly<Record<string, EmulatorSystem>> = {
  nes: "nes",
  gb: "gb",
  gbc: "gbc",
  gba: "gba",
};

/** The extensions the file picker offers, with their dots, for `accept`. */
export const EMULATOR_ACCEPT = Object.keys(SYSTEM_BY_EXTENSION)
  .map((extension) => `.${extension}`)
  .join(",");

/** The system a file name belongs to, or null when it is not one we run. */
export function systemForFileName(name: string): EmulatorSystem | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return SYSTEM_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Past this a file is not a console game of these systems (GBA tops out at 32 MB). */
export const EMULATOR_MAX_BYTES = 64 * 1024 * 1024;
