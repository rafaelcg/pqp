import { beforeEach, describe, expect, it } from "vitest";
import {
  addIntentFromSearch,
  HANDLE_INTENT_TTL_MS,
  stashAddIntent,
  stashHandleClaim,
  takeAddIntent,
  takeHandleClaim,
} from "./handle-intent";

/**
 * The two intentions that have to survive a sign-up. What is actually being
 * pinned here is that each of them fires EXACTLY ONCE — a claim that repeats
 * spends the 30-day rename cooldown on a name the person already has, and an add
 * that repeats sends a stranger a friend request every time they reload.
 */

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage & { map: Map<string, string> };
}

/** Safari private mode, an embedded webview: every call throws. */
const hostileStorage = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
  removeItem() {
    throw new Error("denied");
  },
} as unknown as Storage;

describe("the handle claim intent", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("survives the round trip", () => {
    stashHandleClaim(storage, "rafa");
    expect(takeHandleClaim(storage)).toBe("rafa");
  });

  it("is consumed, so the claim cannot fire twice", () => {
    stashHandleClaim(storage, "rafa");
    expect(takeHandleClaim(storage)).toBe("rafa");
    expect(takeHandleClaim(storage)).toBeNull();
  });

  it("expires, so an abandoned signup does not act months later", () => {
    const now = Date.now();
    stashHandleClaim(storage, "rafa", now);
    expect(takeHandleClaim(storage, now + HANDLE_INTENT_TTL_MS - 1)).toBe("rafa");

    stashHandleClaim(storage, "rafa", now);
    expect(
      takeHandleClaim(storage, now + HANDLE_INTENT_TTL_MS + 1),
    ).toBeNull();
  });

  it("keeps the two intents apart", () => {
    stashHandleClaim(storage, "rafa");
    stashAddIntent(storage, "outro");
    expect(takeAddIntent(storage)).toBe("outro");
    expect(takeHandleClaim(storage)).toBe("rafa");
  });

  it("reads anything unparseable as no intent", () => {
    for (const junk of ["", "not json", "[]", '{"handle":42}', '{"at":1}']) {
      storage.map.set("pqp:pending-handle-claim", junk);
      expect(takeHandleClaim(storage)).toBeNull();
    }
  });

  it("does nothing at all when storage is denied", () => {
    expect(() => stashHandleClaim(hostileStorage, "rafa")).not.toThrow();
    expect(takeHandleClaim(hostileStorage)).toBeNull();
    expect(takeHandleClaim(null)).toBeNull();
    expect(() => stashHandleClaim(null, "rafa")).not.toThrow();
  });
});

describe("addIntentFromSearch", () => {
  it("reads the handle out of ?add=", () => {
    expect(addIntentFromSearch("?add=rafa")).toBe("rafa");
    expect(addIntentFromSearch("?add=@Rafa")).toBe("rafa");
    expect(addIntentFromSearch("?claim=x&add=rafa_cg")).toBe("rafa_cg");
  });

  it("answers null for anything that is not a handle", () => {
    // The query string is user-writable and the value goes straight into a
    // request path, so the shape check is not decoration.
    for (const search of [
      "",
      "?add=",
      "?add=ab",
      "?add=.rafa",
      "?add=" + encodeURIComponent("../../api/me"),
      "?add=" + "a".repeat(40),
      "?other=rafa",
    ]) {
      expect(addIntentFromSearch(search)).toBeNull();
    }
  });
});
