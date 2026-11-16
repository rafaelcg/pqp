// @vitest-environment jsdom
import type { JamPublication } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamPublicationState } from "@/hooks/use-jam-publication";
import { I18nProvider } from "@/lib/i18n";
import { JamPublicSheet } from "./jam-public-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const SONG = "11111111-1111-4111-8111-111111111111";

function publication(autoAcceptOutside: boolean): JamPublication {
  return {
    songId: SONG,
    status: "live",
    listed: true,
    publishedAt: new Date().toISOString(),
    hasOrigin: false,
    showOrigin: true,
    plays: 0,
    likes: 0,
    removedReason: null,
    cover: "none",
    parts: [],
    pendingTakes: 0,
    autoAcceptOutside,
  };
}

function render(autoAcceptOutside: boolean) {
  const setAutoAccept = vi.fn(async () => true);
  const state: JamPublicationState = {
    loading: false,
    lookupFailed: false,
    publication: publication(autoAcceptOutside),
    busy: false,
    error: null,
    refresh: async () => undefined,
    publish: async () => true,
    setShowOrigin: async () => true,
    setAutoAccept,
    unpublish: async () => true,
  };
  act(() => {
    root.render(
      <I18nProvider>
        <JamPublicSheet
          open
          onClose={() => undefined}
          songId={SONG}
          viewerId={null}
          songTitle="In Bloom"
          originName={null}
          state={state}
          publicUrl="http://localhost/jam/m/x"
        />
      </I18nProvider>,
    );
  });
  return setAutoAccept;
}

const switchEl = () => document.querySelector<HTMLElement>("[data-jam-auto-accept] [role=switch]")!;
const buttonWith = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((one) => one.textContent?.trim() === text);

describe("the auto-accept switch in a song's public settings", () => {
  it("is off by default, says what it does in plain words, and asks before turning on", () => {
    const setAutoAccept = render(false);
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("without you tapping Accept");
    act(() => switchEl().click());
    // Nothing is written until the person confirms, and the question says it all.
    expect(setAutoAccept).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Accept outside parts on their own?");
    expect(document.body.textContent).toContain("Parts already waiting still wait for you");
    expect(document.body.textContent).toContain("Switching it off does not remove what already got in");
    act(() => buttonWith("Not now")!.click());
    expect(setAutoAccept).not.toHaveBeenCalled();
    act(() => switchEl().click());
    act(() => buttonWith("Turn on")!.click());
    expect(setAutoAccept).toHaveBeenCalledWith(true);
  });

  it("shows that it is on, and turns off in one tap with no question", () => {
    const setAutoAccept = render(true);
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
    act(() => switchEl().click());
    expect(setAutoAccept).toHaveBeenCalledWith(false);
    expect(document.body.textContent).not.toContain("Accept outside parts on their own?");
  });
});
