import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * QA-122: with `data-contrast="more"` the new look's card and dialog edges
 * stayed at an alpha of the text colour. The override has to exist, read the
 * border pair, and come AFTER every redesign block that defines the same
 * tokens (same specificity, so the later one wins).
 */
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const SELECTOR = ':root[data-redesign][data-contrast="more"] {';
const start = css.indexOf(SELECTOR);
const block = css.slice(start, css.indexOf("}", start));

const EDGES = [
  "--card-border",
  "--popover-border",
  "--dialog-border",
  "--sheet-edge",
  "--composer-border",
  "--sidebar-invite-border",
];
const HAIRLINES = [
  "--menu-separator",
  "--pane-header-rule",
  "--dialog-header-rule",
  "--dialog-footer-rule",
  "--settings-rule",
];

describe("high contrast in the new look", () => {
  it("has an override block", () => {
    expect(start).toBeGreaterThan(0);
  });

  it("points surface edges at the strong border", () => {
    for (const token of EDGES) {
      expect(block, token).toContain(`${token}: var(--color-border-strong);`);
    }
  });

  it("points rules and separators at the border", () => {
    for (const token of HAIRLINES) {
      expect(block, token).toContain(`${token}: var(--color-border);`);
    }
  });

  it("comes after every redesign definition of those tokens", () => {
    for (const token of [...EDGES, ...HAIRLINES]) {
      const last = css.lastIndexOf(`  ${token}:`, start - 1);
      const inBlock = css.indexOf(`  ${token}:`, start);
      expect(last, token).toBeGreaterThan(0);
      expect(inBlock, token).toBeGreaterThan(start);
      expect(css.lastIndexOf(`  ${token}:`)).toBeLessThan(start + block.length);
    }
  });
});
