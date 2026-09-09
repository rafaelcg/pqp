// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { setInCall } from "@/lib/in-call-state";
import {
  isUpdateWaiting,
  requestUpdatePrompt,
  resetUpdateState,
} from "@/lib/update-prompt-state";
import type { ServiceWorkerControls } from "@/lib/register-sw";
import { CornerCard } from "./corner-card";
import { UpdatePrompt } from "./update-prompt";

/**
 * THE BUG THIS FILE EXISTS FOR, reported from production on 9 Sep 2026:
 * *"other onboarding popups are making the update one disappear so im stuck on
 * an old version of the app cause i can't click on it anymore."*
 *
 * Reproduced on a real build served by a real service worker: with a new
 * bundle waiting and the QG invite up, ONE Escape keypress removed the update
 * card and left the onboarding card standing. Every corner card attaches its
 * own capture-phase Escape listener to `document`; the update card is mounted
 * first (it lives in `main.tsx`, outside `App`), so it registers first, runs
 * first, calls `preventDefault`, and the card the person was actually trying
 * to dismiss survives while the one they cannot get back does not. Twenty
 * minutes of snooze later it is due again, unless they are in a call, and a
 * watch party is hours of call.
 *
 * A DOM is the only place any of that is observable, so this file, its
 * `corner-card-escape` sibling and `qg-hint-gating` are the only ones in the
 * client suite that ask for jsdom. Everything else stays on `node`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Stands in for the service worker: `arrive()` is a new build landing. */
function fakeWorker() {
  let notify: (() => void) | null = null;
  let updated = 0;
  const register = (onNeedRefresh: () => void): ServiceWorkerControls => {
    notify = onNeedRefresh;
    return {
      async update() {
        updated += 1;
      },
      dispose() {
        notify = null;
      },
    };
  };
  return {
    register,
    arrive: () => act(() => notify?.()),
    updates: () => updated,
  };
}

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInCall(false);
  resetUpdateState();
});

function updateCard(): Element | null {
  return document.querySelector('[data-corner-card="update"]');
}

function pressEscape() {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function clickText(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  );
  if (!button) {
    throw new Error(`no button labelled ${text}`);
  }
  act(() => button.click());
}

/** The exit animation unmounts a corner card 180ms after `open` goes false. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

describe("the update notice", () => {
  it("appears when a build lands, and Escape does not take it away", async () => {
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    expect(updateCard()).toBeNull();

    await worker.arrive();
    expect(updateCard()).not.toBeNull();

    pressEscape();
    await settle();

    expect(updateCard()).not.toBeNull();
  });

  it("does not swallow Escape from the onboarding card beside it", async () => {
    // The other half of the reported bug: the keypress was aimed at the QG
    // card, and that card has to actually close.
    const worker = fakeWorker();
    let hintClosed = 0;
    await mount(
      <>
        <UpdatePrompt register={worker.register} />
        <CornerCard
          open
          onClose={() => (hintClosed += 1)}
          label="qg"
          dismissLabel="dismiss"
          dataAttribute="qg"
          title="Come into the QG"
        />
      </>,
    );
    await worker.arrive();

    pressEscape();
    await settle();

    expect(hintClosed).toBe(1);
    expect(updateCard()).not.toBeNull();
  });

  it("keeps the build waiting after Later, so the rail keeps its way back", async () => {
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    await worker.arrive();
    expect(isUpdateWaiting()).toBe(true);

    clickText("Later");
    await settle();

    expect(updateCard()).toBeNull();
    // The card is snoozed. The FACT is not: this is what draws the rail icon.
    expect(isUpdateWaiting()).toBe(true);
  });

  it("comes back when the rail asks for it, snoozed or not", async () => {
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    await worker.arrive();

    clickText("Later");
    await settle();
    expect(updateCard()).toBeNull();

    act(() => requestUpdatePrompt());
    expect(updateCard()).not.toBeNull();
  });

  it("hushes during a call but comes back when the rail asks", async () => {
    // The hush is deliberate: a reload kills a screen share and cannot restore
    // it. What must not happen is the person having no way to take the update
    // for the length of a watch party.
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    await worker.arrive();

    act(() => setInCall(true));
    await settle();
    expect(updateCard()).toBeNull();
    expect(isUpdateWaiting()).toBe(true);

    act(() => requestUpdatePrompt());
    expect(updateCard()).not.toBeNull();
  });

  it("takes the update when Reload is pressed", async () => {
    const worker = fakeWorker();
    await mount(<UpdatePrompt register={worker.register} />);
    await worker.arrive();

    clickText("Reload");

    expect(worker.updates()).toBe(1);
  });
});
