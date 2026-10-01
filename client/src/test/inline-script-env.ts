/**
 * A tiny fake browser for running the inline scripts `index.html` gets at build
 * time (the deferred tags, the deferred entry) exactly as written.
 *
 * They are strings of ES5 that cannot import anything, so the only honest test
 * is to run the string. This provides just what they touch: a `document` with a
 * head, an `<html>` element with attributes, `addEventListener`,
 * `setTimeout`/`clearTimeout` (the caller uses vitest's fake timers), and a
 * `PerformanceObserver` the test can feed largest-contentful-paint entries.
 */

import vm from "node:vm";

export interface CreatedScript {
  src?: string;
  type?: string;
  async?: boolean;
  crossOrigin?: string;
  attrs: Record<string, string>;
}

type Listener = (event?: unknown) => void;

export interface InlineEnv {
  /** Scripts appended to `document.head`, in order. */
  appended: CreatedScript[];
  /** Window-level listeners registered, by event name. */
  listeners: Map<string, Listener[]>;
  /** Fire a window event (`load`, `pointerdown`, ...). */
  fire: (name: string) => void;
  /** Deliver largest-contentful-paint entries to the observer, if any. */
  paint: (entries: Array<{ url?: string }>) => void;
  /** Set what `document.readyState` says. */
  setReadyState: (state: string) => void;
  run: (source: string) => void;
}

export function inlineEnv(opts: {
  route: "home" | "other" | null;
  readyState?: string;
  hasIdleCallback?: boolean;
  hasObserver?: boolean;
}): InlineEnv {
  const appended: CreatedScript[] = [];
  const listeners = new Map<string, Listener[]>();
  let observerCallback: ((list: { getEntries: () => unknown[] }) => void) | null =
    null;
  const state = { readyState: opts.readyState ?? "loading" };

  const win: Record<string, unknown> = {
    addEventListener(name: string, fn: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    },
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  };
  if (opts.hasIdleCallback !== false) {
    win.requestIdleCallback = (fn: Listener) => setTimeout(fn, 0);
  }
  const document = {
    get readyState() {
      return state.readyState;
    },
    documentElement: {
      getAttribute: (name: string) =>
        name === "data-route" ? opts.route : null,
    },
    head: {
      appendChild(node: CreatedScript) {
        appended.push(node);
      },
    },
    createElement(): CreatedScript {
      const node: CreatedScript = {
        attrs: {},
        // `setAttribute` is what the tag loader uses for data-*.
      } as CreatedScript;
      (node as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute =
        (k, v) => {
          node.attrs[k] = v;
        };
      return node;
    },
  };
  win.document = document;
  win.window = win;

  class FakeObserver {
    constructor(cb: (list: { getEntries: () => unknown[] }, o: FakeObserver) => void) {
      observerCallback = (list) => cb(list, this);
    }
    observe() {}
    disconnect() {}
  }

  const context: Record<string, unknown> = {
    ...win,
    document,
    window: win,
    addEventListener: win.addEventListener,
    setTimeout,
    clearTimeout,
    requestIdleCallback: win.requestIdleCallback,
  };
  if (opts.hasObserver !== false) {
    context.PerformanceObserver = FakeObserver;
  }
  const sandbox = vm.createContext(context);

  return {
    appended,
    listeners,
    fire(name) {
      for (const fn of listeners.get(name) ?? []) fn();
    },
    paint(entries) {
      observerCallback?.({ getEntries: () => entries });
    },
    setReadyState(s) {
      state.readyState = s;
    },
    run(source) {
      vm.runInContext(source, sandbox);
    },
  };
}

/** The body of an inline `<script>` tag. */
export function scriptBody(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) {
    throw new Error("no inline script in: " + html.slice(0, 80));
  }
  return match[1];
}
