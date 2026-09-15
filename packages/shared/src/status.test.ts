import { describe, expect, it } from "vitest";
import { manualStatusSchema, userStatusSchema } from "./status.js";

describe("manualStatusSchema", () => {
  it("accepts the four manual values, away included", () => {
    for (const value of ["online", "away", "dnd", "invisible"]) {
      expect(manualStatusSchema.parse(value)).toBe(value);
    }
  });

  it("still refuses anything else, idle included", () => {
    for (const value of ["idle", "offline", "busy", ""]) {
      expect(manualStatusSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("userStatusSchema", () => {
  it("is unchanged: four values, and still no invisible", () => {
    for (const value of ["online", "idle", "dnd", "offline"]) {
      expect(userStatusSchema.parse(value)).toBe(value);
    }
    expect(userStatusSchema.safeParse("invisible").success).toBe(false);
    expect(userStatusSchema.safeParse("away").success).toBe(false);
  });
});
