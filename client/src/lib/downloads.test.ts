import { describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_PAGE_PATH,
  DOWNLOAD_PAGE_URL,
  detectDownloadPlan,
  detectMacArch,
  detectPlatform,
  fetchLatestAssets,
  isAndroidDevice,
  type NavigatorUAData,
} from "./downloads";

/** Real user agent strings, copied rather than invented. */
const UA = {
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  linuxFirefox:
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ reports a desktop Safari UA. Only maxTouchPoints gives it away.
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  chromeOS:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

function uaData(
  overrides: Partial<NavigatorUAData> & { architecture?: string },
): NavigatorUAData {
  const { architecture, ...rest } = overrides;
  return {
    ...rest,
    getHighEntropyValues:
      architecture === undefined
        ? undefined
        : () => Promise.resolve({ architecture, bitness: "64" }),
  };
}

describe("the public download URL", () => {
  it("is a stable path on pqp.gg, not a versioned GitHub filename", () => {
    expect(DOWNLOAD_PAGE_PATH).toBe("/download");
    expect(DOWNLOAD_PAGE_URL).toBe("https://pqp.gg/download");
  });
});

describe("detectPlatform", () => {
  it("reads a Mac", () => {
    expect(detectPlatform({ userAgent: UA.macSafari })).toBe("mac");
    expect(detectPlatform({ userAgent: UA.macChrome })).toBe("mac");
  });

  it("reads Windows", () => {
    expect(detectPlatform({ userAgent: UA.windows })).toBe("windows");
  });

  it("reads Linux", () => {
    expect(detectPlatform({ userAgent: UA.linux })).toBe("linux");
    expect(detectPlatform({ userAgent: UA.linuxFirefox })).toBe("linux");
  });

  it("reads iOS as mobile, not as a desktop download", () => {
    expect(detectPlatform({ userAgent: UA.iphone })).toBe("mobile");
  });

  it("reads an iPad as mobile even though it claims to be a Macintosh", () => {
    // The whole reason maxTouchPoints is consulted: without it every iPad is
    // offered a .dmg.
    expect(detectPlatform({ userAgent: UA.ipad, maxTouchPoints: 5 })).toBe(
      "mobile",
    );
  });

  it("keeps a real Mac a Mac — no Mac reports touch points", () => {
    expect(detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: 0 })).toBe(
      "mac",
    );
  });

  it("reads Android as mobile before its UA string's 'Linux' can win", () => {
    expect(detectPlatform({ userAgent: UA.android })).toBe("mobile");
  });

  it("trusts userAgentData.mobile over the UA string", () => {
    expect(
      detectPlatform({
        userAgent: UA.android,
        userAgentData: uaData({ platform: "Android", mobile: true }),
      }),
    ).toBe("mobile");
  });

  it("prefers userAgentData.platform to sniffing", () => {
    expect(
      detectPlatform({
        userAgent: "something nobody has ever seen",
        userAgentData: uaData({ platform: "macOS", mobile: false }),
      }),
    ).toBe("mac");
    expect(
      detectPlatform({
        userAgent: "",
        userAgentData: uaData({ platform: "Windows", mobile: false }),
      }),
    ).toBe("windows");
  });

  it("offers a Chromebook nothing — there is no artifact it can install", () => {
    expect(detectPlatform({ userAgent: UA.chromeOS })).toBe("unknown");
    expect(
      detectPlatform({
        userAgent: UA.chromeOS,
        userAgentData: uaData({ platform: "Chrome OS", mobile: false }),
      }),
    ).toBe("unknown");
  });

  it("falls back to unknown rather than guessing", () => {
    expect(detectPlatform({})).toBe("unknown");
    expect(detectPlatform({ userAgent: "curl/8.6.0" })).toBe("unknown");
  });
});

describe("detectMacArch", () => {
  it("reads Apple Silicon from the architecture hint", async () => {
    await expect(
      detectMacArch({
        userAgent: UA.macChrome,
        userAgentData: uaData({ platform: "macOS", architecture: "arm" }),
      }),
    ).resolves.toBe("arm64");
  });

  it("reads Intel from the architecture hint", async () => {
    await expect(
      detectMacArch({
        userAgent: UA.macChrome,
        userAgentData: uaData({ platform: "macOS", architecture: "x86" }),
      }),
    ).resolves.toBe("x64");
  });

  it("says it does not know when the browser has no userAgentData at all", async () => {
    // Safari and Firefox. The UA string says "Intel Mac OS X" on an M3, so
    // there is nothing else to read and guessing would ship the wrong binary.
    await expect(detectMacArch({ userAgent: UA.macSafari })).resolves.toBeNull();
  });

  it("says it does not know when the hint is refused", async () => {
    await expect(
      detectMacArch({
        userAgent: UA.macChrome,
        userAgentData: {
          platform: "macOS",
          getHighEntropyValues: () => Promise.reject(new Error("blocked")),
        },
      }),
    ).resolves.toBeNull();
  });

  it("says it does not know for an architecture it cannot map", async () => {
    await expect(
      detectMacArch({
        userAgent: UA.macChrome,
        userAgentData: uaData({ platform: "macOS", architecture: "sparc" }),
      }),
    ).resolves.toBeNull();
  });
});

describe("detectDownloadPlan", () => {
  it("pairs a Mac with its architecture", async () => {
    await expect(
      detectDownloadPlan({
        userAgent: UA.macChrome,
        userAgentData: uaData({ platform: "macOS", architecture: "arm" }),
      }),
    ).resolves.toEqual({ platform: "mac", macArch: "arm64" });
  });

  it("leaves the architecture open on a Mac that will not say", async () => {
    await expect(
      detectDownloadPlan({ userAgent: UA.macSafari }),
    ).resolves.toEqual({ platform: "mac", macArch: null });
  });

  it("never probes the architecture off a Mac", async () => {
    const probe = vi.fn(() => Promise.resolve({ architecture: "arm" }));
    const plan = await detectDownloadPlan({
      userAgent: UA.windows,
      userAgentData: { platform: "Windows", getHighEntropyValues: probe },
    });
    expect(plan).toEqual({ platform: "windows", macArch: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it("gives a phone no architecture and no desktop artifact", async () => {
    await expect(detectDownloadPlan({ userAgent: UA.android })).resolves.toEqual(
      { platform: "mobile", macArch: null },
    );
    await expect(detectDownloadPlan({ userAgent: UA.iphone })).resolves.toEqual({
      platform: "mobile",
      macArch: null,
    });
  });
});

describe("isAndroidDevice", () => {
  it("reads an Android phone", () => {
    expect(isAndroidDevice({ userAgent: UA.android })).toBe(true);
  });

  it("believes the browser's own answer over the UA string", () => {
    expect(
      isAndroidDevice({ userAgent: "", userAgentData: uaData({ platform: "Android" }) }),
    ).toBe(true);
  });

  // The three that matter, because each of them would be offered a Play tester
  // link they cannot use: the other phone, the desktop, and the Chromebook
  // whose Android runtime does not put the word in a browser UA.
  it("is false on iOS, on the desktop and on ChromeOS", () => {
    expect(isAndroidDevice({ userAgent: UA.iphone })).toBe(false);
    expect(isAndroidDevice({ userAgent: UA.windows })).toBe(false);
    expect(isAndroidDevice({ userAgent: UA.macSafari })).toBe(false);
    expect(isAndroidDevice({ userAgent: UA.chromeOS })).toBe(false);
  });

  // Android's UA also says "Linux", which is what `detectPlatform` has to order
  // around. The reverse must not happen: desktop Linux is not Android.
  it("does not read desktop Linux as Android", () => {
    expect(isAndroidDevice({ userAgent: UA.linux })).toBe(false);
    expect(isAndroidDevice({ userAgent: UA.linuxFirefox })).toBe(false);
  });

  it("is false with no signals at all", () => {
    expect(isAndroidDevice({})).toBe(false);
  });
});

// The names below are the ones a real Electron release produces. Version 0.1.0
// is used here to prove the match survives a version bump, which is the entire
// reason these are patterns and not constants.
const RELEASE_BODY = {
  tag_name: "v0.1.0",
  assets: [
    "pqp-0.1.0-arm64.dmg",
    "pqp-0.1.0-arm64.zip",
    "pqp-0.1.0-arm64.zip.blockmap",
    "pqp-0.1.0-x64.dmg",
    "pqp-0.1.0-x64.zip",
    "pqp-0.1.0-x64.zip.blockmap",
    "pqp-0.1.0-x64.exe",
    "pqp-0.1.0-x64.exe.blockmap",
    "pqp-0.1.0-x64-portable.exe",
    "pqp-0.1.0-x86_64.AppImage",
    "pqp-0.1.0-amd64.deb",
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
  ].map((name) => ({
    name,
    browser_download_url: `https://github.com/rafaelcg/pqp/releases/download/v0.1.0/${name}`,
  })),
};

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("fetchLatestAssets", () => {
  it("picks one file per platform out of the full asset list", async () => {
    const urls = await fetchLatestAssets(() =>
      Promise.resolve(jsonResponse(RELEASE_BODY)),
    );
    expect(urls).toEqual({
      "mac-arm64":
        "https://github.com/rafaelcg/pqp/releases/download/v0.1.0/pqp-0.1.0-arm64.dmg",
      "mac-x64":
        "https://github.com/rafaelcg/pqp/releases/download/v0.1.0/pqp-0.1.0-x64.dmg",
      windows:
        "https://github.com/rafaelcg/pqp/releases/download/v0.1.0/pqp-0.1.0-x64.exe",
      "windows-portable":
        "https://github.com/rafaelcg/pqp/releases/download/v0.1.0/pqp-0.1.0-x64-portable.exe",
      "linux-appimage":
        "https://github.com/rafaelcg/pqp/releases/download/v0.1.0/pqp-0.1.0-x86_64.AppImage",
      "linux-deb":
        "https://github.com/rafaelcg/pqp/releases/download/v0.1.0/pqp-0.1.0-amd64.deb",
    });
  });

  // The two Windows `.exe` files are the only pair of assets whose names can
  // shadow each other, and the failure would be invisible: whichever pattern
  // matched both would hand the same file to the person the fallback exists
  // for. These are the literal names on the v0.1.4 release, sizes 119877744
  // and 119073175, so this is a fact about the release and not about a fixture.
  it("keeps the Windows installer and the portable build apart", async () => {
    const windows = {
      assets: ["pqp-0.1.4-x64.exe", "pqp-0.1.4-x64-portable.exe"].map(
        (name) => ({ name, browser_download_url: `https://example.test/${name}` }),
      ),
    };
    await expect(
      fetchLatestAssets(() => Promise.resolve(jsonResponse(windows))),
    ).resolves.toEqual({
      windows: "https://example.test/pqp-0.1.4-x64.exe",
      "windows-portable": "https://example.test/pqp-0.1.4-x64-portable.exe",
    });
  });

  // Assets arrive in whatever order the GitHub API lists them, and the matcher
  // keeps the first hit per id. Reversing the list would expose a portable
  // pattern loose enough to claim the installer, or the reverse.
  it("keeps them apart whichever order the release lists them in", async () => {
    const reversed = {
      assets: ["pqp-0.1.4-x64-portable.exe", "pqp-0.1.4-x64.exe"].map(
        (name) => ({ name, browser_download_url: `https://example.test/${name}` }),
      ),
    };
    await expect(
      fetchLatestAssets(() => Promise.resolve(jsonResponse(reversed))),
    ).resolves.toEqual({
      windows: "https://example.test/pqp-0.1.4-x64.exe",
      "windows-portable": "https://example.test/pqp-0.1.4-x64-portable.exe",
    });
  });

  it("never mistakes a blockmap or an update feed for a download", async () => {
    const urls = await fetchLatestAssets(() =>
      Promise.resolve(jsonResponse(RELEASE_BODY)),
    );
    for (const url of Object.values(urls)) {
      expect(url).not.toMatch(/blockmap|\.yml$/);
    }
  });

  it("does not hand a Mac zip to someone who asked for the app", async () => {
    // Squirrel.Mac consumes the .zip; a human wants the .dmg.
    const urls = await fetchLatestAssets(() =>
      Promise.resolve(jsonResponse(RELEASE_BODY)),
    );
    expect(urls["mac-arm64"]).toMatch(/\.dmg$/);
    expect(urls["mac-x64"]).toMatch(/\.dmg$/);
  });

  it("keeps working if the version is ever dropped from the filenames", async () => {
    // `artifactName` in electron/package.json could reasonably become
    // `${productName}-${os}-${arch}.${ext}` to make the names stable. Matching
    // on shape rather than on a literal means that change needs no edit here —
    // and it means bumping 0.0.1 → 0.1.0 needed none either.
    const stable = {
      assets: [
        "pqp-mac-arm64.dmg",
        "pqp-mac-x64.dmg",
        "pqp-win-x64.exe",
        "pqp-linux-x86_64.AppImage",
        "pqp-linux-amd64.deb",
      ].map((name) => ({
        name,
        browser_download_url: `https://example.test/${name}`,
      })),
    };
    await expect(
      fetchLatestAssets(() => Promise.resolve(jsonResponse(stable))),
    ).resolves.toEqual({
      "mac-arm64": "https://example.test/pqp-mac-arm64.dmg",
      "mac-x64": "https://example.test/pqp-mac-x64.dmg",
      windows: "https://example.test/pqp-win-x64.exe",
      "linux-appimage": "https://example.test/pqp-linux-x86_64.AppImage",
      "linux-deb": "https://example.test/pqp-linux-amd64.deb",
    });
  });

  it("returns nothing when the API rate-limits, rather than throwing", async () => {
    await expect(
      fetchLatestAssets(() => Promise.resolve(jsonResponse({}, false))),
    ).resolves.toEqual({});
  });

  it("returns nothing when the network is gone", async () => {
    await expect(
      fetchLatestAssets(() => Promise.reject(new Error("offline"))),
    ).resolves.toEqual({});
  });

  it("survives a release with no assets, or junk in the list", async () => {
    await expect(
      fetchLatestAssets(() => Promise.resolve(jsonResponse({ assets: [] }))),
    ).resolves.toEqual({});
    await expect(
      fetchLatestAssets(() =>
        Promise.resolve(jsonResponse({ assets: [null, 7, { name: 12 }] })),
      ),
    ).resolves.toEqual({});
    await expect(
      fetchLatestAssets(() => Promise.resolve(jsonResponse(null))),
    ).resolves.toEqual({});
  });
});
