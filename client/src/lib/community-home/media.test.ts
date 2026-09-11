import { describe, expect, it } from "vitest";
import {
  COMMUNITY_HOME_MAX_BYTES,
  formatHomeBytes,
  instagramEmbedSrc,
  parseCommunityHomeEmbed,
  parseYoutubeVideoId,
  tiktokEmbedSrc,
  twitchEmbedSrc,
  youtubeEmbedSrc,
} from "./media";

describe("community home media helpers", () => {
  it("parses watch, youtu.be, and shorts URLs", () => {
    expect(
      parseYoutubeVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    ).toBe("jNQXAC9IVRw");
    expect(parseYoutubeVideoId("https://youtu.be/jNQXAC9IVRw")).toBe(
      "jNQXAC9IVRw",
    );
    expect(
      parseYoutubeVideoId("https://www.youtube.com/shorts/jNQXAC9IVRw"),
    ).toBe("jNQXAC9IVRw");
    expect(parseYoutubeVideoId("https://example.com/watch?v=nope")).toBeNull();
  });

  it("builds a nocookie embed only from a valid URL", () => {
    expect(youtubeEmbedSrc("https://youtu.be/jNQXAC9IVRw")).toBe(
      "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw",
    );
    expect(youtubeEmbedSrc("not-a-url")).toBeNull();
  });

  it("classifies TikTok and Instagram paste URLs and builds their iframes", () => {
    const tiktok = "https://www.tiktok.com/@scout2015/video/6718335390845095173";
    expect(parseCommunityHomeEmbed(tiktok)).toBe("tiktok");
    expect(tiktokEmbedSrc(tiktok)).toBe(
      "https://www.tiktok.com/player/v1/6718335390845095173",
    );
    expect(parseCommunityHomeEmbed("https://vm.tiktok.com/ZMh3xYd/")).toBeNull();

    const ig = "https://www.instagram.com/reel/CqK2e0_JXkA/";
    expect(parseCommunityHomeEmbed(ig)).toBe("instagram");
    expect(instagramEmbedSrc(ig)).toBe(
      "https://www.instagram.com/reel/CqK2e0_JXkA/embed/",
    );
    expect(
      parseCommunityHomeEmbed("https://www.instagram.com/stories/rafa/1"),
    ).toBeNull();
  });

  it("formats bytes and keeps the 100 MiB ceiling", () => {
    expect(formatHomeBytes(420 * 1024)).toBe("420 KiB");
    expect(COMMUNITY_HOME_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it("classifies a Twitch channel URL and builds a parented player src", () => {
    expect(parseCommunityHomeEmbed("https://www.twitch.tv/moonkaselive")).toBe(
      "twitch",
    );
    expect(
      twitchEmbedSrc("https://www.twitch.tv/moonkaselive", "pqp.gg"),
    ).toBe(
      "https://player.twitch.tv/?channel=moonkaselive&parent=pqp.gg&autoplay=false",
    );
  });
});
