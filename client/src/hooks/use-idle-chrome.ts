import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Video-player chrome for the call stage.
 *
 * While a screen share or a camera is on stage, the controls bar and the
 * title overlay sit on top of the picture. A person watching a film does not
 * move the pointer, so after a few idle seconds both fade out; any pointer
 * move, touch or key over the stage brings them back and restarts the clock.
 * On a phone there is no pointer to rest, so a tap on the stage toggles them
 * instead, the way every mobile player does.
 *
 * The rules live in `createIdleChrome`, a small controller with no React and
 * no DOM in it, so they can be pinned with fake timers. `useIdleChrome` is
 * the thin binding a component uses.
 */

/** How long the pointer has to rest before the chrome goes. */
export const IDLE_CHROME_DELAY_MS = 3000;

export interface IdleChromeConfig {
  /**
   * Whether the chrome may hide at all. False when nothing is on stage (an
   * audio-only call keeps today's always-visible bar) or the stage is
   * collapsed.
   */
  enabled: boolean;
  /**
   * Something is holding the chrome open: a menu from the bar, the pointer
   * resting on the bar, keyboard focus inside it, or a push-to-talk key held
   * down. While pinned the chrome shows and the clock does not run.
   */
  pinned: boolean;
}

export interface IdleChromeController {
  /** True while the chrome is faded out. */
  readonly hidden: boolean;
  configure(config: IdleChromeConfig): void;
  /** Pointer move, key, touch: show the chrome and restart the idle clock. */
  activity(): void;
  /** A tap on the stage: show if hidden, hide if shown. */
  toggle(): void;
  dispose(): void;
}

export function createIdleChrome(
  onChange: (hidden: boolean) => void,
  delayMs: number = IDLE_CHROME_DELAY_MS,
): IdleChromeController {
  let hidden = false;
  let config: IdleChromeConfig = { enabled: false, pinned: false };
  let timer: ReturnType<typeof setTimeout> | null = null;

  function set(next: boolean) {
    if (hidden === next) {
      return;
    }
    hidden = next;
    onChange(next);
  }
  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function mayHide() {
    return config.enabled && !config.pinned;
  }
  function arm() {
    clear();
    if (!mayHide()) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (mayHide()) {
        set(true);
      }
    }, delayMs);
  }

  return {
    get hidden() {
      return hidden;
    },
    configure(next) {
      const wasPinned = config.pinned;
      const wasEnabled = config.enabled;
      config = next;
      if (!mayHide()) {
        // Pinned or disabled: whatever was going to happen, it shows now.
        clear();
        set(false);
        return;
      }
      // Coming out of a pin (menu closed, pointer left the bar) or a share
      // just starting: the clock starts fresh from here, not from the last
      // move, which may have been minutes ago.
      if (wasPinned || !wasEnabled || !timer) {
        arm();
      }
    },
    activity() {
      set(false);
      arm();
    },
    toggle() {
      if (hidden) {
        set(false);
        arm();
        return;
      }
      if (mayHide()) {
        clear();
        set(true);
      }
    },
    dispose() {
      clear();
    },
  };
}

/**
 * Tailwind classes for a piece of chrome. Reduced motion means an instant
 * toggle, not a 200 ms fade: appearing and vanishing chrome is exactly the
 * motion being declined, but a bar that never leaves the film is not the
 * answer either.
 *
 * Hidden chrome still takes pointer events, on purpose. `pointer-events:
 * none` reads as the obvious choice, but then nothing that checks a hit
 * target before moving the pointer (Playwright's click, some assistive
 * pointers) can ever reach the bar, because the move that would have woken
 * it never happens. Instead the bar swallows the first press while hidden,
 * so an invisible hang-up button cannot be pressed by accident and the press
 * itself brings the bar back.
 */
export function idleChromeClassName(input: {
  hidden: boolean;
  reducedMotion: boolean;
}): string {
  const motion = input.reducedMotion
    ? "transition-none"
    : "transition-opacity duration-200";
  return input.hidden ? `${motion} opacity-0` : `${motion} opacity-100`;
}

export function useIdleChrome(
  enabled: boolean,
  pinned: boolean,
): {
  hidden: boolean;
  /**
   * The same answer, read synchronously. A pointer move and the press that
   * follows it arrive in one gesture, before React has re-rendered with the
   * move's `hidden`, so a handler deciding whether to swallow the press must
   * ask the controller, not the render.
   */
  isHidden: () => boolean;
  /** Bind to pointer move, key down and focus over the stage. */
  wake: () => void;
  /** Bind to a touch tap on the stage. */
  toggle: () => void;
} {
  const [hidden, setHidden] = useState(false);
  const controller = useRef<IdleChromeController | null>(null);
  if (!controller.current) {
    controller.current = createIdleChrome(setHidden);
  }
  useEffect(() => {
    controller.current?.configure({ enabled, pinned });
  }, [enabled, pinned]);
  useEffect(() => {
    const current = controller.current;
    return () => current?.dispose();
  }, []);
  const isHidden = useCallback(() => controller.current?.hidden ?? false, []);
  const wake = useCallback(() => controller.current?.activity(), []);
  const toggle = useCallback(() => controller.current?.toggle(), []);
  return { hidden, isHidden, wake, toggle };
}

/**
 * Whether a touch tap landed on the picture rather than on something that
 * already answers a tap (a button, a slider, the self preview, the chrome
 * itself). Only a tap on the picture toggles the chrome; everything else is
 * plain activity.
 */
export function tapIsOnStage(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return true;
  }
  return (
    target.closest(
      "button, a, input, select, textarea, [role='slider'], [role='button'], [data-call-chrome], [data-call-pip]",
    ) === null
  );
}
