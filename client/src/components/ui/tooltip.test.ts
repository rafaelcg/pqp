import { describe, expect, it } from "vitest";
import { tooltipA11y } from "./tooltip";

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
