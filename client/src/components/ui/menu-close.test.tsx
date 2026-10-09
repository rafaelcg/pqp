// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Menu } from "./menu";

/**
 * A menu that goes away while open still says it closed.
 *
 * Radix reports a close from an effect on its Root, so a Root that unmounts
 * in the same render that closes it never reports anything. The call stage
 * counts open tile menus to keep its controls from fading, and a "Parar de
 * assistir" row removes the very menu it sits in: the count never came back
 * down and the stage never idled again for that share.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const ITEMS: ContextMenuItemDef[] = [{ id: "a", label: "A", onSelect: () => {} }];

function render(items: ContextMenuItemDef[], onOpenChange: (open: boolean) => void) {
  act(() => {
    root!.render(
      <Menu items={items} onOpenChange={onOpenChange}>
        <button type="button">open</button>
      </Menu>,
    );
  });
}

async function openMenu() {
  const trigger = host!.querySelector("button")!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

describe("Menu", () => {
  it("reports a close when its items run out while it is open", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onOpenChange = vi.fn();
    render(ITEMS, onOpenChange);
    await openMenu();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    render([], onOpenChange);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("reports a close when it unmounts while open", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onOpenChange = vi.fn();
    render(ITEMS, onOpenChange);
    await openMenu();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    act(() => root!.render(<div />));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
