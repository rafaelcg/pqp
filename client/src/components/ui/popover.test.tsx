import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { POPOVER_OWN_EDGE, POPOVER_SURFACE, PopoverPanel } from "@/components/ui/popover";

describe("Popover surface", () => {
  it("is the level-3 elevation at the card radius when the tokens are unset", () => {
    expect(POPOVER_SURFACE).toContain("elevation-3");
    expect(POPOVER_SURFACE).toContain("rounded-[var(--popover-radius,var(--radius-card))]");
  });

  it("moves the edge and the lift only under the redesign, through the elevation variables", () => {
    expect(POPOVER_SURFACE).toContain("redesign:[--elevation-3-border:var(--popover-border)]");
    expect(POPOVER_SURFACE).toContain("redesign:[--elevation-3-shadow:var(--popover-shadow)]");
    expect(POPOVER_SURFACE).not.toMatch(/(^|\s)\[--elevation-3/);
  });

  it("renders a panel with the caller's classes and attributes", () => {
    const html = renderToStaticMarkup(
      <PopoverPanel role="dialog" aria-label="Nota" className="w-72 p-4" />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Nota"');
    expect(html).toContain("w-72 p-4");
    expect(html).toContain("elevation-3");
  });

  it("defines every popover token in both redesign blocks", () => {
    const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
    const dark = css.slice(css.indexOf(":root[data-redesign] {"));
    const light = css.slice(css.indexOf(':root[data-redesign][data-theme="light"] {'));
    for (const token of ["--popover-surface", "--popover-border", "--popover-shadow"]) {
      expect(dark.slice(0, dark.indexOf("\n}\n"))).toContain(`${token}:`);
      expect(light.slice(0, light.indexOf("\n}\n"))).toContain(`${token}:`);
    }
  });

  it("gives a caller's own edge the popover's under the redesign", () => {
    expect(POPOVER_OWN_EDGE).toBe("redesign:border-[color:var(--popover-border)]");
  });
});
