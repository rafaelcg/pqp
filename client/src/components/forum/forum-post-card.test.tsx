import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ForumPostSummary, ForumTag } from "@pqp/shared";
import { ForumPostCard } from "./forum-post-card";

const tag = (n: number, name: string, moderated = false): ForumTag => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name,
  emoji: null,
  moderated,
  position: n,
  postCount: 1,
});
const TAGS = [tag(1, "Bug"), tag(2, "Games"), tag(3, "Front"), tag(4, "DevOps"), tag(5, "Oficial", true)];
const BY_ID = new Map(TAGS.map((one) => [one.id, one]));

const POST: ForumPostSummary = {
  id: "00000000-0000-4000-8000-0000000000aa",
  forumId: "00000000-0000-4000-8000-0000000000ff",
  title: "Valorant fecha sozinho",
  authorId: "00000000-0000-4000-8000-0000000000b0",
  authorName: "lari_gg",
  authorAvatarUrl: null,
  authorIsWebhook: false,
  createdAt: "2026-10-11T12:00:00.000Z",
  lastActivityAt: "2026-10-11T12:30:00.000Z",
  pinnedAt: "2026-10-11T12:00:00.000Z",
  lockedAt: "2026-10-11T12:00:00.000Z",
  resolvedAt: "2026-10-11T12:00:00.000Z",
  acceptedAnswerId: null,
  preview: "Desde ontem o jogo abre e fecha.",
  openingDeleted: false,
  openingKind: "text",
  attachmentCount: 0,
  replyCount: 23,
  reactionCount: 12,
  topReaction: { emoji: "🔥", count: 12 },
  thumbnailUrl: null,
  thumbnailAttachmentId: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  tagIds: TAGS.map((one) => one.id),
};

function render(props: Partial<Parameters<typeof ForumPostCard>[0]> = {}) {
  return renderToStaticMarkup(
    <ForumPostCard
      post={POST}
      unread={{ kind: "unread", count: 5 }}
      tagsById={BY_ID}
      href="/app/server/s/channel/f/post/p"
      tabIndex={0}
      onOpen={() => {}}
      onFocus={() => {}}
      {...props}
    />,
  );
}

describe("ForumPostCard", () => {
  it("never folds a status into +N, while tags past the cap do fold", () => {
    const html = render();
    expect(html).toContain("Resolved");
    expect(html).toContain("Closed");
    expect(html).toContain("Pinned");
    // Three tags drawn, two folded.
    expect(html).toContain("+2");
  });

  it("names the card for a screen reader, new replies included", () => {
    const html = render();
    expect(html).toMatch(/aria-label="Valorant fecha sozinho, [^"]*by lari_gg, 23 replies, [^"]*5 new replies"/);
    expect(html).toContain("+5 new");
  });

  it("says Novo with a word, not only a colour", () => {
    expect(render({ unread: { kind: "new" } })).toContain(">New<");
  });

  it("draws no thumbnail box when the opening message has no image", () => {
    expect(render()).not.toContain("<img");
    expect(render({ post: { ...POST, thumbnailUrl: "https://x/y.png" } })).toContain('alt=""');
  });

  it("reads a deleted account and a deleted opening message", () => {
    const html = render({
      post: { ...POST, authorName: null, authorId: null, openingDeleted: true, preview: null },
    });
    expect(html).toContain("Deleted account");
    expect(html).toContain("The original message was deleted");
  });
});
