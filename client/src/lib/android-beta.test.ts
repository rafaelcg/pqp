import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANDROID_BETA_PROMPT_STORAGE_KEY,
  androidBetaLinks,
  isAndroidBetaPromptSeen,
  rememberAndroidBetaPrompt,
} from "./android-beta";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function hostileStorage() {
  return {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

const GROUP = "https://groups.google.com/g/example-testers";
const OPT_IN = "https://play.google.com/apps/testing/gg.pqp.app";

describe("androidBetaLinks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers both links when the build has both", () => {
    vi.stubEnv("VITE_ANDROID_BETA_GROUP_URL", GROUP);
    vi.stubEnv("VITE_ANDROID_BETA_URL", OPT_IN);
    expect(androidBetaLinks()).toEqual({ groupUrl: GROUP, optInUrl: OPT_IN });
  });

  // Half a flow is worse than none: the opt-in link on its own sends people to
  // a Google page that silently does nothing, because nothing put them on the
  // tester list first.
  it("answers null when only the opt-in link is set", () => {
    vi.stubEnv("VITE_ANDROID_BETA_GROUP_URL", "");
    vi.stubEnv("VITE_ANDROID_BETA_URL", OPT_IN);
    expect(androidBetaLinks()).toBeNull();
  });

  it("answers null when only the group link is set", () => {
    vi.stubEnv("VITE_ANDROID_BETA_GROUP_URL", GROUP);
    vi.stubEnv("VITE_ANDROID_BETA_URL", "");
    expect(androidBetaLinks()).toBeNull();
  });

  it("answers null when neither is set", () => {
    vi.stubEnv("VITE_ANDROID_BETA_GROUP_URL", "");
    vi.stubEnv("VITE_ANDROID_BETA_URL", "");
    expect(androidBetaLinks()).toBeNull();
  });

  // A single space is how the pair is blanked from CI without a code change,
  // and a value out of a secret store can arrive with a newline on it.
  it("treats a whitespace-only value as unset", () => {
    vi.stubEnv("VITE_ANDROID_BETA_GROUP_URL", " ");
    vi.stubEnv("VITE_ANDROID_BETA_URL", OPT_IN);
    expect(androidBetaLinks()).toBeNull();
  });

  it("trims a value that arrived with a newline", () => {
    vi.stubEnv("VITE_ANDROID_BETA_GROUP_URL", `${GROUP}\n`);
    vi.stubEnv("VITE_ANDROID_BETA_URL", `  ${OPT_IN}`);
    expect(androidBetaLinks()).toEqual({ groupUrl: GROUP, optInUrl: OPT_IN });
  });
});

describe("isAndroidBetaPromptSeen", () => {
  it("is false on a fresh session, which is the only time it shows", () => {
    expect(isAndroidBetaPromptSeen(fakeStorage())).toBe(false);
  });

  it("is true once the impression is recorded", () => {
    const storage = fakeStorage();
    rememberAndroidBetaPrompt(storage);
    expect(isAndroidBetaPromptSeen(storage)).toBe(true);
  });

  it("reads the key the write wrote", () => {
    const storage = fakeStorage();
    rememberAndroidBetaPrompt(storage);
    expect(storage.getItem(ANDROID_BETA_PROMPT_STORAGE_KEY)).toBe("1");
  });

  it("ignores a value that is not the flag", () => {
    expect(
      isAndroidBetaPromptSeen(
        fakeStorage({ [ANDROID_BETA_PROMPT_STORAGE_KEY]: "0" }),
      ),
    ).toBe(false);
  });

  // The opposite default from `isDownloadHintDismissed`, and deliberately so:
  // a popup we cannot remember showing must not show, or private mode turns it
  // into an ad on every navigation.
  it("says seen when there is no storage at all", () => {
    expect(isAndroidBetaPromptSeen(null)).toBe(true);
  });

  it("says seen when storage throws", () => {
    expect(isAndroidBetaPromptSeen(hostileStorage())).toBe(true);
  });
});

describe("rememberAndroidBetaPrompt", () => {
  it("survives a store that refuses the write", () => {
    expect(() => rememberAndroidBetaPrompt(hostileStorage())).not.toThrow();
    expect(() => rememberAndroidBetaPrompt(null)).not.toThrow();
  });
});
