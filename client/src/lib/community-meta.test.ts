// The REAL shipped document, imported through Vite's `?raw` rather than read
// off disk with `node:fs` — the client's tsconfig has no Node types, and this
// suite has no business being the one file that needs them.
import INDEX_HTML from "../../index.html?raw";
import { communitySlugFromPath } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  absoluteImageUrl,
  communityCardText,
  communitySlugFromMetaPath,
  escapeHtml,
  injectCommunityHead,
  renderCommunityHead,
  type CommunityMeta,
} from "./community-meta";

/**
 * The `/c/<slug>` half of the Pages middleware.
 *
 * The middleware itself cannot be exercised without a wrangler runtime, so this
 * suite tests the whole of what could actually be wrong: the path parser that
 * decides whether the middleware acts at all, the card copy, and the rewrite —
 * run against THE REAL `index.html`, imported as text, so a change to the
 * shipped document that breaks the rewrite fails here rather than in
 * production. Same shape as `profile-meta.test.ts`, one namespace over.
 */

const OPTIONS = {
  siteOrigin: "https://pqp.gg",
  apiOrigin: "https://api.pqp.gg",
  locale: "pt-BR" as const,
};

const VALORANT: CommunityMeta = {
  slug: "valorant-brasil",
  name: "Valorant Brasil",
  tagline: "a gente perde junto",
  category: "games",
  memberCount: 1240,
  iconUrl: "/api/servers/abc/icon?v=1",
  bannerUrl: "/api/servers/abc/banner?v=1",
};

describe("communitySlugFromMetaPath", () => {
  it("agrees with the shared parser on every path either might see", () => {
    // The duplication is deliberate (the middleware must not import the
    // workspace package — see the file header). This is what stops it drifting.
    const paths = [
      "/c/valorant-brasil",
      "/c/valorant-brasil/",
      "/c/Valorant",
      "/c/ab",
      "/c/suporte",
      "/c/valorant.br",
      "/c/valorant_br",
      "/c/-valorant",
      `/c/${"a".repeat(200)}`,
      "/c/",
      "/c",
      "/c/a/b",
      "/",
      "/app",
      "/@rafa",
      "/garanta",
      "/assets/index-abc123.js",
    ];
    for (const path of paths) {
      expect([path, communitySlugFromMetaPath(path)]).toEqual([
        path,
        communitySlugFromPath(path),
      ]);
    }
  });

  it("does not act on anything that is not a community URL", () => {
    // This runs in front of EVERY request the site serves, including every
    // hashed asset, so a loose parser starts rewriting the landing page.
    expect(communitySlugFromMetaPath("/")).toBeNull();
    expect(communitySlugFromMetaPath("/@rafa")).toBeNull();
    expect(communitySlugFromMetaPath("/app/server/x")).toBeNull();
  });

  it("survives a truncated percent escape", () => {
    expect(communitySlugFromMetaPath("/c/%E0%A4%A")).toBeNull();
  });
});

describe("communityCardText", () => {
  it("leads with the tagline, because the tagline is the joke", () => {
    const { title, description } = communityCardText(VALORANT, "pt-BR");
    expect(title).toBe("Valorant Brasil · comunidade no pqp");
    expect(description.startsWith("a gente perde junto")).toBe(true);
    expect(description).toContain("membros");
    expect(description).toContain("Games");
  });

  it("leads with the count when there is no tagline", () => {
    const { description } = communityCardText(
      { ...VALORANT, tagline: null },
      "pt-BR",
    );
    expect(description).toContain("1.240 membros");
    expect(description).toContain("Entra aí.");
  });

  it("says member, singular, for a community of one", () => {
    const { description } = communityCardText(
      { ...VALORANT, tagline: null, memberCount: 1 },
      "pt-BR",
    );
    expect(description).toContain("1 membro ");
  });

  it("answers in English when the reader's browser does", () => {
    const { title, description } = communityCardText(
      { ...VALORANT, tagline: null },
      "en",
    );
    expect(title).toContain("a community on pqp");
    expect(description).toContain("1,240 members");
  });

  it("falls back to the raw slug for a category it has never heard of", () => {
    // A category added to the app before it is added to this file must render
    // something true rather than a blank.
    const { description } = communityCardText(
      { ...VALORANT, tagline: null, category: "fofoca" },
      "pt-BR",
    );
    expect(description).toContain("fofoca");
  });
});

describe("absoluteImageUrl", () => {
  it("resolves our own root-relative paths against the API origin", () => {
    expect(
      absoluteImageUrl("/api/servers/abc/banner?v=1", "https://api.pqp.gg"),
    ).toBe("https://api.pqp.gg/api/servers/abc/banner?v=1");
  });

  it("passes an absolute https URL through", () => {
    expect(absoluteImageUrl("https://cdn.example.com/a.png", "x")).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("refuses anything an og:image must not carry", () => {
    // An unfurl with a broken image is worse than one with a generic image.
    expect(absoluteImageUrl("http://cdn.example.com/a.png", "x")).toBeNull();
    expect(absoluteImageUrl("data:image/svg+xml,<svg>", "x")).toBeNull();
    expect(absoluteImageUrl(null, "x")).toBeNull();
  });
});

describe("renderCommunityHead", () => {
  it("asks for a wide card when there is a banner to fill it", () => {
    // The one decision this file makes that `profile-meta.ts` does not: a
    // banner is 3:1 and a wide card is the shape it was cropped for.
    const head = renderCommunityHead(VALORANT, OPTIONS);
    expect(head).toContain('name="twitter:card" content="summary_large_image"');
    expect(head).toContain(
      'property="og:image" content="https://api.pqp.gg/api/servers/abc/banner?v=1"',
    );
  });

  it("falls back to the square icon and a small card without one", () => {
    const head = renderCommunityHead({ ...VALORANT, bannerUrl: null }, OPTIONS);
    expect(head).toContain('name="twitter:card" content="summary"');
    expect(head).toContain(
      'property="og:image" content="https://api.pqp.gg/api/servers/abc/icon?v=1"',
    );
  });

  it("falls back to the site card when there is no image at all", () => {
    const head = renderCommunityHead(
      { ...VALORANT, bannerUrl: null, iconUrl: null },
      OPTIONS,
    );
    expect(head).toContain("https://pqp.gg/images/og-image.jpg");
  });

  it("escapes everything a community owner controls", () => {
    const head = renderCommunityHead(
      {
        ...VALORANT,
        name: 'Valorant" onload="alert(1)',
        tagline: "<script>alert(1)</script>",
      },
      OPTIONS,
    );
    expect(head).not.toContain('onload="alert(1)"');
    expect(head).not.toContain("<script>alert(1)</script>");
    expect(head).toContain("&quot;");
  });

  it("cannot close its own JSON-LD block early", () => {
    const head = renderCommunityHead(
      { ...VALORANT, tagline: "</script><script>alert(1)</script>" },
      OPTIONS,
    );
    const jsonLd = head.slice(head.indexOf('type="application/ld+json"'));
    expect(jsonLd).not.toContain("</script><script>");
    expect(jsonLd).toContain("\\u003c");
  });

  it("declares an Organization and its join count, and no membership", () => {
    const head = renderCommunityHead(VALORANT, OPTIONS);
    expect(head).toContain('"@type":"Organization"');
    expect(head).toContain('"userInteractionCount":1240');
    // The page carries no member list; the structured data must not imply one.
    expect(head).not.toContain('"member"');
    expect(head).not.toContain('"memberOf"');
  });

  it("canonicalises to the /c/ URL and offers both languages", () => {
    const head = renderCommunityHead(VALORANT, OPTIONS);
    expect(head).toContain(
      '<link rel="canonical" href="https://pqp.gg/c/valorant-brasil" />',
    );
    expect(head).toContain('hreflang="pt-BR"');
    expect(head).toContain('hreflang="en"');
  });
});

describe("escapeHtml", () => {
  it("covers everything that can escape an attribute", () => {
    expect(escapeHtml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });
});

describe("injectCommunityHead", () => {
  it("replaces the product's own card in the real index.html", () => {
    // A document with two og:title tags is one where the crawler picks the
    // first, which would make the rewrite a no-op that looks like it worked.
    const out = injectCommunityHead(INDEX_HTML, VALORANT, OPTIONS);
    expect(out.match(/property="og:title"/g)).toHaveLength(1);
    expect(out.match(/<title>/g)).toHaveLength(1);
    expect(out).toContain("Valorant Brasil · comunidade no pqp");
  });

  it("leaves everything that is not the social vocabulary alone", () => {
    const out = injectCommunityHead(INDEX_HTML, VALORANT, OPTIONS);
    expect(out).toContain('<meta charset=');
    expect(out).toContain('name="viewport"');
    expect(out).toContain("</html>");
  });

  it("serves the document unchanged when there is no head to write into", () => {
    // Cannot happen with our own index.html, and serving the page unmodified is
    // the correct answer if it ever does — that is the bar every failure path
    // in this feature is held to.
    const html = "<p>no head here</p>";
    expect(injectCommunityHead(html, VALORANT, OPTIONS)).toBe(html);
  });
});
