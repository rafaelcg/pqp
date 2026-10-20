import type { StartOptions } from "./emulator";
import type { Turbo } from "./turbo";

/**
 * What the rest of Locadora asks of a running console, and nothing about how
 * it is done. The HUD, the saves and the stage talk to this, so they can be
 * tested against a fake and the EmulatorJS facade (`emulator.ts`) is the one
 * place that knows `gameManager`.
 */
/** 0 is normal speed, anything else is the ratio to run at (above 1, up to 10, halves allowed). */
export type { Turbo };

/** Action name to the `KeyboardEvent.code` that drives it. */
export type KeyMap = Readonly<Record<string, string>>;

export interface VideoSize {
  width: number;
  height: number;
}

export interface EmulatorRuntime {
  /** Boots the console; resolves once the game is on screen and waiting for Start. */
  start(options: StartOptions): Promise<void>;
  /** Pauses (true) or resumes (false) the main loop. */
  pause(paused: boolean): void;
  /** The whole machine state, for a save slot. */
  getState(): Promise<Uint8Array>;
  loadState(state: Uint8Array): Promise<void>;
  /** The current frame as a PNG, for slot thumbnails. */
  screenshot(): Promise<Blob>;
  /** The game's own battery save, or null when the core has none. */
  readSram(): Promise<Uint8Array | null>;
  writeSram(data: Uint8Array): Promise<void>;
  /** 0 is normal speed; a ratio goes to the core as a float, and silencing the game above 3x is the runtime's doing. */
  setTurbo(turbo: Turbo): void;
  /** The core's frame size in source pixels, or null before the first frame. */
  videoSize(): VideoSize | null;
  /** Game keys reach the core only while this is on (off while a text field has focus). */
  setKeyboard(enabled: boolean): void;
  setKeymap(map: KeyMap): void;
  /** The sound switch: silence (true) or the volume the person had (false). The game keeps running either way. */
  setMuted(muted: boolean): void;
}
