import { beforeEach, describe, expect, it } from "vitest";
import {
  addIntentFromSearch,
  CREATE_INTENT_PARAMS,
  createIntentFromSearch,
  createIntentHref,
  HANDLE_INTENT_TTL_MS,
  rememberCreateIntentFromLocation,
  stashCreateIntent,
  rememberInviteRefFromLocation,
  stashAddIntent,
  stashInviteRef,
  stashHandleClaim,
  stashJoinIntent,
  takeAddIntent,
  takeCreateIntent,
  takeHandleClaim,
  takeInviteRef,
  takeJoinIntent,
  type CreateIntent,
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
  const DISCORD: CreateIntent = { mode: "import", source: null };
  const NEW: CreateIntent = { mode: "name", source: null };

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("survives the trip through sign-up and is consumed on arrival", () => {
    stashCreateIntent(storage, DISCORD);
    expect(takeCreateIntent(storage)).toEqual(DISCORD);
    // Opening the dialog on every reload would be a nag, not an intent.
    expect(takeCreateIntent(storage)).toBeNull();
  });

  it("expires like the others", () => {
    stashCreateIntent(storage, NEW, 0);
    expect(takeCreateIntent(storage, HANDLE_INTENT_TTL_MS + 1)).toBeNull();
  });

  it("keeps its own key", () => {
    stashJoinIntent(storage, "valorant-brasil");
    stashCreateIntent(storage, DISCORD);
    expect(takeJoinIntent(storage)).toBe("valorant-brasil");
    expect(takeCreateIntent(storage)).toEqual(DISCORD);
  });

  it("refuses a stashed value that is not an intent", () => {
    storage.setItem(
      "pqp:pending-create-community",
      JSON.stringify({ handle: "rm -rf", at: Date.now() }),
    );
    expect(takeCreateIntent(storage)).toBeNull();
  });

  it("does nothing at all when storage is denied", () => {
    expect(() => stashCreateIntent(hostileStorage, DISCORD)).not.toThrow();
    expect(takeCreateIntent(hostileStorage)).toBeNull();
  });

  it("reads only the two known values from ?create=", () => {
    expect(createIntentFromSearch("?create=discord")).toEqual(DISCORD);
    expect(createIntentFromSearch("?x=1&create=new")).toEqual(NEW);
    expect(createIntentFromSearch("?create=DISCORD")).toBeNull();
    expect(createIntentFromSearch("?create=")).toBeNull();
    expect(createIntentFromSearch("")).toBeNull();
  });

  it("is the same intent whether a link says ?create=discord or ?import=discord", () => {
    expect(createIntentFromSearch("?create=discord")).toEqual(
      createIntentFromSearch("?import=discord"),
    );
    // A template named in ?import= wins over a bare ?create=.
    expect(createIntentFromSearch("?create=new&import=hgM48av5Q69A")).toEqual({
      mode: "import",
      source: "https://discord.new/hgM48av5Q69A",
    });
  });

  it("writes the link a CTA carries, and reads it back as the same intent", () => {
    const template: CreateIntent = {
      mode: "import",
      source: "https://discord.new/hgM48av5Q69A",
    };
    expect(createIntentHref(DISCORD)).toBe("/app?import=discord");
    expect(createIntentHref(NEW)).toBe("/app?create=new");
    expect(createIntentHref(template)).toBe("/app?import=hgM48av5Q69A");
    for (const intent of [DISCORD, NEW, template]) {
      const href = createIntentHref(intent);
      expect(createIntentFromSearch(href.slice(href.indexOf("?")))).toEqual(intent);
    }
  });

  it("names every parameter it reads, for the URL clean-up", () => {
    expect([...CREATE_INTENT_PARAMS].sort()).toEqual(["create", "import"]);
  });
});

describe("the Discord import spelling of it", () => {
  it("reads the door alone, or a template it can pre-fill", () => {
    expect(createIntentFromSearch("?import=discord")).toEqual({
      mode: "import",
      source: null,
    });
    expect(createIntentFromSearch("?import=1")).toEqual({
      mode: "import",
      source: null,
    });
    expect(createIntentFromSearch("?import=hgM48av5Q69A")).toEqual({
      mode: "import",
      source: "https://discord.new/hgM48av5Q69A",
    });
    expect(
      createIntentFromSearch(
        `?import=${encodeURIComponent("https://discord.new/hgM48av5Q69A")}`,
      ),
    ).toEqual({ mode: "import", source: "https://discord.new/hgM48av5Q69A" });
  });

  it("ignores anything that is not a template or the door", () => {
    expect(createIntentFromSearch("")).toBeNull();
    expect(createIntentFromSearch("?import=")).toBeNull();
    expect(createIntentFromSearch("?import=https://evil.example/x")).toBeNull();
    expect(createIntentFromSearch("?import=a b")).toBeNull();
  });

  it("survives a sign-up once, and only once", () => {
    const storage = memoryStorage();
    rememberCreateIntentFromLocation(storage, { search: "?import=discord" });
    expect(takeCreateIntent(storage)).toEqual({ mode: "import", source: null });
    expect(takeCreateIntent(storage)).toBeNull();

    rememberCreateIntentFromLocation(storage, { search: "?import=hgM48av5Q69A" });
    expect(takeCreateIntent(storage)).toEqual({
      mode: "import",
      source: "https://discord.new/hgM48av5Q69A",
    });

    // The /vem spelling rides the same stash.
    rememberCreateIntentFromLocation(storage, { search: "?create=new" });
    expect(takeCreateIntent(storage)).toEqual({ mode: "name", source: null });
  });

  it("stashes nothing for a page without the parameter, and expires", () => {
    const storage = memoryStorage();
    rememberCreateIntentFromLocation(storage, { search: "?ref=perfil" });
    expect(storage.map.size).toBe(0);
    rememberCreateIntentFromLocation(storage, { search: "?import=discord" }, 0);
    expect(takeCreateIntent(storage, HANDLE_INTENT_TTL_MS + 1)).toBeNull();
  });

  it("does nothing when storage is denied", () => {
    expect(() =>
      rememberCreateIntentFromLocation(hostileStorage, { search: "?import=discord" }),
    ).not.toThrow();
    expect(takeCreateIntent(hostileStorage)).toBeNull();
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

describe("putting an invite ref back", () => {
  it("lets a retry after a failed join send the same tag", () => {
    const storage = memoryStorage();
    stashInviteRef(storage, "abc123", "discord");
    const ref = takeInviteRef(storage, "abc123", "");
    expect(ref).toBe("discord");
    // The join failed: put it back, and the panel's retry reads it.
    stashInviteRef(storage, "abc123", ref);
    expect(takeInviteRef(storage, "abc123", "")).toBe("discord");
    // Nothing to put back is a no-op.
    stashInviteRef(storage, "abc123", null);
    expect(storage.map.size).toBe(0);
  });
});
