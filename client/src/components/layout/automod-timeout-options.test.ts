import { describe, expect, it } from "vitest";
import { timeoutOptions } from "./automod-settings-section";

describe("timeoutOptions", () => {
  it("shows the six presets for a preset value or no timeout", () => {
    expect(timeoutOptions(0)).toEqual([1, 5, 10, 60, 1440, 10080]);
    expect(timeoutOptions(60)).toEqual([1, 5, 10, 60, 1440, 10080]);
  });

  it("adds a value saved over the API in its place", () => {
    expect(timeoutOptions(30)).toEqual([1, 5, 10, 30, 60, 1440, 10080]);
    expect(timeoutOptions(40320)).toEqual([1, 5, 10, 60, 1440, 10080, 40320]);
  });
});
