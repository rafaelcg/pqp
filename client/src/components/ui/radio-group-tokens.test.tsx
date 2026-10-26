// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  RadioGroup,
  SEGMENTED_CELL,
  SEGMENTED_CELL_OFF,
  SEGMENTED_CELL_ON,
  SEGMENTED_TRACK,
} from "@/components/ui/radio-group";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}

const OPTIONS = [
  { value: "a", label: "A", description: "first" },
  { value: "b", label: "B", description: "second" },
] as const;

function group(variant: "segmented" | "chips" | "list") {
  return draw(
    <RadioGroup
      label="g"
      variant={variant}
      value="a"
      onValueChange={() => undefined}
      options={variant === "segmented" ? OPTIONS.map(({ value, label }) => ({ value, label })) : OPTIONS}
    />,
  );
}

describe("RadioGroup tokens", () => {
  it("draws today's segmented track and thumb when the tokens are unset", () => {
    const host = group("segmented");
    const track = host.querySelector('[role="radiogroup"]')!.className;
    expect(track).toContain("bg-[color:var(--segmented-bg,var(--color-surface-0))]");
    expect(track).toContain("border-[color:var(--segmented-border,var(--color-border))]");
    const [on, off] = host.querySelectorAll('[role="radio"]');
    expect(on!.className).toContain("bg-[color:var(--segmented-thumb,var(--color-surface-2))]");
    expect(on!.className).toContain("shadow-[var(--segmented-thumb-shadow,0_0_transparent)]");
    expect(off!.className).toContain("text-[color:var(--segmented-text,var(--color-text-tertiary))]");
  });

  it("keeps the chip edge and hover on tokens, and only weights the checked chip under the redesign", () => {
    const [on, off] = group("chips").querySelectorAll('[role="radio"]');
    expect(on!.className).not.toContain("font-medium");
    expect(off!.className).toContain("border-[color:var(--chip-border,var(--color-border))]");
    expect(off!.className).toContain("hover:bg-[color:var(--chip-hover,var(--color-surface-2))]");
  });

  it("sizes the list dot from tokens and fills it with the accent only under the redesign", () => {
    const [on, off] = group("list").querySelectorAll('[role="radio"] [aria-hidden]');
    expect(on!.getAttribute("class")).toContain("redesign:bg-accent");
    expect(on!.getAttribute("class")).toContain("h-[var(--radio-size,1rem)]");
    expect(on!.firstElementChild!.getAttribute("class")).toContain(
      "bg-[color:var(--radio-dot,var(--color-accent))]",
    );
    expect(off!.getAttribute("class")).toContain(
      "border-[color:var(--radio-off-ring,var(--color-border-strong))]",
    );
  });

  it("puts the segmented track on the control ladder and the ring inside it", () => {
    const [cell] = group("segmented").querySelectorAll('[role="radio"]');
    expect(cell!.className).toContain("sm:h-[var(--segmented-h,2rem)]");
    expect(cell!.className).toContain("focus-visible:ring-offset-[length:var(--segmented-ring-offset,2px)]");
    expect(cell!.className).toContain("redesign:focus-visible:ring-offset-transparent");
    const track = group("segmented").querySelector('[role="radiogroup"]')!.className;
    expect(track).toContain("border-[length:var(--segmented-border-w,1px)]");
  });

  it("exports the recipe a hand-drawn segmented picker shares", () => {
    expect(SEGMENTED_TRACK).toContain("p-[var(--segmented-pad,0.125rem)]");
    expect(SEGMENTED_CELL).toContain("rounded-[var(--segmented-radius,var(--radius-control))]");
    expect(SEGMENTED_CELL_ON).toContain("font-medium text-text");
    expect(SEGMENTED_CELL_OFF).toContain("var(--color-text-tertiary)");
  });
});
