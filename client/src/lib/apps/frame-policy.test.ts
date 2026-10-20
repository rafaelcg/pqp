// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  instagramEmbedSrc,
  tiktokEmbedSrc,
  twitchEmbedSrc,
  youtubeEmbedSrc,
} from "@pqp/shared";
import {
  FRAME_POLICY_ATTRIBUTE,
  FRAME_SRC_ORIGINS,
  buildFramePolicy,
  ensureAppFramePolicy,
} from "./frame-policy";

afterEach(() => {
  document.head.querySelectorAll("meta").forEach((meta) => meta.remove());
});

const APPS = "https://pqp-apps.pages.dev";

function sources(policy: string): string[] {
  expect(policy.startsWith("frame-src ")).toBe(true);
  return policy.slice("frame-src ".length).split(" ");
}

describe("buildFramePolicy", () => {
  it("is a frame-src and nothing else, so it constrains no other kind of request", () => {
    const policy = buildFramePolicy({ appsOrigin: APPS });
    expect(policy).not.toContain(";");
    expect(policy).not.toMatch(/default-src|script-src|connect-src|child-src|worker-src/);
    expect(sources(policy)).toEqual(expect.arrayContaining(["'self'", "blob:", APPS]));
  });

  it("does not list an origin with a redirect-capable sign-in flow: an app frame could hand it data", () => {
    const list = sources(buildFramePolicy({ appsOrigin: APPS }));
    expect(list).not.toContain("https://accounts.google.com");
    expect(list.some((origin) => /clerk/i.test(origin))).toBe(false);
  });

  it("lists the apps origin, every built-in embed origin and the extras once each", () => {
    const list = sources(buildFramePolicy({ appsOrigin: APPS, extraOrigins: ["https://embed.example.com", APPS] }));
    for (const origin of FRAME_SRC_ORIGINS) expect(list).toContain(origin);
    expect(list).toContain("https://embed.example.com");
    expect(new Set(list).size).toBe(list.length);
  });

  it("never carries a wildcard, a scheme-only source, data: or anything that is not an http(s) origin", () => {
    const list = sources(
      buildFramePolicy({
        appsOrigin: APPS,
        extraOrigins: ["https://*.clerk.accounts.dev", "javascript:alert(1)", "data:text/html,x", "https:", "*", "not a url", "ftp://x.test"],
      }),
    );
    expect(list.some((s) => s.includes("*"))).toBe(false);
    expect(list).not.toContain("data:");
    expect(list).not.toContain("https:");
    expect(list.filter((s) => !s.startsWith("'") && s !== "blob:").every((s) => /^https?:\/\/[^/*]+$/.test(s))).toBe(true);
  });

  it("drops an apps origin it cannot parse instead of widening the policy", () => {
    const list = sources(buildFramePolicy({ appsOrigin: "nonsense" }));
    expect(list.some((s) => s.includes("nonsense"))).toBe(false);
  });
});

describe("the embeds the client really renders stay allowed", () => {
  const allowed = (url: string) => sources(buildFramePolicy({ appsOrigin: APPS })).includes(new URL(url).origin);

  it("YouTube (community home and the music player), Twitch, TikTok and Instagram", () => {
    const urls = [
      youtubeEmbedSrc("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      // the IFrame API player builds https://www.youtube.com/embed/<id>
      "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1",
      twitchEmbedSrc("https://www.twitch.tv/somechannel", "pqp.gg"),
      twitchEmbedSrc("https://www.twitch.tv/videos/123456789", "pqp.gg"),
      twitchEmbedSrc("https://clips.twitch.tv/FamousCleverClipSlug", "pqp.gg"),
      tiktokEmbedSrc("https://www.tiktok.com/@someone/video/7234567890123456789"),
      instagramEmbedSrc("https://www.instagram.com/p/CxAbCdEfGhI/"),
    ];
    for (const url of urls) {
      expect(url, "the builder returned nothing, so the test is not testing it").not.toBeNull();
      expect(allowed(url!), url!).toBe(true);
    }
  });

  it("only these source files render an iframe: a new one must be added to the policy", () => {
    const root = join(__dirname, "../..");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.fixture\./.test(name) && !/\/apps\//.test(full)) {
          if (/<iframe\b|createElement\(["']iframe["']\)/.test(readFileSync(full, "utf8"))) {
            found.push(full.slice(root.length + 1));
          }
        }
      }
    };
    walk(root);
    // The YouTube IFrame API player (music queue) creates its iframe from script, so it has no literal here;
    // its origin, www.youtube.com, is in the list above. The emulator room frames
    // our own `/emulator/room.html`, which `frame-src 'self'` already covers.
    expect(found.sort()).toEqual([
      "components/communities/community-featured-media.tsx",
      "components/community-home/community-home-media.tsx",
      "components/emulator/emulator-room.tsx",
    ]);
  });
});

describe("ensureAppFramePolicy", () => {
  it("inserts one Content-Security-Policy meta in the head and says it did", () => {
    expect(ensureAppFramePolicy({ appsOrigin: APPS })).toBe(true);
    const metas = document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]!.getAttribute("content")).toBe(buildFramePolicy({ appsOrigin: APPS }));
    expect(metas[0]!.hasAttribute(FRAME_POLICY_ATTRIBUTE)).toBe(true);
  });

  it("is inserted once however many frames mount", () => {
    expect(ensureAppFramePolicy({ appsOrigin: APPS })).toBe(true);
    expect(ensureAppFramePolicy({ appsOrigin: APPS })).toBe(false);
    expect(ensureAppFramePolicy({ appsOrigin: "http://localhost:5175" })).toBe(false);
    expect(document.head.querySelectorAll("meta[http-equiv]")).toHaveLength(1);
  });
});
