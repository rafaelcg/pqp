import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommunityHomeFeed } from "./community-home-feed";

/**
 * Lock visibility in the feed chrome. Storage is stubbed so SSR markup does
 * not touch a real localStorage (vitest node env).
 */

const channels = [
  {
    id: "v1",
    serverId: "s1",
    kind: "server" as const,
    name: "mesa",
    type: "voice" as const,
    position: 0,
    parentId: null,
    isPrivate: false,
    topic: null,
    imageUrl: null,
  },
];

describe("CommunityHomeFeed lock visibility", () => {
  it("free viewer sees the VIP lock, not the full clip label path", () => {
    const storage = new Map<string, string>();
    storage.set("pqp:community-home-viewer", "free");
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
      const html = renderToStaticMarkup(
        <CommunityHomeFeed
          serverId="s1"
          serverName="Mesa da Tues"
          channels={channels}
          authorName="Raf"
          isOwner={false}
          isVip={false}
          onJoinVoice={() => {}}
        />,
      );
      expect(html).toContain("VIP");
      expect(html).toContain("Unlock inner");
      expect(html).toContain("Join the call");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});
