// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function classesOf(element: ReactElement): string[] {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  return (host.querySelector("button")!.getAttribute("class") ?? "").split(/\s+/);
}

describe("Button", () => {
  it("styles the redesign through tokens that fall back to the old values", () => {
    const classes = classesOf(<Button variant="ghost">x</Button>);
    expect(classes).toContain("text-[color:var(--button-ghost-text,var(--color-text-tertiary))]");
    expect(classes).toContain("hover:bg-[var(--button-ghost-hover,var(--color-surface-2))]");
    expect(classes).toContain("px-[var(--button-px,1rem)]");
    // No `redesign:` class: it would outrank a call site's own class.
    expect(classes.some((c) => c.startsWith("redesign:"))).toBe(false);
  });

  it("touches only the disabled state with redesign classes, on the primary", () => {
    const primary = classesOf(<Button>x</Button>).filter((c) => c.startsWith("redesign:"));
    expect(primary.length).toBeGreaterThan(0);
    expect(primary.every((c) => c.startsWith("redesign:disabled:"))).toBe(true);
  });

  it("lets a call site's fill and border win over the secondary tokens", () => {
    const classes = classesOf(
      <Button variant="secondary" className="bg-transparent border-danger">
        x
      </Button>,
    );
    expect(classes).toContain("bg-transparent");
    expect(classes).toContain("border-danger");
    expect(classes.some((c) => c.includes("--button-secondary-bg"))).toBe(false);
    expect(classes.some((c) => c.includes("--button-secondary-border"))).toBe(false);
  });

  it("lets a call site's colour and padding win over the tokens", () => {
    const classes = classesOf(
      <Button variant="ghost" className="px-6 text-danger">
        x
      </Button>,
    );
    expect(classes).toContain("text-danger");
    expect(classes).toContain("px-6");
    expect(classes.some((c) => c.includes("--button-ghost-text"))).toBe(false);
    expect(classes.some((c) => c.includes("--button-px"))).toBe(false);
  });

  it("draws the touch size and the quiet danger variant", () => {
    expect(classesOf(<Button size="lg">x</Button>)).toContain("h-11");
    expect(classesOf(<Button size="icon-lg">x</Button>)).toContain("w-11");
    expect(classesOf(<Button size="icon-sm">x</Button>)).toContain("w-[var(--control-sm)]");
    const danger = classesOf(<Button variant="danger-ghost">x</Button>);
    expect(danger).toContain("text-danger");
    expect(danger).toContain("hover:bg-[var(--button-danger-ghost-hover,var(--color-surface-2))]");
  });

  it("keeps a transparent shadow fallback so the focus ring's box-shadow stays valid", () => {
    expect(classesOf(<Button>x</Button>)).toContain(
      "shadow-[var(--button-primary-shadow,0_0_transparent)]",
    );
  });
});
