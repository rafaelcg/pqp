import { describe, expect, it } from "vitest";
import { collapsedPeopleLabel } from "./collapsed-people-label";

const inCall = (count: number) => `${count} in call`;

describe("collapsedPeopleLabel", () => {
  it("is empty when nobody is in the room", () => {
    expect(collapsedPeopleLabel([], inCall)).toBe("");
  });

  it("is the person's name when they are alone", () => {
    expect(collapsedPeopleLabel(["Dev User"], inCall)).toBe("Dev User");
  });

  it("lists two names, not the channel", () => {
    expect(collapsedPeopleLabel(["Dev User", "Bob"], inCall)).toBe(
      "Dev User, Bob",
    );
  });

  it("switches to a count past two faces", () => {
    expect(collapsedPeopleLabel(["A", "B", "C"], inCall)).toBe("3 in call");
  });
});
