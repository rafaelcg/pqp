// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, dialogOpener, noteMenuRowChosen } from "./dialog";
import { Menu } from "./menu";

/*
 * A row that opens a dialog hands focus to that dialog. Radix's own
 * return-to-trigger used to run after it and pull focus back out from under
 * the modal, so Enter reopened the menu behind it (QA, 2026-10-11).
 *
 * Focus is polled rather than read after a fixed wait: on a loaded CI runner
 * the menu can finish closing after the wait (2026-10-12).
 */

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function mount(onSelect: () => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <Menu items={[{ id: "open", label: "Abrir", onSelect }]}>
        <button type="button">Menu</button>
      </Menu>,
    );
  });
  return host.querySelector("button")!;
}

async function openWithKeyboard(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function chooseFirstRow() {
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  await act(async () => {
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("Menu focus after a row is chosen", () => {
  it("leaves focus where the chosen row put it", async () => {
    const dialogButton = document.createElement("button");
    // As a real dialog does: it mounts and takes focus once the menu has
    // closed, not while the menu still traps focus.
    const trigger = mount(() => {
      setTimeout(() => {
        document.body.appendChild(dialogButton);
        dialogButton.focus();
      }, 0);
    });
    await openWithKeyboard(trigger);
    await chooseFirstRow();
    // Focus reaching the dialog is not enough: the bug was the menu taking it
    // back afterwards. Wait for the menu to be gone and its timers to run.
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(dialogButton);
  });

  it("returns focus to the trigger when the row took none", async () => {
    const trigger = mount(() => undefined);
    await openWithKeyboard(trigger);
    await chooseFirstRow();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("returns focus to the trigger when the dialog a row opened closes", async () => {
    let close: () => void = () => undefined;
    function Harness() {
      const [open, setOpen] = useState(false);
      close = () => setOpen(false);
      return (
        <>
          <Menu items={[{ id: "open", label: "Abrir", onSelect: () => setOpen(true) }]}>
            <button type="button">Menu</button>
          </Menu>
          <Dialog open={open} title="Ajustes" onClose={() => setOpen(false)}>
            <button type="button">Dentro</button>
          </Dialog>
        </>
      );
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    const trigger = host.querySelector("button")!;
    await openWithKeyboard(trigger);
    await chooseFirstRow();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    await act(async () => {
      close();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("names the chosen row's trigger for a dialog that opens after the menu is gone", async () => {
    const trigger = mount(() => undefined);
    noteMenuRowChosen(trigger);
    expect(dialogOpener(document.body)).toBe(trigger);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    // Focus that is somewhere real is the opener, whatever was chosen.
    expect(dialogOpener(elsewhere)).toBe(elsewhere);
    noteMenuRowChosen(null);
    expect(dialogOpener(document.body)).toBe(document.body);
  });

  it("forgets the chosen row once the menu has settled focus", async () => {
    const trigger = mount(() => undefined);
    await openWithKeyboard(trigger);
    await chooseFirstRow();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    // A dialog opened later, by something else, with focus on <body>, must not
    // send focus back to this menu's trigger when it closes.
    trigger.blur();
    expect(dialogOpener(document.body)).toBe(document.body);
  });
});
