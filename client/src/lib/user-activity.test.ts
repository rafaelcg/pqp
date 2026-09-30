// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  TYPING_WINDOW_MS,
  focusedFieldHasText,
  idleForMs,
  isTypingNow,
  markActivity,
  resetActivityForTests,
} from "./user-activity";

afterEach(() => {
  document.body.innerHTML = "";
  resetActivityForTests(0);
});

function focusNew<T extends HTMLElement>(el: T): T {
  document.body.append(el);
  el.focus();
  return el;
}

describe("idleForMs", () => {
  it("counts from the last interaction", () => {
    markActivity(10_000);
    expect(idleForMs(10_000)).toBe(0);
    expect(idleForMs(70_000)).toBe(60_000);
  });

  it("never goes negative when the clock steps back", () => {
    markActivity(10_000);
    expect(idleForMs(5_000)).toBe(0);
  });
});

describe("focusedFieldHasText", () => {
  it("is false with nothing focused", () => {
    expect(focusedFieldHasText(document)).toBe(false);
  });

  it("is true for a textarea with text, false for an empty one", () => {
    const box = focusNew(document.createElement("textarea"));
    expect(focusedFieldHasText(document)).toBe(false);
    box.value = "olá";
    expect(focusedFieldHasText(document)).toBe(true);
    box.value = "   ";
    expect(focusedFieldHasText(document)).toBe(false);
  });

  it("is true for a text input with text, false for a checkbox", () => {
    const input = focusNew(document.createElement("input"));
    input.value = "x";
    expect(focusedFieldHasText(document)).toBe(true);
    const check = focusNew(document.createElement("input"));
    check.type = "checkbox";
    check.value = "on";
    expect(focusedFieldHasText(document)).toBe(false);
  });

  it("is true for a contenteditable composer with text in it", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    // jsdom does not implement `isContentEditable`; the attribute is what a
    // real browser derives it from.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    focusNew(editor);
    expect(focusedFieldHasText(document)).toBe(false);
    editor.textContent = "rascunho";
    expect(focusedFieldHasText(document)).toBe(true);
  });
});

describe("isTypingNow", () => {
  it("is true for a key pressed within the window, false after it", () => {
    markActivity(100_000, true);
    expect(isTypingNow(100_000 + TYPING_WINDOW_MS - 1, null)).toBe(true);
    expect(isTypingNow(100_000 + TYPING_WINDOW_MS, null)).toBe(false);
  });

  it("is false for a click, which is activity but not typing", () => {
    markActivity(100_000);
    expect(isTypingNow(100_001, null)).toBe(false);
  });

  it("is true for text sitting in the focused field with no key pressed lately", () => {
    resetActivityForTests(0);
    focusNew(document.createElement("textarea")).value = "draft";
    expect(isTypingNow(10 * TYPING_WINDOW_MS, document)).toBe(true);
  });
});
