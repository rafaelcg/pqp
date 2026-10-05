// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "@/components/ui/dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("Dialog focus trap", () => {
  it("wraps Tab from the last real stop, skipping a roving group's parked members", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <Dialog open title="Aparência" onClose={() => {}}>
          <div role="radiogroup">
            <button type="button" role="radio" aria-checked="true" tabIndex={0}>
              Português
            </button>
            <button type="button" role="radio" aria-checked="false" tabIndex={-1}>
              Español
            </button>
          </div>
        </Dialog>,
      ),
    );
    // jsdom has no layout, so the trap's visibility filter sees nothing as
    // rendered; give every candidate an offsetParent.
    for (const node of document.querySelectorAll<HTMLElement>("button")) {
      Object.defineProperty(node, "offsetParent", { configurable: true, value: document.body });
    }
    const checked = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')][0]!;
    checked.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    // Tab from the last stop wraps to the first one (the close button), and
    // the parked "Español" is never treated as the last stop.
    expect(document.activeElement?.getAttribute("aria-label") ?? "").not.toBe("");
    expect(document.activeElement?.textContent).not.toBe("Español");
    const close = document.activeElement as HTMLElement;
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(close).not.toBe(checked);
    expect(document.activeElement).toBe(checked);
  });
});
