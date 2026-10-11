import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHARE_PRIORITY,
  getSharePriority,
  parseSharePriority,
  resetSharePriorityForTests,
  setSharePriority,
  sharePriorityContentHint,
  sharePriorityDegradation,
  subscribeSharePriority,
} from "./share-priority";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

beforeEach(() => {
  resetSharePriorityForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSharePriorityForTests();
});

describe("share priority", () => {
  it("defaults to motion, which is what every share did before the choice existed", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(DEFAULT_SHARE_PRIORITY).toBe("motion");
    expect(getSharePriority()).toBe("motion");
  });

  it("maps each choice onto the hint and the sender preference together", () => {
    expect(sharePriorityContentHint("motion")).toBe("motion");
    expect(sharePriorityDegradation("motion")).toBe("maintain-framerate");
    expect(sharePriorityContentHint("detail")).toBe("detail");
    expect(sharePriorityDegradation("detail")).toBe("maintain-resolution");
  });

  it("lets nothing but a known choice in from storage", () => {
    expect(parseSharePriority("detail")).toBe("detail");
    for (const junk of [null, undefined, "", "balanced", 3, {}]) {
      expect(parseSharePriority(junk)).toBe("motion");
    }
  });

  it("remembers the choice on this device and reads it back", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setSharePriority("detail");
    expect(storage.data.get("pqp:share-priority")).toBe("detail");
    resetSharePriorityForTests();
    expect(getSharePriority()).toBe("detail");
  });

  it("tells listeners about a change, and only about a change", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const heard: string[] = [];
    subscribeSharePriority((priority) => heard.push(priority));
    setSharePriority("detail");
    setSharePriority("detail");
    setSharePriority("motion");
    expect(heard).toEqual(["detail", "motion"]);
  });

  it("still applies for the session when storage refuses", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(getSharePriority()).toBe("motion");
    setSharePriority("detail");
    expect(getSharePriority()).toBe("detail");
  });
});
