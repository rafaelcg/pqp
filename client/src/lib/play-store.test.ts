import { describe, expect, it } from "vitest";
import { playStoreUrlFrom } from "./play-store";

describe("playStoreUrlFrom", () => {
  it("is null when unset, unlike the APK URL, which falls back to GitHub", () => {
    expect(playStoreUrlFrom(undefined)).toBeNull();
    expect(playStoreUrlFrom("")).toBeNull();
  });

  it("honours a set URL", () => {
    expect(playStoreUrlFrom("https://play.google.com/store/apps/details?id=gg.pqp.app")).toBe(
      "https://play.google.com/store/apps/details?id=gg.pqp.app",
    );
  });

  it("trims it", () => {
    expect(
      playStoreUrlFrom("  https://play.google.com/store/apps/details?id=gg.pqp.app  "),
    ).toBe("https://play.google.com/store/apps/details?id=gg.pqp.app");
  });

  it("is null for whitespace only", () => {
    expect(playStoreUrlFrom(" ")).toBeNull();
  });

  it("is null for a non-string value", () => {
    expect(playStoreUrlFrom(42)).toBeNull();
  });
});
