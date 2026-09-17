import { describe, expect, it } from "vitest";
import {
  COMMUNITY_ABOUT_MAX_LENGTH,
  COMMUNITY_LINKS_MAX,
  communityAboutSchema,
  normalizeCommunityLinks,
  parseCommunityFeaturedEmbed,
  parseCommunityLink,
} from "./communities.js";

describe("parseCommunityLink", () => {
  it("classifies allowlisted hosts, never from a client-supplied kind", () => {
    expect(parseCommunityLink("https://www.youtube.com/@mooncase")?.kind).toBe(
      "youtube",
    );
    expect(parseCommunityLink("https://twitch.tv/moonkaselive")?.kind).toBe(
      "twitch",
    );
    expect(parseCommunityLink("https://instagram.com/mooncase")?.kind).toBe(
      "instagram",
    );
    expect(parseCommunityLink("https://www.tiktok.com/@mooncase")?.kind).toBe(
      "tiktok",
    );
    expect(parseCommunityLink("https://x.com/mooncase")?.kind).toBe("x");
    expect(parseCommunityLink("https://twitter.com/mooncase")?.kind).toBe("x");
    expect(parseCommunityLink("https://mooncase.gg")?.kind).toBe("site");
  });

  it("refuses http, credentials, and short TikTok redirects", () => {
    expect(parseCommunityLink("http://youtube.com/@x")).toBeNull();
    expect(parseCommunityLink("https://user:pass@youtube.com/@x")).toBeNull();
    expect(parseCommunityLink("https://vm.tiktok.com/ZMabcdef/")).toBeNull();
    expect(parseCommunityLink("javascript:alert(1)")).toBeNull();
  });
});

describe("normalizeCommunityLinks", () => {
  it("dedupes, recaps at eight, and refuses a junk entry", () => {
    const twice = normalizeCommunityLinks([
      { url: "https://twitch.tv/moonkaselive" },
      { url: "https://twitch.tv/moonkaselive" },
    ]);
    expect(twice).toHaveLength(1);

    const tooMany = Array.from({ length: COMMUNITY_LINKS_MAX + 1 }, (_, i) => ({
      url: `https://example.com/${i}`,
    }));
    expect(normalizeCommunityLinks(tooMany)).toBeNull();
    expect(normalizeCommunityLinks([{ url: "not-a-url" }])).toBeNull();
    expect(normalizeCommunityLinks([])).toEqual([]);
  });
});

describe("parseCommunityFeaturedEmbed", () => {
  it("accepts a YouTube video and a Twitch channel, refuses a channel-as-youtube", () => {
    expect(
      parseCommunityFeaturedEmbed("https://youtu.be/jNQXAC9IVRw"),
    ).toEqual({
      kind: "youtube",
      url: "https://youtu.be/jNQXAC9IVRw",
    });
    expect(
      parseCommunityFeaturedEmbed("https://www.twitch.tv/moonkaselive"),
    ).toEqual({
      kind: "twitch",
      url: "https://www.twitch.tv/moonkaselive",
    });
    expect(
      parseCommunityFeaturedEmbed("https://www.youtube.com/@mooncase"),
    ).toBeNull();
    expect(
      parseCommunityFeaturedEmbed("https://www.tiktok.com/@mooncase/video/1"),
    ).toBeNull();
  });
});

describe("communityAboutSchema", () => {
  it("trims and caps at 2000", () => {
    expect(communityAboutSchema.parse("  oi  ")).toBe("oi");
    expect(
      communityAboutSchema.safeParse("x".repeat(COMMUNITY_ABOUT_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
  });
});
