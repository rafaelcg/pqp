import { describe, expect, it } from "vitest";
import { shouldRunReveals } from "./use-scroll-reveal";

const CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

describe("shouldRunReveals", () => {
  it("runs for an ordinary browser that allows motion", () => {
    expect(
      shouldRunReveals({
        userAgent: CHROME,
        reducedMotion: false,
        hasObserver: true,
      }),
    ).toBe(true);
  });

  it("never runs when the reader asked for less motion", () => {
    expect(
      shouldRunReveals({
        userAgent: CHROME,
        reducedMotion: true,
        hasObserver: true,
      }),
    ).toBe(false);
  });

  it("never runs without IntersectionObserver, so nothing waits forever", () => {
    expect(
      shouldRunReveals({
        userAgent: CHROME,
        reducedMotion: false,
        hasObserver: false,
      }),
    ).toBe(false);
  });

  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Twitterbot/1.0",
    "facebookexternalhit/1.1",
    "WhatsApp/2.23.20.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0 Safari/537.36",
  ])("skips crawlers and preview renderers: %s", (userAgent) => {
    expect(
      shouldRunReveals({ userAgent, reducedMotion: false, hasObserver: true }),
    ).toBe(false);
  });
});
