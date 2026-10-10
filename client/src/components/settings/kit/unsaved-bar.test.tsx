// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UnsavedChangesBar,
  type UnsavedChangesBarProps,
} from "@/components/settings/kit/unsaved-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(props: Partial<UnsavedChangesBarProps> = {}) {
  act(() =>
    root!.render(
      <UnsavedChangesBar
        visible
        saving={false}
        onDiscard={() => {}}
        onSave={() => {}}
        {...props}
      />,
    ),
  );
}

const button = (kind: "save" | "discard") =>
  host!.querySelector<HTMLButtonElement>(`[data-unsaved-${kind}]`)!;
const region = () => host!.querySelector<HTMLElement>('p.sr-only[role="status"]')!;

describe("UnsavedChangesBar", () => {
  it("keeps Salvar and Descartar focusable while the save runs, and ignores them", () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render({ onSave, onDiscard });
    act(() => button("save").focus());
    render({ onSave, onDiscard, saving: true });
    for (const kind of ["save", "discard"] as const) {
      expect(button(kind).disabled).toBe(false);
      expect(button(kind).getAttribute("aria-disabled")).toBe("true");
      act(() => button(kind).click());
    }
    expect(document.activeElement).toBe(button("save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("says the save starting and its failure through the region mounted before them", () => {
    render({ visible: false });
    const before = region();
    expect(before.textContent).toBe("");
    render({ saving: true });
    expect(region()).toBe(before);
    expect(before.textContent).toMatch(/Saving|Salvando/);
    render({ error: "Não deu pra salvar." });
    expect(before.textContent).toBe("Não deu pra salvar.");
    // The visible line is plain text: one voice, not two.
    const line = host!.querySelector("[data-unsaved-error]")!;
    expect(line.textContent).toBe("Não deu pra salvar.");
    expect(line.getAttribute("role")).toBeNull();
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });

  it("lets its buttons wrap inside the bar on a phone instead of running off it", () => {
    render({ onShowSource: () => {} });
    const group = button("save").parentElement!;
    expect(group.className).not.toMatch(/\bshrink-0\b/);
    expect(group.className).toMatch(/\bflex-wrap\b/);
    expect(group.className).toMatch(/\bmax-w-full\b/);
  });
});
