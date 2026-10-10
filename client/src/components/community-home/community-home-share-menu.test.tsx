import type { PublicUser } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CommunityHomePost } from "@/lib/community-home";
import { I18nProvider } from "@/lib/i18n";
import { PostCard } from "./community-home-feed";
import { shareErrorKey } from "./community-home-share-dialog";
import { ApiError } from "@/lib/api";

const author: PublicUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  displayName: "Tues",
  username: "tues",
  tag: "tues#0002",
  avatarUrl: null,
  customStatus: null,
};

function post(overrides: Partial<CommunityHomePost> = {}): CommunityHomePost {
  const now = "2026-09-01T12:00:00.000Z";
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    serverId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    author,
    authorBadge: "owner",
    title: "Sessão 11",
    body: "texto",
    teaser: null,
    visibility: "free",
    status: "published",
    commentsEnabled: true,
    media: null,
    hasMedia: false,
    posterUrl: null,
    locked: false,
    likeCount: 0,
    likedByMe: false,
    commentCount: 0,
    commentTeaser: [],
    pinned: false,
    scheduledAt: null,
    scheduleTimezone: null,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    translation: null,
    ...overrides,
  };
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe("PostCard share actions", () => {
  it("staff get Share and Copy link on a published post, and the card carries its id", () => {
    const html = render(
      <PostCard
        post={post()}
        me={author}
        locked={false}
        canManageServer
        vipEnabled={false}
        onShare={() => undefined}
        onCopyLink={() => undefined}
      />,
    );
    expect(html).toContain("data-home-share");
    expect(html).toContain("data-home-copy-link");
    expect(html).toContain('data-home-post-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"');
  });

  it("a draft is not shareable, and a member sees no menu at all", () => {
    const draft = render(
      <PostCard
        post={post({ status: "draft" })}
        me={author}
        locked={false}
        canManageServer
        vipEnabled={false}
        mode="drafts"
        onShare={() => undefined}
        onCopyLink={() => undefined}
      />,
    );
    expect(draft).not.toContain("data-home-share");
    const member = render(
      <PostCard post={post()} me={author} locked={false} canManageServer={false} vipEnabled={false} />,
    );
    expect(member).not.toContain("data-home-card-menu");
  });
});

describe("shareErrorKey", () => {
  it("names the reason the chat refused", () => {
    expect(shareErrorKey(new ApiError(403, "no"))).toBe("communityHome.share.error.cannotSend");
    expect(shareErrorKey(new ApiError(429, "slow"))).toBe("communityHome.share.error.slowMode");
    expect(shareErrorKey(new Error("boom"))).toBe("communityHome.share.error.generic");
  });
});
