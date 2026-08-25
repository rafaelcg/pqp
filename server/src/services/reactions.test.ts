import { describe, expect, it } from "vitest";
import {
  summariseReactionRows,
  type ReactionRow,
} from "./reactions.js";

const VIEWER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const MSG = "00000000-0000-4000-8000-0000000000aa";

function row(
  user_id: string,
  display_name: string,
  emoji = "👍",
): ReactionRow {
  return { message_id: MSG, emoji, user_id, display_name };
}

describe("summariseReactionRows", () => {
  it("groups by emoji, marks me, and keeps first reactors", () => {
    const byMessage = summariseReactionRows(
      [
        row(OTHER, "Alice"),
        row(VIEWER, "Dev"),
        row(OTHER, "Alice", "❤️"),
      ],
      VIEWER,
    );
    const list = byMessage.get(MSG)!;
    expect(list).toEqual([
      {
        emoji: "👍",
        count: 2,
        me: true,
        users: [
          { id: OTHER, displayName: "Alice" },
          { id: VIEWER, displayName: "Dev" },
        ],
      },
      {
        emoji: "❤️",
        count: 1,
        me: false,
        users: [{ id: OTHER, displayName: "Alice" }],
      },
    ]);
  });

  it("caps named users while keeping the full count", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(`user-${i}`, `U${i}`),
    );
    const [summary] = summariseReactionRows(rows, undefined, 3).get(MSG)!;
    expect(summary.count).toBe(25);
    expect(summary.users).toHaveLength(3);
    expect(summary.users[0]!.displayName).toBe("U0");
  });
});
