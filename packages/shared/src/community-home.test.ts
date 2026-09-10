import { describe, expect, it } from "vitest";
import {
  parseCommunityHomeEmbed,
  parseTwitchEmbed,
  parseYoutubeVideoId,
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

describe("parseCommunityHomeEmbed", () => {
  it("classifies YouTube first and Twitch second", () => {
    expect(parseYoutubeVideoId("https://youtu.be/jNQXAC9IVRw")).toBe(
      "jNQXAC9IVRw",
    );
    expect(parseCommunityHomeEmbed("https://youtu.be/jNQXAC9IVRw")).toBe(
      "youtube",
    );
    expect(
      parseCommunityHomeEmbed("https://www.twitch.tv/moonkaselive"),
    ).toBe("twitch");
    expect(parseCommunityHomeEmbed("https://example.com/watch")).toBeNull();
  });
});
