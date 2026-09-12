import { describe, expect, it } from "vitest";
import { collectVideos, parseDurationLabel } from "./innertube.js";

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
});
