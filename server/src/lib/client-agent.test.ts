import { describe, expect, it } from "vitest";
import { applyDeclaredClient, parseClientAgent, sanitizeAppVersion } from "./client-agent.js";

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const EDGE_WIN = `${CHROME_WIN} Edg/130.0.0.0`;
const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const ELECTRON_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) pqp/0.2.7 Chrome/128.0.6613.186 Electron/32.2.0 Safari/537.36";
const ELECTRON_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) pqp/0.2.7 Chrome/128.0.6613.186 Electron/32.2.0 Safari/537.36";

describe("parseClientAgent", () => {
  it("reads browsers as web, with the OS and browser family and no version", () => {
    expect(parseClientAgent(CHROME_WIN)).toEqual({
      platform: "web",
      appVersion: null,
      osFamily: "windows",
      browserFamily: "chrome",
    });
    expect(parseClientAgent(EDGE_WIN).browserFamily).toBe("edge");
    expect(parseClientAgent(FIREFOX_LINUX)).toMatchObject({
      osFamily: "linux",
      browserFamily: "firefox",
    });
    expect(parseClientAgent(SAFARI_MAC)).toMatchObject({
      osFamily: "macos",
      browserFamily: "safari",
    });
    // A phone's browser is web, not the iOS app, and not "macos".
    expect(parseClientAgent(SAFARI_IPHONE)).toMatchObject({
      platform: "web",
      osFamily: "ios",
      browserFamily: "safari",
    });
    expect(parseClientAgent(CHROME_ANDROID)).toMatchObject({
      platform: "web",
      osFamily: "android",
      browserFamily: "chrome",
    });
  });

  it("reads the desktop shell and its own version", () => {
    expect(parseClientAgent(ELECTRON_WIN)).toEqual({
      platform: "desktop",
      appVersion: "0.2.7",
      osFamily: "windows",
      browserFamily: "electron",
    });
    expect(parseClientAgent(ELECTRON_MAC)).toMatchObject({
      platform: "desktop",
      osFamily: "macos",
    });
  });

  it("knows an Android app by OkHttp and does not mistake the library for our version", () => {
    expect(parseClientAgent("okhttp/5.0.0")).toEqual({
      platform: "android",
      appVersion: null,
      osFamily: "android",
      browserFamily: null,
    });
  });

  it("knows the iOS app by URLSession and takes only our own build number", () => {
    expect(parseClientAgent("pqp/412 CFNetwork/1568.200.51 Darwin/24.1.0")).toEqual({
      platform: "ios",
      appVersion: "412",
      osFamily: "ios",
      browserFamily: null,
    });
    // Some other URLSession client is still "ios" but its number is not ours.
    expect(
      parseClientAgent("OtherApp/9 CFNetwork/1568.200.51 Darwin/24.1.0").appVersion,
    ).toBeNull();
  });

  it("records nothing for no agent or one it does not know", () => {
    for (const ua of [undefined, null, "", "curl/8.4.0", "node"]) {
      expect(parseClientAgent(ua).platform).toBe("unknown");
    }
  });

  it("never lets a hostile agent put anything but a plain version into the result", () => {
    const hostile = `Mozilla/5.0 Electron/1 pqp/1.0.0'; DROP TABLE users;-- ${"x".repeat(5000)}`;
    const facts = parseClientAgent(hostile);
    expect(facts.platform).toBe("desktop");
    expect(facts.appVersion).toBe("1.0.0");
    expect(JSON.stringify(facts)).not.toContain("DROP");
  });
});

describe("sanitizeAppVersion", () => {
  it("keeps plain versions and drops everything else", () => {
    expect(sanitizeAppVersion("0.4.25")).toBe("0.4.25");
    expect(sanitizeAppVersion("4718c63")).toBe("4718c63");
    expect(sanitizeAppVersion("1.0 beta")).toBeNull();
    expect(sanitizeAppVersion("a/b")).toBeNull();
    expect(sanitizeAppVersion("x".repeat(40))).toBeNull();
    expect(sanitizeAppVersion(12)).toBeNull();
  });
});

describe("applyDeclaredClient", () => {
  const parsed = parseClientAgent("okhttp/5.0.0");

  it("lets an app fill in the version the user agent cannot carry", () => {
    expect(applyDeclaredClient(parsed, { platform: "android", version: "0.4.25" })).toMatchObject({
      platform: "android",
      appVersion: "0.4.25",
      osFamily: "android",
    });
  });

  it("ignores junk, and a platform outside the enum", () => {
    expect(applyDeclaredClient(parsed, "nope")).toBe(parsed);
    expect(applyDeclaredClient(parsed, null)).toBe(parsed);
    expect(applyDeclaredClient(parsed, { platform: "toaster", version: "a b" })).toBe(parsed);
    expect(applyDeclaredClient(parsed, { platform: "unknown" })).toBe(parsed);
  });
});
