import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversionSendTo,
  isNewAccount,
  NEW_ACCOUNT_WINDOW_MS,
  reportSignupConversion,
  shouldReportSignup,
  SIGNUP_REPORTED_KEY,
} from "./google-ads";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const SEND_TO = "AW-123456789/AbCdEf";
const JUST_NOW = new Date(NOW - 5_000);

/** A localStorage stand-in that can be told to refuse, like Safari private. */
function fakeStorage(initial: Record<string, string> = {}, deny = false) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => {
      if (deny) {
        throw new Error("denied");
      }
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (deny) {
        throw new Error("denied");
      }
      map.set(key, value);
    },
  };
}

describe("conversionSendTo", () => {
  it("needs both halves", () => {
    expect(conversionSendTo("AW-1", "label")).toBe("AW-1/label");
    expect(conversionSendTo("AW-1", undefined)).toBeNull();
    expect(conversionSendTo(undefined, "label")).toBeNull();
    expect(conversionSendTo("  ", "label")).toBeNull();
    expect(conversionSendTo("AW-1", "   ")).toBeNull();
  });

  it("trims, so a trailing newline in a CI secret is not part of the id", () => {
    expect(conversionSendTo(" AW-1\n", " label ")).toBe("AW-1/label");
  });
});

describe("isNewAccount", () => {
  it("says yes inside the window and no outside it", () => {
    expect(isNewAccount(JUST_NOW, NOW)).toBe(true);
    expect(isNewAccount(new Date(NOW - NEW_ACCOUNT_WINDOW_MS + 1), NOW)).toBe(
      true,
    );
    expect(isNewAccount(new Date(NOW - NEW_ACCOUNT_WINDOW_MS - 1), NOW)).toBe(
      false,
    );
  });

  it("says no for the account somebody made last year", () => {
    expect(isNewAccount(new Date(NOW - 365 * 24 * 60 * 60 * 1000), NOW)).toBe(
      false,
    );
  });

  it("says no when there is no date and when the clock is ahead", () => {
    expect(isNewAccount(null, NOW)).toBe(false);
    expect(isNewAccount(undefined, NOW)).toBe(false);
    expect(isNewAccount(new Date(Number.NaN), NOW)).toBe(false);
    expect(isNewAccount(new Date(NOW + 60_000), NOW)).toBe(false);
  });
});

describe("shouldReportSignup", () => {
  const base = {
    accountCreatedAt: JUST_NOW,
    userId: "user_new",
    lastReportedUserId: null,
    now: NOW,
  };

  it("reports a brand-new account this browser has not reported", () => {
    expect(shouldReportSignup(base)).toBe(true);
  });

  it("never reports the same account twice", () => {
    expect(
      shouldReportSignup({ ...base, lastReportedUserId: "user_new" }),
    ).toBe(false);
  });

  it("still reports a second brand-new account on the same browser", () => {
    expect(
      shouldReportSignup({ ...base, lastReportedUserId: "user_older" }),
    ).toBe(true);
  });

  it("does not report a returning member on a cleared browser", () => {
    expect(
      shouldReportSignup({
        ...base,
        accountCreatedAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000),
        lastReportedUserId: null,
      }),
    ).toBe(false);
  });

  it("does not report without an account id", () => {
    expect(shouldReportSignup({ ...base, userId: null })).toBe(false);
  });
});

describe("reportSignupConversion", () => {
  const makeGtag = () => vi.fn((..._args: unknown[]) => {});
  let gtag: ReturnType<typeof makeGtag>;

  beforeEach(() => {
    gtag = makeGtag();
  });

  function report(overrides: Record<string, unknown> = {}) {
    return reportSignupConversion({
      accountCreatedAt: JUST_NOW,
      userId: "user_new",
      storage: fakeStorage(),
      gtag,
      sendTo: SEND_TO,
      now: NOW,
      ...overrides,
    });
  }

  it("sends one conversion for a fresh account", () => {
    expect(report()).toBe(true);
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: SEND_TO,
    });
  });

  it("records the account before sending, so a repeat is impossible", () => {
    const storage = fakeStorage();
    expect(report({ storage })).toBe(true);
    expect(storage.map.get(SIGNUP_REPORTED_KEY)).toBe("user_new");
    expect(report({ storage })).toBe(false);
    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it("sends nothing on a build with no tag", () => {
    expect(report({ sendTo: null })).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
  });

  it("sends nothing when the tag was blocked and gtag never appeared", () => {
    expect(report({ gtag: undefined })).toBe(false);
  });

  it("sends nothing rather than send unguarded when storage is refused", () => {
    expect(report({ storage: fakeStorage({}, true) })).toBe(false);
    expect(report({ storage: null })).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
  });

  it("sends nothing for a returning member", () => {
    expect(report({ accountCreatedAt: new Date(NOW - 86_400_000) })).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
  });
});
