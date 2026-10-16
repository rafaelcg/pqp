// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSoundboardMarksForTests,
  showSoundboardMark,
  useSoundboardMark,
} from "./soundboard";

/*
 * Every play notifies the soundboard store, and a call draws a mark per
 * person. A play must re-render the player's mark only, not everyone's.
 */

const renders = new Map<string, number>();

function Mark({ userId }: { userId: string }) {
  renders.set(userId, (renders.get(userId) ?? 0) + 1);
  const mark = useSoundboardMark(userId);
  return <span data-user={userId}>{mark ? mark.soundId : ""}</span>;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  renders.clear();
  resetSoundboardMarksForTests();
  vi.useRealTimers();
});

describe("useSoundboardMark", () => {
  it("re-renders only the mark of the person who played", () => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <>
          <Mark userId="a" />
          <Mark userId="b" />
          <Mark userId="c" />
        </>,
      );
    });
    const before = new Map(renders);
    act(() => {
      showSoundboardMark({ userId: "a", displayName: "A", emoji: "x", soundId: "builtin:palmas" });
    });
    expect(renders.get("a")).toBe((before.get("a") ?? 0) + 1);
    expect(renders.get("b")).toBe(before.get("b"));
    expect(renders.get("c")).toBe(before.get("c"));
    expect(host.querySelector('[data-user="a"]')!.textContent).toBe("builtin:palmas");
  });
});
