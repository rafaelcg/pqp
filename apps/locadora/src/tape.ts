import { PqpAppError, type PickedFile } from "@pqp/app-sdk";
import { platformForExt } from "./library";
import { checkRom } from "./rom-header";
import { CORE_ASSETS, coreForExtension, NOTICES_ASSET, type CoreName } from "./systems";

/**
 * "Pick a game": the step between the person's click and the emulator.
 *
 * The picker is the pqp page's, not ours: `files.pickLocal` opens it, reads the
 * file from the person's disk and hands the bytes over with the extension from
 * the manifest's accept list. THE FILE NAME NEVER REACHES THIS FRAME, so there
 * is nothing here that could log, show or send it. The size cap is the
 * manifest's too; the checks below are the frame's own second look.
 */

/** The slice of the SDK this step uses, so a test can stand in for the host. */
export interface TapeHost {
  files: { pickLocal(): Promise<PickedFile | null> };
  assets: { get(name: string): Promise<ArrayBuffer> };
}

/** The text of the third-party notices (`notices.txt`), or null when the host cannot hand it over. */
export async function loadNotices(host: Pick<TapeHost, "assets">): Promise<string | null> {
  try {
    return new TextDecoder().decode(await host.assets.get(NOTICES_ASSET));
  } catch {
    return null;
  }
}

/** `invalid`: the file is not a cartridge of its system (empty, text, the wrong size, no header the console would read). */
export type TapeProblem = "unsupported" | "too-big" | "invalid" | "load";

/** A `.locadora` file is a bundle of saves, never a game: it goes to the import dialog, not to the emulator. */
export const BUNDLE_PICK_EXT = ".locadora";

export type PickOutcome =
  | { kind: "cancelled" }
  | { kind: "problem"; problem: TapeProblem }
  | { kind: "bundle"; bytes: Uint8Array }
  | { kind: "file"; ext: string; bytes: ArrayBuffer };

/** The host's picker alone, with a bundle told apart from a game by its extension. Nothing is fetched. */
export async function pickTape(host: Pick<TapeHost, "files">): Promise<PickOutcome> {
  let picked: PickedFile | null;
  try {
    picked = await host.files.pickLocal();
  } catch (error) {
    if (error instanceof PqpAppError) {
      if (error.code === "too-large") return { kind: "problem", problem: "too-big" };
      if (error.code === "not-allowed") return { kind: "problem", problem: "unsupported" };
    }
    return { kind: "problem", problem: "load" };
  }
  if (picked === null) return { kind: "cancelled" };
  if (picked.ext.trim().toLowerCase() === BUNDLE_PICK_EXT) return { kind: "bundle", bytes: new Uint8Array(picked.bytes) };
  return { kind: "file", ext: picked.ext, bytes: picked.bytes };
}

export type TapeOutcome =
  | { kind: "cancelled" }
  | { kind: "problem"; problem: TapeProblem }
  | { kind: "bundle"; bytes: Uint8Array }
  | {
      kind: "ready";
      core: CoreName;
      ext: string;
      rom: ArrayBuffer;
      coreData: ArrayBuffer;
      report: ArrayBuffer;
    };

/** `onPicked` runs once a file was chosen and the emulator's files are about to be fetched (the slow part). */
export async function chooseTape(host: TapeHost, onPicked?: () => void): Promise<TapeOutcome> {
  const picked = await pickTape(host);
  if (picked.kind !== "file") return picked;

  const core = coreForExtension(picked.ext);
  if (core === null) return { kind: "problem", problem: "unsupported" };
  // a file that is not a game is turned back here: nothing about it reaches the shelf, the store or the emulator
  const platform = platformForExt(picked.ext);
  if (platform === null || !checkRom(new Uint8Array(picked.bytes), platform).ok) return { kind: "problem", problem: "invalid" };

  onPicked?.();
  try {
    const names = CORE_ASSETS[core];
    const [coreData, report] = await Promise.all([host.assets.get(names.data), host.assets.get(names.report)]);
    return { kind: "ready", core, ext: picked.ext, rom: picked.bytes, coreData, report };
  } catch {
    return { kind: "problem", problem: "load" };
  }
}
