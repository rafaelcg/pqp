import { describe, expect, it, vi } from "vitest";
import { track } from "./track";

describe("track", () => {
  it("hands the event to Umami when the hosted tag is there", () => {
    const umami = { track: vi.fn() };
    track("onboarding_start", { path: "cold" }, { umami });
    expect(umami.track).toHaveBeenCalledWith("onboarding_start", { path: "cold" });
  });

  it("does nothing on a build with no tag, which is every self-host", () => {
    expect(() => track("onboarding_start", undefined, {})).not.toThrow();
    expect(() => track("onboarding_start", undefined, undefined)).not.toThrow();
  });

  it("never lets a broken tag break the caller", () => {
    const umami = {
      track: () => {
        throw new Error("blocked");
      },
    };
    expect(() => track("age_gate_pass", undefined, { umami })).not.toThrow();
  });
});
