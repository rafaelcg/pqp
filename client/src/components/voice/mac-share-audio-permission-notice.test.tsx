// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveCatalogue } from "@/lib/i18n";
import {
  clearMacShareAudioPermission,
  raiseMacShareAudioPermission,
  resetMacShareAudioPermissionForTests,
} from "@/lib/mac-share-audio-permission";
import { MacShareAudioPermissionNotice } from "./mac-share-audio-permission-notice";

/**
 * The presenter's card for a Mac share that went out with no sound because
 * System Audio Recording is not granted. The detection is
 * `mac-shell-share-audio.test.ts`; this proves the card says it, opens the
 * Settings pane from its button, and a new share's failure opens it again.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(visible = true) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(<MacShareAudioPermissionNotice visible={visible} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setActiveCatalogue(undefined);
  resetMacShareAudioPermissionForTests();
  delete (globalThis as { window?: { pqpDesktop?: unknown } }).window?.pqpDesktop;
  vi.useRealTimers();
});

const card = () => document.querySelector('[data-corner-card="mac-share-audio-permission"]');
const buttonNamed = (text: string) =>
  [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;

describe("MacShareAudioPermissionNotice", () => {
  it("renders nothing until a Mac share loses its sound", () => {
    render();
    expect(card()).toBeNull();
  });

  it("says what the viewers get, what to turn on, and no em dash", () => {
    render();
    act(() => raiseMacShareAudioPermission());
    expect(card()?.textContent).toContain("Your share has no sound");
    expect(card()?.textContent).toContain("System Audio Recording");
    expect(card()?.textContent).toContain("headphones");
    expect(card()?.textContent).not.toMatch(/—/);
  });

  it("opens the System Audio Recording pane from its button", () => {
    const open = vi.fn(async () => true);
    (window as unknown as { pqpDesktop: unknown }).pqpDesktop = {
      isElectron: true,
      platform: "darwin",
      macShareAudioOpenSettings: open,
    };
    render();
    act(() => raiseMacShareAudioPermission());
    act(() => buttonNamed("Open System Settings")?.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("closes with Got it, opens again for the next share, and goes when the next share starts", () => {
    vi.useFakeTimers();
    render();
    act(() => raiseMacShareAudioPermission());
    act(() => buttonNamed("Got it")?.click());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(card()).toBeNull();
    act(() => raiseMacShareAudioPermission());
    expect(card()).not.toBeNull();
    act(() => clearMacShareAudioPermission());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(card()).toBeNull();
  });
});
