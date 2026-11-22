// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushPin } from "@phosphor-icons/react";
import { Copy, Pin } from "lucide-react";
import { ContextMenu, type ContextMenuItemDef } from "./context-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let phoneWidth = false;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  phoneWidth = false;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: phoneWidth,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
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
  root = null;
  host = null;
  document.documentElement.removeAttribute("data-redesign");
  localStorage.clear();
  vi.unstubAllGlobals();
});

function render(ui: React.ReactElement) {
  act(() => root!.render(ui));
}

async function openAt(target: Element) {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
}

const menu = () => document.querySelector("[data-context-menu]");
const row = (id: string) => document.querySelector<HTMLElement>(`[data-menu-item="${id}"]`);

async function key(target: Element, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

describe("ContextMenu submenu", () => {
  const copyText = vi.fn();
  const items: ContextMenuItemDef[] = [
    { id: "reply", label: "Responder", onSelect: () => {} },
    {
      id: "copy",
      label: "Copiar",
      submenu: [
        { id: "copy-text", label: "Copiar texto", onSelect: copyText },
        { id: "copy-link", label: "Copiar link da mensagem", onSelect: () => {} },
        { id: "copy-id", label: "Copiar ID da mensagem", onSelect: () => {} },
      ],
    },
  ];

  it("opens with arrow right and closes with arrow left", async () => {
    render(
      <ContextMenu items={items}>
        <div data-testid="target">mensagem</div>
      </ContextMenu>,
    );
    await openAt(host!.querySelector("[data-testid=target]")!);
    expect(menu()).not.toBeNull();
    const trigger = row("copy")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    // Its rows are not in the menu until the submenu opens.
    expect(row("copy-text")).toBeNull();

    await act(async () => trigger.focus());
    await key(trigger, "ArrowRight");
    expect(document.querySelector("[data-context-submenu=copy]")).not.toBeNull();
    // Only the top-level menu answers to the menu's own test hook.
    expect(document.querySelectorAll("[data-context-menu]")).toHaveLength(1);
    const inner = row("copy-text")!;
    expect(inner).not.toBeNull();

    await key(inner, "ArrowLeft");
    expect(document.querySelector("[data-context-submenu=copy]")).toBeNull();
    expect(menu()).not.toBeNull();
  });

  it("draws a menu without submenus through the shared rows only", async () => {
    render(
      <ContextMenu items={[{ id: "reply", label: "Responder", onSelect: () => {} }]}>
        <div data-testid="target">mensagem</div>
      </ContextMenu>,
    );
    await openAt(host!.querySelector("[data-testid=target]")!);
    expect(row("reply")!.getAttribute("aria-haspopup")).toBeNull();
  });
});

describe("ContextMenu row glyphs", () => {
  it("draws the Lucide icon and its Phosphor twin for a row with a glyph", async () => {
    render(
      <ContextMenu
        items={[
          { id: "pin", label: "Fixar", icon: Pin, glyph: PushPin, onSelect: () => {} },
          { id: "copy", label: "Copiar", icon: Copy, onSelect: () => {} },
        ]}
      >
        <div data-testid="target">mensagem</div>
      </ContextMenu>,
    );
    await openAt(host!.querySelector("[data-testid=target]")!);
    // With a glyph: Lucide hidden under the redesign, Phosphor shown only there.
    const pin = [...row("pin")!.querySelectorAll("svg")];
    expect(pin).toHaveLength(2);
    expect(pin[0]!.getAttribute("class")).toContain("lucide-pin");
    expect(pin[0]!.getAttribute("class")).toContain("redesign:hidden");
    expect(pin[1]!.getAttribute("class")).toContain("redesign:block");
    // Without one: the Lucide icon alone, as before.
    const copy = [...row("copy")!.querySelectorAll("svg")];
    expect(copy).toHaveLength(1);
    expect(copy[0]!.getAttribute("class")).toContain("lucide-copy");
    expect(copy[0]!.getAttribute("class")).not.toContain("redesign:hidden");
  });
});

describe("ContextMenu phone sheet", () => {
  const items: ContextMenuItemDef[] = [{ id: "reply", label: "Responder", onSelect: vi.fn() }];

  it("draws the grabber and the header only for a sheet", async () => {
    render(
      <ContextMenu items={items} sheetOnPhone sheetHeader={<p>Ana: oi</p>}>
        <div data-testid="target">mensagem</div>
      </ContextMenu>,
    );
    await openAt(host!.querySelector("[data-testid=target]")!);
    const header = document.querySelector("[data-sheet-header]")!;
    expect(header.textContent).toBe("Ana: oi");
    expect(header.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector("[data-sheet-grabber]")).not.toBeNull();
    // Hidden by default: only the redesign, below sm, shows them.
    expect(header.className).toContain("hidden");
    expect(header.className).toContain("redesign:max-sm:block");
  });

  it("ignores the header on a menu that is never a sheet", async () => {
    render(
      <ContextMenu items={items} sheetHeader={<p>Ana: oi</p>}>
        <div data-testid="target">mensagem</div>
      </ContextMenu>,
    );
    await openAt(host!.querySelector("[data-testid=target]")!);
    expect(document.querySelector("[data-sheet-header]")).toBeNull();
    expect(document.querySelector("[data-sheet-grabber]")).toBeNull();
  });

  it("does not let the release of the opening press choose a row", async () => {
    phoneWidth = true;
    localStorage.setItem("pqp-redesign", "on");
    const onSelect = vi.fn();
    render(
      <ContextMenu items={[{ id: "delete", label: "Apagar", onSelect }]} sheetOnPhone>
        <div data-testid="target">mensagem</div>
      </ContextMenu>,
    );
    await openAt(host!.querySelector("[data-testid=target]")!);
    const target = row("delete")!;
    await act(async () => {
      target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
    // A new press inside the sheet counts.
    await act(async () => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
      target.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
