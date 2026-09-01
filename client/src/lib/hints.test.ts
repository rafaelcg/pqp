import { describe, expect, it } from "vitest";
import {
  isAutomatedBrowser,
  isHintSeen,
  rememberHint,
  shouldPersistHints,
} from "./hints";

function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe("hints store", () => {
  it("never persists on localhost, so a developer sees every card again", () => {
    expect(shouldPersistHints("localhost")).toBe(false);
    expect(shouldPersistHints("127.0.0.1")).toBe(false);
    expect(shouldPersistHints("pqp.gg")).toBe(true);
    const storage = memory({ "x": "1" });
    expect(isHintSeen("x", storage, false)).toBe(false);
    rememberHint("y", storage, false);
    expect(storage.dump()).toEqual({ x: "1" });
  });

  it("remembers and reads back on a real host", () => {
    const storage = memory();
    expect(isHintSeen("x", storage, true)).toBe(false);
    rememberHint("x", storage, true);
    expect(isHintSeen("x", storage, true)).toBe(true);
  });

  it("treats missing or hostile storage as already seen", () => {
    expect(isHintSeen("x", null, true)).toBe(true);
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(isHintSeen("x", hostile, true)).toBe(true);
    expect(() => rememberHint("x", hostile, true)).not.toThrow();
  });

  it("reads the automation flag", () => {
    expect(isAutomatedBrowser({ webdriver: true })).toBe(true);
    expect(isAutomatedBrowser({})).toBe(false);
    expect(isAutomatedBrowser(undefined)).toBe(false);
  });
});
