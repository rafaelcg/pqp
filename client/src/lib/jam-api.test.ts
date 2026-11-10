import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { jamOutcomeUnknown } from "./jam-api";

describe("a create whose outcome is unknown", () => {
  it("is a lost reply or a server error: the thing may exist, so the list is read again", () => {
    expect(jamOutcomeUnknown(new TypeError("Failed to fetch"))).toBe(true);
    expect(jamOutcomeUnknown(new ApiError(0, "network"))).toBe(true);
    expect(jamOutcomeUnknown(new ApiError(502, "bad gateway"))).toBe(true);
  });

  it("is not a plain refusal", () => {
    expect(jamOutcomeUnknown(new ApiError(403, "jam_channels_off"))).toBe(false);
    expect(jamOutcomeUnknown(new ApiError(429, "jam_rate_limited"))).toBe(false);
  });
});
