/**
 * What Locadora can run, by the extension the host's picker reports.
 *
 * Three cores ship (docs/EMULATOR_ROOM.md has the license of each and the three
 * that were refused): FCEUmm for the NES, bsnes for the SNES and mGBA for Game
 * Boy, Game Boy Color and Game Boy Advance. The picker's accept list and size cap are the
 * manifest's (`capabilities.localFiles`), a test keeps this table equal to it.
 * Archives (`.zip` and the like) are refused on purpose: one file, one system,
 * nothing unpacked.
 */
export type CoreName = "fceumm" | "mgba" | "bsnes";

export const CORE_BY_EXTENSION: Readonly<Record<string, CoreName>> = {
  ".nes": "fceumm",
  ".gb": "mgba",
  ".gbc": "mgba",
  ".gba": "mgba",
  ".sfc": "bsnes",
  ".smc": "bsnes",
};

export const ACCEPTED_EXTENSIONS = Object.keys(CORE_BY_EXTENSION);

/** The `assets[]` of the manifest each core needs: its repacked archive and its report. */
export const CORE_ASSETS: Readonly<Record<CoreName, { data: string; report: string }>> = {
  fceumm: { data: "fceumm-core.pqpc", report: "fceumm.json" },
  mgba: { data: "mgba-core.pqpc", report: "mgba.json" },
  bsnes: { data: "bsnes-core.pqpc", report: "bsnes.json" },
};

/** The third-party notices, shipped as an asset so the app can show them (`license.notices` names the same file). */
export const NOTICES_ASSET = "notices.txt";

/** The file names the frontend asks for, which `EJS_paths` answers with blob URLs (it matches by basename). */
export const FRONTEND_FILE_NAMES: Readonly<Record<CoreName, { data: string; report: string }>> = {
  fceumm: { data: "fceumm-legacy-wasm.data", report: "fceumm.json" },
  mgba: { data: "mgba-legacy-wasm.data", report: "mgba.json" },
  bsnes: { data: "bsnes-legacy-wasm.data", report: "bsnes.json" },
};

export function coreForExtension(ext: string): CoreName | null {
  return Object.hasOwn(CORE_BY_EXTENSION, ext) ? (CORE_BY_EXTENSION[ext] ?? null) : null;
}
