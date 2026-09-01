import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommunityHomeFeed } from "./community-home-feed";
import { COMMUNITY_HOME_POSTS_VERSION, seedCommunityHomePosts } from "@/lib/community-home";

/**
 * Lock visibility in the feed chrome. Storage is stubbed so SSR markup does
 * not touch a real localStorage (vitest node env).
 */

function withStorage<T>(
  seed: Record<string, string>,
  run: () => T,
): T {
  const storage = new Map<string, string>(Object.entries(seed));
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
    },
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  }
}

describe("CommunityHomeFeed lock visibility", () => {
  it("free viewer sees the VIP lock and no join-call CTA", () => {
    const posts = seedCommunityHomePosts("s1");
    const html = withStorage(
      {
        "pqp:community-home-viewer": "free",
        "pqp:community-home-posts:s1": JSON.stringify({
          version: COMMUNITY_HOME_POSTS_VERSION,
          posts,
        }),
      },
      () =>
        renderToStaticMarkup(
          <CommunityHomeFeed
            serverId="s1"
            serverName="Mesa da Tues"
            authorName="Raf"
            canManageServer={false}
            isOwner={false}
            isVip={false}
          />,
        ),
    );
    expect(html).toContain("VIP");
    expect(html).toContain("Unlock inner");
    expect(html).toContain("data-home-locked-media");
    expect(html).not.toContain("Join the call");
    expect(html).not.toContain("entrar na call");
    // Locked VIP media must not leak the youtube / file URL into free DOM.
    expect(html).not.toContain("sessao-11-clip.webm");
  });

  it("manage-server staff keeps Compose available while Preview uses viewer tabs", () => {
    const posts = seedCommunityHomePosts("s1");
    const html = withStorage(
      {
        "pqp:community-home-viewer": "free",
        "pqp:community-home-posts:s1": JSON.stringify({
          version: COMMUNITY_HOME_POSTS_VERSION,
          posts,
        }),
      },
      () =>
        renderToStaticMarkup(
          <CommunityHomeFeed
            serverId="s1"
            serverName="Mesa da Tues"
            authorName="Raf"
            canManageServer
            isOwner
            isVip={false}
          />,
        ),
    );
    expect(html).toContain("data-home-staff-tabs");
    expect(html).toContain("data-home-compose");
    expect(html).toContain("data-home-viewer-tabs");
    expect(html).toContain("Compose");
    expect(html).toContain("Preview");
  });
});
