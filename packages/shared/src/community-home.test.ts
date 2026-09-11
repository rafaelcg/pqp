import { describe, expect, it } from "vitest";
import {
  communityHomeMediaSchema,
  instagramCanonicalUrl,
  instagramEmbedSrc,
  parseCommunityHomeEmbed,
  parseInstagramEmbed,
  parseTikTokVideoId,
  parseTwitchEmbed,
  parseYoutubeVideoId,
  tiktokCanonicalUrl,
  tiktokEmbedSrc,
  twitchEmbedSrc,
} from "./community-home.js";

describe("parseTwitchEmbed", () => {
  it("reads a channel, including the mobile host and leftover query", () => {
    expect(parseTwitchEmbed("https://www.twitch.tv/moonkaselive")).toEqual({
      kind: "channel",
      id: "moonkaselive",
    });
    expect(parseTwitchEmbed("https://twitch.tv/MoonKaseLive/")).toEqual({
      kind: "channel",
      id: "moonkaselive",
    });
    expect(
      parseTwitchEmbed("https://m.twitch.tv/moonkaselive?referrer=raid"),
    ).toEqual({ kind: "channel", id: "moonkaselive" });
  });

  it("reads a VOD and a clip from both hosts", () => {
    expect(parseTwitchEmbed("https://www.twitch.tv/videos/123456789")).toEqual({
      kind: "video",
      id: "123456789",
    });
    expect(
      parseTwitchEmbed("https://www.twitch.tv/moonkaselive/video/v987"),
    ).toEqual({ kind: "video", id: "987" });
    expect(
      parseTwitchEmbed(
        "https://clips.twitch.tv/AmazonianEncouragingLyrebirdDAESuppy",
      ),
    ).toEqual({
      kind: "clip",
      id: "AmazonianEncouragingLyrebirdDAESuppy",
    });
    expect(
      parseTwitchEmbed(
        "https://www.twitch.tv/moonkaselive/clip/ThisIsFine-abc123XYZ",
      ),
    ).toEqual({ kind: "clip", id: "ThisIsFine-abc123XYZ" });
  });

  it("reads the player and clips embed URLs themselves", () => {
    expect(
      parseTwitchEmbed("https://player.twitch.tv/?channel=moonkaselive"),
    ).toEqual({ kind: "channel", id: "moonkaselive" });
    expect(parseTwitchEmbed("https://player.twitch.tv/?video=v123")).toEqual({
      kind: "video",
      id: "123",
    });
    expect(
      parseTwitchEmbed(
        "https://clips.twitch.tv/embed?clip=AmazonianEncouragingLyrebirdDAESuppy",
      ),
    ).toEqual({
      kind: "clip",
      id: "AmazonianEncouragingLyrebirdDAESuppy",
    });
  });

  it("refuses directory chrome, other hosts, and javascript", () => {
    expect(parseTwitchEmbed("https://www.twitch.tv/directory")).toBeNull();
    expect(parseTwitchEmbed("https://www.twitch.tv/videos")).toBeNull();
    expect(parseTwitchEmbed("https://www.twitch.tv/moonkaselive/schedule")).toBeNull();
    expect(parseTwitchEmbed("https://example.com/moonkaselive")).toBeNull();
    expect(parseTwitchEmbed("javascript:alert(1)")).toBeNull();
    expect(parseTwitchEmbed("https://youtu.be/jNQXAC9IVRw")).toBeNull();
  });

  it("refuses reserved or extra nested paths that cannot render as a player", () => {
    expect(
      parseTwitchEmbed(
        "https://www.twitch.tv/directory/clip/AmazonianEncouragingLyrebirdDAESuppy",
      ),
    ).toBeNull();
    expect(
      parseTwitchEmbed("https://www.twitch.tv/settings/video/123456789"),
    ).toBeNull();
    expect(
      parseTwitchEmbed(
        "https://www.twitch.tv/moonkaselive/clip/ThisIsFine-abc123XYZ/extra",
      ),
    ).toBeNull();
    expect(
      parseTwitchEmbed("https://www.twitch.tv/videos/123456789/extra"),
    ).toBeNull();
    expect(
      parseTwitchEmbed(
        "https://clips.twitch.tv/embed/AmazonianEncouragingLyrebirdDAESuppy",
      ),
    ).toBeNull();
    expect(
      parseTwitchEmbed(
        "https://clips.twitch.tv/AmazonianEncouragingLyrebirdDAESuppy/extra",
      ),
    ).toBeNull();
    expect(
      parseTwitchEmbed("https://player.twitch.tv/?channel=directory"),
    ).toBeNull();
  });
});

describe("twitchEmbedSrc", () => {
  it("pins parent to the embedding host and does not autoplay", () => {
    expect(
      twitchEmbedSrc("https://www.twitch.tv/moonkaselive", "pqp.gg"),
    ).toBe(
      "https://player.twitch.tv/?channel=moonkaselive&parent=pqp.gg&autoplay=false",
    );
    expect(
      twitchEmbedSrc("https://www.twitch.tv/videos/123", "localhost"),
    ).toBe("https://player.twitch.tv/?video=123&parent=localhost&autoplay=false");
    expect(
      twitchEmbedSrc(
        "https://clips.twitch.tv/AmazonianEncouragingLyrebirdDAESuppy",
        "staging.pqp-3yr.pages.dev",
      ),
    ).toBe(
      "https://clips.twitch.tv/embed?clip=AmazonianEncouragingLyrebirdDAESuppy&parent=staging.pqp-3yr.pages.dev&autoplay=false",
    );
  });

  it("refuses a parent that is not a hostname", () => {
    expect(
      twitchEmbedSrc("https://www.twitch.tv/moonkaselive", "pqp.gg&channel=x"),
    ).toBeNull();
    expect(twitchEmbedSrc("https://www.twitch.tv/moonkaselive", "")).toBeNull();
  });
});

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

describe("tiktokCanonicalUrl", () => {
  it("returns an https tiktok.com URL from a parsed id, never the raw paste", () => {
    expect(
      tiktokCanonicalUrl(`https://m.tiktok.com/v/${TIKTOK_ID}.html`),
    ).toBe(`https://www.tiktok.com/video/${TIKTOK_ID}`);
    expect(tiktokCanonicalUrl("javascript:alert(1)")).toBeNull();
    expect(tiktokCanonicalUrl("https://evil.example/video/1")).toBeNull();
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

describe("instagramCanonicalUrl", () => {
  it("returns an https instagram.com URL from a parsed target, never the raw paste", () => {
    expect(instagramCanonicalUrl(`https://instagr.am/p/${IG_CODE}/`)).toBe(
      `https://www.instagram.com/p/${IG_CODE}/`,
    );
    expect(instagramCanonicalUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("parseCommunityHomeEmbed", () => {
  it("classifies YouTube, Twitch, TikTok, then Instagram", () => {
    expect(parseYoutubeVideoId("https://youtu.be/jNQXAC9IVRw")).toBe(
      "jNQXAC9IVRw",
    );
    expect(parseCommunityHomeEmbed("https://youtu.be/jNQXAC9IVRw")).toBe(
      "youtube",
    );
    expect(
      parseCommunityHomeEmbed("https://www.twitch.tv/moonkaselive"),
    ).toBe("twitch");
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

describe("communityHomeMediaSchema", () => {
  const youtube = {
    kind: "youtube" as const,
    name: "YouTube",
    contentType: null,
    byteSize: null,
    url: null,
    youtubeUrl: "https://youtu.be/jNQXAC9IVRw",
  };

  it("treats a missing twitchUrl as null so an older API still loads the feed", () => {
    expect(communityHomeMediaSchema.parse(youtube)).toEqual({
      ...youtube,
      twitchUrl: null,
    });
  });
});
