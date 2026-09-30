import { describe, expect, it } from "vitest";
import {
  PLAY_STORE_LISTING_URL,
  playStoreUrlFrom,
  playStoreUrlWithLocale,
} from "./play-store";

describe("playStoreUrlFrom", () => {
  it("falls back to our Play listing when unset, same shape as the APK URL", () => {
    expect(playStoreUrlFrom(undefined)).toBe(PLAY_STORE_LISTING_URL);
    expect(playStoreUrlFrom("")).toBe(PLAY_STORE_LISTING_URL);
    expect(PLAY_STORE_LISTING_URL).toContain("id=gg.pqp.app");
  });

  it("honours a set override URL", () => {
    expect(playStoreUrlFrom("https://play.google.com/store/apps/details?id=gg.other")).toBe(
      "https://play.google.com/store/apps/details?id=gg.other",
    );
  });

  it("trims an override", () => {
    expect(
      playStoreUrlFrom("  https://play.google.com/store/apps/details?id=gg.other  "),
    ).toBe("https://play.google.com/store/apps/details?id=gg.other");
  });

  it("hides the badge when the env is a single space", () => {
    expect(playStoreUrlFrom(" ")).toBeNull();
  });

  it("falls back for a non-string value", () => {
    expect(playStoreUrlFrom(42)).toBe(PLAY_STORE_LISTING_URL);
  });
});

describe("playStoreUrlWithLocale", () => {
  it("adds hl for a known locale", () => {
    expect(playStoreUrlWithLocale(PLAY_STORE_LISTING_URL, "en")).toBe(
      `${PLAY_STORE_LISTING_URL}&hl=en`,
    );
    expect(playStoreUrlWithLocale(PLAY_STORE_LISTING_URL, "pt-BR")).toBe(
      `${PLAY_STORE_LISTING_URL}&hl=pt-BR`,
    );
  });

  it("uses es-419 for our one Spanish catalogue, matching lib/locale.ts", () => {
    expect(playStoreUrlWithLocale(PLAY_STORE_LISTING_URL, "es")).toBe(
      `${PLAY_STORE_LISTING_URL}&hl=es-419`,
    );
  });

  it("replaces an hl the override URL already carries", () => {
    expect(
      playStoreUrlWithLocale("https://play.google.com/store/apps/details?id=x&hl=fr", "en"),
    ).toBe("https://play.google.com/store/apps/details?id=x&hl=en");
  });

  it("returns the url unchanged for an unknown locale", () => {
    expect(playStoreUrlWithLocale(PLAY_STORE_LISTING_URL, "fr")).toBe(PLAY_STORE_LISTING_URL);
  });

  it("returns the url unchanged if it cannot be parsed", () => {
    expect(playStoreUrlWithLocale("not a url", "en")).toBe("not a url");
  });
});
