import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

import { queuePreferenceSync } from "./preferences";
import {
  CHAT_DISPLAY_STORAGE_KEY,
  DEFAULT_CHAT_DISPLAY,
  adoptChatDisplay,
  applyChatDisplay,
  getChatDisplay,
  lineHeightFor,
  normalizeChatDisplay,
  setChatDisplay,
} from "./chat-display";

describe("normalizeChatDisplay", () => {
  it("fills a partial against the defaults", () => {
    expect(normalizeChatDisplay({ fontSize: 18 })).toEqual({
      ...DEFAULT_CHAT_DISPLAY,
      fontSize: 18,
    });
  });

  it("clamps and rounds the sliders", () => {
    expect(normalizeChatDisplay({ fontSize: 40, groupSpacing: -3 })).toEqual({
      ...DEFAULT_CHAT_DISPLAY,
      fontSize: 24,
      groupSpacing: 0,
    });
    expect(normalizeChatDisplay({ fontSize: 15.6 }).fontSize).toBe(16);
  });

  it("ignores junk", () => {
    expect(
      normalizeChatDisplay({
        density: "huge" as never,
        fontSize: "big" as never,
        groupSpacing: Number.NaN,
      }),
    ).toEqual(DEFAULT_CHAT_DISPLAY);
    expect(normalizeChatDisplay(null)).toEqual(DEFAULT_CHAT_DISPLAY);
  });
});

describe("lineHeightFor", () => {
  it("keeps the 22/15 ratio the list has always used", () => {
    expect(lineHeightFor(15)).toBe(22);
    expect(lineHeightFor(12)).toBe(18);
    expect(lineHeightFor(24)).toBe(35);
  });
});

describe("the store", () => {
  const store = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};
  const styles = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    styles.clear();
    for (const key of Object.keys(dataset)) {
      delete dataset[key];
    }
    vi.mocked(queuePreferenceSync).mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    vi.stubGlobal("document", {
      documentElement: {
        dataset,
        style: {
          setProperty: (name: string, value: string) => {
            styles.set(name, value);
          },
        },
      },
    });
  });

  it("publishes the three variables and the density attribute", () => {
    applyChatDisplay({ density: "compact", fontSize: 18, groupSpacing: 4 });
    expect(styles.get("--chat-font-size")).toBe("18px");
    expect(styles.get("--chat-line-height")).toBe("26px");
    expect(styles.get("--chat-group-gap")).toBe("4px");
    expect(dataset.density).toBe("compact");

    applyChatDisplay(DEFAULT_CHAT_DISPLAY);
    expect(dataset.density).toBeUndefined();
  });

  it("a user change is stored and synced; a server value is only stored", () => {
    setChatDisplay({ fontSize: 20 });
    expect(getChatDisplay().fontSize).toBe(20);
    expect(JSON.parse(store.get(CHAT_DISPLAY_STORAGE_KEY) ?? "{}")).toMatchObject(
      { fontSize: 20 },
    );
    expect(queuePreferenceSync).toHaveBeenCalledWith(
      { chatDisplay: expect.objectContaining({ fontSize: 20 }) },
      { immediate: false },
    );

    vi.mocked(queuePreferenceSync).mockClear();
    adoptChatDisplay({ density: "compact" });
    expect(getChatDisplay()).toMatchObject({ density: "compact", fontSize: 20 });
    expect(queuePreferenceSync).not.toHaveBeenCalled();
  });
});
