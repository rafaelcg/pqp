import { describe, expect, it } from "vitest";
import {
  createCommunityHomePost,
  loadCommunityHomePosts,
  seedCommunityHomePosts,
  visibleCommunityHomePosts,
  homeMediaFromYoutube,
} from "./posts";
import { homePostIsLocked } from "./visibility";
import { youtubeEmbedSrc } from "./media";

describe("community home posts fixtures", () => {
  it("seeds free media and a locked VIP clip without call CTAs", () => {
    const posts = seedCommunityHomePosts("srv-1");
    expect(posts.some((p) => p.visibility === "free")).toBe(true);
    expect(posts.some((p) => p.visibility === "members")).toBe(true);
    expect(posts.some((p) => p.media?.kind === "image")).toBe(true);
    expect(posts.some((p) => p.media?.kind === "file")).toBe(true);
    expect(posts.some((p) => p.media?.kind === "video")).toBe(true);
    expect(posts.some((p) => p.media?.kind === "youtube")).toBe(true);
    const locked = posts.find((p) => p.visibility === "members");
    expect(locked?.teaser).toBeTruthy();
    expect(locked?.title).toBeTruthy();
    expect(homePostIsLocked("members", "free")).toBe(true);
    for (const post of posts) {
      expect(JSON.stringify(post).toLowerCase()).not.toContain("entrar na call");
      expect(JSON.stringify(post).toLowerCase()).not.toContain("join the call");
      expect(JSON.stringify(post)).not.toContain("voiceChannelName");
    }
  });

  it("load seeds into empty storage as a versioned envelope", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
    const posts = loadCommunityHomePosts("srv-1", storage);
    expect(posts.length).toBeGreaterThan(0);
    const raw = map.get("pqp:community-home-posts:srv-1");
    expect(raw).toBeTruthy();
    const envelope = JSON.parse(raw!) as { version: number; posts: unknown[] };
    expect(envelope.version).toBe(2);
    expect(Array.isArray(envelope.posts)).toBe(true);
  });

  it("reseeds legacy array storage", () => {
    const map = new Map<string, string>();
    map.set(
      "pqp:community-home-posts:srv-1",
      JSON.stringify([{ id: "old", serverId: "srv-1", body: "x", visibility: "free" }]),
    );
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
    const posts = loadCommunityHomePosts("srv-1", storage);
    expect(posts.some((p) => p.id.startsWith("seed-mapa"))).toBe(true);
  });

  it("compose creates a post with the signed-in author, not a hardcoded Tues", () => {
    const post = createCommunityHomePost("srv-1", "Raf", {
      body: "aviso da mesa",
      visibility: "members",
      teaser: "só inner",
      authorBadge: "owner",
      status: "draft",
    });
    expect(post.authorName).toBe("Raf");
    expect(post.authorBadge).toBe("owner");
    expect(post.visibility).toBe("members");
    expect(post.teaser).toBe("só inner");
    expect(post.status).toBe("draft");
  });

  it("drafts are staff-only in the visible list", () => {
    const published = createCommunityHomePost("srv-1", "Raf", {
      body: "pub",
      visibility: "free",
      status: "published",
    });
    const draft = createCommunityHomePost("srv-1", "Raf", {
      body: "rascunho",
      visibility: "free",
      status: "draft",
    });
    expect(
      visibleCommunityHomePosts([published, draft], { canManageServer: false }),
    ).toEqual([published]);
    expect(
      visibleCommunityHomePosts([published, draft], { canManageServer: true }),
    ).toHaveLength(2);
  });

  it("youtube helper refuses non-youtube URLs", () => {
    expect(homeMediaFromYoutube("https://example.com/v")).toBeNull();
    const media = homeMediaFromYoutube(
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    );
    expect(media?.kind).toBe("youtube");
    expect(youtubeEmbedSrc(media!.youtubeUrl!)).toContain("embed/jNQXAC9IVRw");
  });
});
