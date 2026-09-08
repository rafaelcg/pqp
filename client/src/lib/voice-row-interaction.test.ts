import { describe, expect, it } from "vitest";
import {
  resolveVoiceRowClick,
  resolveVoiceRowDoubleClick,
  resolveVoiceRowKey,
} from "./voice-row-interaction";

describe("resolveVoiceRowClick", () => {
  it("selects an unselected voice row instead of joining", () => {
    expect(
      resolveVoiceRowClick({ selected: false, joinable: true }),
    ).toBe("select");
  });

  it("joins on a second click of an already-selected row (touch's second tap)", () => {
    expect(resolveVoiceRowClick({ selected: true, joinable: true })).toBe(
      "join",
    );
  });

  it("just selects a text row, which is never joinable", () => {
    expect(
      resolveVoiceRowClick({ selected: false, joinable: false }),
    ).toBe("select");
    expect(resolveVoiceRowClick({ selected: true, joinable: false })).toBe(
      "select",
    );
  });

  it("keeps clicking a row you are already in a no-op join, never a re-select loop", () => {
    // `joinable` is false for a channel you are connected to, so clicking it
    // (selected or not) always resolves to "select" and never re-joins.
    expect(resolveVoiceRowClick({ selected: true, joinable: false })).toBe(
      "select",
    );
  });
});

describe("resolveVoiceRowDoubleClick", () => {
  it("joins an unselected, joinable row", () => {
    expect(
      resolveVoiceRowDoubleClick({ selected: false, joinable: true }),
    ).toBe("join");
  });

  it("does nothing when the row was already selected before the double click", () => {
    // The click handler's second click already joined in this case; firing
    // again here would double-invoke the join.
    expect(
      resolveVoiceRowDoubleClick({ selected: true, joinable: true }),
    ).toBeNull();
  });

  it("does nothing for a channel that cannot be joined", () => {
    expect(
      resolveVoiceRowDoubleClick({ selected: false, joinable: false }),
    ).toBeNull();
  });
});

describe("resolveVoiceRowKey", () => {
  it("Enter joins a joinable row", () => {
    expect(resolveVoiceRowKey("Enter", { joinable: true })).toBe("join");
  });

  it("Enter just selects when joining is not on the table", () => {
    expect(resolveVoiceRowKey("Enter", { joinable: false })).toBe("select");
  });

  it("Space always selects, never joins", () => {
    expect(resolveVoiceRowKey(" ", { joinable: true })).toBe("select");
    expect(resolveVoiceRowKey(" ", { joinable: false })).toBe("select");
  });

  it("ignores every other key", () => {
    expect(resolveVoiceRowKey("Tab", { joinable: true })).toBeNull();
    expect(resolveVoiceRowKey("ArrowDown", { joinable: true })).toBeNull();
  });
});
