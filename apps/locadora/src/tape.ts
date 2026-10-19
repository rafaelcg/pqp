import { PqpAppError, type PickedFile } from "@pqp/app-sdk";
import { CORE_ASSETS, coreForExtension, type CoreName } from "./systems";

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

export type TapeProblem = "unsupported" | "too-big" | "load";

export type TapeOutcome =
  | { kind: "cancelled" }
  | { kind: "problem"; problem: TapeProblem }
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

  const core = coreForExtension(picked.ext);
  if (core === null) return { kind: "problem", problem: "unsupported" };

  onPicked?.();
  try {
    const names = CORE_ASSETS[core];
    const [coreData, report] = await Promise.all([host.assets.get(names.data), host.assets.get(names.report)]);
    return { kind: "ready", core, ext: picked.ext, rom: picked.bytes, coreData, report };
  } catch {
    return { kind: "problem", problem: "load" };
  }
}
