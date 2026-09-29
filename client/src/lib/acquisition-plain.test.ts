import { beforeEach, describe, expect, it } from "vitest";
import {
  ACQUISITION_DONE_KEY,
  ACQUISITION_KEY,
  SIGNUP_STARTED_KEY,
  SIGNUP_STARTED_TTL_MS,
  acquisitionFromLocation,
  landingForStorage,
  acknowledgeAcquisition,
  markSignupStarted,
  peekAcquisition,
  peekSignupSeconds,
  referrerSource,
  rememberAcquisitionFromLocation,
  takeAcquisition,
  takeSignupSeconds,
} from "./acquisition";

/**
 * The two gaps the 2026-09-29 retention report found: a bare `/c/<slug>` link
 * recorded no acquisition at all (210 of 213 viewers of one watch party), and
 * the time spent inside the Clerk modal was unmeasured. Both stay in the
 * site's own localStorage, hold no identifier, and are consumed once.
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

describe("plain visits (no campaign parameters)", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });
  const T = Date.now();
  const arrival = (referrer: string) => ({ referrer, hostname: "pqp.gg" });

  it("records the landing of a bare /c/<slug> link, which used to leave nothing", () => {
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moonkisticos" },
      T + 1_000,
      arrival(""),
    );
    expect(takeAcquisition(storage, T + 5_000)).toEqual({ landing: "/c/moonkisticos" });
  });

  it("records the referring SITE only: host, never path or query", () => {
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moonkisticos" },
      T + 1_000,
      arrival("https://www.twitch.tv/moonkase/videos/123?secret=1"),
    );
    expect(takeAcquisition(storage, T + 5_000)).toEqual({
      source: "twitch.tv",
      medium: "referral",
      landing: "/c/moonkisticos",
    });
  });

  it("reads an Android Custom Tab's app referrer", () => {
    expect(
      referrerSource("android-app://com.twitch.android.app", "pqp.gg"),
    ).toEqual({
      source: "android-app:com.twitch.android.app",
      medium: "referral",
    });
  });

  it("ignores ourselves, our sign-in, and referrers that are not a site", () => {
    for (const referrer of [
      "",
      "not a url",
      "https://pqp.gg/app",
      "https://staging.pqp.gg/x",
      "https://accounts.clerk.accounts.dev/sign-up",
      "file:///tmp/x",
      "javascript:alert(1)",
    ]) {
      expect(referrerSource(referrer, "pqp.gg")).toBeNull();
    }
  });

  it("does not call another site on the same country suffix ours, but does call a subdomain ours", () => {
    expect(referrerSource("https://example.co.uk/x", "pqp.co.uk")).toEqual({
      source: "example.co.uk",
      medium: "referral",
    });
    expect(referrerSource("https://www.pqp.co.uk/x", "pqp.co.uk")).toBeNull();
    expect(referrerSource("https://app.pqp.co.uk/x", "pqp.co.uk")).toBeNull();
    expect(referrerSource("https://pqp.gg/x", "staging.pqp.gg")).toBeNull();
  });

  it("never stores an invite code or any path below the first segment", () => {
    expect(landingForStorage("/invite/AbC123secret")).toBe("/invite");
    expect(landingForStorage("/app/channels/9f1c")).toBe("/app");
    expect(landingForStorage("/@rafa")).toBe("/@rafa");
    expect(landingForStorage("/c/moon/extra")).toBe("/c/moon");
    expect(landingForStorage("/")).toBe("/");
    expect(
      acquisitionFromLocation("?utm_source=x", "/invite/AbC123secret")?.landing,
    ).toBe("/invite");
  });

  it("without the page-load context (a URL only) records nothing, as before", () => {
    rememberAcquisitionFromLocation(storage, { search: "", pathname: "/c/x" }, 1_000);
    expect(storage.map.has(ACQUISITION_KEY)).toBe(false);
  });

  it("a real campaign replaces a plain visit; a plain visit never replaces anything", () => {
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moon" },
      T + 1_000,
      arrival("https://t.co/x"),
    );
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/" },
      T + 2_000,
      arrival("https://example.org/x"),
    );
    expect(JSON.parse(storage.map.get(ACQUISITION_KEY)!)).toMatchObject({
      source: "t.co",
      landing: "/c/moon",
    });
    rememberAcquisitionFromLocation(
      storage,
      { search: "?utm_source=google&utm_medium=cpc", pathname: "/tela" },
      T + 3_000,
      arrival(""),
    );
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moon" },
      T + 4_000,
      arrival("https://t.co/x"),
    );
    expect(takeAcquisition(storage, T + 5_000)).toEqual({
      source: "google",
      medium: "cpc",
      landing: "/tela",
    });
  });

  it("does not re-stash after a consume, so a returning account costs one request per browser", () => {
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moon" },
      T + 1_000,
      arrival(""),
    );
    expect(takeAcquisition(storage, T + 5_000)).not.toBeNull();
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moon" },
      T + 2_000,
      arrival(""),
    );
    expect(storage.map.has(ACQUISITION_KEY)).toBe(false);
    // A real campaign still records: that is a different question.
    rememberAcquisitionFromLocation(
      storage,
      { search: "?ref=reddit", pathname: "/" },
      T + 3_000,
      arrival(""),
    );
    expect(takeAcquisition(storage, T + 5_000)).toEqual({ ref: "reddit", landing: "/" });
  });

  it("does not hand the internal plain flag to the API", () => {
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moon" },
      T + 1_000,
      arrival(""),
    );
    expect(Object.keys(takeAcquisition(storage, T + 5_000)!)).not.toContain("plain");
  });

  it("does nothing when storage is denied", () => {
    expect(() =>
      rememberAcquisitionFromLocation(
        hostileStorage,
        { search: "", pathname: "/c/x" },
        T + 1_000,
        arrival("https://twitch.tv"),
      ),
    ).not.toThrow();
  });
});

describe("the stash outlives a failed send", () => {
  it("peeking never consumes; only an acknowledgement clears it and sets the marker", () => {
    const storage = memoryStorage();
    const T = Date.now();
    rememberAcquisitionFromLocation(
      storage,
      { search: "", pathname: "/c/moon" },
      T,
      { referrer: "", hostname: "pqp.gg" },
    );
    markSignupStarted(storage, T);
    // A request that fails: nothing is cleared, so the next load sends again.
    expect(peekAcquisition(storage, T + 10_000)).toEqual({ landing: "/c/moon" });
    expect(peekAcquisition(storage, T + 20_000)).toEqual({ landing: "/c/moon" });
    expect(peekSignupSeconds(storage, T + 20_000)).toBe(20);
    expect(storage.map.has(ACQUISITION_DONE_KEY)).toBe(false);
    // A later plain visit is still recorded while nothing was accepted.
    // The server accepted: cleared, and only now is the marker set.
    acknowledgeAcquisition(storage, true);
    expect(storage.map.has(ACQUISITION_KEY)).toBe(false);
    expect(storage.map.has(SIGNUP_STARTED_KEY)).toBe(false);
    expect(storage.map.has(ACQUISITION_DONE_KEY)).toBe(true);
  });

  it("acknowledging with nothing sent tidies up without setting the marker", () => {
    const storage = memoryStorage();
    storage.setItem(ACQUISITION_KEY, "{garbage");
    acknowledgeAcquisition(storage, false);
    expect(storage.map.size).toBe(0);
  });
});

describe("time in sign-up", () => {
  it("a sign-up that took longer than 15 minutes was two visits and is not reported", () => {
    const storage = memoryStorage();
    markSignupStarted(storage, 1_000_000);
    expect(peekSignupSeconds(storage, 1_000_000 + 16 * 60_000)).toBeNull();
    expect(peekSignupSeconds(storage, 1_000_000 + 14 * 60_000)).toBe(840);
  });

  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("turns the modal-open stamp into a duration in 5 s steps, once", () => {
    markSignupStarted(storage, 1_000_000);
    expect(takeSignupSeconds(storage, 1_000_000 + 47_000)).toBe(45);
    expect(takeSignupSeconds(storage, 1_000_000 + 50_000)).toBeNull();
  });

  it("first press wins, so tapping the CTA twice does not restart the clock", () => {
    markSignupStarted(storage, 1_000_000);
    markSignupStarted(storage, 1_020_000);
    expect(takeSignupSeconds(storage, 1_060_000)).toBe(60);
  });

  it("drops an abandoned attempt older than an hour instead of reporting it", () => {
    markSignupStarted(storage, 1_000_000);
    expect(
      takeSignupSeconds(storage, 1_000_000 + SIGNUP_STARTED_TTL_MS + 1),
    ).toBeNull();
    markSignupStarted(storage, 1_000_000);
    markSignupStarted(storage, 1_000_000 + SIGNUP_STARTED_TTL_MS + 5_000);
    expect(
      takeSignupSeconds(storage, 1_000_000 + SIGNUP_STARTED_TTL_MS + 25_000),
    ).toBe(20);
  });

  it("answers null for no stamp, garbage, a stamp from the future, and denied storage", () => {
    expect(takeSignupSeconds(storage, 5)).toBeNull();
    storage.setItem(SIGNUP_STARTED_KEY, "banana");
    expect(takeSignupSeconds(storage, 5)).toBeNull();
    markSignupStarted(storage, 9_000_000);
    expect(takeSignupSeconds(storage, 1_000)).toBeNull();
    expect(() => markSignupStarted(hostileStorage)).not.toThrow();
    expect(takeSignupSeconds(hostileStorage)).toBeNull();
  });

  it("stores only a timestamp, never an id", () => {
    markSignupStarted(storage, 1_000_000);
    expect(storage.map.get(SIGNUP_STARTED_KEY)).toBe("1000000");
  });
});
