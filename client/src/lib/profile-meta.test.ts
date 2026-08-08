// The REAL shipped document, imported through Vite's `?raw` rather than read
// off disk with `node:fs` — the client's tsconfig has no Node types, and this
// suite has no business being the one file that needs them.
import INDEX_HTML from "../../index.html?raw";
import { handleFromPath } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import {
  absoluteAvatarUrl,
  escapeHtml,
  handleFromMetaPath,
  injectProfileHead,
  preferredLocale,
  profileCardText,
  renderProfileHead,
  type ProfileMeta,
} from "./profile-meta";

/**
 * The Cloudflare Pages middleware cannot be exercised without a wrangler
 * runtime, so this suite tests the whole of what could actually be wrong: the
 * path parser that decides whether the middleware acts at all, the card copy,
 * and the rewrite itself — run against THE REAL `index.html`, imported as text, so
 * a change to the shipped document that breaks the rewrite fails here rather
 * than in production.
 */

const OPTIONS = {
  siteOrigin: "https://pqp.gg",
  apiOrigin: "https://api.pqp.gg",
  locale: "pt-BR" as const,
};

const RAFA: ProfileMeta = {
  handle: "rafa",
  displayName: "Rafa",
  avatarUrl: "/api/avatars/abc?v=1",
  badges: [{ name: "Futebol" }, { name: "Games" }],
  depoimentoCount: 7,
};

describe("handleFromMetaPath", () => {
  it("agrees with the shared parser on every path either might see", () => {
    // The duplication is deliberate (the middleware must not import the
    // workspace package — see the file header). This is what stops it drifting.
    const paths = [
      "/@rafa",
      "/@rafa/",
      "/@Rafa",
      "/@ab",
      "/@admin",
      "/@a".padEnd(30, "b"),
      "/",
      "/app",
      "/garanta",
      "/privacy",
      "/@",
      "/@rafa/x",
      "/rafa",
      "/assets/index-abc123.js",
    ];
    for (const path of paths) {
      expect(handleFromMetaPath(path)).toBe(handleFromPath(path));
    }
  });

  it("acts on a profile path and on nothing else", () => {
    expect(handleFromMetaPath("/@rafa")).toBe("rafa");
    expect(handleFromMetaPath("/@Rafa")).toBe("rafa");
    expect(handleFromMetaPath("/")).toBeNull();
    expect(handleFromMetaPath("/app/dm")).toBeNull();
    expect(handleFromMetaPath("/assets/index-abc.js")).toBeNull();
  });

  it("survives a malformed percent escape without throwing", () => {
    expect(handleFromMetaPath("/@%E0%A4%A")).toBeNull();
  });
});

describe("preferredLocale", () => {
  it("obeys an explicit ?lang=", () => {
    expect(preferredLocale("?lang=en", "pt-BR")).toBe("en");
    expect(preferredLocale("?lang=pt-BR", "en-US")).toBe("pt-BR");
  });

  it("defaults to Portuguese, because that is who this is for", () => {
    expect(preferredLocale("", null)).toBe("pt-BR");
    expect(preferredLocale("", "fr-FR,fr;q=0.9")).toBe("pt-BR");
  });

  it("gives English to a browser that actually leads with it", () => {
    expect(preferredLocale("", "en-US,en;q=0.9")).toBe("en");
  });

  it("does not mistake an English fallback for an English reader", () => {
    expect(preferredLocale("", "pt-BR,pt;q=0.9,en;q=0.8")).toBe("pt-BR");
  });
});

describe("profileCardText", () => {
  it("names the person and the handle in the title", () => {
    expect(profileCardText(RAFA, "pt-BR").title).toBe("Rafa (@rafa) no pqp");
    expect(profileCardText(RAFA, "en").title).toBe("Rafa (@rafa) on pqp");
  });

  it("lists one or two communities and counts more than that", () => {
    const one = profileCardText({ ...RAFA, badges: [{ name: "Futebol" }] }, "pt-BR");
    expect(one.description).toContain("Futebol");
    const many = profileCardText(
      { ...RAFA, badges: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      "pt-BR",
    );
    expect(many.description).toContain("3 comunidades");
  });

  it("still says something when the profile is empty", () => {
    const bare = profileCardText(
      { ...RAFA, badges: [], depoimentoCount: 0 },
      "pt-BR",
    );
    expect(bare.description).toContain("Garanta o seu @");
    expect(bare.description.length).toBeGreaterThan(10);
  });

  it("keeps the description inside what an unfurler will show", () => {
    const long = profileCardText(
      {
        handle: "a".repeat(20),
        displayName: "N".repeat(60),
        avatarUrl: null,
        badges: [{ name: "x" }, { name: "y" }, { name: "z" }],
        depoimentoCount: 999,
      },
      "pt-BR",
    );
    expect(long.description.length).toBeLessThan(120);
  });
});

describe("absoluteAvatarUrl", () => {
  it("resolves this API's own path against the API origin", () => {
    expect(absoluteAvatarUrl("/api/avatars/abc?v=1", "https://api.pqp.gg")).toBe(
      "https://api.pqp.gg/api/avatars/abc?v=1",
    );
  });

  it("passes an absolute https URL through", () => {
    expect(absoluteAvatarUrl("https://cdn.test/a.png", "https://api.pqp.gg")).toBe(
      "https://cdn.test/a.png",
    );
  });

  it("refuses anything a card cannot safely load", () => {
    for (const bad of [null, "", "http://insecure.test/a.png", "data:image/png;base64,AAA", "javascript:alert(1)"]) {
      expect(absoluteAvatarUrl(bad, "https://api.pqp.gg")).toBeNull();
    }
  });
});

describe("escapeHtml", () => {
  it("closes every way out of an attribute", () => {
    expect(escapeHtml('a"><script>x</script>')).toBe(
      "a&quot;&gt;&lt;script&gt;x&lt;/script&gt;",
    );
  });
});

describe("renderProfileHead", () => {
  it("escapes a display name that is trying to break out", () => {
    const head = renderProfileHead(
      { ...RAFA, displayName: '"><img src=x onerror=alert(1)>' },
      OPTIONS,
    );
    expect(head).not.toContain("<img src=x");
    expect(head).toContain("&quot;&gt;&lt;img");
  });

  it("cannot close its own JSON-LD block", () => {
    const head = renderProfileHead(
      { ...RAFA, displayName: "</script><script>alert(1)</script>" },
      OPTIONS,
    );
    const jsonLd = head.slice(head.indexOf('application/ld+json'));
    expect(jsonLd.indexOf("</script>")).toBe(jsonLd.lastIndexOf("</script>"));
  });

  it("uses a square-friendly Twitter card, since the image is an avatar", () => {
    expect(renderProfileHead(RAFA, OPTIONS)).toContain(
      'name="twitter:card" content="summary"',
    );
  });

  it("falls back to the site card image when there is no usable avatar", () => {
    const head = renderProfileHead({ ...RAFA, avatarUrl: null }, OPTIONS);
    expect(head).toContain("https://pqp.gg/images/og-image.jpg");
  });

  it("canonicalises to the profile URL and offers both languages", () => {
    const head = renderProfileHead(RAFA, OPTIONS);
    expect(head).toContain('rel="canonical" href="https://pqp.gg/@rafa"');
    expect(head).toContain('hreflang="pt-BR"');
    expect(head).toContain('hreflang="en"');
  });

  it("asks to be indexed — this page is the point of the feature", () => {
    expect(renderProfileHead(RAFA, OPTIONS)).toContain(
      'content="index, follow"',
    );
  });
});

describe("injectProfileHead against the real index.html", () => {
  const output = injectProfileHead(INDEX_HTML, RAFA, OPTIONS);

  it("replaces the product's title rather than adding a second one", () => {
    expect(output.match(/<title>/g)).toHaveLength(1);
    expect(output).toContain("<title>Rafa (@rafa) no pqp</title>");
    expect(output).not.toContain("pqp — group chat you own");
  });

  it("leaves exactly one of each social tag", () => {
    for (const tag of [
      'property="og:title"',
      'property="og:description"',
      'property="og:image"',
      'property="og:url"',
      'name="twitter:title"',
      'name="twitter:image"',
      'rel="canonical"',
    ]) {
      expect(output.split(tag)).toHaveLength(2);
    }
  });

  it("keeps everything that is not SEO", () => {
    // The pre-paint theme script, the viewport, the icons and the font
    // preconnects all have to survive — a rewrite that drops them ships a page
    // that flashes white and renders in Times New Roman.
    expect(output).toContain('name="viewport"');
    expect(output).toContain('rel="apple-touch-icon"');
    expect(output).toContain("fonts.googleapis.com");
    expect(output).toContain('localStorage.getItem("pqp-theme")');
    expect(output).toContain('name="theme-color"');
    expect(output).toContain('<script type="module"');
  });

  it("replaces the site's structured data with the profile's", () => {
    expect(output).toContain('"@type":"ProfilePage"');
    expect(output).not.toContain("SoftwareApplication");
    expect(output.match(/application\/ld\+json/g)).toHaveLength(1);
  });

  it("still parses as one document with a head and a root div", () => {
    expect(output.indexOf("<head>")).toBeLessThan(output.indexOf("</head>"));
    expect(output).toContain('<div id="root"></div>');
  });

  it("returns a document with no head untouched", () => {
    expect(injectProfileHead("<p>hi</p>", RAFA, OPTIONS)).toBe("<p>hi</p>");
  });
});
