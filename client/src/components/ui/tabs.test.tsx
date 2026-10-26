// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Tabs, type TabItem, type TabsSize, type TabsVariant } from "@/components/ui/tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}

type Id = "a" | "b" | "c";
const ITEMS: TabItem<Id>[] = [
  { id: "a", label: "A" },
  { id: "b", label: "B", disabled: true },
  { id: "c", label: "C", count: 3 },
];

function Harness({ variant, size, onChange }: { variant?: TabsVariant; size?: TabsSize; onChange?: (id: Id) => void }) {
  const [value, setValue] = useState<Id>("a");
  return (
    <Tabs
      label="Views"
      variant={variant}
      size={size}
      items={ITEMS}
      value={value}
      panelId="panel"
      onValueChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

function tabs(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

function press(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("Tabs", () => {
  it("names the list, marks the selected tab and points every tab at the panel", () => {
    const host = draw(<Harness />);
    const list = host.querySelector('[role="tablist"]')!;
    expect(list.getAttribute("aria-label")).toBe("Views");
    const [a, b, c] = tabs(host);
    expect(a!.getAttribute("aria-selected")).toBe("true");
    expect(c!.getAttribute("aria-selected")).toBe("false");
    expect(a!.getAttribute("aria-controls")).toBe("panel");
    expect(b!.disabled).toBe(true);
  });

  it("puts only the selected tab in the tab order", () => {
    const host = draw(<Harness />);
    expect(tabs(host).map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves and selects with the arrows, skipping a disabled tab, and wraps", () => {
    const onChange = vi.fn();
    const host = draw(<Harness onChange={onChange} />);
    const [a, , c] = tabs(host);
    a!.focus();
    press(a!, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(c);
    expect(c!.tabIndex).toBe(0);
    press(c!, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("a");
    press(a!, "End");
    expect(onChange).toHaveBeenLastCalledWith("c");
    press(c!, "Home");
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("does not call back when the selected tab is clicked again", () => {
    const onChange = vi.fn();
    const host = draw(<Harness onChange={onChange} />);
    act(() => tabs(host)[0]!.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws a count only above zero, and passes data attributes through", () => {
    const host = draw(
      <Tabs
        items={[
          { id: "x", label: "X", count: 0, data: { "data-pane": "x" } },
          { id: "y", label: "Y", count: 2 },
        ]}
        value="x"
        onValueChange={() => undefined}
      />,
    );
    const [x, y] = tabs(host);
    expect(x!.textContent).toBe("X");
    expect(x!.getAttribute("data-pane")).toBe("x");
    expect(y!.textContent).toBe("Y2");
  });
});

describe("Tabs looks with the toggle off", () => {
  function look(variant: TabsVariant, size: TabsSize) {
    const host = draw(<Harness variant={variant} size={size} />);
    const [on, , off] = tabs(host);
    return { list: host.querySelector('[role="tablist"]')!.className, on: on!.className, off: off!.className };
  }

  it("keeps the bot overview's underline and its focus ring", () => {
    const { list, on, off } = look("underline", "md");
    expect(list).toContain("border-[color:var(--tabs-rule,var(--color-border))]");
    expect(on).toContain("border-accent text-text");
    expect(off).toContain("text-[color:var(--tabs-off-text,var(--color-text-tertiary))]");
    expect(on).toContain("focus-visible:ring-2");
    expect(on).not.toContain("redesign:focus-visible:ring-2");
  });

  it("keeps the role tabs' track, thumb and shadow, and draws no new focus ring or truncation", () => {
    const { list, on } = look("segmented", "md");
    expect(list).toContain("rounded-[var(--segmented-radius,0.75rem)]");
    expect(list).toContain("p-[var(--segmented-pad,0.25rem)]");
    expect(on).toContain("bg-[color:var(--segmented-thumb,var(--color-surface-1))]");
    expect(on).toContain("0_1px_3px_0_rgb(0_0_0/0.1),0_1px_2px_-1px_rgb(0_0_0/0.1)");
    expect(on).toContain("redesign:truncate");
    expect(on).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(on).not.toMatch(/(^|\s)focus-visible:ring-2/);
  });

  it("keeps the profile popover's compact track", () => {
    const { list, on } = look("segmented", "xs");
    expect(list).toContain("rounded-[var(--segmented-radius,0.5rem)]");
    expect(on).toContain("text-[11px]");
    expect(on).toContain("shadow-[var(--segmented-thumb-shadow,0_0_transparent)]");
  });

  it("keeps the friends and call-split pills", () => {
    expect(look("pill", "md").on).toContain("bg-[color:var(--tabs-pill-on,var(--color-surface-2))] text-text");
    expect(look("pill", "xs").on).toContain("bg-[color:var(--tabs-pill-on,var(--color-surface-2))] text-text");
  });

  it("keeps the reports filter's filled chip", () => {
    const { on, off } = look("filled", "sm");
    expect(on).toContain("bg-accent text-surface-0");
    expect(off).toContain("bg-[color:var(--tabs-filled-off,var(--color-surface-2))]");
  });

  it("sets a selected pill apart from a hovered one by weight, and the filled chip on the accent's own text", () => {
    expect(look("pill", "md").on).toContain("redesign:font-medium");
    expect(look("pill", "xs").on).toContain("redesign:font-medium");
    expect(look("pill", "xs").off).toContain("redesign:font-normal");
    expect(look("filled", "sm").on).toContain("redesign:text-on-accent");
  });

  it("puts segmented cells on RadioGroup's ladder only under the redesign", () => {
    expect(look("segmented", "md").on).toContain("redesign:h-[var(--segmented-h)]");
    expect(look("segmented", "xs").on).toContain("redesign:h-[var(--segmented-h-sm)]");
    expect(look("segmented", "xs").list).toContain("redesign:p-[var(--segmented-pad)]");
    expect(look("segmented", "md").list).toContain("redesign:gap-0.5");
    expect(look("segmented", "xs").on).toContain("redesign:font-medium");
    expect(look("segmented", "xs").off).toContain("redesign:font-normal");
    expect(look("filled", "sm").off).toContain("redesign:hover:bg-[color:var(--tabs-filled-hover)]");
  });
});
