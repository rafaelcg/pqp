import { describe, expect, it } from "vitest";
import { presenterMicWarning } from "./watch-party-mic-warning";

describe("presenterMicWarning", () => {
  it("warns when presenting with the mic muted", () => {
    expect(presenterMicWarning(true, true)).toBe("warn");
  });

  it("says nothing while not presenting, muted or not", () => {
    expect(presenterMicWarning(false, true)).toBe("none");
    expect(presenterMicWarning(false, false)).toBe("none");
  });

  it("says nothing while presenting with the mic open", () => {
    expect(presenterMicWarning(true, false)).toBe("none");
  });
});
