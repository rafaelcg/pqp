import { describe, expect, it } from "vitest";
import { highestRoleColor, usernameFromTag } from "./author-display";

const roles = [
  { id: "low", color: "#111111", position: 1 },
  { id: "high", color: "#ff00aa", position: 5 },
  { id: "plain", color: null, position: 9 },
];

describe("highestRoleColor", () => {
  it("picks the highest position that has a colour", () => {
    expect(highestRoleColor(["low", "high", "plain"], roles)).toBe("#ff00aa");
  });

  it("skips a higher role with no colour", () => {
    expect(highestRoleColor(["low", "plain"], roles)).toBe("#111111");
  });

  it("returns null when nothing held is painted", () => {
    expect(highestRoleColor(["plain"], roles)).toBeNull();
    expect(highestRoleColor([], roles)).toBeNull();
    expect(highestRoleColor(undefined, roles)).toBeNull();
  });
});

describe("usernameFromTag", () => {
  it("takes the handle before the discriminator", () => {
    expect(usernameFromTag("dev_user#8692")).toBe("dev_user");
  });

  it("rejects a missing or empty tag", () => {
    expect(usernameFromTag(null)).toBeNull();
    expect(usernameFromTag("")).toBeNull();
    expect(usernameFromTag("#1234")).toBeNull();
    expect(usernameFromTag("nobody")).toBeNull();
  });
});
