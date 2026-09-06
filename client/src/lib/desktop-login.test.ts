import { afterEach, describe, expect, it } from "vitest";
import {
  clearStashedDesktopLoginParams,
  desktopLoginHandoffHref,
  loopbackHandoffUrl,
  parseDesktopLoginSearch,
  parseDesktopLoopbackReturn,
  resolveDesktopLoginParams,
  stashDesktopLoginParams,
} from "./desktop-login";

const memory = new Map<string, string>();
const session = {
  getItem(key: string) {
    return memory.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    memory.set(key, value);
  },
  removeItem(key: string) {
    memory.delete(key);
  },
};

Object.defineProperty(globalThis, "sessionStorage", {
  value: session,
  configurable: true,
});

afterEach(() => {
  memory.clear();
});

describe("parseDesktopLoopbackReturn", () => {
  it("accepts a bare 127.0.0.1 callback", () => {
    expect(parseDesktopLoopbackReturn("http://127.0.0.1:41234/callback")).toBe(
      "http://127.0.0.1:41234/callback",
    );
  });

  it("normalises odd IPv4 spellings through URL parsing, then still requires 127.0.0.1", () => {
    // WHATWG parses `127.1` to 127.0.0.1; we re-check hostname after parse.
    expect(parseDesktopLoopbackReturn("http://127.1:41234/callback")).toBe(
      "http://127.0.0.1:41234/callback",
    );
  });

  it("refuses everything that is not a loopback callback", () => {
    for (const value of [
      "https://127.0.0.1:41234/callback",
      "http://localhost:41234/callback",
      "http://[::1]:41234/callback",
      "http://127.0.0.1:41234/other",
      "http://127.0.0.1:41234/callback?x=1",
      "http://127.0.0.1:41234/callback#x",
      "http://user:pass@127.0.0.1:41234/callback",
      "http://127.0.0.1/callback",
      "http://127.0.0.1:80/callback",
      "http://evil.test/callback",
      "not a url",
      "",
    ]) {
      expect(parseDesktopLoopbackReturn(value)).toBeNull();
    }
  });
});

describe("parseDesktopLoginSearch", () => {
  it("reads mode, return, and state", () => {
    const params = parseDesktopLoginSearch(
      "?mode=sign-up&return=http://127.0.0.1:41234/callback&state=abc",
    );
    expect(params.mode).toBe("sign-up");
    expect(params.returnUrl).toBe("http://127.0.0.1:41234/callback");
    expect(params.state).toBe("abc");
    expect(params.done).toBe(false);
  });

  it("drops a hostile return", () => {
    const params = parseDesktopLoginSearch(
      "?return=https://evil.test/steal&state=abc",
    );
    expect(params.returnUrl).toBeNull();
  });

  it("allowlists next through signedOutRedirectPath", () => {
    expect(
      parseDesktopLoginSearch("?next=/app/invite/AB12").next,
    ).toBe("/app/invite/AB12");
    expect(parseDesktopLoginSearch("?next=https://evil.test").next).toBe("/app");
  });
});

describe("desktopLoginHandoffHref / loopbackHandoffUrl", () => {
  it("rebuilds the page URL without a hash", () => {
    expect(
      desktopLoginHandoffHref("https://pqp.gg", {
        mode: "sign-in",
        returnUrl: "http://127.0.0.1:41234/callback",
        state: "abc",
        next: null,
        done: false,
      }),
    ).toBe(
      "https://pqp.gg/desktop-login?mode=sign-in&return=http%3A%2F%2F127.0.0.1%3A41234%2Fcallback&state=abc",
    );
  });

  it("puts the ticket on the loopback URL", () => {
    expect(
      loopbackHandoffUrl("http://127.0.0.1:41234/callback", "st_x", "abc"),
    ).toBe("http://127.0.0.1:41234/callback?ticket=st_x&state=abc");
  });
});

describe("resolveDesktopLoginParams stash", () => {
  const live = {
    mode: "sign-in" as const,
    returnUrl: "http://127.0.0.1:41234/callback",
    state: "abc",
    next: null,
    done: false,
  };

  it("keeps return/state across a Clerk hop that drops the query", () => {
    stashDesktopLoginParams(live);
    expect(resolveDesktopLoginParams("?mode=sign-in")).toEqual(live);
  });

  it("drops the stash when the app says the handoff is done", () => {
    stashDesktopLoginParams(live);
    expect(resolveDesktopLoginParams("?done=1").done).toBe(true);
    expect(resolveDesktopLoginParams("")).toEqual({
      mode: "sign-in",
      returnUrl: null,
      state: null,
      next: null,
      done: false,
    });
  });

  it("drops a cleared stash so Switch account cannot reuse an old listener", () => {
    stashDesktopLoginParams(live);
    clearStashedDesktopLoginParams();
    expect(resolveDesktopLoginParams("").returnUrl).toBeNull();
  });
});
