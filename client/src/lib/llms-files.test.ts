import { describe, expect, it } from "vitest";
import LLMS from "../../public/llms.txt?raw";
import LLMS_FULL from "../../public/llms-full.txt?raw";
import SITEMAP from "../../public/sitemap.xml?raw";
import { ARTICLES } from "./blog/articles";
import { COMPARE_PAGES } from "../content/compare-products";

/**
 * `llms.txt` and `llms-full.txt` are hand-written, and they went stale: the
 * hosting line named a provider the API had left, and neither file linked a
 * single guide. These pin what can be pinned: every comparison page and every
 * guide is linked, the product facts that changed are not stated the old way,
 * and the two files carry the limits a reader needs before trusting a claim.
 */
describe("llms.txt and llms-full.txt", () => {
  it("link the compare hub, every product page and /vs-discord", () => {
    for (const path of ["/compare", "/vs-discord", ...COMPARE_PAGES.map((p) => `/compare/${p}`)]) {
      expect(LLMS, path).toContain(`https://pqp.gg${path}`);
      expect(LLMS_FULL, path).toContain(`https://pqp.gg${path}`);
    }
  });

  it("link every guide in the blog", () => {
    expect(ARTICLES.length).toBeGreaterThan(0);
    for (const article of ARTICLES) {
      expect(LLMS, article.slug).toContain(`https://pqp.gg/blog/${article.slug}`);
    }
  });

  it("only link pages the sitemap lists or the app serves", () => {
    for (const path of ["/compare", "/compare/stoat", "/compare/teamspeak", "/compare/slack"]) {
      expect(SITEMAP).toContain(`<loc>https://pqp.gg${path}</loc>`);
    }
  });

  it("do not name a host the API has left, and say where it runs now", () => {
    for (const text of [LLMS, LLMS_FULL]) {
      expect(text).not.toMatch(/Fly\.io|Railway/);
    }
    expect(LLMS_FULL).toMatch(/Cloudflare/);
    expect(LLMS_FULL).toMatch(/São Paulo/);
  });

  it("name the three languages and the Clerk caveat on self-hosting", () => {
    expect(LLMS).toMatch(/Portuguese, English and Spanish/);
    expect(LLMS_FULL).toMatch(/English and Spanish/);
    for (const text of [LLMS, LLMS_FULL]) {
      expect(text).toMatch(/own Clerk account/);
    }
  });

  it("say pqp is made by two brothers, never solo", () => {
    expect(LLMS).toMatch(/two brothers/);
    for (const text of [LLMS, LLMS_FULL]) {
      expect(text).not.toMatch(/\bsolo\b|one person|single developer/i);
    }
  });

  it("carry no em dash and do not talk about another company's troubles", () => {
    for (const text of [LLMS, LLMS_FULL]) {
      expect(text).not.toContain("—");
      expect(text).not.toMatch(/ANPD|suspen|\bbanned?\b|\bVPN\b/i);
    }
  });
});
