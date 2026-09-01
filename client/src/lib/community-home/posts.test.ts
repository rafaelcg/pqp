import { describe, expect, it } from "vitest";
import {
  createCommunityHomePost,
  loadCommunityHomePosts,
  resolveHomeVoiceChannelId,
  seedCommunityHomePosts,
} from "./posts";
import { homePostIsLocked } from "./visibility";

describe("community home posts fixtures", () => {
  it("seeds a free post and a locked members post", () => {
    const posts = seedCommunityHomePosts("srv-1");
    expect(posts.some((p) => p.visibility === "free")).toBe(true);
    expect(posts.some((p) => p.visibility === "members")).toBe(true);
    const locked = posts.find((p) => p.visibility === "members");
    expect(locked?.teaser).toBeTruthy();
    expect(homePostIsLocked("members", "free")).toBe(true);
  });

  it("load seeds into empty storage", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    const posts = loadCommunityHomePosts("srv-1", storage);
    expect(posts.length).toBeGreaterThan(0);
    expect(map.get("pqp:community-home-posts:srv-1")).toBeTruthy();
  });

  it("compose creates an owner post with chosen visibility", () => {
    const post = createCommunityHomePost("srv-1", "Raf", {
      body: "aviso da mesa",
      visibility: "members",
      teaser: "só inner",
    });
    expect(post.authorBadge).toBe("owner");
    expect(post.visibility).toBe("members");
    expect(post.teaser).toBe("só inner");
  });

  it("resolveHomeVoiceChannelId prefers a named voice channel", () => {
    const channels = [
      { id: "t1", name: "geral", type: "text" },
      { id: "v1", name: "mapa", type: "voice" },
      { id: "v2", name: "mesa", type: "voice" },
    ];
    expect(resolveHomeVoiceChannelId(channels, "mesa")).toBe("v2");
    expect(resolveHomeVoiceChannelId(channels, null)).toBe("v1");
    expect(resolveHomeVoiceChannelId([], null)).toBeNull();
  });
});
