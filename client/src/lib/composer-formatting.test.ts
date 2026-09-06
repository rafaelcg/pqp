import { describe, expect, it } from "vitest";
import {
  caretInsideUnclosedFence,
  composerBodyIsEmpty,
  COMPOSER_FORM_CLASS,
  formattingMarkerForKey,
  toggleBlockFormatting,
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

  it("stacks bold then italics with nothing selected, and unstacks in either order", () => {
    // Ctrl+B, Ctrl+I, then type: the caret sits inside `****`, which is an
    // empty bold pair and not an empty italics pair, so Ctrl+I adds a star.
    const bold = toggleFormatting("", 0, 0, "**");
    const both = toggleFormatting(bold.value, bold.selectionStart, bold.selectionEnd, "*");
    expect(both.value).toBe("******");
    expect(both.selectionStart).toBe(3);
    const italicOff = toggleFormatting(both.value, 3, 3, "*");
    expect(italicOff.value).toBe("****");
    expect(italicOff.selectionStart).toBe(2);
    const boldOff = toggleFormatting(both.value, 3, 3, "**");
    expect(boldOff.value).toBe("**");
    expect(boldOff.selectionStart).toBe(1);
  });

  it("removes an empty pair that is selected whole rather than wrapping it", () => {
    // Italics is left out: `**` selected whole is indistinguishable from an
    // empty bold pair, and the asterisk count says bold.
    for (const marker of ["**", "~~", "`"] as const) {
      const edit = toggleFormatting(`a ${marker}${marker} b`, 2, 2 + 2 * marker.length, marker);
      expect(edit.value).toBe("a  b");
      expect([edit.selectionStart, edit.selectionEnd]).toEqual([2, 2]);
    }
  });

  it("never splits a surrogate pair at a selection edge", () => {
    // Emoji are two UTF-16 units; a marker between the halves renders as two
    // broken glyphs. A browser will not place the edge there, but the function
    // must survive a caller that does.
    const edit = toggleFormatting("a😀b", 0, 2, "**");
    expect(edit.value).toBe("**a😀**b");
    const tail = toggleFormatting("a😀b", 2, 4, "**");
    expect(tail.value).toBe("a**😀b**");
    expect(toggleFormatting("😀", 0, 2, "*").value).toBe("*😀*");
    expect(toggleFormatting("😀", 1, 1, "*").value).toBe("**😀");
  });

  it("clamps a selection that is out of range and survives an empty value", () => {
    expect(toggleFormatting("", 0, 0, "**").value).toBe("****");
    expect(toggleFormatting("", 0, 5, "~~").value).toBe("~~~~");
    expect(toggleFormatting("abc", 5, 9, "`").value).toBe("abc``");
    expect(toggleFormatting("abc", -3, 2, "**").value).toBe("**ab**c");
  });

  it("keeps a selection inside a run of asterisks that is only half ours", () => {
    // `**bo|ld**` with only `bo` selected: the right edge has no marker, so
    // this is a wrap, not an unwrap, and the span applied is just the selection.
    const edit = toggleFormatting("**bold**", 2, 4, "**");
    expect([edit.replaceStart, edit.replaceEnd, edit.replacement]).toEqual([2, 4, "**bo**"]);
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe("bo");
  });

  it("copes with a very long value", () => {
    const big = "*".repeat(100_000);
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) {
      toggleFormatting(big, 0, big.length, "*");
      toggleFormatting(big, 50_000, 50_000, "**");
    }
    expect(performance.now() - started).toBeLessThan(2_000);
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

describe("toggleBlockFormatting quote", () => {
  it("prefixes the current line when nothing is selected", () => {
    const edit = toggleBlockFormatting("hello world", 6, 6, "quote");
    expect(edit.value).toBe("> hello world");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([8, 8]);
  });

  it("prefixes every selected line and leaves the block selected", () => {
    const edit = toggleBlockFormatting("one\ntwo\nthree", 0, 13, "quote");
    expect(edit.value).toBe("> one\n> two\n> three");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([0, 19]);
    expect([edit.replaceStart, edit.replaceEnd, edit.replacement]).toEqual([
      0,
      13,
      "> one\n> two\n> three",
    ]);
  });

  it("unwraps when every selected line is already quoted", () => {
    const wrapped = toggleBlockFormatting("one\ntwo", 0, 7, "quote");
    const edit = toggleBlockFormatting(
      wrapped.value,
      wrapped.selectionStart,
      wrapped.selectionEnd,
      "quote",
    );
    expect(edit.value).toBe("one\ntwo");
  });

  it("adds the prefix only to lines that are missing it", () => {
    const edit = toggleBlockFormatting("> one\ntwo", 0, 9, "quote");
    expect(edit.value).toBe("> one\n> two");
  });

  it("strips a leading > without a space as well", () => {
    const edit = toggleBlockFormatting(">hello", 0, 6, "quote");
    expect(edit.value).toBe("hello");
  });

  it("quotes an empty composer and parks the caret after the prefix", () => {
    const edit = toggleBlockFormatting("", 0, 0, "quote");
    expect(edit.value).toBe("> ");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([2, 2]);
  });

  it("does not touch lines outside the selection", () => {
    const edit = toggleBlockFormatting("keep\nchange\nkeep", 5, 11, "quote");
    expect(edit.value).toBe("keep\n> change\nkeep");
  });

  it("treats a trailing newline on a full selection as the end of the last line", () => {
    const edit = toggleBlockFormatting("one\ntwo\n", 0, 8, "quote");
    expect(edit.value).toBe("> one\n> two\n");
  });

  it("accepts a backwards selection", () => {
    expect(toggleBlockFormatting("hello", 5, 0, "quote").value).toBe("> hello");
  });

  it("clamps a selection that is out of range", () => {
    expect(toggleBlockFormatting("abc", 9, 20, "quote").value).toBe("> abc");
    expect(toggleBlockFormatting("abc", -2, 2, "quote").value).toBe("> abc");
  });
});

describe("toggleBlockFormatting list", () => {
  it("prefixes the current line with a dash", () => {
    const edit = toggleBlockFormatting("milk", 0, 0, "list");
    expect(edit.value).toBe("- milk");
    expect(edit.selectionStart).toBe(2);
  });

  it("prefixes every selected line and unwraps on a second tap", () => {
    const on = toggleBlockFormatting("one\ntwo", 0, 7, "list");
    expect(on.value).toBe("- one\n- two");
    const off = toggleBlockFormatting(on.value, on.selectionStart, on.selectionEnd, "list");
    expect(off.value).toBe("one\ntwo");
  });

  it("does not treat a star list or a dash without a space as already wrapped", () => {
    expect(toggleBlockFormatting("* milk", 0, 6, "list").value).toBe("- * milk");
    expect(toggleBlockFormatting("-milk", 0, 5, "list").value).toBe("- -milk");
  });

  it("inserts a dash prefix on an empty line", () => {
    const edit = toggleBlockFormatting("", 0, 0, "list");
    expect(edit.value).toBe("- ");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([2, 2]);
  });
});

describe("toggleBlockFormatting fence", () => {
  it("expands a mid-line selection to the line so the wrap is a fence, not a span", () => {
    const edit = toggleBlockFormatting("foo bar baz", 4, 7, "fence");
    expect(edit.value).toBe("```\nfoo bar baz\n```");
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe(
      "foo bar baz",
    );
  });

  it("wraps the selection in a fence and keeps the inner text selected", () => {
    const edit = toggleBlockFormatting("hello world", 6, 11, "fence");
    expect(edit.value).toBe("```\nhello world\n```");
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe(
      "hello world",
    );
    expect([edit.replaceStart, edit.replaceEnd, edit.replacement]).toEqual([
      0,
      11,
      "```\nhello world\n```",
    ]);
  });

  it("unwraps when the fence sits just outside the selection", () => {
    const wrapped = toggleBlockFormatting("word", 0, 4, "fence");
    const edit = toggleBlockFormatting(
      wrapped.value,
      wrapped.selectionStart,
      wrapped.selectionEnd,
      "fence",
    );
    expect(edit.value).toBe("word");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([0, 4]);
  });

  it("unwraps when the selection includes the fence markers", () => {
    const edit = toggleBlockFormatting("```\nword\n```", 0, 12, "fence");
    expect(edit.value).toBe("word");
  });

  it("inserts an empty fence on its own lines when the caret is mid-line", () => {
    const edit = toggleBlockFormatting("hello ", 6, 6, "fence");
    expect(edit.value).toBe("hello \n```\n\n```");
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([11, 11]);
  });

  it("removes an empty fence the caret is inside instead of nesting another", () => {
    const empty = toggleBlockFormatting("", 0, 0, "fence");
    expect(empty.value).toBe("```\n\n```");
    const edit = toggleBlockFormatting(empty.value, empty.selectionStart, empty.selectionEnd, "fence");
    expect(edit.value).toBe("");
    expect(edit.replacement).toBe("");
  });

  it("wraps a multi-line selection as one fence", () => {
    const value = "one\ntwo";
    const edit = toggleBlockFormatting(value, 0, value.length, "fence");
    expect(edit.value).toBe("```\none\ntwo\n```");
  });

  it("unwraps the line's fence when only part of the inner text is selected", () => {
    const edit = toggleBlockFormatting("```\nbold\n```", 4, 6, "fence");
    expect(edit.value).toBe("bold");
  });

  it("accepts a backwards selection and clamps out of range", () => {
    expect(toggleBlockFormatting("word", 4, 0, "fence").value).toBe("```\nword\n```");
    expect(toggleBlockFormatting("abc", 9, 12, "fence").value).toBe("abc\n```\n\n```");
  });
});

describe("caretInsideUnclosedFence", () => {
  it("treats the caret between an empty fence pair as inside", () => {
    const empty = toggleBlockFormatting("", 0, 0, "fence");
    expect(caretInsideUnclosedFence(empty.value, empty.selectionStart)).toBe(true);
  });

  it("is false after the closing fence", () => {
    expect(caretInsideUnclosedFence("```\ncode\n```", 12)).toBe(false);
  });

  it("is true on a line typed inside an unclosed fence", () => {
    expect(caretInsideUnclosedFence("```\nhello", 9)).toBe(true);
  });
});

describe("composerBodyIsEmpty", () => {
  it("treats an empty fence as nothing to send", () => {
    expect(composerBodyIsEmpty("```\n\n```")).toBe(true);
    expect(composerBodyIsEmpty("hi")).toBe(false);
  });
});

describe("COMPOSER_FORM_CLASS", () => {
  it("does not make the form a scroll container, so @ : / popups stay visible", () => {
    expect(COMPOSER_FORM_CLASS).not.toMatch(/overflow-y-|max-h-/);
  });
});
