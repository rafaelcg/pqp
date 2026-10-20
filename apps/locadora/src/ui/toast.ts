/**
 * Toasts (SPEC 4.4 and 14): one short line over the bar, `role="status"`, with
 * an optional action ("Desfazer"). One at a time: a new one replaces the old.
 *
 * Timing is a courtesy, not a trap (WCAG 2.2.1): a toast waits while the
 * pointer is on it or focus is inside it, and leaves a little after. A toast
 * with an action lives longer, because that is the undo window.
 */
import { h } from "./dom";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  text: string;
  action?: ToastAction;
  /** Milliseconds on screen. Defaults to `DEFAULT_TTL_MS`, or `ACTION_TTL_MS` with an action. */
  ttl?: number;
}

export const DEFAULT_TTL_MS = 4000;
/** Matches the 10 s the saves keep the previous slot content for an undo (SPEC 4.4). */
export const ACTION_TTL_MS = 10_000;
/** After hover or focus leaves, how long the toast stays at least. */
export const LINGER_MS = 1500;

export interface Toaster {
  /** The live region; the caller puts it in the stage. It exists (and is empty) before any toast, which screen readers need. */
  readonly element: HTMLElement;
  show(toast: ToastOptions): void;
  /** Removes the toast on screen, if any. */
  clear(): void;
  destroy(): void;
}

export function createToaster(): Toaster {
  const region = h("div", { class: "loc-toasts", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: HTMLElement | null = null;

  const stopTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  function clear() {
    stopTimer();
    current?.remove();
    current = null;
  }

  function arm(ms: number) {
    stopTimer();
    timer = setTimeout(clear, ms);
  }

  function show({ text, action, ttl }: ToastOptions) {
    clear();
    const lifetime = ttl ?? (action ? ACTION_TTL_MS : DEFAULT_TTL_MS);
    const node = h("div", { class: "loc-toast" }, h("span", { class: "loc-toast-text" }, text));
    if (action) {
      const button = h("button", { type: "button", class: "loc-toast-action" }, action.label);
      let used = false;
      button.addEventListener("click", () => {
        // the undo runs once, and the toast is gone before it does, so a double click cannot run it twice
        if (used) return;
        used = true;
        clear();
        action.run();
      });
      node.append(button);
    }
    // a toast waits while it is being read or used: pointer on it, or focus inside it
    let pointerIn = false;
    let focusIn = false;
    const settle = () => {
      if (current !== node) return;
      if (pointerIn || focusIn) stopTimer();
      else arm(LINGER_MS);
    };
    node.addEventListener("pointerenter", () => {
      pointerIn = true;
      settle();
    });
    node.addEventListener("pointerleave", () => {
      pointerIn = false;
      settle();
    });
    node.addEventListener("focusin", () => {
      focusIn = true;
      settle();
    });
    node.addEventListener("focusout", () => {
      focusIn = false;
      settle();
    });
    current = node;
    region.append(node);
    arm(lifetime);
  }

  return {
    element: region,
    show,
    clear,
    destroy() {
      clear();
      region.remove();
    },
  };
}
