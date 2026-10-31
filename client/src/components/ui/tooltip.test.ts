import { describe, expect, it } from "vitest";
import { tooltipA11y, tooltipBubbleClass } from "./tooltip";

describe("tooltipA11y", () => {
  it("says the label once when the tooltip is only the label", () => {
    // The bug this pins: Radix points `aria-describedby` at the bubble while
    // it is open, so a name and a bubble that agree get read twice —
    // "Mute microphone, button, Mute microphone".
    const a11y = tooltipA11y({ label: "Mute microphone" });
    expect(a11y.name).toBe("Mute microphone");
    expect(a11y.description).toBeUndefined();
    expect(a11y.describedBy).toBe(false);
  });

  it("describes with the detail alone, never with the label again", () => {
    const a11y = tooltipA11y({
      label: "Send this computer's sound with the share",
      detail: "Off by default.",
    });
    expect(a11y.name).toBe("Send this computer's sound with the share");
    expect(a11y.description).toBe("Off by default.");
    expect(a11y.describedBy).toBe(true);
  });

  it("lets a row disambiguate the name without lengthening the bubble", () => {
    // A member list is twelve identical "Kick" buttons to a screen reader.
    const a11y = tooltipA11y({ label: "Kick", name: "Kick: rafa" });
    expect(a11y.name).toBe("Kick: rafa");
    expect(a11y.description).toBeUndefined();
  });

  it("treats an empty detail as no detail", () => {
    // Not pedantry: Radix announces the bubble's own text whenever the
    // content's `aria-label` is falsy, so an empty string would not mean "no
    // description", it would mean "describe this control with its own name".
    const a11y = tooltipA11y({ label: "Reply", detail: "" });
    expect(a11y.description).toBeUndefined();
    expect(a11y.describedBy).toBe(false);
  });
});

describe("tooltipBubbleClass", () => {
  it("draws today's bubble when the redesign tokens are unset", () => {
    const bubble = tooltipBubbleClass();
    expect(bubble).toContain("bg-[color:var(--tooltip-bg,var(--elevation-3-surface))]");
    expect(bubble).toContain("border-[color:var(--tooltip-border,var(--elevation-3-border))]");
    expect(bubble).toContain("shadow-[var(--tooltip-shadow,var(--elevation-3-shadow))]");
    expect(bubble).toContain("px-[var(--tooltip-px,0.5rem)]");
    // No `redesign:` class: the toggle reaches the bubble through tokens only.
    expect(bubble).not.toContain("redesign:");
  });

  it("keeps the rail bubble's own surface as its fallback", () => {
    const rail = tooltipBubbleClass("rail");
    expect(rail).toContain("bg-[color:var(--tooltip-bg,var(--color-surface-0))]");
    expect(rail).toContain("[font-family:var(--tooltip-rail-font,inherit)]");
  });
});
