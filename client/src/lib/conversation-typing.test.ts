import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearListTyping,
  LIST_TYPING_TTL_MS,
  listTypingSnapshot,
  noteListTyping,
  resetListTypingForTests,
} from "@/lib/conversation-typing";

beforeEach(() => {
  vi.useFakeTimers();
  resetListTypingForTests();
});

afterEach(() => {
  resetListTypingForTests();
  vi.useRealTimers();
});

describe("list typing", () => {
  it("names who is typing per conversation and forgets them after the TTL", () => {
    noteListTyping("c1", "u1", "Gabi");
    noteListTyping("c2", "u2", "Kata");
    noteListTyping("c2", "u3", "Caio");
    expect(listTypingSnapshot().get("c1")).toEqual(["Gabi"]);
    expect(listTypingSnapshot().get("c2")).toEqual(["Kata", "Caio"]);

    vi.advanceTimersByTime(LIST_TYPING_TTL_MS + 100);
    expect(listTypingSnapshot().size).toBe(0);
  });

  it("a fresh frame keeps the line up; their message ends it at once", () => {
    noteListTyping("c1", "u1", "Gabi");
    vi.advanceTimersByTime(LIST_TYPING_TTL_MS - 1000);
    noteListTyping("c1", "u1", "Gabi");
    vi.advanceTimersByTime(2000);
    expect(listTypingSnapshot().get("c1")).toEqual(["Gabi"]);

    clearListTyping("c1", "u1");
    expect(listTypingSnapshot().has("c1")).toBe(false);
  });
});
