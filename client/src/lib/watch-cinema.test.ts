import { describe, expect, it } from "vitest";
import {
  isWatchCinemaMode,
  shouldToggleWatchChatOverlay,
  watchCinemaChatOverlay,
} from "./watch-cinema";

describe("isWatchCinemaMode", () => {
  it("is the pane we restyle (element fullscreen or in-page expand)", () => {
    expect(isWatchCinemaMode("element")).toBe(true);
    expect(isWatchCinemaMode("expand")).toBe(true);
  });

  it("is off when nothing is fullscreen, and on iPhone's native player", () => {
    // The native player is already film-only; overlaying our chat on a pane
    // that is not on screen would be a layout for nobody.
    expect(isWatchCinemaMode("off")).toBe(false);
    expect(isWatchCinemaMode("video")).toBe(false);
  });
});

describe("watchCinemaChatOverlay", () => {
  it("only overlays while cinema owns the pane", () => {
    expect(watchCinemaChatOverlay("element", true)).toBe(true);
    expect(watchCinemaChatOverlay("expand", true)).toBe(true);
    expect(watchCinemaChatOverlay("element", false)).toBe(false);
    expect(watchCinemaChatOverlay("off", true)).toBe(false);
    expect(watchCinemaChatOverlay("video", true)).toBe(false);
  });
});

describe("shouldToggleWatchChatOverlay", () => {
  const key = {
    key: "c",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    target: null,
  };

  it("toggles on c / C with no modifiers", () => {
    expect(shouldToggleWatchChatOverlay(key)).toBe(true);
    expect(shouldToggleWatchChatOverlay({ ...key, key: "C" })).toBe(true);
  });

  it("ignores other keys and modified c", () => {
    expect(shouldToggleWatchChatOverlay({ ...key, key: "f" })).toBe(false);
    expect(shouldToggleWatchChatOverlay({ ...key, ctrlKey: true })).toBe(false);
    expect(shouldToggleWatchChatOverlay({ ...key, metaKey: true })).toBe(false);
    expect(shouldToggleWatchChatOverlay({ ...key, altKey: true })).toBe(false);
  });

  it("does not steal c from the composer", () => {
    expect(
      shouldToggleWatchChatOverlay({
        ...key,
        target: { tagName: "INPUT" } as unknown as EventTarget,
      }),
    ).toBe(false);
    expect(
      shouldToggleWatchChatOverlay({
        ...key,
        target: { tagName: "TEXTAREA" } as unknown as EventTarget,
      }),
    ).toBe(false);
    expect(
      shouldToggleWatchChatOverlay({
        ...key,
        target: { isContentEditable: true } as unknown as EventTarget,
      }),
    ).toBe(false);
  });
});
