import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_HINT_STORAGE_KEY,
  dismissDownloadHint,
  isDownloadHintDismissed,
} from "./download-hint";

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

describe("isDownloadHintDismissed", () => {
  it("is false with nothing stored", () => {
    expect(isDownloadHintDismissed(fakeStorage())).toBe(false);
  });

  it("is false with no storage at all", () => {
    expect(isDownloadHintDismissed(null)).toBe(false);
  });

  it("is true once the dismiss is recorded", () => {
    expect(
      isDownloadHintDismissed(
        fakeStorage({ [DOWNLOAD_HINT_STORAGE_KEY]: "1" }),
      ),
    ).toBe(true);
  });

  it("ignores any other stored value", () => {
    expect(
      isDownloadHintDismissed(
        fakeStorage({ [DOWNLOAD_HINT_STORAGE_KEY]: "true" }),
      ),
    ).toBe(false);
  });

  it("does not throw when the store refuses the read", () => {
    expect(isDownloadHintDismissed(hostileStorage())).toBe(false);
  });
});

describe("dismissDownloadHint", () => {
  it("records the dismiss so the next read hides the strip", () => {
    const storage = fakeStorage();
    dismissDownloadHint(storage);
    expect(isDownloadHintDismissed(storage)).toBe(true);
  });

  it("does not throw when the store refuses the write", () => {
    expect(() => dismissDownloadHint(hostileStorage())).not.toThrow();
    expect(() => dismissDownloadHint(null)).not.toThrow();
  });
});
