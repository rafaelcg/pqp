/**
 * The screens of Locadora and the rule for moving between them (SPEC 3). One
 * place says which screen is showing, so a module that wants to put up a
 * message does not also have to know which sections to hide.
 *
 * `balcao` is the home (the shelf), `onboarding` the first-visit walkthrough,
 * `palco` the game on screen, `watching` the spectator's view. `outside` (the
 * app opened outside pqp) and `ended` (the session is over) are dead ends:
 * nothing leaves them, because there is nothing to go back to.
 */
export type Screen = "connecting" | "balcao" | "onboarding" | "loading" | "palco" | "watching" | "outside" | "ended";

export const SCREENS: readonly Screen[] = ["connecting", "balcao", "onboarding", "loading", "palco", "watching", "outside", "ended"];

const TERMINAL: ReadonlySet<Screen> = new Set(["outside", "ended"]);

export type ScreenListener = (screen: Screen, previous: Screen) => void;

export interface ScreenMachine {
  readonly current: Screen;
  /** Moves to `next`; false (and nothing changes) when the current screen is a dead end. */
  go(next: Screen): boolean;
  /** Called after every change, in the order added. Not called for a move to the same screen. */
  onChange(listener: ScreenListener): void;
}

export function createScreens(initial: Screen = "connecting"): ScreenMachine {
  let current = initial;
  const listeners: ScreenListener[] = [];
  return {
    get current() {
      return current;
    },
    go(next) {
      if (TERMINAL.has(current)) return false;
      if (next === current) return true;
      const previous = current;
      current = next;
      for (const listener of listeners) listener(next, previous);
      return true;
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}
