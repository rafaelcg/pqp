// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ShortcutOverlay } from "./shortcut-overlay";
import { defaultShortcutBindings } from "@/lib/keyboard-shortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(props: { pushToTalkOn?: boolean; onClose?: () => void } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ShortcutOverlay
        open
        bindings={defaultShortcutBindings(false)}
        pushToTalkKey={{
          code: "KeyK",
          label: "K",
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
        }}
        onClose={props.onClose ?? (() => undefined)}
        {...props}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const pttRow = () =>
  [...document.querySelectorAll("div.py-1\\.5")].find((row) =>
    /Push-to-talk|Falar segurando|Pulsar para hablar/i.test(row.textContent ?? ""),
  )!;

describe("ShortcutOverlay push-to-talk", () => {
  it("lists the key while the mode is push-to-talk", () => {
    mount({ pushToTalkOn: true });
    expect(pttRow().querySelector("kbd")?.textContent).toBe("K");
  });

  it("says it is off, and draws no key, while the mode is voice activity", () => {
    mount({ pushToTalkOn: false });
    expect(pttRow().querySelector("kbd")).toBeNull();
    expect(pttRow().textContent).toMatch(/Off|Desligado|Desactivado/);
  });
});

describe("ShortcutOverlay backdrop", () => {
  it("cancels the mousedown's default on the backdrop, so focus is not moved to the page", () => {
    let closed = 0;
    mount({ onClose: () => (closed += 1) });
    const layer = document.querySelector("[data-dialog-layer]")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      layer.dispatchEvent(down);
    });
    expect(closed).toBe(1);
    expect(down.defaultPrevented).toBe(true);
  });

  it("leaves a mousedown inside the panel alone", () => {
    mount();
    const title = document.querySelector("[data-dialog-panel] h2")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      title.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(false);
  });
});
