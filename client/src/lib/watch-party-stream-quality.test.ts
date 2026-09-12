import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCH_PARTY_MAX_PUBLISH_HEIGHT } from "./video-quality";
import {
  DEFAULT_WATCH_PARTY_STREAM_QUALITY,
  parseWatchPartyStreamQuality,
  readWatchPartyStreamQuality,
  watchPartyPublishCeilingHeight,
  writeWatchPartyStreamQuality,
} from "./watch-party-stream-quality";

/** A Map-backed localStorage; the suite runs in `node` with no DOM. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } satisfies Storage;
}

describe("watch-party stream quality", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: fakeStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults to 720p, the safe choice a host gets for doing nothing", () => {
    expect(DEFAULT_WATCH_PARTY_STREAM_QUALITY).toBe("720p");
    expect(WATCH_PARTY_MAX_PUBLISH_HEIGHT).toBe(720);
  });

  it("maps each choice to its publish ceiling in picture lines", () => {
    expect(watchPartyPublishCeilingHeight("720p")).toBe(720);
    expect(watchPartyPublishCeilingHeight("1080p")).toBe(1080);
  });

  it("parses a stored value and falls back to the default on junk", () => {
    expect(parseWatchPartyStreamQuality("720p")).toBe("720p");
    expect(parseWatchPartyStreamQuality("1080p")).toBe("1080p");
    for (const junk of ["4k", "", null, undefined, 720, {}]) {
      expect(parseWatchPartyStreamQuality(junk)).toBe(
        DEFAULT_WATCH_PARTY_STREAM_QUALITY,
      );
    }
  });

  it("persists a choice and reads it back, the shape use-voice reads at share start", () => {
    expect(readWatchPartyStreamQuality()).toBe("720p");
    writeWatchPartyStreamQuality("1080p");
    expect(readWatchPartyStreamQuality()).toBe("1080p");
    writeWatchPartyStreamQuality("720p");
    expect(readWatchPartyStreamQuality()).toBe("720p");
  });

  it("reads the safe default when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readWatchPartyStreamQuality()).toBe("720p");
  });
});
