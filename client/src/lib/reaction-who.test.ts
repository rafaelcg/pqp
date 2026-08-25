import { describe, expect, it } from "vitest";
import { formatReactionWho, REACTION_WHO_NAMED } from "./reaction-who";

const ME = "me";
const t = (key: string, vars?: Record<string, unknown>) => {
  if (key === "chat.you") {
    return "You";
  }
  if (key === "chat.reaction.someone") {
    return "Someone";
  }
  if (key === "chat.reaction.names.two") {
    return `${vars?.a} and ${vars?.b}`;
  }
  if (key === "chat.reaction.names.many") {
    return `${vars?.list} and ${vars?.last}`;
  }
  if (key === "chat.reaction.overflow") {
    return `${vars?.list} and ${vars?.count} more`;
  }
  return key;
};

describe("formatReactionWho", () => {
  it("returns empty when the payload has no names", () => {
    expect(formatReactionWho([], 3, ME, t)).toBe("");
    expect(formatReactionWho(undefined, 1, ME, t)).toBe("");
  });

  it("says You for the current account", () => {
    expect(
      formatReactionWho(
        [{ id: ME, displayName: "Dev User" }],
        1,
        ME,
        t,
      ),
    ).toBe("You");
  });

  it("joins two names and puts You first", () => {
    expect(
      formatReactionWho(
        [
          { id: "a", displayName: "Alice" },
          { id: ME, displayName: "Dev User" },
        ],
        2,
        ME,
        t,
      ),
    ).toBe("You and Alice");
  });

  it("lists three or more without an Oxford comma", () => {
    expect(
      formatReactionWho(
        [
          { id: "a", displayName: "Alice" },
          { id: "b", displayName: "Bob" },
          { id: "c", displayName: "Carol" },
        ],
        3,
        ME,
        t,
      ),
    ).toBe("Alice, Bob and Carol");
  });

  it("overflows past the named cap using the real count", () => {
    const users = Array.from({ length: REACTION_WHO_NAMED }, (_, i) => ({
      id: `u${i}`,
      displayName: `N${i}`,
    }));
    expect(formatReactionWho(users, 12, ME, t)).toBe(
      "N0, N1, N2, N3, N4, N5, N6, N7 and 4 more",
    );
  });
});
