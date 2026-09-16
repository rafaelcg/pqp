import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectVideos,
  innertubeRelated,
  INNERTUBE_RELATED_LIMIT,
  parseDurationLabel,
  resetInnerTubeRelatedCache,
} from "./innertube.js";

describe("parseDurationLabel", () => {
  it("reads clock labels and refuses the rest", () => {
    expect(parseDurationLabel("3:55")).toBe(235_000);
    expect(parseDurationLabel("1:02:03")).toBe(3_723_000);
    expect(parseDurationLabel("AO VIVO")).toBeNull();
    expect(parseDurationLabel(undefined)).toBeNull();
  });
});

describe("collectVideos", () => {
  it("finds WEB videoRenderers wherever they sit, once each, in order", () => {
    const response = {
      contents: {
        anything: [
          {
            itemSectionRenderer: {
              contents: [
                {
                  videoRenderer: {
                    videoId: "tI9kSZgMLsc",
                    title: { runs: [{ text: "Legião Urbana - " }, { text: "Tempo Perdido" }] },
                    lengthText: { simpleText: "3:55" },
                    thumbnail: { thumbnails: [{ url: "a" }, { url: "https://i.ytimg.com/x.jpg" }] },
                  },
                },
                { videoRenderer: { videoId: "tI9kSZgMLsc", title: { simpleText: "dup" } } },
                { adSlotRenderer: { videoRenderer: { videoId: "short", title: { simpleText: "bad id" } } } },
                { compactVideoRenderer: { videoId: "dQw4w9WgXcQ", title: { simpleText: "Rick" } } },
              ],
            },
          },
        ],
      },
    };
    expect(collectVideos(response)).toEqual([
      {
        videoId: "tI9kSZgMLsc",
        title: "Legião Urbana - Tempo Perdido",
        durationMs: 235_000,
        thumbnailUrl: "https://i.ytimg.com/x.jpg",
      },
      {
        videoId: "dQw4w9WgXcQ",
        title: "Rick",
        durationMs: null,
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      },
    ]);
  });

  it("reads TVHTML5 and playlist lockups, with the badge as the duration", () => {
    const response = {
      items: [
        {
          lockupViewModel: {
            contentId: "fOT0BUpITw8",
            contentImage: {
              thumbnailViewModel: {
                overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: "4:01" } }] } }],
              },
            },
            metadata: { lockupMetadataViewModel: { title: { content: "Arcángel - FN8" } } },
          },
        },
      ],
    };
    expect(collectVideos(response, 5)).toEqual([
      {
        videoId: "fOT0BUpITw8",
        title: "Arcángel - FN8",
        durationMs: 241_000,
        thumbnailUrl: "https://i.ytimg.com/vi/fOT0BUpITw8/hqdefault.jpg",
      },
    ]);
    expect(collectVideos(response, 0)).toEqual([]);
  });

  it("reads endScreenVideoRenderer the same way as compactVideoRenderer", () => {
    const response = {
      overlay: {
        endScreenVideoRenderer: {
          videoId: "endScreen01",
          title: { simpleText: "Related end screen" },
          lengthText: { simpleText: "3:21" },
        },
      },
    };
    expect(collectVideos(response)).toEqual([
      {
        videoId: "endScreen01",
        title: "Related end screen",
        durationMs: 201_000,
        thumbnailUrl: "https://i.ytimg.com/vi/endScreen01/hqdefault.jpg",
      },
    ]);
  });
});

describe("innertubeRelated", () => {
  afterEach(() => {
    resetInnerTubeRelatedCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const compactNext = {
    contents: {
      compactVideoRenderer: {
        videoId: "dQw4w9WgXcQ",
        title: { simpleText: "Seed" },
      },
      more: {
        compactVideoRenderer: {
          videoId: "relWeb00001",
          title: { simpleText: "Related WEB" },
          lengthText: { simpleText: "3:21" },
        },
      },
    },
  };

  const lockupNext = {
    items: [
      {
        lockupViewModel: {
          contentId: "dQw4w9WgXcQ",
          metadata: { lockupMetadataViewModel: { title: { content: "Seed" } } },
        },
      },
      {
        lockupViewModel: {
          contentId: "relLock0001",
          contentImage: {
            thumbnailViewModel: {
              overlays: [
                {
                  thumbnailOverlayBadgeViewModel: {
                    thumbnailBadges: [{ thumbnailBadgeViewModel: { text: "4:01" } }],
                  },
                },
              ],
            },
          },
          metadata: { lockupMetadataViewModel: { title: { content: "Related TV" } } },
        },
      },
    ],
  };

  function mockNext(body: unknown) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("youtubei/v1/next")) {
        throw new Error(`unexpected fetch ${url}`);
      }
      return { ok: true, status: 200, json: async () => body };
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      fetchMock as unknown as typeof fetch,
    );
    return fetchMock;
  }

  it("reads compactVideoRenderer watch-next and drops the seed id", async () => {
    mockNext(compactNext);
    await expect(innertubeRelated("dQw4w9WgXcQ", 5)).resolves.toEqual([
      {
        videoId: "relWeb00001",
        title: "Related WEB",
        durationMs: 201_000,
        thumbnailUrl: "https://i.ytimg.com/vi/relWeb00001/hqdefault.jpg",
      },
    ]);
  });

  it("reads lockupViewModel watch-next and drops the seed id", async () => {
    mockNext(lockupNext);
    await expect(innertubeRelated("dQw4w9WgXcQ", 5)).resolves.toEqual([
      {
        videoId: "relLock0001",
        title: "Related TV",
        durationMs: 241_000,
        thumbnailUrl: "https://i.ytimg.com/vi/relLock0001/hqdefault.jpg",
      },
    ]);
  });

  it("keeps twenty watch-next hits by default", async () => {
    const extra = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `r${i}`,
        {
          compactVideoRenderer: {
            videoId: `relWeb${String(i).padStart(5, "0")}`,
            title: { simpleText: `Related ${i}` },
            lengthText: { simpleText: "3:00" },
          },
        },
      ]),
    );
    mockNext({
      contents: {
        seed: {
          compactVideoRenderer: {
            videoId: "dQw4w9WgXcQ",
            title: { simpleText: "Seed" },
          },
        },
        ...extra,
      },
    });
    const videos = await innertubeRelated("dQw4w9WgXcQ");
    expect(videos).toHaveLength(INNERTUBE_RELATED_LIMIT);
    expect(videos?.[0]?.videoId).toBe("relWeb00000");
    expect(videos?.[19]?.videoId).toBe("relWeb00019");
  });

  it("serves a later call from the six-hour cache", async () => {
    const fetchMock = mockNext(compactNext);
    await innertubeRelated("dQw4w9WgXcQ", 5);
    await innertubeRelated("dQw4w9WgXcQ", 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent related fetches and keeps the full cap for a later caller", async () => {
    const extra = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `r${i}`,
        {
          compactVideoRenderer: {
            videoId: `relWeb${String(i).padStart(5, "0")}`,
            title: { simpleText: `Related ${i}` },
            lengthText: { simpleText: "3:00" },
          },
        },
      ]),
    );
    const body = {
      contents: {
        seed: {
          compactVideoRenderer: {
            videoId: "dQw4w9WgXcQ",
            title: { simpleText: "Seed" },
          },
        },
        ...extra,
      },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("youtubei/v1/next")) {
        throw new Error(`unexpected fetch ${url}`);
      }
      await gate;
      return { ok: true, status: 200, json: async () => body };
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      fetchMock as unknown as typeof fetch,
    );
    const first = innertubeRelated("dQw4w9WgXcQ", 5);
    const second = innertubeRelated("dQw4w9WgXcQ", INNERTUBE_RELATED_LIMIT);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(INNERTUBE_RELATED_LIMIT);
    expect(a?.[0]?.videoId).toBe("relWeb00000");
    expect(b?.[19]?.videoId).toBe("relWeb00019");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
