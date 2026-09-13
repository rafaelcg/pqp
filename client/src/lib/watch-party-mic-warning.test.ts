import { describe, expect, it } from "vitest";
import { micIsInaudible, presenterMicWarning } from "./watch-party-mic-warning";

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

describe("micIsInaudible", () => {
  it("is true for muted", () => {
    expect(micIsInaudible("muted")).toBe(true);
  });

  // Farol, 2026-09-13: not in the call at all reads exactly like muted to
  // anyone listening — the room hears nothing either way — but the go-live
  // checklist and the persistent banner both fed only `=== "muted"` in,
  // so a presenter who was never in voice at all showed "Mic on" and no
  // warning despite being just as silent as someone who muted.
  it("is true for off, the same silence as muted", () => {
    expect(micIsInaudible("off")).toBe(true);
  });

  it("is false for an open mic, room-only or everyone", () => {
    expect(micIsInaudible("room")).toBe(false);
    expect(micIsInaudible("everyone")).toBe(false);
  });

  it("is false when undefined (no mic state known at all)", () => {
    expect(micIsInaudible(undefined)).toBe(false);
  });
});
