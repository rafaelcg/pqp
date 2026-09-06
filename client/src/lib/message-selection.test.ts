import { describe, expect, it } from "vitest";
import { toggleMessageSelection } from "./message-selection";

const IDS = ["a", "b", "c", "d", "e"];

function toggle(
  selected: string[],
  messageId: string,
  options: { anchorId?: string | null; extend?: boolean; max?: number } = {},
) {
  return [
    ...toggleMessageSelection(new Set(selected), IDS, messageId, {
      anchorId: options.anchorId ?? null,
      extend: options.extend ?? false,
      max: options.max ?? 100,
    }),
  ];
}

describe("toggleMessageSelection", () => {
  it("adds and removes a single message", () => {
    expect(toggle([], "b")).toEqual(["b"]);
    expect(toggle(["b"], "b")).toEqual([]);
  });

  it("takes the whole range on a Shift-click, in either direction", () => {
    expect(toggle(["b"], "d", { anchorId: "b", extend: true })).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(toggle(["d"], "b", { anchorId: "d", extend: true })).toEqual([
      "d",
      "b",
      "c",
    ]);
  });

  it("never deselects through a range", () => {
    // Sweeping back over rows that are already picked must not clear them.
    expect(
      toggle(["b", "c", "d"], "d", { anchorId: "b", extend: true }).sort(),
    ).toEqual(["b", "c", "d"]);
  });

  it("falls back to a plain toggle when the anchor is no longer loaded", () => {
    // A page-out left the anchor outside the window. Ranging from index -1
    // would sweep from the top of the loaded history to the click.
    expect(toggle([], "c", { anchorId: "gone", extend: true })).toEqual(["c"]);
  });

  it("stops at the cap instead of refusing the click", () => {
    expect(toggle(["a", "b"], "c", { max: 2 })).toEqual(["a", "b"]);
    // Deselecting still works at the cap: it is the only way back under it.
    expect(toggle(["a", "b"], "b", { max: 2 })).toEqual(["a"]);
  });

  it("stops a range at the cap rather than dropping the whole gesture", () => {
    expect(
      toggle(["a"], "e", { anchorId: "a", extend: true, max: 3 }),
    ).toEqual(["a", "b", "c"]);
  });
});
