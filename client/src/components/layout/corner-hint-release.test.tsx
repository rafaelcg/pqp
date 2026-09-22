// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CargosHint } from "./cargos-hint";
import { MobileBetaHint } from "./mobile-beta-hint";
import { ShortcutsHint } from "./shortcuts-hint";
import { WhatsNewPrompt } from "./whats-new-prompt";

/**
 * DISMISSING A CORNER CARD HAS TO GIVE THE CORNER BACK.
 *
 * `lib/corner-hints.ts` hands the corner to the first card that wants it,
 * and `App` yields the one attached-hint slot for as long as anybody holds
 * it (`liveAttachedHint`). Each of these cards closed itself with local
 * state and told `App` nothing, so `App` went on offering the corner to a
 * card nobody could see and buried every attached tip behind it — the call
 * dock card and both music cards — for the rest of the page load.
 *
 * On localhost that was every load, because `lib/hints.ts` deliberately
 * remembers no dismissal there, so the card came back on the next render of
 * the queue and the in-call tips were never drawn once.
 *
 * The URL above is not localhost on purpose: this was not a localhost bug.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

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
  localStorage.clear();
});

function card(name: string): HTMLElement | null {
  return document.querySelector(`[data-corner-card="${name}"]`);
}

/** The X in the card's own header, which is the plain dismissal. */
async function dismiss(name: string) {
  const button = card(name)?.querySelector<HTMLButtonElement>(
    "button[aria-label]",
  );
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
}

describe("a dismissed corner card releases the corner", () => {
  it("cargos", async () => {
    const onDismiss = vi.fn();
    await mount(
      <CargosHint enabled onOpenRoles={() => {}} onDismiss={onDismiss} />,
    );

    expect(card("cargos")).not.toBeNull();
    await dismiss("cargos");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the phone beta invite", async () => {
    const onDismiss = vi.fn();
    await mount(
      <MemoryRouter>
        <MobileBetaHint enabled onDismiss={onDismiss} />
      </MemoryRouter>,
    );

    expect(card("mobile-beta")).not.toBeNull();
    await dismiss("mobile-beta");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Novidades", async () => {
    const onDismiss = vi.fn();
    await mount(
      <WhatsNewPrompt enabled onOpen={() => {}} onDismiss={onDismiss} />,
    );

    expect(card("whats-new")).not.toBeNull();
    await dismiss("whats-new");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the shortcut map", async () => {
    const onDismiss = vi.fn();
    await mount(
      <ShortcutsHint enabled shortcutLabel="Cmd + /" onDismiss={onDismiss} />,
    );

    expect(card("shortcuts")).not.toBeNull();
    await dismiss("shortcuts");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("taking the card's own action also releases it", () => {
  it("cargos opens the roles editor and gives the corner back", async () => {
    const onDismiss = vi.fn();
    const onOpenRoles = vi.fn();
    await mount(
      <CargosHint enabled onOpenRoles={onOpenRoles} onDismiss={onDismiss} />,
    );

    const cta = [...document.querySelectorAll("button")].find(
      (one) => one.getAttribute("aria-label") === null,
    );
    expect(cta).toBeDefined();
    await act(async () => {
      cta!.click();
    });

    expect(onOpenRoles).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
