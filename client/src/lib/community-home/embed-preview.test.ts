import { describe, expect, it } from "vitest";
import { parseCommunityHomeEmbed } from "./media";
import {
  communityHomeEmbedMedia,
  composeSubmitEmbedUrl,
  loneSupportedEmbedUrl,
  resolveComposeEmbedUrl,
} from "./embed-preview";

const youtube = "https://youtu.be/jNQXAC9IVRw";
const watch = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const tiktok = "https://www.tiktok.com/@scout2015/video/6718335390845095173";
const instagram = "https://www.instagram.com/reel/CqK2e0_JXkA/";

describe("parseCommunityHomeEmbed", () => {
  it("classifies YouTube, TikTok and Instagram watch URLs", () => {
    expect(parseCommunityHomeEmbed(youtube)).toBe("youtube");
    expect(parseCommunityHomeEmbed(watch)).toBe("youtube");
    expect(
      parseCommunityHomeEmbed("https://www.youtube.com/shorts/jNQXAC9IVRw"),
    ).toBe("youtube");
    expect(parseCommunityHomeEmbed(tiktok)).toBe("tiktok");
    expect(parseCommunityHomeEmbed(instagram)).toBe("instagram");
  });

  it("rejects empty, junk, and hosts we do not embed", () => {
    expect(parseCommunityHomeEmbed("")).toBeNull();
    expect(parseCommunityHomeEmbed("   ")).toBeNull();
    expect(parseCommunityHomeEmbed("https://example.com/watch")).toBeNull();
    expect(parseCommunityHomeEmbed("not a url")).toBeNull();
  });
});

describe("loneSupportedEmbedUrl", () => {
  it("accepts a body that is only a supported URL", () => {
    expect(loneSupportedEmbedUrl(`  ${youtube}  `)).toBe(youtube);
    expect(loneSupportedEmbedUrl(tiktok)).toBe(tiktok);
    expect(loneSupportedEmbedUrl(instagram)).toBe(instagram);
  });

  it("ignores a URL mixed with other text", () => {
    expect(loneSupportedEmbedUrl(`olha ${youtube}`)).toBeNull();
    expect(loneSupportedEmbedUrl(`${youtube}\nmais texto`)).toBeNull();
    expect(loneSupportedEmbedUrl("https://example.com/x")).toBeNull();
  });
});

describe("resolveComposeEmbedUrl", () => {
  it("lets the link field win, even when the body is also a URL", () => {
    expect(resolveComposeEmbedUrl(watch, youtube)).toBe(watch);
  });

  it("falls back to a lone body URL when the field is empty", () => {
    expect(resolveComposeEmbedUrl("", youtube)).toBe(youtube);
    expect(resolveComposeEmbedUrl("   ", tiktok)).toBe(tiktok);
  });

  it("keeps a non-empty field that does not parse, so submit can still block", () => {
    expect(resolveComposeEmbedUrl("https://example.com/x", youtube)).toBe(
      "https://example.com/x",
    );
  });
});

describe("composeSubmitEmbedUrl", () => {
  it("does not send a body URL while a file is still selected", () => {
    expect(
      composeSubmitEmbedUrl({
        linkField: "",
        body: youtube,
        hasFileMedia: true,
      }),
    ).toBeNull();
    expect(
      composeSubmitEmbedUrl({
        linkField: watch,
        body: youtube,
        hasFileMedia: true,
      }),
    ).toBeNull();
  });

  it("sends the link field, or a lone body URL when the field is empty", () => {
    expect(
      composeSubmitEmbedUrl({
        linkField: watch,
        body: youtube,
        hasFileMedia: false,
      }),
    ).toBe(watch);
    expect(
      composeSubmitEmbedUrl({
        linkField: "",
        body: tiktok,
        hasFileMedia: false,
      }),
    ).toBe(tiktok);
  });
});

describe("communityHomeEmbedMedia", () => {
  it("builds the same media the feed card renders", () => {
    expect(communityHomeEmbedMedia(youtube)).toEqual({
      kind: "youtube",
      name: "YouTube",
      contentType: null,
      byteSize: null,
      url: null,
      youtubeUrl: youtube,
      twitchUrl: null,
    });
    expect(communityHomeEmbedMedia(tiktok)?.kind).toBe("tiktok");
    expect(communityHomeEmbedMedia(instagram)?.kind).toBe("instagram");
    expect(communityHomeEmbedMedia("https://example.com/x")).toBeNull();
  });
});
