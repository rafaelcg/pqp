import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ForumPostSummary, ForumTag } from "@pqp/shared";
import { loadLocale, setActiveCatalogue } from "@/lib/i18n";
import { ForumPinnedTile, ForumPostCard } from "./forum-post-card";

const tag = (n: number, name: string, moderated = false): ForumTag => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name,
  emoji: null,
  icon: null,
  preset: null,
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
  thumbnailVideoUrl: null,
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

  it("draws a pinned post as a small tile: pin, title, status glyphs", () => {
    const html = renderToStaticMarkup(
      <ForumPinnedTile
        post={POST}
        unread={{ kind: "read" }}
        href="/app/server/s/channel/f/post/p"
        tabIndex={0}
        onOpen={() => {}}
        onFocus={() => {}}
      />,
    );
    expect(html).toContain("data-forum-pinned-row");
    // Status still named, as glyphs; no preview, tags or numbers.
    expect(html).toContain('aria-label="Closed"');
    expect(html).toContain('aria-label="Resolved"');
    expect(html).not.toContain("Desde ontem");
    expect(html).not.toContain("+2");
    // The whole tile is still the post's link, with the full accessible name.
    expect(html).toMatch(/<a [^>]*aria-label="Valorant fecha sozinho, /);
  });

  it("names a pinned tile new or unread exactly like the card does", () => {
    const tile = (unread: Parameters<typeof ForumPinnedTile>[0]["unread"]) =>
      renderToStaticMarkup(
        <ForumPinnedTile
          post={POST}
          unread={unread}
          href="/app/server/s/channel/f/post/p"
          tabIndex={0}
          onOpen={() => {}}
          onFocus={() => {}}
        />,
      );
    expect(tile({ kind: "unread", count: 5 })).toMatch(/<a [^>]*aria-label="[^"]*, 5 new replies"/);
    expect(tile({ kind: "new" })).toMatch(/<a [^>]*aria-label="[^"]*, new"/);
    expect(tile({ kind: "read" })).not.toMatch(/<a [^>]*aria-label="[^"]*, (new|\d+ new repl)/);
  });

  it("invites a first reply only on an unlocked post the viewer did not write", () => {
    const empty = { ...POST, replyCount: 0, lockedAt: null };
    expect(render({ post: empty })).toContain("Be the first to reply");
    expect(render({ post: empty, viewerId: "someone-else" })).toContain("Be the first to reply");
    expect(render({ post: empty, viewerId: POST.authorId })).not.toContain("Be the first to reply");
    expect(render({ post: { ...empty, lockedAt: POST.lockedAt } })).not.toContain(
      "Be the first to reply",
    );
  });

  it("draws the tiny avatar's monogram on a disc", () => {
    expect(render()).toMatch(/rounded-full[^"]*bg-surface-3[^"]*">L</);
  });

  it("marks unread with a shape and a heavier title, and says so in the name", () => {
    const html = render({ unread: { kind: "new" } });
    expect(html).toContain("data-forum-unread-dot");
    expect(html).toMatch(/aria-label="[^"]*, new"/);
    expect(render({ unread: { kind: "read" } })).not.toContain("data-forum-unread-dot");
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

describe("ForumPostCard, the three lines", () => {
  it("draws a row as the title over one line of facts, without the preview", () => {
    const card = render();
    const row = render({ variant: "row" });
    expect(card).toContain("Desde ontem o jogo abre e fecha.");
    expect(card).toContain("line-clamp-2");
    expect(row).toContain('data-forum-variant="row"');
    expect(row).toContain(">lari_gg<");
    expect(row).toContain("Bug, Games +3");
    expect(row).not.toContain("Desde ontem o jogo abre e fecha.");
    // The row keeps its status, as named glyphs.
    expect(row).toContain('aria-label="Resolved"');
  });

  it("draws a gallery tile picture first, and the opening text when there is none", () => {
    const withPicture = render({ variant: "tile", post: { ...POST, thumbnailUrl: "https://x/y.png" } });
    expect(withPicture).toContain('data-forum-thumbnail="tile"');
    const textOnly = render({ variant: "tile" });
    expect(textOnly).toContain("Desde ontem o jogo abre e fecha.");
  });

  it("draws the title heavier than the rest of the card, read or not", () => {
    expect(render({ unread: { kind: "read" } })).toMatch(/<a [^>]*class="[^"]*font-semibold/);
    expect(render({ unread: { kind: "new" } })).toMatch(/<a [^>]*class="[^"]*font-bold/);
  });

  it("names a post that is one picture or one clip, and counts several files", () => {
    const filesOnly = { ...POST, preview: null, openingKind: "attachment" as const };
    // One picture or one clip: the picture itself says it, no "Image" line.
    const picture = render({
      post: { ...filesOnly, attachmentCount: 1, thumbnailUrl: "https://x/y.png" },
    });
    expect(picture).toContain('data-forum-thumbnail="media"');
    expect(picture).not.toContain(">Image<");
    const clip = render({
      post: { ...filesOnly, attachmentCount: 1, thumbnailVideoUrl: "https://x/y.mp4" },
    });
    expect(clip).toContain('data-forum-thumbnail="media"');
    expect(clip).not.toContain(">Video<");
    // Several pictures say how many on the picture.
    expect(
      render({ post: { ...filesOnly, attachmentCount: 4, thumbnailUrl: "https://x/y.png" } }),
    ).toContain(">1/4<");
    expect(render({ post: { ...filesOnly, attachmentCount: 3 } })).toContain("3 files");
    // No emoji in the copy: the icon is drawn, and several files have none.
    expect(render({ post: { ...filesOnly, attachmentCount: 3 } })).not.toContain("data-forum-preview-icon");
    expect(
      render({ post: { ...filesOnly, attachmentCount: 1, thumbnailUrl: "https://x/y.png" } }),
    ).not.toMatch(/📷|🎬/);
  });

  it("draws a clip's first frame when there is no picture", () => {
    const html = render({ post: { ...POST, thumbnailVideoUrl: "https://x/y.mp4" } });
    expect(html).toContain('<video src="https://x/y.mp4#t=0.1"');
    expect(html).toContain('preload="metadata"');
    // A picture wins over a clip.
    const both = render({
      post: { ...POST, thumbnailUrl: "https://x/y.png", thumbnailVideoUrl: "https://x/y.mp4" },
    });
    expect(both).toContain("<img");
    expect(both).not.toContain("<video");
  });

  it("ends a preview the server cut with an ellipsis", () => {
    const long = "a".repeat(200);
    expect(render({ post: { ...POST, preview: long } })).toContain(`${long}…`);
    expect(render()).not.toContain("fecha.…");
  });
});

describe("ForumPostCard, tag chips", () => {
  afterEach(() => {
    setActiveCatalogue(undefined);
  });

  const starter: ForumTag = {
    ...tag(1, "Question"),
    icon: "question",
    emoji: "❓",
    preset: "question",
  };
  const only = (one: ForumTag) =>
    render({ post: { ...POST, tagIds: [one.id] }, tagsById: new Map([[one.id, one]]) });

  it("draws the tag's icon, not its emoji, and keeps it out of the accessibility tree", () => {
    const html = only(starter);
    expect(html).toContain('data-forum-tag-icon="question"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("❓");
  });

  it("falls back to the emoji of a row that has no icon, and to nothing", () => {
    expect(only({ ...starter, icon: null })).toContain("❓");
    const bare = only({ ...starter, icon: null, emoji: null });
    expect(bare).not.toContain("data-forum-tag-icon");
    expect(bare).not.toContain("<svg viewBox");
  });

  it("names a starter in the reader's language, and a renamed tag by its own name", async () => {
    expect(only(starter)).toContain(">Question<");
    await loadLocale("pt-BR");
    expect(only(starter)).toContain(">Dúvida<");
    expect(only(starter)).not.toContain(">Question<");
    expect(only({ ...starter, name: "Pergunte", preset: null })).toContain(">Pergunte<");
    await loadLocale("es");
    expect(only(starter)).toContain(">Duda<");
  });
});
