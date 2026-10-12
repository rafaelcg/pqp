// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveCatalogue } from "@/lib/i18n";
import { onConnectionCheckRequest } from "@/lib/settings-request";
import { AudioHealthNotice } from "./audio-health-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  return document.querySelector('[data-corner-card="voice-audio-health"]');
}

function button(label: string): HTMLButtonElement | null {
  return ([...(card()?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === label,
  ) ?? null) as HTMLButtonElement | null;
}

describe("AudioHealthNotice", () => {
  it("renders nothing without a prompt", () => {
    mount(<AudioHealthNotice prompt={null} onRepair={() => {}} onDismiss={() => {}} />);
    expect(card()).toBeNull();
  });

  it("says which way the sound broke, and the button repairs it", () => {
    const onRepair = vi.fn();
    mount(<AudioHealthNotice prompt="mic" onRepair={onRepair} onDismiss={() => {}} />);
    expect(card()?.textContent).toContain("Looks like your mic stopped");
    act(() => button("Fix it")!.click());
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("offers the connection check beside the repair", () => {
    const opened = vi.fn();
    const stop = onConnectionCheckRequest(opened);
    mount(<AudioHealthNotice prompt="hearing" onRepair={() => {}} onDismiss={() => {}} />);
    expect(card()?.textContent).toContain("Can't hear anyone?");
    act(() => button("Check connection")!.click());
    expect(opened).toHaveBeenCalledTimes(1);
    stop();
  });

  it("closes", () => {
    const onDismiss = vi.fn();
    mount(<AudioHealthNotice prompt="micUnavailable" onRepair={() => {}} onDismiss={onDismiss} />);
    act(() => (card()?.querySelector('button[aria-label="Dismiss hint"]') as HTMLButtonElement).click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
