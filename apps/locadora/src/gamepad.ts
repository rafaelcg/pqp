/**
 * Gamepad detection for the controller map (SPEC 4.2): while the map is open,
 * poll the Gamepad API, say when a pad shows up, and say which buttons are
 * held so the drawing can glow. It only reads. The game's own gamepad support
 * is the emulator's; this is the walkthrough noticing it.
 *
 * Browsers hide a pad until a button is pressed on it, so "found" arrives with
 * the first press, which is the moment the copy ("Achei um gamepad!") is for.
 */
import { BUTTONS_BY_PLATFORM, type PadButton, type Platform } from "./keymap";

export interface PadLike {
  id: string;
  connected: boolean;
  buttons: ArrayLike<{ pressed: boolean }>;
  axes: ArrayLike<number>;
}

/** The "standard" mapping every browser reports for the pads it knows. */
const STANDARD: Readonly<Record<number, PadButton>> = {
  0: "b",
  1: "a",
  2: "y",
  3: "x",
  4: "l",
  5: "r",
  8: "select",
  9: "start",
  12: "up",
  13: "down",
  14: "left",
  15: "right",
};

/** A stick past this counts as the d-pad. */
const AXIS_THRESHOLD = 0.5;

/**
 * The buttons held on `pad`, as this console's buttons. A console without a
 * button folds it onto the nearest one (Y onto B, X onto A) and drops
 * shoulders it does not have, so every press lights something on the drawing.
 */
export function heldButtons(pad: PadLike, platform: Platform): Set<PadButton> {
  const own = BUTTONS_BY_PLATFORM[platform];
  const held = new Set<PadButton>();
  const add = (button: PadButton) => {
    if (own.includes(button)) held.add(button);
    else if (button === "y" && own.includes("b")) held.add("b");
    else if (button === "x" && own.includes("a")) held.add("a");
  };
  for (const [index, button] of Object.entries(STANDARD)) {
    if (pad.buttons[Number(index)]?.pressed) add(button);
  }
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  if (x <= -AXIS_THRESHOLD) add("left");
  if (x >= AXIS_THRESHOLD) add("right");
  if (y <= -AXIS_THRESHOLD) add("up");
  if (y >= AXIS_THRESHOLD) add("down");
  return held;
}

/** "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)" to "Xbox 360 Controller". */
export function padName(id: string): string {
  const name = id.replace(/\s*\(.*\)\s*$/, "").trim();
  return name || id;
}

export interface GamepadWatcherOptions {
  platform: () => Platform;
  /** A pad appeared (first one, or the first after all were lost). */
  onFound?: (name: string) => void;
  /** Every pad is gone. */
  onLost?: () => void;
  /** The held buttons changed; the empty set means all released. */
  onHeld?: (held: ReadonlySet<PadButton>) => void;
  /** Defaults to `navigator.getGamepads`. */
  getPads?: () => ArrayLike<PadLike | null>;
  /** Defaults to `requestAnimationFrame`. Returns what `cancel` takes. */
  schedule?: (tick: () => void) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface GamepadWatcher {
  start(): void;
  stop(): void;
  /** One poll, for tests and for the first read on `start`. */
  poll(): void;
  readonly found: boolean;
}

function sameSet(a: ReadonlySet<PadButton>, b: ReadonlySet<PadButton>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

export function createGamepadWatcher(options: GamepadWatcherOptions): GamepadWatcher {
  const getPads =
    options.getPads ??
    (() => (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" ? navigator.getGamepads() : []));
  const schedule =
    options.schedule ??
    ((tick: () => void) =>
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : setTimeout(tick, 16));
  const cancelHandle =
    options.cancel ??
    ((handle: unknown) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let running = false;
  let handle: unknown = null;
  let found = false;
  let held: ReadonlySet<PadButton> = new Set();

  function poll() {
    let pad: PadLike | null = null;
    const pads = getPads();
    for (let i = 0; i < pads.length; i += 1) {
      const candidate = pads[i];
      if (candidate?.connected) {
        pad = candidate;
        break;
      }
    }
    if (!pad) {
      if (found) {
        found = false;
        held = new Set();
        options.onHeld?.(held);
        options.onLost?.();
      }
      return;
    }
    if (!found) {
      found = true;
      options.onFound?.(padName(pad.id));
    }
    const now = heldButtons(pad, options.platform());
    if (!sameSet(now, held)) {
      held = now;
      options.onHeld?.(now);
    }
  }

  function loop() {
    if (!running) return;
    poll();
    handle = schedule(loop);
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      if (handle !== null) cancelHandle(handle);
      handle = null;
      if (found) {
        found = false;
        held = new Set();
      }
    },
    poll,
    get found() {
      return found;
    },
  };
}
