// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIGNUP_ASSIST_OVERRIDE_KEY,
  SIGNUP_CTA_KEY,
  SIGNUP_CTA_TTL_MS,
  noteSignupCta,
  noteSignupReturn,
  secondsBucket,
  shouldResumeSignUp,
  signupAssistEnabled,
  webviewKind,
} from "./signup-assist";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

const IOS_INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22A5297f Instagram 350.0.0";
const IOS_WKWEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36";

afterEach(() => {
  delete (window as { umami?: unknown }).umami;
});

describe("webviewKind", () => {
  it("names the in-app browsers where Google sign-in is refused", () => {
    expect(webviewKind(IOS_INSTAGRAM)).toBe("instagram");
    expect(webviewKind(IOS_WKWEBVIEW)).toBe("ios-webview");
    expect(webviewKind(ANDROID_WEBVIEW)).toBe("android-webview");
    expect(webviewKind("Mozilla/5.0 (Linux; Android 14) FBAN/FB4A;FBAV/450")).toBe("facebook");
  });
  it("leaves real browsers alone, Custom Tabs included", () => {
    expect(webviewKind(IOS_SAFARI)).toBeNull();
    expect(webviewKind(ANDROID_CHROME)).toBeNull();
    expect(webviewKind("")).toBeNull();
  });
});

describe("signupAssistEnabled", () => {
  it("is off unless the build turns it on", () => {
    expect(signupAssistEnabled(undefined, memoryStorage())).toBe(false);
    expect(signupAssistEnabled("", memoryStorage())).toBe(false);
    expect(signupAssistEnabled("true", memoryStorage())).toBe(true);
  });
  it("lets one browser override the build either way", () => {
    const on = memoryStorage({ [SIGNUP_ASSIST_OVERRIDE_KEY]: "on" });
    const off = memoryStorage({ [SIGNUP_ASSIST_OVERRIDE_KEY]: "off" });
    expect(signupAssistEnabled(undefined, on)).toBe(true);
    expect(signupAssistEnabled("true", off)).toBe(false);
  });
  it("survives a storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(signupAssistEnabled("true", hostile)).toBe(true);
    expect(signupAssistEnabled(undefined, null)).toBe(false);
  });
});

describe("the CTA to return timing", () => {
  it("counts the tap and the return with the seconds between them", () => {
    const umami = { track: vi.fn() };
    (window as { umami?: unknown }).umami = umami;
    const storage = memoryStorage();
    noteSignupCta("community", "moon", storage, 1_000, IOS_INSTAGRAM);
    expect(umami.track).toHaveBeenCalledWith("signup_cta_click", {
      surface: "community",
      webview: "instagram",
    });
    noteSignupReturn(storage, 1_000 + 47_000, IOS_INSTAGRAM, 20_000);
    expect(umami.track).toHaveBeenLastCalledWith("signup_return", {
      surface: "community",
      seconds: 47,
      bucket: "30-60s",
      webview: "instagram",
    });
    expect(storage.map.has(SIGNUP_CTA_KEY)).toBe(false);
  });

  it("counts a return once, and not at all for a stale or foreign record", () => {
    const umami = { track: vi.fn() };
    (window as { umami?: unknown }).umami = umami;
    const storage = memoryStorage();
    noteSignupCta("community", "moon", storage, 0, ANDROID_CHROME);
    noteSignupReturn(storage, 5_000, ANDROID_CHROME, 1_000);
    noteSignupReturn(storage, 6_000, ANDROID_CHROME, 1_000);
    expect(umami.track.mock.calls.filter(([n]) => n === "signup_return")).toHaveLength(1);

    umami.track.mockClear();
    noteSignupCta("community", "moon", storage, 0, ANDROID_CHROME);
    umami.track.mockClear();
    noteSignupReturn(storage, SIGNUP_CTA_TTL_MS + 1, ANDROID_CHROME, SIGNUP_CTA_TTL_MS);
    noteSignupReturn(memoryStorage({ [SIGNUP_CTA_KEY]: "not json" }), 1, "", 1);
    expect(umami.track).not.toHaveBeenCalled();
  });

  it("does not count an existing account that signed in after an abandoned tap", () => {
    const umami = { track: vi.fn() };
    (window as { umami?: unknown }).umami = umami;
    const storage = memoryStorage();
    noteSignupCta("community", "moon", storage, 1_000_000, ANDROID_CHROME);
    umami.track.mockClear();
    noteSignupReturn(storage, 1_050_000, ANDROID_CHROME, 1_000_000 - 86_400_000);
    expect(umami.track).not.toHaveBeenCalled();
    expect(storage.map.has(SIGNUP_CTA_KEY)).toBe(false);
  });

  it("does not count when Clerk cannot say when the account was created", () => {
    const umami = { track: vi.fn() };
    (window as { umami?: unknown }).umami = umami;
    const storage = memoryStorage();
    noteSignupCta("community", "moon", storage, 1_000, ANDROID_CHROME);
    umami.track.mockClear();
    noteSignupReturn(storage, 9_000, ANDROID_CHROME, null);
    expect(umami.track).not.toHaveBeenCalled();
  });

  it("counts once when two tabs boot on the same record", () => {
    const umami = { track: vi.fn() };
    (window as { umami?: unknown }).umami = umami;
    const storage = memoryStorage();
    noteSignupCta("community", "moon", storage, 1_000, ANDROID_CHROME);
    umami.track.mockClear();
    // Both tabs read the record before either removes it.
    const snapshot = storage.getItem(SIGNUP_CTA_KEY)!;
    noteSignupReturn(storage, 9_000, ANDROID_CHROME, 2_000);
    storage.setItem(SIGNUP_CTA_KEY, snapshot);
    noteSignupReturn(storage, 9_001, ANDROID_CHROME, 2_000);
    expect(umami.track.mock.calls.filter(([n]) => n === "signup_return")).toHaveLength(1);
  });

  it("does not throw when storage is denied", () => {
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
    expect(() => noteSignupCta("community", "moon", hostile, 0, "")).not.toThrow();
    expect(() => noteSignupReturn(hostile, 1, "", 1)).not.toThrow();
  });

  it("buckets", () => {
    expect([5, 20, 45, 90, 200, 900].map(secondsBucket)).toEqual([
      "<15s",
      "15-30s",
      "30-60s",
      "1-2m",
      "2-5m",
      "5m+",
    ]);
  });
});

describe("shouldResumeSignUp", () => {
  const waiting = { status: "missing_requirements", unverifiedFields: ["email_address"] };
  const tapped = () => {
    const storage = memoryStorage();
    noteSignupCta("community", "moon", storage, 1_000, "");
    return storage;
  };

  it("reopens the code step when this browser started it and the flag is on", () => {
    expect(
      shouldResumeSignUp({ enabled: true, surface: "community", target: "moon", signUp: waiting, storage: tapped(), now: 2_000 }),
    ).toBe(true);
  });
  it("does nothing with the flag off", () => {
    expect(
      shouldResumeSignUp({ enabled: false, surface: "community", target: "moon", signUp: waiting, storage: tapped(), now: 2_000 }),
    ).toBe(false);
  });
  it("does nothing without a tap from this browser, or from another surface, or an hour late", () => {
    const base = { enabled: true, surface: "community", target: "moon", signUp: waiting, now: 2_000 } as const;
    expect(shouldResumeSignUp({ ...base, storage: memoryStorage() })).toBe(false);
    expect(shouldResumeSignUp({ ...base, surface: "profile", storage: tapped() })).toBe(false);
    expect(shouldResumeSignUp({ ...base, target: "other", storage: tapped() })).toBe(false);
    expect(shouldResumeSignUp({ ...base, storage: tapped(), now: 1_000 + SIGNUP_CTA_TTL_MS + 1 })).toBe(false);
  });
  it("does nothing unless Clerk is waiting on a code", () => {
    const base = { enabled: true, surface: "community", target: "moon", storage: tapped(), now: 2_000 } as const;
    expect(shouldResumeSignUp({ ...base, signUp: null })).toBe(false);
    expect(shouldResumeSignUp({ ...base, signUp: { status: "complete" } })).toBe(false);
    expect(
      shouldResumeSignUp({ ...base, signUp: { status: "missing_requirements", unverifiedFields: [] } }),
    ).toBe(false);
  });
});
