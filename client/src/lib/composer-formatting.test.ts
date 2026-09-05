import { describe, expect, it } from "vitest";
import {
  formattingMarkerForKey,
  toggleFormatting,
  type ShortcutKey,
} from "./composer-formatting.js";

describe("toggleFormatting", () => {
  it("wraps a selection in the marker and keeps the inner text selected", () => {
    const edit = toggleFormatting("hello world", 6, 11, "**");
    expect(edit.value).toBe("hello **world**");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([8, 13]);
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe("world");
  });

  it("reports the smallest changed span so the browser can record one undo step", () => {
    const edit = toggleFormatting("hello world", 6, 11, "**");
    expect([edit.replaceStart, edit.replaceEnd, edit.replacement]).toEqual([6, 11, "**world**"]);
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const wrapped = toggleFormatting("hello world", 6, 11, "**");
    const edit = toggleFormatting(
      wrapped.value,
      wrapped.selectionStart,
      wrapped.selectionEnd,
      "**",
    );
    expect(edit.value).toBe("hello world");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([6, 11]);
  });

  it("unwraps when the selection includes the markers", () => {
    const edit = toggleFormatting("say **word** now", 4, 12, "**");
    expect(edit.value).toBe("say word now");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([4, 8]);
  });

  it("inserts an empty pair with the caret between when nothing is selected", () => {
    const edit = toggleFormatting("hello ", 6, 6, "**");
    expect(edit.value).toBe("hello ****");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([8, 8]);
  });

  it("removes an empty pair the caret is inside instead of nesting another", () => {
    const edit = toggleFormatting("hello ****", 8, 8, "**");
    expect(edit.value).toBe("hello ");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([6, 6]);
    expect(edit.replacement).toBe("");
  });

  it("stacks bold then italics into ***text***", () => {
    const bold = toggleFormatting("word", 0, 4, "**");
    const both = toggleFormatting(bold.value, bold.selectionStart, bold.selectionEnd, "*");
    expect(both.value).toBe("***word***");
    expect(both.value.slice(both.selectionStart, both.selectionEnd)).toBe("word");
  });

  it("removes only the italics from ***text*** and leaves the bold", () => {
    const edit = toggleFormatting("***word***", 3, 7, "*");
    expect(edit.value).toBe("**word**");
    const again = toggleFormatting(edit.value, edit.selectionStart, edit.selectionEnd, "**");
    expect(again.value).toBe("word");
  });

  it("does not mistake bold for italics", () => {
    // `**word**` is bold only, so Ctrl+I must add italics, not strip a star.
    const edit = toggleFormatting("**word**", 2, 6, "*");
    expect(edit.value).toBe("***word***");
  });

  it("handles a selection at the start and at the end of the value", () => {
    expect(toggleFormatting("abc def", 0, 3, "~~").value).toBe("~~abc~~ def");
    expect(toggleFormatting("abc def", 4, 7, "`").value).toBe("abc `def`");
    expect(toggleFormatting("abc", 0, 3, "**").value).toBe("**abc**");
  });

  it("wraps a multi-line selection as one span", () => {
    const value = "one\ntwo\nthree";
    const edit = toggleFormatting(value, 0, value.length, "**");
    expect(edit.value).toBe("**one\ntwo\nthree**");
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe(value);
  });

  it("leaves edge whitespace outside the markers, since `** x**` is not bold", () => {
    const edit = toggleFormatting("hello world ", 5, 12, "**");
    expect(edit.value).toBe("hello **world** ");
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe("world");
  });

  it("accepts a backwards selection", () => {
    expect(toggleFormatting("hello world", 11, 6, "**").value).toBe("hello **world**");
  });

  it("covers strikethrough and inline code round trips", () => {
    for (const marker of ["~~", "`"] as const) {
      const on = toggleFormatting("a word b", 2, 6, marker);
      expect(on.value).toBe(`a ${marker}word${marker} b`);
      const off = toggleFormatting(on.value, on.selectionStart, on.selectionEnd, marker);
      expect(off.value).toBe("a word b");
    }
  });
});

describe("formattingMarkerForKey", () => {
  function key(overrides: Partial<ShortcutKey> & { key: string }): ShortcutKey {
    return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides };
  }

  it("maps the four bindings under the platform's primary modifier", () => {
    expect(formattingMarkerForKey(key({ key: "b", ctrlKey: true }), false)).toBe("**");
    expect(formattingMarkerForKey(key({ key: "i", ctrlKey: true }), false)).toBe("*");
    expect(formattingMarkerForKey(key({ key: "e", ctrlKey: true }), false)).toBe("`");
    expect(formattingMarkerForKey(key({ key: "X", ctrlKey: true, shiftKey: true }), false)).toBe(
      "~~",
    );
    expect(formattingMarkerForKey(key({ key: "b", metaKey: true }), true)).toBe("**");
    expect(formattingMarkerForKey(key({ key: "X", metaKey: true, shiftKey: true }), true)).toBe(
      "~~",
    );
  });

  it("uses Cmd on a Mac and Ctrl elsewhere, never the other one", () => {
    expect(formattingMarkerForKey(key({ key: "b", ctrlKey: true }), true)).toBeNull();
    expect(formattingMarkerForKey(key({ key: "b", metaKey: true }), false)).toBeNull();
    expect(formattingMarkerForKey(key({ key: "b", ctrlKey: true, metaKey: true }), true)).toBeNull();
    expect(
      formattingMarkerForKey(key({ key: "b", ctrlKey: true, metaKey: true }), false),
    ).toBeNull();
  });

  it("ignores Alt and unbound keys", () => {
    expect(formattingMarkerForKey(key({ key: "b", ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(formattingMarkerForKey(key({ key: "b", metaKey: true, altKey: true }), true)).toBeNull();
    expect(formattingMarkerForKey(key({ key: "u", ctrlKey: true }), false)).toBeNull();
    expect(formattingMarkerForKey(key({ key: "b" }), false)).toBeNull();
    expect(formattingMarkerForKey(key({ key: "Enter", ctrlKey: true }), false)).toBeNull();
  });

  it("requires Shift for strikethrough and refuses it for the rest", () => {
    expect(formattingMarkerForKey(key({ key: "x", ctrlKey: true }), false)).toBeNull();
    expect(formattingMarkerForKey(key({ key: "B", ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });
});
