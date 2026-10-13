// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_NOTICE_AUTO_HIDE_MS } from "./voice-notice-bar";
import {
  useWatchPartySilentShareWarning,
  WatchPartySilentShareWarning,
} from "./watch-party-silent-share-warning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness({ active }: { active: boolean }) {
  const warning = useWatchPartySilentShareWarning(active);
  return warning.shown ? <WatchPartySilentShareWarning onDismiss={warning.dismiss} /> : null;
}

function render(active: boolean) {
  act(() => {
    root!.render(<Harness active={active} />);
  });
}

function strip(): HTMLElement | null {
  return document.querySelector("[data-watch-party-silent-share]");
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("WatchPartySilentShareWarning", () => {
  it("shows nothing while the party has its sound", () => {
    render(false);
    expect(strip()).toBeNull();
  });

  it("is an alert that outlives the notice strip's auto-hide", () => {
    render(true);
    expect(strip()?.getAttribute("role")).toBe("alert");
    act(() => {
      vi.advanceTimersByTime(VOICE_NOTICE_AUTO_HIDE_MS * 10);
    });
    expect(strip()).not.toBeNull();
  });

  it("goes only when the host closes it, and comes back for the next silent share", () => {
    render(true);
    act(() => {
      strip()!.querySelector("button")!.click();
    });
    expect(strip()).toBeNull();
    render(true);
    expect(strip()).toBeNull();

    render(false);
    render(true);
    expect(strip()).not.toBeNull();
  });
});
