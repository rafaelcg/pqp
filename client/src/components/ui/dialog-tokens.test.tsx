import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The dialog renders through a portal with focus management, so its classes
// are pinned at the source: every token falls back to what the toggle off drew.
const source = readFileSync(new URL("./dialog.tsx", import.meta.url), "utf8");

describe("Dialog tokens", () => {
  it("keeps today's scrim, rules, inset and title when the tokens are unset", () => {
    expect(source).toContain("bg-[color:var(--dialog-scrim,color-mix(in_oklab,var(--color-surface-0)_80%,transparent))]");
    expect(source).toContain("backdrop-blur-[var(--dialog-scrim-blur,2px)]");
    expect(source).toContain("border-[color:var(--dialog-header-rule,var(--color-border))]");
    expect(source).toContain("border-[color:var(--dialog-footer-rule,var(--color-border))]");
    expect(source).toContain("px-[var(--dialog-px,1.25rem)]");
    expect(source).toContain("pb-[var(--dialog-header-pb,1rem)]");
    expect(source).toContain("text-[length:var(--dialog-title-size,1.5rem)]");
    expect(source).toContain("leading-[var(--dialog-title-leading,2rem)]");
  });

  it("moves the panel's edge and lift only under the redesign", () => {
    expect(source).toContain("redesign:[--elevation-3-border:var(--dialog-border)]");
    expect(source).toContain("redesign:[--elevation-3-shadow:var(--dialog-shadow)]");
  });

  it("draws the close button as IconButton's ghost only under the redesign", () => {
    expect(source).toContain("redesign:rounded-[var(--icon-button-radius)]");
    expect(source).toContain("redesign:hover:bg-[color:var(--icon-button-hover)]");
    expect(source).toContain("hover:bg-surface-2 hover:text-text");
  });

  it("sets the eyebrow in sentence case only under the redesign", () => {
    expect(source).toContain("text-xs uppercase tracking-[0.18em] text-accent redesign:font-medium redesign:normal-case");
  });
});
