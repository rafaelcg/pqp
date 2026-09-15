// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveCatalogue } from "@/lib/i18n";
import { MicFallbackNotice } from "./mic-fallback-notice";

/**
 * Reported 2026-09-14: the fallback-microphone notice had no way to close,
 * so it sat over the stage for the rest of the call even after the saved
 * device came back. `use-voice.test.ts` pins the state machine behind it
 * (`voiceState.micFallback`); this is the one thing only a real DOM can
 * prove: the close button is actually there, and clicking it actually
 * reports a close. Same jsdom pattern as `corner-card-escape.test.tsx`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setActiveCatalogue(undefined);
});

function card(): Element | null {
  return document.querySelector('[data-corner-card="voice-mic-fallback"]');
}

function closeButton(): HTMLButtonElement | null {
  return card()?.querySelector('button[aria-label="Dismiss hint"]') ?? null;
}

function switchButton(): HTMLButtonElement | null {
  return [...(card()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Switch microphone",
  ) as HTMLButtonElement | undefined ?? null;
}

describe("MicFallbackNotice", () => {
  it("renders nothing while there is no fallback", () => {
    mount(<MicFallbackNotice micFallback={null} onDismiss={() => {}} />);
    expect(card()).toBeNull();
  });

  it("names the substitute microphone and offers a way to switch back", () => {
    mount(
      <MicFallbackNotice
        micFallback={{ label: "fifine Microphone" }}
        onDismiss={() => {}}
      />,
    );
    expect(card()?.textContent).toContain("fifine Microphone");
    expect(switchButton()).not.toBeNull();
  });

  it("says so plainly when the substitute has no name", () => {
    mount(<MicFallbackNotice micFallback={{ label: null }} onDismiss={() => {}} />);
    expect(card()?.textContent).toContain("using another one");
  });

  it("has a close button, and clicking it reports a close", () => {
    const onDismiss = vi.fn();
    mount(
      <MicFallbackNotice
        micFallback={{ label: "fifine Microphone" }}
        onDismiss={onDismiss}
      />,
    );
    const button = closeButton();
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way while the call chrome starts hidden", () => {
    // Same reasoning as `CapacityNotice.visible`: a card nobody can see must
    // not spend its impression, and must not be there for the chrome's own
    // fade-in to reveal a beat later.
    mount(
      <MicFallbackNotice
        micFallback={{ label: "fifine Microphone" }}
        visible={false}
        onDismiss={() => {}}
      />,
    );
    expect(card()).toBeNull();
  });
});
