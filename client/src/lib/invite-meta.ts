/**
 * Server-side meta injection for `/app/invite/<code>`, the most-shared URL this
 * product has.
 *
 * THE PROBLEM, one namespace over from `profile-meta.ts` and worse. Somebody
 * creates a community, copies the invite, pastes it into a WhatsApp group, and
 * it unfurls as "pqp: group chat you own" over a stock photograph: the product
 * introducing itself to people who were not asking about a product. The one
 * sentence the card had to carry is the one nobody wrote down. This is a static
 * SPA, `Seo` fixes the head in the browser, and WhatsApp, Discord, Telegram,
 * Facebook and Twitter all read the bytes without running the script.
 *
 * THE FIFTH HEAD BUILDER, and the only one that is deliberately anonymous. The
 * other four name the thing they describe: a person, a community, a marketing
 * page, a release note. This one names nothing, and that is the design rather
 * than a gap in it. See NAMES, below.
 *
 * NAMES. An invite is semi-public: whoever holds the link can walk in, so the
 * link is not a secret. It is not a licence either. Putting the community's
 * name in the card would publish it to everyone the link ever touches, which
 * includes every forward, every screenshot, and every crawler that reaches the
 * URL, for servers whose owners never opted into being public at all.
 * `docs/HANDLES.md` sets the house position for the two surfaces that DO carry
 * a name: `/@handle` exists because a person claimed a public handle, and
 * `pqp.gg/c/<slug>` exists because an owner opted a community into the
 * directory. Neither is true of an ordinary server, which is what almost every
 * invite points at. So this card says that an invitation exists and what
 * clicking it does, and leaves the identity of the room to the page itself,
 * which asks for a login first.
 *
 * WHICH ALSO SETTLES THE HARD CASE. A revoked, expired, exhausted, or entirely
 * invented code unfurls exactly like a live one, because nothing is looked up.
 * There is no name to leak from a dead invite and no oracle that tells a
 * stranger holding a guessed code whether it is real. Had this fetched, that
 * difference would have had to be engineered back in on purpose.
 *
 * NOTHING IS FETCHED, and therefore nothing about this depends on
 * `COMMUNITIES_ENABLED`, on the API being up, or on an invite belonging to a
 * community rather than a plain server. It is a pure string rewrite, like the
 * marketing and blog builders and unlike the profile and community ones, so
 * the middleware branch runs before the API origin is even resolved.
 *
 * WHAT A NAMED CARD WOULD COST. It needs `GET /api/public/invites/:code`,
 * unauthenticated, answering at most a name and an icon and ONLY for a server
 * that already opted into the public directory, 404 for everything else so
 * revoked, private and never-existed stay indistinguishable. That endpoint does
 * not exist today (`GET /api/invites/:code` requires a Bearer token, which the
 * edge does not have), and adding one is an API deploy. This module is the half
 * that does not need one.
 *
 * DELIBERATELY DEPENDENCY-FREE, like its four siblings: wrangler's esbuild
 * bundles it outside the pnpm workspace, so it cannot import `@pqp/shared` or
 * the i18n JSON. `invite-meta.test.ts` pins the path parser against
 * `parseAppRoute`, so the duplication cannot drift without failing the suite.
 * `escapeHtml` is imported from `marketing-meta` for the reason `blog-meta`
 * gives: the middleware already loads that module unconditionally, so sharing
 * it costs no bytes and removes another place for an escaping bug to hide.
 */

import { escapeHtml } from "./marketing-meta";

export type InviteLocale = "pt-BR" | "en";

/**
 * What a generated code looks like: `randomBytes(5).toString("base64url")`
 * truncated to eight characters, so base64url's alphabet and nothing else.
 * Bounded well above eight because the generator is the server's business and
 * may change, and bounded at all because this string is interpolated into an
 * attribute in a document.
 *
 * Codes are matched case-sensitively, unlike handles and community slugs. A
 * handle is a name and names are folded; an invite code is a secret and
 * `AbC` is a different secret from `abc`.
 */
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The code in `/app/invite/aBc12_xY`, or null for every other path.
 *
 * Null is the middleware's "not my business" answer and it has to be exactly
 * that: this runs in front of EVERY request the site serves, including every
 * hashed asset under `/assets/`, so the check is a prefix test followed by a
 * pattern match and never a loose one.
 *
 * Stricter than `parseAppRoute`, on purpose and in the safe direction.
 * `parseAppRoute` accepts any non-empty segment because it hands whatever it
 * finds to an API call that will refuse it; this hands it to a `<head>`. A
 * code that does not match the shape a code has falls through to the product's
 * own card, which is the correct answer for a URL that was never an invite.
 */
export function inviteCodeFromMetaPath(pathname: string): string | null {
  const match = /^\/app\/invite\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return CODE_PATTERN.test(decoded) ? decoded : null;
}

/**
 * The card's words.
 *
 * "Comunidade" rather than "servidor" because that is what the product calls a
 * server everywhere a person can read it (`invite.join.eyebrow`,
 * `invite.create.serverFallback`), and the card is read by somebody who has
 * never seen the app.
 *
 * Short on purpose. WhatsApp truncates a description at roughly 120 characters
 * and Twitter at 200, and WhatsApp is most of the audience for this particular
 * link, so the sentence that has to survive the cut comes first: somebody
 * invited you, and here is where.
 *
 * No name in either string. That is the point of the file; see the header.
 */
export function inviteCardText(locale: InviteLocale): {
  title: string;
  description: string;
} {
  return locale === "pt-BR"
    ? {
        title: "Você recebeu um convite no pqp",
        description:
          "Alguém te chamou pra uma comunidade no pqp. Abre o link pra ver qual é e entrar. De graça, sem instalar nada.",
      }
    : {
        title: "You have an invite to a community on pqp",
        description:
          "Someone invited you to a community on pqp. Open the link to see which one and come in. Free, nothing to install.",
      };
}

/**
 * Every tag the rewrite manages, as one string.
 *
 * `noindex, nofollow` IS THE ONE TAG THIS FILE CARES MOST ABOUT. Every other
 * builder here says `index, follow`, because every other builder describes a
 * page that exists to be found. An invite URL exists to be handed to one group
 * of people, and a search result carrying one is that link escaping the group
 * it was sent to. Crawlers must be able to read the card and must not be able
 * to keep the address, and those are two different permissions: the unfurl is
 * the fetch, the index is what this tag refuses. `robots.txt` allows the fetch
 * for exactly this reason, and this is the other half of that pair.
 *
 * NO CANONICAL AND NO HREFLANG, unlike all four siblings. A canonical pointing
 * anywhere else would be read by the unfurlers that follow one (LinkedIn does)
 * as "show that page's card instead", which is the bug being fixed; a canonical
 * pointing here would contradict the `noindex` directly above it. There is
 * nothing to canonicalise: the page is a door, not a document.
 *
 * `og:url` IS THE REQUESTED URL, code and all, because it has to be. Facebook
 * re-fetches an `og:url` that differs from the URL it was given and renders
 * whatever that answers with — so a "safer" `og:url` of the site root would
 * silently restore the generic homepage card on the platform with the most
 * reach. The code is not published by being echoed: the crawler already has it,
 * it arrived in the request line. It is escaped anyway, and the parser above
 * has already refused anything that is not base64url.
 *
 * No JSON-LD. Structured data on a `noindex` page describes nothing to nobody,
 * and the only entity worth describing is the one this card will not name.
 */
export function renderInviteHead(
  code: string,
  siteOrigin: string,
  locale: InviteLocale,
): string {
  const { title, description } = inviteCardText(locale);
  const url = `${siteOrigin}/app/invite/${encodeURIComponent(code)}`;
  // The site's own card image. There is no per-invite picture to show and
  // there must not be one: a community's icon IS its identity, and the whole
  // argument of this file is that an invite card does not publish that.
  const image = `${siteOrigin}/images/og-image.jpg`;
  const e = escapeHtml;

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="robots" content="noindex, nofollow" />`,
  ].join("\n    ");
}

/**
 * Every tag this module owns, so a second injection cannot leave two titles in
 * one document. Deliberately the same shape as the copy in `marketing-meta`,
 * `profile-meta`, `community-meta` and `blog-meta`: each builder strips what it
 * writes, and only ever one of them runs on a given request.
 *
 * It strips `<link rel="canonical">` and the `ld+json` block even though this
 * builder writes neither back. That is the whole reason the strip is here: the
 * shipped `index.html` canonicalises to `https://pqp.gg/` and carries product
 * structured data, and leaving either in place would hand the crawler a
 * homepage-shaped answer next to an invite-shaped one.
 *
 * The property class is `[a-zA-Z:_]+` and NOT the `[a-zA-Z:]+` its four
 * siblings use, which is one character and one real bug: `og:site_name` has an
 * underscore in it, so the siblings do not strip it and every rewritten page on
 * the site today ships two `og:site_name` tags. Both say "pqp", so nothing
 * visible is wrong and nobody noticed. Fixed here rather than everywhere
 * because this file is the change; the siblings are a one-character follow-up.
 */
const MANAGED_TAGS =
  /[ \t]*(?:<title>[\s\S]*?<\/title>|<meta\s+(?:name|property)="(?:description|robots|og:[a-zA-Z:_]+|twitter:[a-zA-Z:_]+)"[\s\S]*?\/>|<link\s+rel="canonical"[^>]*\/>|<link\s+rel="alternate"[^>]*\/>|<script type="application\/ld\+json">[\s\S]*?<\/script>)\n?/g;

/**
 * Rewrite a document's head for one invite link.
 *
 * Also corrects `<html lang="en">` when the head is being written in
 * Portuguese, for the reason `marketing-meta` gives: a pt-BR title on a
 * document that declares itself English is a mixed signal to exactly the
 * readers this rewrite exists for.
 *
 * Returns the html unchanged when it has no `<head>`, which is the bar every
 * failure path in this feature is held to: a page that unfurls badly is a bad
 * day, a page that 500s at the edge is a dead link, and this middleware sits in
 * front of the whole site.
 */
export function injectInviteHead(
  html: string,
  code: string,
  options: { siteOrigin: string; locale: InviteLocale },
): string {
  if (html.indexOf("<head>") === -1) {
    return html;
  }
  let stripped = html.replace(MANAGED_TAGS, "");
  if (options.locale === "pt-BR") {
    stripped = stripped.replace('<html lang="en">', '<html lang="pt-BR">');
  }
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return (
    stripped.slice(0, insertAt) +
    "\n    " +
    renderInviteHead(code, options.siteOrigin, options.locale) +
    stripped.slice(insertAt)
  );
}
