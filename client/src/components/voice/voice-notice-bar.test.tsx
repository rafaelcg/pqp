// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceNoticeBar } from "./voice-notice-bar";

/**
 * Reported 2026-09-17: "this call got big, join/leave sounds are off" sat
 * over the stage for the rest of the call with no way to close it. Every
 * voice notice is transient, so the strip auto-hides and has a close button.
 * Same jsdom pattern as `mic-fallback-notice.test.tsx`.
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

function strip(): Element | null {
  return document.querySelector("[data-voice-notice]");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("VoiceNoticeBar", () => {
  it("shows a notice, then hides it on its own", () => {
    mount(<VoiceNoticeBar notice="call got big" autoHideMs={1000} />);
    expect(strip()?.textContent).toContain("call got big");
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(strip()).toBeNull();
  });

  it("can be closed, and only a NEW notice shows again", () => {
    mount(<VoiceNoticeBar notice="first" autoHideMs={60_000} />);
    act(() => {
      (strip()!.querySelector("button") as HTMLButtonElement).click();
    });
    expect(strip()).toBeNull();
    act(() => {
      root!.render(<VoiceNoticeBar notice="first" autoHideMs={60_000} />);
    });
    expect(strip()).toBeNull();
    act(() => {
      root!.render(<VoiceNoticeBar notice="second" autoHideMs={60_000} />);
    });
    expect(strip()?.textContent).toContain("second");
  });
});
