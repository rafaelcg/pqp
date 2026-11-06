// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/error-boundary";
import { setInCall } from "@/lib/in-call-state";
import { setStaleChunkBannerVisible } from "@/lib/stale-chunk-state";
import { takeTypeAhead } from "@/lib/type-ahead";
import {
  deferredDialog,
  deferredPanel,
  preloadDeferredPanels,
  resetDeferredPreloadForTests,
} from "./deferred";

/**
 * The second-screen surfaces are fetched when first drawn. What these pin is
 * that a split stays invisible: a dialog fetches nothing until it is asked to
 * open and then behaves like the static one, a panel draws its fallback while
 * its chunk arrives, and a chunk that cannot load costs that surface and not the
 * app (the bug report 120 shape, `error-boundary.test.tsx`).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactNode) {
  host ??= document.createElement("div");
  if (!host.isConnected) {
    document.body.append(host);
  }
  root ??= createRoot(host);
  return act(async () => {
    root!.render(node);
  });
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetDeferredPreloadForTests();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
  setStaleChunkBannerVisible(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function Dialog({ open, label }: { open: boolean; label: string }) {
  return <div data-testid="dialog">{`${label}:${open ? "open" : "closed"}`}</div>;
}

describe("deferredDialog", () => {
  it("fetches nothing and draws nothing until it is first asked to open", async () => {
    const load = vi.fn(async () => ({ default: Dialog }));
    const Deferred = deferredDialog(load);
    await render(<Deferred open={false} label="a" />);
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="dialog"]')).toBeNull();
  });

  it("loads on the first open and then behaves like the static dialog", async () => {
    const load = vi.fn(async () => ({ default: Dialog }));
    const Deferred = deferredDialog(load);
    await render(<Deferred open={false} label="a" />);
    await render(<Deferred open label="a" />);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="dialog"]')?.textContent).toBe("a:open");

    // Closing keeps it mounted with open=false, so a close animation and a
    // draft in a field survive, and nothing is fetched again.
    await render(<Deferred open={false} label="a" />);
    expect(document.querySelector('[data-testid="dialog"]')?.textContent).toBe("a:closed");
    await render(<Deferred open label="b" />);
    expect(document.querySelector('[data-testid="dialog"]')?.textContent).toBe("b:open");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts loaded when it is mounted already open", async () => {
    const Deferred = deferredDialog(async () => ({ default: Dialog }));
    await render(<Deferred open label="x" />);
    await settle();
    expect(document.querySelector('[data-testid="dialog"]')?.textContent).toBe("x:open");
  });

  it("takes its own predicate when there is no open prop", async () => {
    function Report({ target }: { target: string | null }) {
      return <div data-testid="report">{target}</div>;
    }
    const load = vi.fn(async () => ({ default: Report }));
    const Deferred = deferredDialog(load, (props) => props.target != null);
    await render(<Deferred target={null} />);
    await settle();
    expect(load).not.toHaveBeenCalled();
    await render(<Deferred target="msg-1" />);
    await settle();
    expect(document.querySelector('[data-testid="report"]')?.textContent).toBe("msg-1");
  });

  it("typeAhead: keys pressed while the chunk is still loading start the dialog's field", async () => {
    let release: (() => void) | null = null;
    function Typing({ open }: { open: boolean }) {
      // Read at commit, like the quick switcher: a Suspense reveal can wait
      // after the first render while the capture is still taking keys.
      const [text, setText] = useState("");
      useLayoutEffect(() => {
        const held = takeTypeAhead();
        if (held) {
          setText(held);
        }
      }, []);
      return <input data-testid="field" value={text} readOnly data-open={open} />;
    }
    const Deferred = deferredDialog(
      () =>
        new Promise<{ default: typeof Typing }>((resolve) => {
          release = () => resolve({ default: Typing });
        }),
      undefined,
      { typeAhead: true },
    );
    await render(<Deferred open={false} />);
    // The shell's own handler flips `open` (Ctrl/Cmd+K); the chunk is not here.
    await render(<Deferred open />);
    expect(document.querySelector('[data-testid="field"]')).toBeNull();

    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      window.dispatchEvent(event);
      return event;
    };
    for (const key of "borax") {
      expect(press(key).defaultPrevented).toBe(true);
    }
    press("Backspace");
    // Chords and named keys are not the dialog's words.
    expect(press("k", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("ArrowDown").defaultPrevented).toBe(false);

    release!();
    await settle();
    const field = document.querySelector<HTMLInputElement>('[data-testid="field"]');
    expect(field?.value).toBe("bora");

    // Once loaded, typing is the dialog's own again and nothing lingers.
    expect(press("z").defaultPrevented).toBe(false);
    expect(takeTypeAhead()).toBe("");
  });

  it("typeAhead: holds nothing for a dialog that is not asked to open", async () => {
    const Deferred = deferredDialog(async () => ({ default: Dialog }), undefined, {
      typeAhead: true,
    });
    await render(<Deferred open={false} label="a" />);
    const event = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(takeTypeAhead()).toBe("");
  });

  it("a chunk that cannot load costs the dialog, not the app, even in a call", async () => {
    setInCall(true);
    const Deferred = deferredDialog(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/x.js")),
    );
    await render(
      <ErrorBoundary>
        <main data-testid="stage">the call stage</main>
        <Deferred open />
      </ErrorBoundary>,
    );
    await settle();
    expect(document.querySelector('[data-testid="stage"]')).not.toBeNull();
    expect(document.querySelector("[data-contained-chunk-error]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("pqp updated");
  });
});

describe("deferredPanel", () => {
  it("draws its fallback while the chunk arrives, then the panel with its props", async () => {
    let release: (() => void) | null = null;
    function Panel({ name }: { name: string }) {
      return <section data-testid="panel">{name}</section>;
    }
    const Deferred = deferredPanel(
      () =>
        new Promise<{ default: typeof Panel }>((resolve) => {
          release = () => resolve({ default: Panel });
        }),
      <p data-testid="fallback">loading</p>,
    );
    await render(<Deferred name="forum" />);
    expect(document.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="panel"]')).toBeNull();
    await act(async () => {
      release?.();
    });
    await settle();
    expect(document.querySelector('[data-testid="fallback"]')).toBeNull();
    expect(document.querySelector('[data-testid="panel"]')?.textContent).toBe("forum");
  });

  it("a stale chunk says so in place and leaves the page standing", async () => {
    const Deferred = deferredPanel(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/y.js")),
    );
    await render(
      <ErrorBoundary>
        <main data-testid="page">page</main>
        <Deferred />
      </ErrorBoundary>,
    );
    await settle();
    expect(document.querySelector('[data-testid="page"]')).not.toBeNull();
    expect(document.querySelector("[data-contained-chunk-error]")?.textContent).toContain(
      "Could not open this right now",
    );
  });
});

describe("preloadDeferredPanels", () => {
  // The registry is module-level and shared with every other deferred
  // component in the test file, so assert on the loaders made here.
  it("waits, then fetches one chunk per idle slice and never two at once", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = (name: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { default: Dialog };
    };
    deferredDialog(slow("one"));
    deferredDialog(slow("two"));
    const idleSlices: Array<() => void> = [];
    const cancel = preloadDeferredPanels(1000, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      idle: (cb) => idleSlices.push(cb),
    });
    // Nothing before the delay.
    await vi.advanceTimersByTimeAsync(999);
    expect(idleSlices).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(idleSlices).toHaveLength(1);
    // Run slices until our two loaders have been fetched. Other loaders
    // registered by earlier tests in this file come first; they are harmless.
    for (let i = 0; i < 20 && order.length < 2; i++) {
      const slice = idleSlices.shift();
      slice?.();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(order).toEqual(["one", "two"]);
    expect(maxInFlight).toBe(1);
    cancel();
  });

  it("cancel stops it before the first fetch", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ({ default: Dialog }));
    deferredDialog(load);
    const idleSlices: Array<() => void> = [];
    const cancel = preloadDeferredPanels(1000, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      idle: (cb) => idleSlices.push(cb),
    });
    cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(idleSlices).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("a second call while one runs does nothing", () => {
    const env = {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      idle: vi.fn(),
    };
    const stop = preloadDeferredPanels(1000, env);
    preloadDeferredPanels(1000, env);
    expect(env.setTimeout).toHaveBeenCalledTimes(1);
    stop();
  });
});
