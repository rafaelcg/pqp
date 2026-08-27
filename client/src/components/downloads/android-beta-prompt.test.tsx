import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidBetaPrompt } from "./android-beta-prompt";
import { ANDROID_BETA_PROMPT_STORAGE_KEY } from "@/lib/android-beta";

const GROUP = "https://groups.google.com/g/example-testers";
const OPT_IN = "https://play.google.com/apps/testing/gg.pqp.app";

const UA = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
};

/**
 * Enough of a browser for the three things the gate reads: the UA, the session
 * store, and the two build-time links.
 */
function browser({
  userAgent,
  seen = false,
  links = true,
}: {
  userAgent: string;
  seen?: boolean;
  links?: boolean;
}) {
  const store = new Map<string, string>(
    seen ? [[ANDROID_BETA_PROMPT_STORAGE_KEY, "1"]] : [],
  );
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  });
  vi.stubGlobal("navigator", { userAgent });
  vi.stubEnv("VITE_ANDROID_BETA_GROUP_URL", links ? GROUP : "");
  vi.stubEnv("VITE_ANDROID_BETA_URL", links ? OPT_IN : "");
  return renderToStaticMarkup(<AndroidBetaPrompt />);
}

describe("AndroidBetaPrompt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a desktop visitor to the landing page rather than to Google", () => {
    const html = browser({ userAgent: UA.windows });
    expect(html).toContain("Got an Android phone?");
    expect(html).toContain('href="/android"');
    // The two steps are the page's job. A card that linked straight at the
    // opt-in URL would skip the one that has to happen first.
    expect(html).not.toContain(OPT_IN);
    expect(html).not.toContain(GROUP);
  });

  it("tells an Android visitor they are already on the right phone", () => {
    const html = browser({ userAgent: UA.android });
    expect(html).toContain("You are on the right phone");
    expect(html).toContain('href="/android"');
  });

  // The one device that can never run this build.
  it("renders nothing on iOS", () => {
    expect(browser({ userAgent: UA.iphone })).toBe("");
  });

  // The safe empty state of the second surface: no links, no popup at all.
  it("renders nothing when the build has no beta links", () => {
    expect(browser({ userAgent: UA.windows, links: false })).toBe("");
  });

  it("renders nothing when this session has already seen it", () => {
    expect(browser({ userAgent: UA.windows, seen: true })).toBe("");
  });
});
