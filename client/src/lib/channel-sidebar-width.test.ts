import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MAX_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
  channelSidebarMaxWidth,
  channelSidebarWidthForKey,
  clampChannelSidebarWidth,
  loadChannelSidebarWidth,
  parseStoredChannelSidebarWidth,
  resetChannelSidebarWidth,
  saveChannelSidebarWidth,
} from "./channel-sidebar-width";

const STORAGE_KEY = "pqp:channel-sidebar-width";

/**
 * The suite runs under vitest's `node` environment, which has no
 * `localStorage` global at all. Same stub the collapsed-categories suite uses.
 */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channelSidebarMaxWidth", () => {
  it("is the absolute cap on a wide window", () => {
    expect(channelSidebarMaxWidth(1920)).toBe(CHANNEL_SIDEBAR_MAX_WIDTH);
  });

  it("is a fraction of a narrow window, so the chat keeps most of it", () => {
    // 40% of 900 is 360, under the 420 cap.
    expect(channelSidebarMaxWidth(900)).toBe(360);
  });

  it("never drops below the minimum, however narrow the window", () => {
    expect(channelSidebarMaxWidth(320)).toBe(CHANNEL_SIDEBAR_MIN_WIDTH);
  });

  it("falls back to the absolute cap when the viewport is unknown or absurd", () => {
    expect(channelSidebarMaxWidth(undefined)).toBe(CHANNEL_SIDEBAR_MAX_WIDTH);
    expect(channelSidebarMaxWidth(0)).toBe(CHANNEL_SIDEBAR_MAX_WIDTH);
    expect(channelSidebarMaxWidth(Number.NaN)).toBe(CHANNEL_SIDEBAR_MAX_WIDTH);
  });
});

describe("clampChannelSidebarWidth", () => {
  it("leaves a width inside the bounds alone", () => {
    expect(clampChannelSidebarWidth(300, 1920)).toBe(300);
  });

  it("clamps below the minimum up", () => {
    expect(clampChannelSidebarWidth(40, 1920)).toBe(CHANNEL_SIDEBAR_MIN_WIDTH);
  });

  it("clamps above the maximum down", () => {
    expect(clampChannelSidebarWidth(9000, 1920)).toBe(
      CHANNEL_SIDEBAR_MAX_WIDTH,
    );
  });

  it("clamps a stored wide value down when the window shrinks", () => {
    // The regression this exists for: 420 remembered on a desktop, then the
    // same profile opened in a 900px window.
    expect(clampChannelSidebarWidth(420, 900)).toBe(360);
  });

  it("rounds, so a fractional pointer delta cannot store a sub-pixel width", () => {
    expect(clampChannelSidebarWidth(300.4, 1920)).toBe(300);
    expect(clampChannelSidebarWidth(300.6, 1920)).toBe(301);
  });

  it("treats NaN and Infinity as no answer, not as a bound", () => {
    expect(clampChannelSidebarWidth(Number.NaN, 1920)).toBe(
      CHANNEL_SIDEBAR_DEFAULT_WIDTH,
    );
    expect(clampChannelSidebarWidth(Number.POSITIVE_INFINITY, 1920)).toBe(
      CHANNEL_SIDEBAR_DEFAULT_WIDTH,
    );
  });
});

describe("parseStoredChannelSidebarWidth", () => {
  it("reads a plain number", () => {
    expect(parseStoredChannelSidebarWidth("312", 1920)).toBe(312);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(parseStoredChannelSidebarWidth(null, 1920)).toBe(
      CHANNEL_SIDEBAR_DEFAULT_WIDTH,
    );
  });

  it("falls back to the default on a corrupt value", () => {
    for (const raw of ["", "   ", "abc", "256px", "{not json", "NaN"]) {
      expect(parseStoredChannelSidebarWidth(raw, 1920)).toBe(
        CHANNEL_SIDEBAR_DEFAULT_WIDTH,
      );
    }
  });

  it("clamps a stored value that is out of bounds", () => {
    expect(parseStoredChannelSidebarWidth("12", 1920)).toBe(
      CHANNEL_SIDEBAR_MIN_WIDTH,
    );
    expect(parseStoredChannelSidebarWidth("5000", 1920)).toBe(
      CHANNEL_SIDEBAR_MAX_WIDTH,
    );
  });
});

describe("load and save", () => {
  it("round-trips a width", () => {
    saveChannelSidebarWidth(333);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("333");
    expect(loadChannelSidebarWidth(1920)).toBe(333);
  });

  it("survives a corrupt stored value", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadChannelSidebarWidth(1920)).toBe(CHANNEL_SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("channelSidebarWidthForKey", () => {
  it("grows on ArrowRight and shrinks on ArrowLeft, one step", () => {
    expect(
      channelSidebarWidthForKey("ArrowRight", {
        current: 256,
        viewportWidth: 1920,
      }),
    ).toBe(264);
    expect(
      channelSidebarWidthForKey("ArrowLeft", {
        current: 256,
        viewportWidth: 1920,
      }),
    ).toBe(248);
  });

  it("takes a larger step with Shift", () => {
    expect(
      channelSidebarWidthForKey("ArrowRight", {
        current: 256,
        shiftKey: true,
        viewportWidth: 1920,
      }),
    ).toBe(288);
    expect(
      channelSidebarWidthForKey("ArrowLeft", {
        current: 256,
        shiftKey: true,
        viewportWidth: 1920,
      }),
    ).toBe(224);
  });

  it("cannot step past either bound", () => {
    expect(
      channelSidebarWidthForKey("ArrowLeft", {
        current: CHANNEL_SIDEBAR_MIN_WIDTH,
        shiftKey: true,
        viewportWidth: 1920,
      }),
    ).toBe(CHANNEL_SIDEBAR_MIN_WIDTH);
    expect(
      channelSidebarWidthForKey("ArrowRight", {
        current: CHANNEL_SIDEBAR_MAX_WIDTH,
        shiftKey: true,
        viewportWidth: 1920,
      }),
    ).toBe(CHANNEL_SIDEBAR_MAX_WIDTH);
  });

  it("jumps to the bounds on Home and End", () => {
    expect(
      channelSidebarWidthForKey("Home", { current: 300, viewportWidth: 1920 }),
    ).toBe(CHANNEL_SIDEBAR_MIN_WIDTH);
    expect(
      channelSidebarWidthForKey("End", { current: 300, viewportWidth: 1920 }),
    ).toBe(CHANNEL_SIDEBAR_MAX_WIDTH);
    // End respects the viewport half of the cap too.
    expect(
      channelSidebarWidthForKey("End", { current: 300, viewportWidth: 900 }),
    ).toBe(360);
  });

  it("ignores every other key, so Tab and Escape still do their own job", () => {
    for (const key of ["Tab", "Escape", "ArrowUp", "ArrowDown", "a", "Enter"]) {
      expect(
        channelSidebarWidthForKey(key, { current: 256, viewportWidth: 1920 }),
      ).toBeNull();
    }
  });
});

describe("resetChannelSidebarWidth", () => {
  it("is the default on a window with room for it", () => {
    expect(resetChannelSidebarWidth(1920)).toBe(CHANNEL_SIDEBAR_DEFAULT_WIDTH);
  });

  it("is clamped on a window without", () => {
    expect(resetChannelSidebarWidth(500)).toBe(200);
  });
});
