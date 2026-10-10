import type { CommunityHomePostCard } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import {
  BauPostCardView,
  posterKind,
} from "./bau-post-card";

function card(over: Partial<CommunityHomePostCard> = {}): CommunityHomePostCard {
  return {
    postId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    serverId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    serverName: "Mesa",
    title: "Sessão 11",
    teaser: "o clip inteiro",
    author: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      displayName: "Tues",
      avatarUrl: null,
    },
    mediaKind: null,
    mediaUrl: null,
    visibility: "free",
    locked: false,
    pinned: false,
    likeCount: 0,
    commentCount: 0,
    publishedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function render(value: CommunityHomePostCard): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <BauPostCardView
        card={value}
        href="https://pqp.gg/app/server/s/bau/p"
        onOpen={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("posterKind", () => {
  it("picks a video frame, a picture, a plate, or nothing", () => {
    expect(posterKind({ mediaKind: "video", mediaUrl: "https://x/v.mp4" })).toBe("video");
    expect(posterKind({ mediaKind: "image", mediaUrl: "https://x/a.png" })).toBe("image");
    expect(posterKind({ mediaKind: "youtube", mediaUrl: "https://i.ytimg.com/a.jpg" })).toBe("image");
    expect(posterKind({ mediaKind: "twitch", mediaUrl: null })).toBe("frame");
    expect(posterKind({ mediaKind: "file", mediaUrl: null })).toBeNull();
    expect(posterKind({ mediaKind: null, mediaUrl: null })).toBeNull();
    // An upload whose url could not be signed still says "video" with a plate.
    expect(posterKind({ mediaKind: "video", mediaUrl: null })).toBe("frame");
  });
});

describe("BauPostCardView", () => {
  it("a video post shows a first-frame video, a play badge, title, teaser, author and the button", () => {
    const html = render(
      card({ mediaKind: "video", mediaUrl: "https://bucket/a.mp4?sig=1", likeCount: 3 }),
    );
    expect(html).toContain("data-bau-card");
    expect(html).toContain('data-bau-card-media="video"');
    expect(html).toContain("<video");
    expect(html).toContain("#t=0.001");
    expect(html).toContain("data-bau-card-play");
    expect(html).toContain("Sessão 11");
    expect(html).toContain("o clip inteiro");
    expect(html).toContain("Tues");
    expect(html).toContain("Open in Baú");
    expect(html).toContain('href="https://pqp.gg/app/server/s/bau/p"');
  });

  it("an image post has a picture and no play badge", () => {
    const html = render(card({ mediaKind: "image", mediaUrl: "https://bucket/a.png" }));
    expect(html).toContain("<img");
    expect(html).not.toContain("data-bau-card-play");
  });

  it("a text post has no poster and still has the button", () => {
    const html = render(card());
    expect(html).toContain('data-bau-card-media="none"');
    expect(html).not.toContain("<video");
    expect(html).toContain("data-bau-card-cta");
  });

  it("a locked post is badged and never plays", () => {
    const html = render(
      card({
        locked: true,
        visibility: "members",
        mediaKind: "youtube",
        mediaUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      }),
    );
    expect(html).toContain("Locked");
    expect(html).not.toContain("data-bau-card-play");
    expect(html).not.toContain("<video");
  });

  it("falls back to a line for an untitled post", () => {
    expect(render(card({ title: null }))).toContain("New in the Baú");
  });
});
