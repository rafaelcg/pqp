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

  it("selects an already-selected joinable row too: a click never joins", () => {
    // The rule Rafael asked for after #360 shipped: one click is always just
    // "show me this channel", however many times it lands. Joining is the
    // double click, the Entrar button, the context menu or Enter.
    expect(resolveVoiceRowClick({ selected: true, joinable: true })).toBe(
      "select",
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
  it("joins a joinable row, selected or not", () => {
    // Selection stopped mattering when the click branch stopped joining:
    // there is no longer a join to double up on, so a double click on the row
    // you are already looking at has to work like any other.
    expect(resolveVoiceRowDoubleClick({ joinable: true })).toBe("join");
  });

  it("does nothing for a channel that cannot be joined", () => {
    expect(resolveVoiceRowDoubleClick({ joinable: false })).toBeNull();
  });

  it("is the only pointer path that joins", () => {
    // Together with the click cases above: two deliberate presses, and the
    // first one on its own can never start a call.
    expect(resolveVoiceRowClick({ selected: false, joinable: true })).toBe(
      "select",
    );
    expect(resolveVoiceRowClick({ selected: true, joinable: true })).toBe(
      "select",
    );
    expect(resolveVoiceRowDoubleClick({ joinable: true })).toBe("join");
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
