import { describe, expect, it } from "vitest";
import {
  collapsedPeopleLabel,
  collapsedPeopleLine,
} from "./collapsed-people-label";

const inCall = (count: number) => `${count} in call`;

describe("collapsedPeopleLine", () => {
  it("says Connecting… while the join is still in flight", () => {
    expect(
      collapsedPeopleLine({
        connected: false,
        callingOut: false,
        statusLine: "Connecting…",
        peopleLabel: "Dev User",
      }),
    ).toBe("Connecting…");
  });

  it("puts the names up the moment the room is connected, whatever the status still says", () => {
    expect(
      collapsedPeopleLine({
        connected: true,
        callingOut: false,
        statusLine: "Connecting…",
        peopleLabel: "Dev User, Bob",
      }),
    ).toBe("Dev User, Bob");
  });

  it("keeps Calling… on an outgoing ring nobody has picked up", () => {
    expect(
      collapsedPeopleLine({
        connected: true,
        callingOut: true,
        statusLine: "Calling…",
        peopleLabel: "Dev User",
      }),
    ).toBe("Calling…");
  });

  it("falls back to the names when there is no status at all", () => {
    expect(
      collapsedPeopleLine({
        connected: false,
        callingOut: false,
        statusLine: null,
        peopleLabel: "Dev User",
      }),
    ).toBe("Dev User");
  });
});

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
