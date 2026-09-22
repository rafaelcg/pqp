import { beforeEach, describe, expect, it } from "vitest";
import {
  addIntentFromSearch,
  createIntentFromSearch,
  HANDLE_INTENT_TTL_MS,
  stashCreateIntent,
  importIntentFromSearch,
  rememberImportIntentFromLocation,
  rememberInviteRefFromLocation,
  stashAddIntent,
  stashHandleClaim,
  stashJoinIntent,
  takeAddIntent,
  takeCreateIntent,
  takeHandleClaim,
  takeImportIntent,
  takeInviteRef,
  takeJoinIntent,
} from "./handle-intent";

/**
 * The three intentions that have to survive a sign-up. What is actually being
 * pinned here is that each of them fires EXACTLY ONCE — a claim that repeats
 * spends the 30-day rename cooldown on a name the person already has, an add
 * that repeats sends a stranger a friend request every time they reload, and a
 * join that repeats re-enters a community somebody may have left.
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

describe("the community join intent", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("survives the trip through sign-up and is consumed on arrival", () => {
    stashJoinIntent(storage, "valorant-brasil");
    expect(takeJoinIntent(storage)).toBe("valorant-brasil");
    // A join that fires twice re-enters a community somebody may have left in
    // between, which is a membership nobody asked for the second time.
    expect(takeJoinIntent(storage)).toBeNull();
  });

  it("expires rather than acting on a signup abandoned in March", () => {
    stashJoinIntent(storage, "valorant-brasil", 0);
    expect(takeJoinIntent(storage, HANDLE_INTENT_TTL_MS + 1)).toBeNull();
  });

  it("keeps its own key, so one intent cannot consume another's", () => {
    stashAddIntent(storage, "rafa");
    stashJoinIntent(storage, "valorant-brasil");
    expect(takeAddIntent(storage)).toBe("rafa");
    expect(takeJoinIntent(storage)).toBe("valorant-brasil");
  });

  it("does nothing at all when storage is denied", () => {
    expect(() => stashJoinIntent(hostileStorage, "valorant")).not.toThrow();
    expect(takeJoinIntent(hostileStorage)).toBeNull();
    expect(takeJoinIntent(null)).toBeNull();
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

describe("the create-community intent", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("survives the trip through sign-up and is consumed on arrival", () => {
    stashCreateIntent(storage, "discord");
    expect(takeCreateIntent(storage)).toBe("discord");
    // Opening the dialog on every reload would be a nag, not an intent.
    expect(takeCreateIntent(storage)).toBeNull();
  });

  it("expires like the others", () => {
    stashCreateIntent(storage, "new", 0);
    expect(takeCreateIntent(storage, HANDLE_INTENT_TTL_MS + 1)).toBeNull();
  });

  it("keeps its own key", () => {
    stashJoinIntent(storage, "valorant-brasil");
    stashCreateIntent(storage, "discord");
    expect(takeJoinIntent(storage)).toBe("valorant-brasil");
    expect(takeCreateIntent(storage)).toBe("discord");
  });

  it("refuses a stashed value that is not one of the two", () => {
    storage.setItem(
      "pqp:pending-create-community",
      JSON.stringify({ handle: "rm -rf", at: Date.now() }),
    );
    expect(takeCreateIntent(storage)).toBeNull();
  });

  it("does nothing at all when storage is denied", () => {
    expect(() => stashCreateIntent(hostileStorage, "discord")).not.toThrow();
    expect(takeCreateIntent(hostileStorage)).toBeNull();
  });

  it("reads only the two known values from the URL", () => {
    expect(createIntentFromSearch("?create=discord")).toBe("discord");
    expect(createIntentFromSearch("?x=1&create=new")).toBe("new");
    expect(createIntentFromSearch("?create=DISCORD")).toBeNull();
    expect(createIntentFromSearch("?create=")).toBeNull();
    expect(createIntentFromSearch("")).toBeNull();
describe("the Discord import intent", () => {
  it("reads the door alone, or a template it can pre-fill", () => {
    expect(importIntentFromSearch("?import=discord")).toEqual({ source: null });
    expect(importIntentFromSearch("?import=1")).toEqual({ source: null });
    expect(importIntentFromSearch("?import=hgM48av5Q69A")).toEqual({
      source: "https://discord.new/hgM48av5Q69A",
    });
    expect(
      importIntentFromSearch(
        `?import=${encodeURIComponent("https://discord.new/hgM48av5Q69A")}`,
      ),
    ).toEqual({ source: "https://discord.new/hgM48av5Q69A" });
  });

  it("ignores anything that is not a template or the door", () => {
    expect(importIntentFromSearch("")).toBeNull();
    expect(importIntentFromSearch("?import=")).toBeNull();
    expect(importIntentFromSearch("?import=https://evil.example/x")).toBeNull();
    expect(importIntentFromSearch("?import=a b")).toBeNull();
  });

  it("survives a sign-up once, and only once", () => {
    const storage = memoryStorage();
    rememberImportIntentFromLocation(storage, { search: "?import=discord" });
    expect(takeImportIntent(storage)).toEqual({ source: null });
    expect(takeImportIntent(storage)).toBeNull();

    rememberImportIntentFromLocation(storage, { search: "?import=hgM48av5Q69A" });
    expect(takeImportIntent(storage)).toEqual({
      source: "https://discord.new/hgM48av5Q69A",
    });
  });

  it("stashes nothing for a page without the parameter, and expires", () => {
    const storage = memoryStorage();
    rememberImportIntentFromLocation(storage, { search: "?ref=perfil" });
    expect(storage.map.size).toBe(0);
    rememberImportIntentFromLocation(storage, { search: "?import=discord" }, 0);
    expect(takeImportIntent(storage, HANDLE_INTENT_TTL_MS + 1)).toBeNull();
  });

  it("does nothing when storage is denied", () => {
    expect(() =>
      rememberImportIntentFromLocation(hostileStorage, { search: "?import=discord" }),
    ).not.toThrow();
    expect(takeImportIntent(hostileStorage)).toBeNull();
  });
});

describe("the invite link's ref", () => {
  it("prefers the URL's own tag", () => {
    expect(takeInviteRef(memoryStorage(), "abc123", "?ref=discord")).toBe("discord");
    expect(takeInviteRef(memoryStorage(), "abc123", "?ref=a@b")).toBeNull();
    expect(takeInviteRef(memoryStorage(), "abc123", "")).toBeNull();
  });

  it("carries the tag through sign-in for the same code only", () => {
    const storage = memoryStorage();
    rememberInviteRefFromLocation(storage, {
      pathname: "/app/invite/abc123",
      search: "?ref=discord",
    });
    // The redirect back drops the query.
    expect(takeInviteRef(storage, "abc123", "")).toBe("discord");
    expect(takeInviteRef(storage, "abc123", "")).toBeNull();

    rememberInviteRefFromLocation(storage, {
      pathname: "/app/invite/abc123",
      search: "?ref=discord",
    });
    expect(takeInviteRef(storage, "other1", "")).toBeNull();
    // Consumed even when it did not match.
    expect(takeInviteRef(storage, "abc123", "")).toBeNull();
  });

  it("stashes nothing off an invite path or without a clean tag", () => {
    const storage = memoryStorage();
    rememberInviteRefFromLocation(storage, { pathname: "/", search: "?ref=discord" });
    rememberInviteRefFromLocation(storage, {
      pathname: "/app/invite/abc123",
      search: "?ref=not ok",
    });
    expect(storage.map.size).toBe(0);
  });
});
