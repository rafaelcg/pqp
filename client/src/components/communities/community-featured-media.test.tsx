import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CommunityFeaturedMedia } from "./community-featured-media";

vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("CommunityFeaturedMedia", () => {
  it("click-to-play does not mount a YouTube iframe", () => {
    const html = renderToStaticMarkup(
      <CommunityFeaturedMedia
        featured={{ kind: "youtube", url: "https://youtu.be/jNQXAC9IVRw" }}
        clickToPlay
      />,
    );
    expect(html).toContain("data-community-featured-play");
    expect(html).toContain("i.ytimg.com/vi/jNQXAC9IVRw");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("youtube-nocookie");
  });

  it("click-to-play does not mount a Twitch player", () => {
    const html = renderToStaticMarkup(
      <CommunityFeaturedMedia
        featured={{ kind: "twitch", url: "https://www.twitch.tv/moonkaselive" }}
        clickToPlay
      />,
    );
    expect(html).toContain("data-community-featured-play");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("player.twitch.tv");
  });
});
