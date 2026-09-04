import { describe, expect, it } from "vitest";
import {
  desktopLoginHandoffHref,
  loopbackHandoffUrl,
  parseDesktopLoginSearch,
  parseDesktopLoopbackReturn,
} from "./desktop-login";

describe("parseDesktopLoopbackReturn", () => {
  it("accepts a bare 127.0.0.1 callback", () => {
    expect(parseDesktopLoopbackReturn("http://127.0.0.1:41234/callback")).toBe(
      "http://127.0.0.1:41234/callback",
    );
  });

  it("normalises odd IPv4 spellings through URL parsing, then still requires 127.0.0.1", () => {
    // `127.1` becomes 127.0.0.1 in some parsers; we re-check hostname after parse.
    const parsed = parseDesktopLoopbackReturn("http://127.1:41234/callback");
    expect(parsed === null || parsed === "http://127.0.0.1:41234/callback").toBe(
      true,
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
