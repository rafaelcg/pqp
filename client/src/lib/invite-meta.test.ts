// The REAL shipped document and the REAL robots.txt, imported through Vite's
// `?raw` rather than read off disk with `node:fs` — the client's tsconfig has
// no Node types, and this suite has no business being the one file that needs
// them.
import INDEX_HTML from "../../index.html?raw";
import ROBOTS_TXT from "../../public/robots.txt?raw";
import { describe, expect, it } from "vitest";
import { parseAppRoute } from "./app-route";
import {
  injectInviteHead,
  inviteCardText,
  inviteCodeFromMetaPath,
  renderInviteHead,
} from "./invite-meta";

/**
 * The `/app/invite/<code>` half of the Pages middleware.
 *
 * The middleware itself cannot be exercised without a wrangler runtime, so this
 * suite tests the whole of what could actually be wrong: the path parser that
 * decides whether the middleware acts at all, the card copy, and the rewrite —
 * run against THE REAL `index.html`, imported as text, so a change to the
 * shipped document that breaks the rewrite fails here rather than in
 * production. Same shape as `community-meta.test.ts`, one namespace over.
 *
 * The tests that matter most here are the ones about what the card does NOT
 * say. An invite link is semi-public, and every assertion below that starts
 * with `not` is a privacy rule written down where it can fail loudly.
 */

const OPTIONS = { siteOrigin: "https://pqp.gg", locale: "pt-BR" as const };

describe("inviteCodeFromMetaPath", () => {
  it("agrees with the app router on every path it claims", () => {
    // The duplication is deliberate (the middleware must not import the
    // workspace package — see the file header). This is what stops it drifting:
    // anything this parser claims must be a path the app itself resolves to the
    // same invite.
    const claimed = [
      "/app/invite/aBc12_xY",
      "/app/invite/aBc12_xY/",
      "/app/invite/a",
      "/app/invite/abc-def_GHI",
    ];
    for (const path of claimed) {
      const code = inviteCodeFromMetaPath(path);
      expect([path, code]).not.toEqual([path, null]);
      expect([path, parseAppRoute(path)]).toEqual([
        path,
        { kind: "invite", code },
      ]);
    }
  });

  it("does not act on anything that is not an invite URL", () => {
    // This runs in front of EVERY request the site serves, including every
    // hashed asset, so a loose parser starts rewriting the landing page.
    for (const path of [
      "/",
      "/@rafa",
      "/c/valorant",
      "/app",
      "/app/invite",
      "/app/invite/",
      "/app/server/x",
      "/app/dm/x",
      "/appointments/invite/x",
      "/assets/index-abc123.js",
    ]) {
      expect([path, inviteCodeFromMetaPath(path)]).toEqual([path, null]);
    }
  });

  it("is stricter than the app router, in the safe direction", () => {
    // `parseAppRoute` hands what it finds to an API call that will refuse it;
    // this hands it to a `<head>`. A path that is not shaped like a code falls
    // through to the product's own card rather than being injected.
    for (const path of [
      '/app/invite/"><script>alert(1)</script>',
      "/app/invite/código",
      "/app/invite/" + "a".repeat(200),
      "/app/invite/abc/extra",
    ]) {
      expect([path, inviteCodeFromMetaPath(path)]).toEqual([path, null]);
    }
    // ...and the router does claim two of those, which is exactly the gap this
    // parser is narrower than.
    expect(parseAppRoute("/app/invite/código")?.kind).toBe("invite");
    expect(parseAppRoute("/app/invite/abc/extra")?.kind).toBe("invite");
  });

  it("keeps a code's case, because a code is a secret and not a name", () => {
    // Handles and community slugs are folded to lowercase; those are names.
    expect(inviteCodeFromMetaPath("/app/invite/AbCdEf12")).toBe("AbCdEf12");
  });

  it("survives a truncated percent escape", () => {
    expect(inviteCodeFromMetaPath("/app/invite/%E0%A4%A")).toBeNull();
  });
});

describe("inviteCardText", () => {
  it("says an invitation exists and what clicking it does", () => {
    const { title, description } = inviteCardText("pt-BR");
    expect(title).toBe("Você recebeu um convite no pqp");
    expect(description).toContain("comunidade");
  });

  it("answers in English when the reader's browser does", () => {
    const { title } = inviteCardText("en");
    expect(title).toContain("invite to a community on pqp");
  });

  it("stays inside what WhatsApp will actually show", () => {
    // WhatsApp truncates a description at roughly 120 characters and it is most
    // of the audience for this particular link.
    for (const locale of ["pt-BR", "en"] as const) {
      expect(inviteCardText(locale).description.length).toBeLessThanOrEqual(120);
      expect(inviteCardText(locale).title.length).toBeLessThanOrEqual(70);
    }
  });
});

describe("renderInviteHead", () => {
  it("writes an invitation where the product's card used to be", () => {
    const head = renderInviteHead("aBc12_xY", "https://pqp.gg", "pt-BR");
    expect(head).toContain(
      '<meta property="og:title" content="Você recebeu um convite no pqp" />',
    );
    expect(head).toContain('name="twitter:card" content="summary_large_image"');
    expect(head).toContain(
      '<meta property="og:image" content="https://pqp.gg/images/og-image.jpg" />',
    );
  });

  it("refuses to index the link it just made shareable", () => {
    // The card is for the group the link was sent to. A search result carrying
    // an invite is that link escaping the group.
    const head = renderInviteHead("aBc12_xY", "https://pqp.gg", "pt-BR");
    expect(head).toContain('name="robots" content="noindex, nofollow"');
    expect(head).not.toContain("index, follow");
  });

  it("points og:url at the URL that was actually requested", () => {
    // Facebook re-fetches an og:url that differs from the URL it was given and
    // renders whatever that answers with, so a "safer" og:url of the site root
    // would silently restore the generic homepage card.
    const head = renderInviteHead("aBc12_xY", "https://pqp.gg", "pt-BR");
    expect(head).toContain(
      '<meta property="og:url" content="https://pqp.gg/app/invite/aBc12_xY" />',
    );
  });

  it("offers no canonical for a page that is a door", () => {
    // A canonical elsewhere is read by the unfurlers that follow one as "show
    // that page's card instead", which is the bug being fixed; a canonical here
    // would contradict the noindex.
    const head = renderInviteHead("aBc12_xY", "https://pqp.gg", "pt-BR");
    expect(head).not.toContain("rel=\"canonical\"");
    expect(head).not.toContain("hreflang");
    expect(head).not.toContain("ld+json");
  });

  it("names nothing about the community behind the code", () => {
    // The whole argument of the feature: an invite is semi-public, not a
    // licence to publish a private room's identity to every forward of the
    // link. The card is identical for every invite on the service.
    const one = renderInviteHead("aBc12_xY", "https://pqp.gg", "pt-BR");
    const other = renderInviteHead("zZ99tt00", "https://pqp.gg", "pt-BR");
    expect(one.replace("aBc12_xY", "CODE")).toBe(
      other.replace("zZ99tt00", "CODE"),
    );
  });

  it("unfurls a dead invite exactly like a live one", () => {
    // Nothing is fetched, so there is no name to leak from a revoked, expired
    // or invented code, and no oracle telling somebody holding a guessed code
    // whether it is real. Stated as a test because it is a property, not an
    // accident of the implementation.
    expect(renderInviteHead("revoked1", "https://pqp.gg", "pt-BR")).toBe(
      renderInviteHead("nevermade", "https://pqp.gg", "pt-BR").replace(
        "nevermade",
        "revoked1",
      ),
    );
  });

  it("escapes the one thing in it a stranger controls", () => {
    // The parser already refuses anything that is not base64url; this is the
    // second lock on the same door, because the code is interpolated into an
    // attribute in a document.
    const head = renderInviteHead(
      'a" onload="alert(1)',
      'https://pqp.gg/x" onload="alert(1)',
      "pt-BR",
    );
    expect(head).not.toContain('onload="alert(1)"');
    expect(head).toContain("&quot;");
  });
});

describe("injectInviteHead", () => {
  it("replaces the product's own card in the real index.html", () => {
    // A document with two og:title tags is one where the crawler picks the
    // first, which would make the rewrite a no-op that looks like it worked.
    const out = injectInviteHead(INDEX_HTML, "aBc12_xY", OPTIONS);
    expect(out.match(/property="og:title"/g)).toHaveLength(1);
    expect(out.match(/<title>/g)).toHaveLength(1);
    expect(out).toContain("Você recebeu um convite no pqp");
  });

  it("strips the one tag with an underscore in its name, too", () => {
    // `og:site_name` is why the strip pattern here is `[a-zA-Z:_]+` and not the
    // `[a-zA-Z:]+` the four sibling builders use: theirs miss it, and every
    // rewritten page in production today ships two of these. Both say "pqp", so
    // nothing visible is wrong, which is why nobody noticed.
    const out = injectInviteHead(INDEX_HTML, "aBc12_xY", OPTIONS);
    expect(out.match(/property="og:site_name"/g)).toHaveLength(1);
  });

  it("strips the shipped canonical and structured data it does not rewrite", () => {
    // index.html canonicalises to https://pqp.gg/ and carries product JSON-LD.
    // Leaving either would hand the crawler a homepage-shaped answer next to
    // an invite-shaped one.
    expect(INDEX_HTML).toContain('<link rel="canonical"');
    expect(INDEX_HTML).toContain("application/ld+json");
    const out = injectInviteHead(INDEX_HTML, "aBc12_xY", OPTIONS);
    expect(out).not.toContain('rel="canonical"');
    expect(out).not.toContain("application/ld+json");
  });

  it("leaves everything that is not the social vocabulary alone", () => {
    const out = injectInviteHead(INDEX_HTML, "aBc12_xY", OPTIONS);
    expect(out).toContain("<meta charset=");
    expect(out).toContain('name="viewport"');
    expect(out).toContain('name="theme-color"');
    expect(out).toContain("</html>");
  });

  it("declares the document Portuguese when the card is written in it", () => {
    expect(injectInviteHead(INDEX_HTML, "aBc12_xY", OPTIONS)).toContain(
      '<html lang="pt-BR">',
    );
    expect(
      injectInviteHead(INDEX_HTML, "aBc12_xY", { ...OPTIONS, locale: "en" }),
    ).toContain('<html lang="en">');
  });

  it("serves the document unchanged when there is no head to write into", () => {
    // Cannot happen with our own index.html, and serving the page unmodified is
    // the correct answer if it ever does — that is the bar every failure path
    // in this feature is held to.
    const html = "<p>no head here</p>";
    expect(injectInviteHead(html, "aBc12_xY", OPTIONS)).toBe(html);
  });
});

describe("robots.txt", () => {
  it("lets a compliant unfurler fetch an invite, and nothing else under /app", () => {
    // Twitter's bot respects this file and was refusing to fetch the URL at
    // all, so the card it never read could not have helped. The Allow must
    // precede the Disallow so first-match parsers agree with longest-match
    // ones.
    const allow = ROBOTS_TXT.indexOf("Allow: /app/invite/");
    const disallow = ROBOTS_TXT.indexOf("Disallow: /app");
    expect(allow).toBeGreaterThan(-1);
    expect(disallow).toBeGreaterThan(-1);
    expect(allow).toBeLessThan(disallow);
  });

  it("is paired with a noindex, which is the half that keeps invites private", () => {
    // Permission to fetch is not permission to index. If one of these two ever
    // moves without the other, this fails.
    expect(renderInviteHead("aBc12_xY", "https://pqp.gg", "pt-BR")).toContain(
      "noindex",
    );
  });
});
