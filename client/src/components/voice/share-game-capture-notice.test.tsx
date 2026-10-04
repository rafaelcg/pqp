// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveCatalogue } from "@/lib/i18n";
import type { ShareCaptureHint } from "@/lib/share-game-capture-hint";
import { ShareGameCaptureNotice } from "./share-game-capture-notice";

/**
 * The presenter's card for a share killed by exclusive fullscreen. The rules
 * are `share-game-capture-hint.test.ts`; this proves the DOM keeps them: the
 * fix is on the card, "Entendi" closes this hint, a new hint opens it again,
 * and "Não mostrar de novo" keeps it closed.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(hint: ShareCaptureHint | null, visible = true) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(<ShareGameCaptureNotice hint={hint} visible={visible} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setActiveCatalogue(undefined);
  vi.useRealTimers();
});

const card = () => document.querySelector('[data-corner-card="share-game-capture"]');
const buttonNamed = (text: string) =>
  [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

describe("ShareGameCaptureNotice", () => {
  it("renders nothing without a hint", () => {
    render(null);
    expect(card()).toBeNull();
  });

  it("says what the viewers see and how to fix it in CS2", () => {
    render({ kind: "black", at: 1 });
    expect(card()?.textContent).toContain("Viewers are seeing a black screen");
    expect(card()?.textContent).toContain("Fullscreen Windowed");
    expect(card()?.textContent).toContain("borderless");
    expect(card()?.textContent).not.toMatch(/—/);
  });

  it("names each kind by what the viewers get", () => {
    render({ kind: "stalled", at: 1 });
    expect(card()?.textContent).toContain("Your share froze for viewers");
    render({ kind: "ended", at: 2 });
    expect(card()?.textContent).toContain("Your share stopped on its own");
  });

  it("Got it closes this hint, and the next hint shows again", () => {
    vi.useFakeTimers();
    render({ kind: "black", at: 1 });
    act(() => buttonNamed("Got it")!.click());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(card()).toBeNull();
    render({ kind: "stalled", at: 2 });
    expect(card()).not.toBeNull();
  });

  it("Don't show again keeps every later hint closed", () => {
    vi.useFakeTimers();
    render({ kind: "black", at: 1 });
    act(() => buttonNamed("Don't show again")!.click());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(card()).toBeNull();
    render({ kind: "stalled", at: 2 });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(card()).toBeNull();
  });

  it("stays out of the way while the call chrome is hidden", () => {
    render({ kind: "black", at: 1 }, false);
    expect(card()).toBeNull();
  });
});
