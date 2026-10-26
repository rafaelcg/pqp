// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  return host;
}

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("Input", () => {
  it("falls back to today's field when the redesign tokens are unset", () => {
    const field = classes(draw(<Input />).querySelector("input"));
    expect(field).toContain("bg-[color:var(--input-bg,var(--color-surface-0))]");
    expect(field).toContain("border-[color:var(--input-border,var(--color-border))]");
    expect(field).toContain("px-[var(--input-px,0.75rem)]");
    expect(field).toContain("h-[var(--input-h,var(--control-lg))]");
    expect(field).toContain("disabled:opacity-[var(--input-disabled-opacity,0.5)]");
    expect(field).toContain(
      "placeholder:text-[color:var(--input-placeholder,color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent))]",
    );
  });

  it("lets a call site's border and fill win over the tokens", () => {
    const field = classes(
      draw(<Input className="border-danger bg-transparent" />).querySelector("input"),
    );
    expect(field).toContain("border-danger");
    expect(field).toContain("bg-transparent");
    expect(field.some((c) => c.includes("--input-border,"))).toBe(false);
    expect(field.some((c) => c.includes("--input-bg,"))).toBe(false);
  });

  it("only uses redesign classes for hover, invalid and disabled", () => {
    const field = classes(draw(<Input />).querySelector("input"));
    const redesign = field.filter((c) => c.startsWith("redesign:"));
    expect(redesign.sort()).toEqual(
      [
        "redesign:aria-invalid:border-danger",
        "redesign:aria-invalid:not-disabled:bg-[color:var(--input-invalid-bg)]",
        "redesign:disabled:bg-transparent",
        "redesign:disabled:placeholder:text-[color:color-mix(in_oklab,var(--color-text-tertiary)_70%,transparent)]",
        "redesign:disabled:text-text-tertiary",
        "redesign:enabled:hover:not-aria-invalid:border-[color:var(--input-hover-border)]",
      ].sort(),
    );
  });

  it("draws the same box around a prefix, and a Textarea shares it", () => {
    const host = draw(<Input prefix="pqp.gg/@" />);
    const box = classes(host.querySelector("div"));
    expect(box).toContain("bg-[color:var(--input-bg,var(--color-surface-0))]");
    expect(classes(host.querySelector("input"))).toContain("bg-transparent");
    const area = classes(draw(<Textarea />).querySelector("textarea"));
    expect(area).toContain("border-[color:var(--input-border,var(--color-border))]");
    expect(area).toContain("min-h-28");
  });

  it("draws a field that is disabled and invalid as disabled", () => {
    const field = classes(draw(<Input disabled aria-invalid />).querySelector("input"));
    expect(field).toContain("redesign:aria-invalid:not-disabled:bg-[color:var(--input-invalid-bg)]");
    expect(field).toContain("redesign:disabled:bg-transparent");
    const box = classes(draw(<Input prefix="@" disabled aria-invalid />).querySelector("div"));
    expect(box).toContain(
      "redesign:has-[input[aria-invalid=true]]:not-has-[input:disabled]:bg-[color:var(--input-invalid-bg)]",
    );
  });
});
