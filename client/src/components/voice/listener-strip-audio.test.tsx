// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ListenerStrip, type StripListener } from "./listener-strip";

/**
 * A listener chip's sound panel, in a real DOM.
 *
 * The row under the stage scrolls sideways inside a stage that hides its
 * overflow. The panel used to open inside the chip, so it existed and nobody
 * could see it. What is pinned here is that it opens OUTSIDE the row, and
 * that being outside does not cost it the behaviour a nested panel had for
 * free: a press on its slider keeps it open, a key on its buttons is theirs,
 * and Escape hands the focus back to the chip.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness() {
  const [volume, setVolume] = useState(1);
  const people: StripListener[] = [
    {
      key: "ana",
      name: "Ana",
      avatarUrl: null,
      speaking: false,
      muted: false,
      serverMuted: false,
      isSelf: false,
      volume,
      onSetVolume: setVolume,
    },
  ];
  return (
    <TooltipProvider>
      <ListenerStrip
        people={people}
        limit={12}
        open
        onToggle={() => {}}
        youLabel="(you)"
      />
    </TooltipProvider>
  );
}

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Harness />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const chip = () =>
  document.querySelector<HTMLElement>('[data-call-listener="Ana"]')!;
const panel = () =>
  document.querySelector<HTMLElement>('[data-testid="peer-audio-menu"]');

function openPanel() {
  act(() => {
    chip().click();
  });
  expect(panel()).not.toBeNull();
}

function key(target: Element, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("ListenerStrip sound panel", () => {
  it("opens outside the row, where the row's overflow cannot clip it", () => {
    mount();
    openPanel();
    const strip = document.querySelector('[data-testid="listener-strip"]');
    expect(strip?.contains(panel())).toBe(false);
    expect(panel()!.style.position).toBe("fixed");
    expect(panel()!.style.visibility).toBe("visible");
  });

  it("stays open while its slider is pressed", () => {
    mount();
    openPanel();
    const slider = panel()!.querySelector('input[type="range"]')!;
    act(() => {
      slider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(panel()).not.toBeNull();
  });

  it("closes on a press anywhere else", () => {
    mount();
    openPanel();
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    expect(panel()).toBeNull();
  });

  it("lets Enter on its mute button be the button's, not the chip's", () => {
    mount();
    openPanel();
    const mute = panel()!.querySelector('[aria-label="Mute Ana"]')!;
    key(mute, "Enter");
    expect(panel()).not.toBeNull();
  });

  it("takes the focus when it opens and gives it back to the chip on Escape", () => {
    mount();
    openPanel();
    expect(panel()!.contains(document.activeElement)).toBe(true);
    key(document.activeElement!, "Escape");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("hands Tab from the last control back to the chip and closes", () => {
    mount();
    openPanel();
    const stops = panel()!.querySelectorAll<HTMLElement>("button, input");
    const last = stops[stops.length - 1]!;
    act(() => last.focus());
    const event = key(last, "Tab");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(chip());
    // Not prevented: the browser carries on from the chip to what follows it.
    expect(event.defaultPrevented).toBe(false);
  });

  it("lands Shift+Tab from the first control on the chip itself", () => {
    mount();
    openPanel();
    const first = panel()!.querySelector<HTMLElement>("button, input")!;
    act(() => first.focus());
    const event = key(first, "Tab", { shiftKey: true });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(chip());
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves Tab between its own controls alone", () => {
    mount();
    openPanel();
    const first = panel()!.querySelector<HTMLElement>("button, input")!;
    act(() => first.focus());
    const event = key(first, "Tab");
    expect(panel()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
