import type { PublicUser } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CommunityHomePost } from "@/lib/community-home";
import { PostCard } from "./community-home-feed";

/**
 * The card's contract, rendered without the feed's network around it.
 *
 *  - a locked post leaks nothing: no body, no media URL, no comment words;
 *  - "free" is never a chip, and VIP is one only while the VIP flag is on;
 *  - the two newest comments and nothing more are in the card's own DOM.
 */

const me: PublicUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  displayName: "Rafa",
  username: "rafa",
  tag: "rafa#0001",
  avatarUrl: null,
};

const author: PublicUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  displayName: "Tues",
  username: "tues",
  tag: "tues#0002",
  avatarUrl: null,
};

function post(overrides: Partial<CommunityHomePost> = {}): CommunityHomePost {
  const now = "2026-09-01T12:00:00.000Z";
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    serverId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    author,
    authorBadge: "owner",
    title: "Sessão 11",
    body: "o mapa do porão",
    teaser: null,
    visibility: "free",
    status: "published",
    commentsEnabled: true,
    media: null,
    locked: false,
    likeCount: 3,
    likedByMe: false,
    commentCount: 0,
    commentTeaser: [],
    pinned: false,
    scheduledAt: null,
    scheduleTimezone: null,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  return renderToStaticMarkup(node);
}

describe("PostCard", () => {
  it("a free post carries no tier chip at all", () => {
    const html = render(
      <PostCard post={post()} me={me} locked={false} canManageServer={false} vipEnabled />,
    );
    expect(html).toContain("o mapa do porão");
    expect(html).not.toContain("data-home-vip-chip");
    expect(html).not.toContain("Everyone");
    expect(html).toContain("data-home-like");
  });

  it("a locked VIP post shows title and teaser only, and no comment words", () => {
    const html = render(
      <PostCard
        post={post({
          visibility: "members",
          body: null,
          teaser: "só o inner vê o clip",
          media: null,
          locked: true,
          commentCount: 4,
          commentTeaser: [],
        })}
        me={me}
        locked
        canManageServer={false}
        vipEnabled
      />,
    );
    expect(html).toContain("Sessão 11");
    expect(html).toContain("só o inner vê o clip");
    expect(html).toContain("data-home-locked-media");
    expect(html).toContain("data-home-unlock-cta");
    expect(html).toContain("data-home-vip-chip");
    expect(html).not.toContain("data-home-comments");
    expect(html).not.toContain("data-home-like");
  });

  it("with the VIP flag off, a members post renders no VIP chip", () => {
    const html = render(
      <PostCard
        post={post({ visibility: "members" })}
        me={me}
        locked={false}
        canManageServer
        vipEnabled={false}
      />,
    );
    expect(html).not.toContain("data-home-vip-chip");
  });

  it("an unlocked post with media puts the URL in the DOM, a locked one does not", () => {
    const media = {
      kind: "video" as const,
      name: "sessao-11-clip.webm",
      contentType: "video/webm",
      byteSize: 1024,
      url: "https://bucket.example/sessao-11-clip.webm?sig=1",
      youtubeUrl: null,
    };
    const open = render(
      <PostCard post={post({ media })} me={me} locked={false} canManageServer={false} vipEnabled={false} />,
    );
    expect(open).toContain("sessao-11-clip.webm");
    // The API nulls media for a locked viewer; the card must not invent it.
    const shut = render(
      <PostCard
        post={post({ visibility: "members", media: null, body: null, locked: true })}
        me={me}
        locked
        canManageServer={false}
        vipEnabled
      />,
    );
    expect(shut).not.toContain("sessao-11-clip.webm");
  });

  it("shows only the two newest comments the API sent, plus a see-all when more exist", () => {
    const comment = (id: string, body: string) => ({
      id,
      author,
      body,
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const html = render(
      <PostCard
        post={post({
          commentCount: 5,
          commentTeaser: [
            comment("dddddddd-dddd-4ddd-8ddd-ddddddddddd1", "primeiro"),
            comment("dddddddd-dddd-4ddd-8ddd-ddddddddddd2", "segundo"),
          ],
        })}
        me={me}
        locked={false}
        canManageServer={false}
        vipEnabled={false}
        onPatch={() => {}}
      />,
    );
    expect(html.match(/data-home-comment(?![s-])/g)?.length).toBe(2);
    expect(html).toContain("data-home-comments-toggle");
    expect(html).toContain("See all 5 comments");
  });

  it("a pinned post says so, and staff get the unpin control", () => {
    const html = render(
      <PostCard
        post={post({ pinned: true })}
        me={me}
        locked={false}
        canManageServer
        vipEnabled={false}
        onTogglePin={() => {}}
      />,
    );
    expect(html).toContain("data-home-pinned-chip");
    expect(html).toContain("data-home-pin");
    expect(html).toContain("Pinned");
  });

  it("a member sees the pinned chip but no pin control", () => {
    const html = render(
      <PostCard
        post={post({ pinned: true })}
        me={me}
        locked={false}
        canManageServer={false}
        vipEnabled={false}
      />,
    );
    expect(html).toContain("data-home-pinned-chip");
    expect(html).not.toContain("data-home-pin>");
  });

  it("a comment that is only a GIF link renders as the GIF, not as a URL", () => {
    const gif = "https://static.klipy.com/gif/abc123.gif";
    const html = render(
      <PostCard
        post={post({
          commentCount: 1,
          commentTeaser: [
            {
              id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd9",
              author,
              body: gif,
              createdAt: "2026-09-02T12:00:00.000Z",
            },
          ],
        })}
        me={me}
        locked={false}
        canManageServer={false}
        vipEnabled={false}
        onPatch={() => {}}
      />,
    );
    // The image, and no visible link text.
    expect(html).toContain(`src="${gif}"`);
    expect(html).not.toContain(`>${gif}<`);

    // A URL on a host we do not embed stays text, which is the allowlist
    // doing its job rather than a broken image from anywhere.
    const elsewhere = "https://example.com/not-a-gif-host.gif";
    const plain = render(
      <PostCard
        post={post({
          commentCount: 1,
          commentTeaser: [
            {
              id: "dddddddd-dddd-4ddd-8ddd-dddddddddd10",
              author,
              body: elsewhere,
              createdAt: "2026-09-02T12:00:00.000Z",
            },
          ],
        })}
        me={me}
        locked={false}
        canManageServer={false}
        vipEnabled={false}
        onPatch={() => {}}
      />,
    );
    expect(plain).not.toContain(`src="${elsewhere}"`);
    expect(plain).toContain(elsewhere);
  });

  it("offers emoji and GIF on the comment box", () => {
    const html = render(
      <PostCard
        post={post()}
        me={me}
        locked={false}
        canManageServer={false}
        vipEnabled={false}
        onPatch={() => {}}
      />,
    );
    expect(html).toContain("data-home-comment-emoji");
    expect(html).toContain("data-home-comment-gif");
  });

  it("staff see edit and delete; members do not", () => {
    const staff = render(
      <PostCard
        post={post()}
        me={me}
        locked={false}
        canManageServer
        vipEnabled={false}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(staff).toContain("data-home-edit");
    expect(staff).toContain("data-home-delete");
    const member = render(
      <PostCard post={post()} me={me} locked={false} canManageServer={false} vipEnabled={false} />,
    );
    expect(member).not.toContain("data-home-edit");
  });
});
