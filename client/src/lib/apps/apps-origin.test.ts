import { describe, expect, it } from "vitest";
import { isOnAppsOrigin, parseAppsOrigin } from "./apps-origin";
import { TokenBucket } from "./limiter";

describe("parseAppsOrigin", () => {
  it("accepts an https origin and http on localhost, and keeps only the origin", () => {
    expect(parseAppsOrigin("https://pqp-apps.pages.dev")).toBe("https://pqp-apps.pages.dev");
    expect(parseAppsOrigin("https://pqp-apps.pages.dev/some/path?x=1")).toBe("https://pqp-apps.pages.dev");
    expect(parseAppsOrigin("http://localhost:5175")).toBe("http://localhost:5175");
    expect(parseAppsOrigin("http://127.0.0.1:5175")).toBe("http://127.0.0.1:5175");
  });

  it("refuses null, junk, plain http elsewhere and other schemes", () => {
    for (const bad of [null, undefined, "", "nonsense", "http://pqp-apps.pages.dev", "javascript:alert(1)", "data:text/html,x", "ftp://x.test"]) {
      expect(parseAppsOrigin(bad), String(bad)).toBeNull();
    }
  });
});

describe("isOnAppsOrigin", () => {
  it("is true only for the exact origin", () => {
    const origin = "https://pqp-apps.pages.dev";
    expect(isOnAppsOrigin("https://pqp-apps.pages.dev/pqp-eco/1.0.0/index.html", origin)).toBe(true);
    expect(isOnAppsOrigin("https://pqp-apps.pages.dev.evil.example/x", origin)).toBe(false);
    expect(isOnAppsOrigin("https://evil.example/https://pqp-apps.pages.dev/", origin)).toBe(false);
    expect(isOnAppsOrigin("http://pqp-apps.pages.dev/x", origin)).toBe(false);
    expect(isOnAppsOrigin("not a url", origin)).toBe(false);
  });
});

describe("TokenBucket", () => {
  it("holds the burst, refills at the rate and never above the burst", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 3, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    now += 500; // one token
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
    now += 60_000; // far more than the burst
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
  });
});
