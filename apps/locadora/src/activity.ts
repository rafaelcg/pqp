/**
 * What the person is doing, told to the page (`ui.activity`): `playing` while a game runs, `paused` while it is
 * paused, `browsing` everywhere else (the Balcão, the welcome, a menu). The guest player keeps its sign-up card off
 * a running game with it. Only ever one of three words: nothing about the game, the shelf or the screen.
 *
 * Said once per change, never repeated, and a failure is swallowed: an older host answers `invalid`, and the page
 * not caring is exactly what that means. With no sink (an ordinary session) nothing is sent at all.
 */

export type ActivityState = "playing" | "paused" | "browsing";

export interface ActivityReporter {
  report(state: ActivityState): void;
  readonly current: ActivityState | null;
}

export function createActivityReporter(sink: ((state: ActivityState) => Promise<unknown>) | null): ActivityReporter {
  let current: ActivityState | null = null;
  return {
    report(state) {
      if (!sink || state === current) return;
      current = state;
      // a report that did not arrive is not "said": the next report of the same state goes out again, so one lost
      // message never leaves the page believing a stale state (and drawing its card over a running game)
      const forget = () => {
        if (current === state) current = null;
      };
      try {
        void sink(state).catch(forget);
      } catch {
        // a host that cannot even take the call
        forget();
      }
    },
    get current() {
      return current;
    },
  };
}
