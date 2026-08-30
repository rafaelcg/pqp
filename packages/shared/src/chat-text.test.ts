import { describe, expect, it } from "vitest";
import { clampChatNewlines } from "./chat-text.js";

describe("clampChatNewlines", () => {
  it("keeps a single Shift+Enter break", () => {
    expect(clampChatNewlines("hello\nworld")).toBe("hello\nworld");
  });

  it("keeps one blank line between paragraphs", () => {
    expect(clampChatNewlines("hello\n\nworld")).toBe("hello\n\nworld");
  });

  it("collapses extra blank lines to one", () => {
    expect(clampChatNewlines("hello\n\n\nworld")).toBe("hello\n\nworld");
    expect(clampChatNewlines("hello\n\n\n\n\nworld")).toBe("hello\n\nworld");
  });

  it("drops leading and trailing blank lines", () => {
    expect(clampChatNewlines("\n\nhello\n")).toBe("hello");
    expect(clampChatNewlines("hello\n\n\n")).toBe("hello");
  });

  it("turns a newline-only body into empty", () => {
    expect(clampChatNewlines("\n\n\n")).toBe("");
    expect(clampChatNewlines("   \n\n\t")).toBe("");
  });

  it("normalizes CR LF", () => {
    expect(clampChatNewlines("hello\r\n\r\n\r\nworld")).toBe("hello\n\nworld");
  });

  it("leaves blank lines inside a fenced block", () => {
    const source = "```\ncode\n\n\n\nstill\n```";
    expect(clampChatNewlines(source)).toBe(source);
  });

  it("still clamps around a fence", () => {
    expect(clampChatNewlines("hi\n\n\n```\na\n\nb\n```\n\n\nbye")).toBe(
      "hi\n\n```\na\n\nb\n```\n\nbye",
    );
  });

  it("is idempotent", () => {
    const once = clampChatNewlines("a\n\n\n\nb\n\n\nc");
    expect(clampChatNewlines(once)).toBe(once);
  });
});
