// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeatureHint,
  resetFeatureHintsForTests,
} from "@/components/layout/feature-hint";
import { HINTS_PERSIST_OVERRIDE_KEY } from "@/lib/hints";

/*
 * A DISMISSAL HAS TO SURVIVE A REMOUNT, BECAUSE ELIGIBILITY DOES.
 *
 * `eligibleThisLoad` deliberately keeps a hint eligible for the whole page
 * load, so the stage swapping its collapsed strip for the expanded one does
 * not remember the card on the discarded tree and hide it on the real one.
 * `open` had no such memory: it starts true on every mount. While a hint's
 * `wanting` was a standing condition that never moved during a call, the
 * two never met. A gate that follows live state (a track starting, a panel
 * opening) unmounts the card and hands it straight back, which is the
 * repeating card the onboarding rules say never to build.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

let host: HTMLDivElement;
let root: Root;

function mount(enabled = true) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  render(enabled);
  return host;
}

function render(enabled: boolean) {
  act(() => {
    root.render(
      <FeatureHint id="music" enabled={enabled} body="A fila fica aqui." />,
    );
  });
}

function unmount() {
  act(() => root.unmount());
  host.remove();
}

describe("a dismissed feature hint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFeatureHintsForTests();
    window.localStorage.clear();
    // jsdom answers localhost, where hints deliberately persist nothing.
    window.localStorage.setItem(HINTS_PERSIST_OVERRIDE_KEY, "1");
  });

  afterEach(() => {
    unmount();
    vi.useRealTimers();
  });

  it("does not come back when its gate flickers and remounts it", () => {
    mount();
    expect(host.querySelector("[data-corner-card='music']")).not.toBeNull();
    // The X; the CTA below it closes the card the same way.
    const dismiss = host.querySelector("button") as HTMLButtonElement;
    act(() => dismiss.click());
    // The card animates out before it unmounts, so let the exit finish.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(host.querySelector("[data-corner-card='music']")).toBeNull();
    unmount();

    mount();
    expect(host.querySelector("[data-corner-card='music']")).toBeNull();
  });

  /*
   * The other half, and the one somebody actually hits: they never press
   * Entendi, they just open the panel the card points at. The gate turns
   * off, the card unmounts, and closing the panel used to hand it back.
   * A gate that turns off after the card has been shown has spent it; a
   * bare remount with the gate unchanged (the stage swapping its strip)
   * has not, which is what `eligibleThisLoad` is there for.
   */
  it("is spent by the gate turning off, not only by Entendi", () => {
    mount();
    expect(host.querySelector("[data-corner-card='music']")).not.toBeNull();
    // They open the Fila: nothing playing is no longer true.
    render(false);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    unmount();

    // And close it again.
    mount();
    expect(host.querySelector("[data-corner-card='music']")).toBeNull();
  });

  it("survives a remount that changed nothing, which is the strip swap", () => {
    mount();
    expect(host.querySelector("[data-corner-card='music']")).not.toBeNull();
    unmount();
    mount();
    expect(host.querySelector("[data-corner-card='music']")).not.toBeNull();
  });
});
