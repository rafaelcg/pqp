import { describe, expect, it } from "vitest";
import {
  highestRoleColor,
  identityMarks,
  usernameFromTag,
} from "./author-display";

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

describe("identityMarks", () => {
  it("is empty for an ordinary member", () => {
    expect(identityMarks({ rank: "member" })).toEqual([]);
  });

  it("gives the owner a crown and an admin a shield", () => {
    expect(identityMarks({ rank: "owner" })).toEqual(["owner"]);
    expect(identityMarks({ rank: "admin" })).toEqual(["admin"]);
  });

  it("marks a character as a bot, including next to rank", () => {
    expect(identityMarks({ rank: "member", isCharacter: true })).toEqual([
      "bot",
    ]);
    expect(identityMarks({ rank: "admin", isCharacter: true })).toEqual([
      "admin",
      "bot",
    ]);
  });

  it("gives a webhook none of these, even if the payload carried rank", () => {
    expect(
      identityMarks({ rank: "owner", isCharacter: true, isWebhook: true }),
    ).toEqual([]);
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
