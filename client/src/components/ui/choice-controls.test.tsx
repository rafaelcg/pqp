// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { CheckRow, TickBox } from "@/components/ui/check-row";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch, SwitchTrack } from "@/components/ui/switch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}

describe("SwitchTrack", () => {
  it("falls back to today's 36 by 20 track and its colours", () => {
    const track = draw(<SwitchTrack checked={false} />).firstElementChild!;
    const cls = track.getAttribute("class")!;
    expect(cls).toContain("h-[var(--switch-h,1.25rem)]");
    expect(cls).toContain("w-[var(--switch-w,2.25rem)]");
    expect(cls).toContain("bg-[color:var(--switch-off-bg,var(--color-surface-2))]");
    expect(cls).toContain("ring-[color:var(--switch-off-ring,var(--color-border))]");
    const knob = track.firstElementChild!.getAttribute("class")!;
    expect(knob).toContain("bg-[color:var(--switch-knob-off,var(--color-text-tertiary))]");
    expect(knob).toContain("shadow-[var(--switch-knob-shadow,0_0_transparent)]");
  });

  it("moves the knob by the travel token when on, and fades when disabled", () => {
    const track = draw(<SwitchTrack checked disabled />).firstElementChild!;
    expect(track.getAttribute("class")).toContain("bg-accent");
    expect(track.getAttribute("class")).toContain("opacity-[var(--switch-disabled-opacity,0.5)]");
    expect(track.firstElementChild!.getAttribute("class")).toContain(
      "translate-x-[var(--switch-travel,1rem)]",
    );
  });
});

describe("Switch", () => {
  it("passes data attributes to the button and draws an adornment after the label", () => {
    const host = draw(
      <Switch
        data-probe=""
        checked={false}
        onCheckedChange={() => undefined}
        label="Baú"
        labelAdornment={<span data-badge>novo</span>}
      />,
    );
    const button = host.querySelector("button")!;
    expect(button.hasAttribute("data-probe")).toBe(true);
    expect(button.querySelector("[data-badge]")).not.toBeNull();
  });

  it("dims a disabled label only under the redesign, and the row hover is a token", () => {
    const button = draw(
      <Switch checked={false} onCheckedChange={() => undefined} disabled label="Off" />,
    ).querySelector("button")!;
    expect(button.querySelector("span span")!.getAttribute("class")).toContain(
      "redesign:group-disabled:text-text-tertiary",
    );
    const enabled = draw(
      <Switch checked={false} onCheckedChange={() => undefined} label="On" />,
    ).querySelector("button")!;
    expect(enabled.className).toContain(
      "hover:bg-[color:var(--choice-row-hover,var(--color-surface-2))]",
    );
  });
});

describe("TickBox and CheckRow", () => {
  it("keeps today's tick with the toggle off and both check glyphs for the two looks", () => {
    const box = draw(<TickBox checked />).firstElementChild!;
    expect(box.getAttribute("class")).toContain("h-[var(--tick-size,1rem)]");
    const glyphs = box.querySelectorAll("svg");
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]!.getAttribute("class")).toContain("redesign:hidden");
    expect(glyphs[1]!.getAttribute("class")).toContain("redesign:block");
  });

  it("draws the picker's 20px tick with the stronger hairline", () => {
    const cls = draw(<TickBox checked={false} size="md" />).firstElementChild!.getAttribute("class")!;
    expect(cls).toContain("h-[var(--tick-size-md,1.25rem)]");
    expect(cls).toContain("ring-[color:var(--tick-off-ring,var(--color-border-strong))]");
  });

  it("toggles from the whole row", () => {
    const onChange = vi.fn();
    const button = draw(
      <CheckRow checked={false} onCheckedChange={onChange} label="Gerenciar canais" />,
    ).querySelector("button")!;
    act(() => button.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Checkbox", () => {
  it("is a native checkbox that keeps the browser's box with the toggle off", () => {
    const input = draw(<Checkbox defaultChecked />).querySelector("input")!;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(true);
    expect(input.className).toContain("accent-[var(--color-accent)]");
    expect(input.className).toContain("[appearance:var(--checkbox-appearance,auto)]");
    expect(input.className).toContain("border-[length:var(--tick-ring-w,0px)]");
  });

  it("lets a caller restore the browser default size and tint", () => {
    const input = draw(<Checkbox className="h-auto w-auto accent-auto" />).querySelector("input")!;
    expect(input.className).toContain("h-auto");
    expect(input.className).not.toContain("h-4");
    expect(input.className).not.toContain("accent-[var(--color-accent)]");
  });

  it("draws a dash for a mixed state only under the redesign", () => {
    const [, dash] = draw(<Checkbox />).querySelectorAll("svg");
    expect(dash!.getAttribute("class")).toContain("redesign:peer-indeterminate:block");
  });

  it("draws its check only under the redesign, out of the pointer's way", () => {
    const check = draw(<Checkbox />).querySelector("svg")!.getAttribute("class")!;
    expect(check).toContain("hidden");
    expect(check).toContain("redesign:peer-[:checked:not(:indeterminate)]:block");
    expect(check).toContain("pointer-events-none");
  });

describe("round 2 behaviour", () => {
  it("centres the track on a described label and pulses a busy one's knob", () => {
    const host = draw(
      <Switch checked busy onCheckedChange={() => undefined} label="Salvando" description="d" />,
    );
    const button = host.querySelector("button")!;
    expect(button.className).toContain("redesign:aria-busy:cursor-progress");
    const track = button.querySelector("span[aria-hidden]")!.getAttribute("class")!;
    expect(track).toContain("mt-[var(--switch-desc-offset,0.125rem)]");
    expect(track).toContain("redesign:motion-safe:[&>span]:animate-pulse");
    expect(track).not.toContain("opacity-70");
  });

  it("fades a disabled Checkbox's check and strengthens its edge from a named label group", () => {
    const host = draw(<Checkbox disabled defaultChecked />);
    expect(host.querySelector("svg")!.getAttribute("class")).toContain(
      "redesign:peer-disabled:opacity-[var(--tick-disabled-opacity,0.5)]",
    );
    expect(host.querySelector("input")!.className).toContain(
      "redesign:group-hover/checkbox:enabled:not-checked:border-[color:var(--tick-hover-ring)]",
    );
  });

  it("aligns a CheckRow's tick to the first line through tokens", () => {
    const button = draw(
      <CheckRow checked={false} onCheckedChange={() => undefined} label="A" description="b" />,
    ).querySelector("button")!;
    expect(button.className).toContain("[align-items:var(--check-row-align,center)]");
    expect(button.querySelector("span[aria-hidden]:last-child")!.getAttribute("class")).toContain(
      "mt-[var(--tick-line-offset,0px)]",
    );
  });
});
});
