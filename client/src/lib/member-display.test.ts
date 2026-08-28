import { describe, expect, it } from "vitest";
import { memberDisplayName, memberMatchesQuery } from "./api";

const harold = {
  nickname: "H",
  displayName: "Harold",
  username: "raf",
  tag: "raf#8683",
};

describe("memberDisplayName", () => {
  it("prefers a nickname over the account display name", () => {
    expect(memberDisplayName(harold)).toBe("H");
  });

  it("falls back to the display name when the nickname is blank", () => {
    expect(
      memberDisplayName({ nickname: "  ", displayName: "Harold" }),
    ).toBe("Harold");
  });
});

describe("memberMatchesQuery", () => {
  it("matches the painted nickname", () => {
    expect(memberMatchesQuery(harold, "h")).toBe(true);
  });

  it("still matches the account display name when a nickname is set", () => {
    expect(memberMatchesQuery(harold, "harold")).toBe(true);
  });

  it("matches username and tag", () => {
    expect(memberMatchesQuery(harold, "raf")).toBe(true);
    expect(memberMatchesQuery(harold, "8683")).toBe(true);
  });

  it("misses a name that is not theirs", () => {
    expect(memberMatchesQuery(harold, "shield-guest")).toBe(false);
  });

  it("treats an empty query as a match", () => {
    expect(memberMatchesQuery(harold, "  ")).toBe(true);
  });
});
