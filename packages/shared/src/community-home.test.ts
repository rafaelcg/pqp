import { describe, expect, it } from "vitest";
import {
  instagramEmbedSrc,
  parseCommunityHomeEmbed,
  parseInstagramEmbed,
  parseTikTokVideoId,
  parseYoutubeVideoId,
  tiktokEmbedSrc,
} from "./community-home.js";

const TIKTOK_ID = "6718335390845095173";
const IG_CODE = "CqK2e0_JXkA";

describe("parseTikTokVideoId", () => {
  it("reads @user/video, mobile /v/, and the player URLs themselves", () => {
    expect(
      parseTikTokVideoId(`https://www.tiktok.com/@scout2015/video/${TIKTOK_ID}`),
    ).toBe(TIKTOK_ID);
    expect(
      parseTikTokVideoId(
        `https://tiktok.com/@scout2015/video/${TIKTOK_ID}?is_from_webapp=1`,
      ),
    ).toBe(TIKTOK_ID);
    expect(parseTikTokVideoId(`https://m.tiktok.com/v/${TIKTOK_ID}.html`)).toBe(
      TIKTOK_ID,
    );
    expect(
      parseTikTokVideoId(`https://www.tiktok.com/embed/v2/${TIKTOK_ID}`),
    ).toBe(TIKTOK_ID);
    expect(
      parseTikTokVideoId(`https://www.tiktok.com/player/v1/${TIKTOK_ID}`),
    ).toBe(TIKTOK_ID);
    expect(
      parseTikTokVideoId(`  https://www.tiktok.com/@x/video/${TIKTOK_ID}  `),
    ).toBe(TIKTOK_ID);
  });

  it("refuses profiles, tags, discover, and short links that need a redirect", () => {
    expect(parseTikTokVideoId("https://www.tiktok.com/@scout2015")).toBeNull();
    expect(parseTikTokVideoId("https://www.tiktok.com/tag/foryou")).toBeNull();
    expect(parseTikTokVideoId("https://www.tiktok.com/discover")).toBeNull();
    expect(parseTikTokVideoId("https://vm.tiktok.com/ZMh3xYd/")).toBeNull();
    expect(parseTikTokVideoId("https://vt.tiktok.com/ZSxxxxx/")).toBeNull();
    expect(parseTikTokVideoId("https://www.tiktok.com/t/ZTxxxxx/")).toBeNull();
    expect(parseTikTokVideoId("javascript:alert(1)")).toBeNull();
    expect(parseTikTokVideoId("https://youtu.be/jNQXAC9IVRw")).toBeNull();
  });
});

describe("tiktokEmbedSrc", () => {
  it("uses the official player/v1 iframe", () => {
    expect(
      tiktokEmbedSrc(`https://www.tiktok.com/@scout2015/video/${TIKTOK_ID}`),
    ).toBe(`https://www.tiktok.com/player/v1/${TIKTOK_ID}`);
    expect(tiktokEmbedSrc("https://www.tiktok.com/@scout2015")).toBeNull();
  });
});

describe("parseInstagramEmbed", () => {
  it("reads /p/, /reel/, and /reels/", () => {
    expect(parseInstagramEmbed(`https://www.instagram.com/p/${IG_CODE}/`)).toEqual({
      kind: "post",
      shortcode: IG_CODE,
    });
    expect(
      parseInstagramEmbed(`https://instagram.com/p/${IG_CODE}/?img_index=1`),
    ).toEqual({ kind: "post", shortcode: IG_CODE });
    expect(
      parseInstagramEmbed(`https://www.instagram.com/reel/${IG_CODE}/`),
    ).toEqual({ kind: "reel", shortcode: IG_CODE });
    expect(
      parseInstagramEmbed(`https://www.instagram.com/reels/${IG_CODE}`),
    ).toEqual({ kind: "reel", shortcode: IG_CODE });
    expect(parseInstagramEmbed(`https://m.instagram.com/p/${IG_CODE}/`)).toEqual({
      kind: "post",
      shortcode: IG_CODE,
    });
    expect(parseInstagramEmbed(`https://instagr.am/p/${IG_CODE}/`)).toEqual({
      kind: "post",
      shortcode: IG_CODE,
    });
  });

  it("refuses profiles, stories, and explore", () => {
    expect(parseInstagramEmbed("https://www.instagram.com/rafa/")).toBeNull();
    expect(
      parseInstagramEmbed("https://www.instagram.com/stories/rafa/123"),
    ).toBeNull();
    expect(parseInstagramEmbed("https://www.instagram.com/explore/")).toBeNull();
    expect(
      parseInstagramEmbed("https://www.instagram.com/explore/tags/bau"),
    ).toBeNull();
    expect(parseInstagramEmbed("javascript:alert(1)")).toBeNull();
  });
});

describe("instagramEmbedSrc", () => {
  it("uses /p/…/embed/ for posts and /reel/…/embed/ for reels", () => {
    expect(instagramEmbedSrc(`https://www.instagram.com/p/${IG_CODE}/`)).toBe(
      `https://www.instagram.com/p/${IG_CODE}/embed/`,
    );
    expect(instagramEmbedSrc(`https://www.instagram.com/reels/${IG_CODE}/`)).toBe(
      `https://www.instagram.com/reel/${IG_CODE}/embed/`,
    );
    expect(instagramEmbedSrc("https://www.instagram.com/rafa/")).toBeNull();
  });
});

describe("parseCommunityHomeEmbed", () => {
  it("classifies YouTube, TikTok, then Instagram", () => {
    expect(parseYoutubeVideoId("https://youtu.be/jNQXAC9IVRw")).toBe(
      "jNQXAC9IVRw",
    );
    expect(parseCommunityHomeEmbed("https://youtu.be/jNQXAC9IVRw")).toBe(
      "youtube",
    );
    expect(
      parseCommunityHomeEmbed(
        `https://www.tiktok.com/@scout2015/video/${TIKTOK_ID}`,
      ),
    ).toBe("tiktok");
    expect(
      parseCommunityHomeEmbed(`https://www.instagram.com/p/${IG_CODE}/`),
    ).toBe("instagram");
    expect(parseCommunityHomeEmbed("https://example.com/watch")).toBeNull();
    expect(parseCommunityHomeEmbed("https://www.tiktok.com/@scout2015")).toBeNull();
  });
});
