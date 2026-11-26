// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JAM_SIGNED_IN_COOKIE,
  JAM_SIGNED_IN_KEY,
  JAM_SIGNED_IN_TTL_MS,
  adoptSignedParam,
  clearedHintCookie,
  decodeHint,
  encodeHint,
  forgetSignedIn,
  hintCookie,
  hintCookieDomain,
  hintFromCookieHeader,
  hintName,
  readSignedIn,
  readStoredHint,
  rememberSignedIn,
  signedParamIn,
  withSignedParam,
  withoutSignedParam,
  writeStoredHint,
} from "./jam-signed-in";

function clearCookie() {
  document.cookie = `${JAM_SIGNED_IN_COOKIE}=; Path=/; Max-Age=0`;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearCookie();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  clearCookie();
});

describe("the display hint", () => {
  it("keeps the first word, without control characters, cut short", () => {
    expect(hintName("Rafael Cammarano")).toBe("Rafael");
    expect(hintName("  ‮Ana\u0007  Souza ")).toBe("Ana");
    expect(hintName("a".repeat(60))).toBe("a".repeat(20));
    expect(hintName("   ")).toBeNull();
    expect(hintName(null)).toBeNull();
    expect(hintName(undefined)).toBeNull();
  });

  it("round-trips a name, an accent and a boolean", () => {
    expect(decodeHint(encodeHint("Zoé"))).toEqual({ name: "Zoé" });
    expect(decodeHint(encodeHint(null))).toEqual({ name: null });
    expect(encodeHint(null)).toBe("1");
  });

  it("reads nothing from anything that is not ours", () => {
    expect(decodeHint("")).toBeNull();
    expect(decodeHint("0")).toBeNull();
    expect(decodeHint("true")).toBeNull();
    expect(decodeHint("2.x")).toBeNull();
    expect(decodeHint(null)).toBeNull();
    // a broken escape is a signed-in hint with no name, not an exception
    expect(decodeHint("1.%E0%A4%A")).toEqual({ name: null });
  });
});

describe("the cookie", () => {
  it("is scoped to .pqp.gg on the hosted instance and nowhere else", () => {
    expect(hintCookieDomain("pqp.gg")).toBe(".pqp.gg");
    expect(hintCookieDomain("jam.pqp.gg")).toBe(".pqp.gg");
    expect(hintCookieDomain("www.pqp.gg")).toBe(".pqp.gg");
    expect(hintCookieDomain("evilpqp.gg")).toBeNull();
    expect(hintCookieDomain("pqp.gg.example.com")).toBeNull();
    expect(hintCookieDomain("localhost")).toBeNull();
    expect(hintCookieDomain("staging.pqp-3yr.pages.dev")).toBeNull();
  });

  it("is Secure and SameSite=Lax on https, with the thirty days", () => {
    const value = hintCookie("Rafa", "pqp.gg", true);
    expect(value).toContain(`${JAM_SIGNED_IN_COOKIE}=1.Rafa`);
    expect(value).toContain("Domain=.pqp.gg");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Path=/");
    expect(value).toContain(`Max-Age=${JAM_SIGNED_IN_TTL_MS / 1000}`);
    expect(value).not.toMatch(/HttpOnly/i);
  });

  it("is host-only and not Secure on http localhost", () => {
    const value = hintCookie(null, "localhost", false);
    expect(value).not.toContain("Domain=");
    expect(value).not.toContain("Secure");
  });

  it("is removed with the same scope it was written with", () => {
    const value = clearedHintCookie("jam.pqp.gg", true);
    expect(value).toContain("Max-Age=0");
    expect(value).toContain("Domain=.pqp.gg");
    expect(value.startsWith(`${JAM_SIGNED_IN_COOKIE}=;`)).toBe(true);
  });

  it("is found among others, and ignores a lookalike", () => {
    expect(hintFromCookieHeader(`a=1; ${JAM_SIGNED_IN_COOKIE}=1.Ana; b=2`)).toEqual({ name: "Ana" });
    expect(hintFromCookieHeader(`x${JAM_SIGNED_IN_COOKIE}=1; b=2`)).toBeNull();
    expect(hintFromCookieHeader("")).toBeNull();
    expect(hintFromCookieHeader(null)).toBeNull();
  });
});

describe("the stored copy", () => {
  it("expires after thirty days and is not read from the future", () => {
    writeStoredHint(localStorage, "Ana", 1_000);
    expect(readStoredHint(localStorage, 1_000 + JAM_SIGNED_IN_TTL_MS)).toEqual({ name: "Ana" });
    expect(readStoredHint(localStorage, 1_000 + JAM_SIGNED_IN_TTL_MS + 1)).toBeNull();
    expect(readStoredHint(localStorage, 1_000 - 120_000)).toBeNull();
  });

  it("treats a hand-edited record as nobody", () => {
    for (const raw of ["", "nope", "{}", '{"value":1,"at":"x"}', '{"value":"zzz","at":1}', "null"]) {
      localStorage.setItem(JAM_SIGNED_IN_KEY, raw);
      expect(readStoredHint(localStorage)).toBeNull();
    }
    expect(readStoredHint(null)).toBeNull();
  });

  it("tolerates storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredHint(hostile)).toBeNull();
    expect(() => writeStoredHint(hostile, "x")).not.toThrow();
  });
});

describe("the address", () => {
  it("marks a link and unmarks it, keeping the rest", () => {
    expect(withSignedParam("https://jam.pqp.gg/")).toBe("https://jam.pqp.gg/?signed=1");
    expect(withSignedParam("http://localhost:5173/jam?lang=es")).toBe("http://localhost:5173/jam?lang=es&signed=1");
    expect(withSignedParam("https://jam.pqp.gg/m/x#a")).toBe("https://jam.pqp.gg/m/x?signed=1#a");
    expect(withoutSignedParam("https://jam.pqp.gg/m/x?signed=1&ref=clip#a")).toBe("https://jam.pqp.gg/m/x?ref=clip#a");
  });

  it("says only an explicit 1 means signed in", () => {
    expect(signedParamIn("?signed=1")).toBe(true);
    expect(signedParamIn("?signed=0")).toBe(false);
    expect(signedParamIn("?signed=true")).toBe(false);
    expect(signedParamIn("")).toBe(false);
  });
});

describe("in the browser", () => {
  it("is nobody until the app says so, then somebody, then nobody again", () => {
    expect(readSignedIn()).toBeNull();
    rememberSignedIn("Rafael Cammarano");
    expect(readSignedIn()).toEqual({ name: "Rafael" });
    expect(document.cookie).toContain(JAM_SIGNED_IN_COOKIE);
    forgetSignedIn();
    expect(readSignedIn()).toBeNull();
    expect(document.cookie).not.toContain(JAM_SIGNED_IN_COOKIE);
    expect(localStorage.getItem(JAM_SIGNED_IN_KEY)).toBeNull();
  });

  it("keeps a visit's marker in this tab only, and takes it off the address", () => {
    window.history.replaceState(null, "", "/jam/m/abc?signed=1&ref=clip");
    adoptSignedParam();
    expect(window.location.search).toBe("?ref=clip");
    expect(readSignedIn()).toEqual({ name: null });
    expect(localStorage.getItem(JAM_SIGNED_IN_KEY)).toBeNull();
    expect(sessionStorage.getItem(JAM_SIGNED_IN_KEY)).not.toBeNull();
  });

  it("keeps the name the app already left when the marker arrives", () => {
    rememberSignedIn("Ana");
    window.history.replaceState(null, "", "/jam?signed=1");
    adoptSignedParam();
    expect(readSignedIn()).toEqual({ name: "Ana" });
  });

  it("does nothing without the marker", () => {
    window.history.replaceState(null, "", "/jam?ref=x");
    adoptSignedParam();
    expect(readSignedIn()).toBeNull();
    expect(window.location.search).toBe("?ref=x");
  });

  it("forgetting clears the visit's copy too", () => {
    window.history.replaceState(null, "", "/jam?signed=1");
    adoptSignedParam();
    forgetSignedIn();
    expect(readSignedIn()).toBeNull();
  });
});
