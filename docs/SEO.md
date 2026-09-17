# SEO: audit, fixes, and the keyword plan

Snapshot: Search Console on 2026-09-14 (49 indexed, 40 not, plus a fresh
"Indexed, though blocked by robots.txt" warning). Written 2026-09-17. Read
[`CLAUDE.md`](../CLAUDE.md) first for what the product actually does today:
every claim below is checked against that and the docs it points at, not
invented.

## What this PR fixes

### 1. `/app/*` was indexed with no content, and `robots.txt` could not stop it

Two URLs Rafael found in Search Console: `/app/server/<id>` and
`/app/server/<id>/channel/<id>`, status "Indexed, though blocked by robots.txt".
`robots.txt` carried `Disallow: /app` (with `Allow: /app/invite/` as the one
exception), on the theory that a crawler kept out of a login-gated tree cannot
index it. That is only true for a crawler that *discovers* the URL by
crawling. One handed the URL directly (an old share, a link in a chat log)
indexes it anyway with no title and no description, because `Disallow` stops
the fetch, and a directive a crawler never fetches is a directive it never
reads.

**Fixed the other way around.** `robots.txt` no longer disallows `/app` (see
`client/public/robots.txt`); the crawl is let through, and the Cloudflare
Pages middleware answers every `/app/*` GET except `/app/invite/*` with
`X-Robots-Tag: noindex, nofollow`, a header a crawler reads before it parses a
single byte of the sign-in screen it would otherwise index. Pure predicate in
`client/src/lib/app-robots.ts` (`isNoIndexAppPath`), wired into
`client/functions/_middleware.ts`, tested in `app-robots.test.ts`. Nothing
about `/app/invite/<code>` changes: it already carries its own `noindex`
through `injectInviteHead`'s meta tag, and it has to stay crawlable so an
unfurler can still draw a card for a pasted invite link.

**What Rafael has to do:** nothing to ship this, but the two known URLs stay
"indexed" in Search Console until Google recrawls them and sees the new
header. Use *URL Inspection → Request Indexing* on both once this is live, or
wait for the normal recrawl cycle.

### 2. Technical SEO on every landing and blog page

Already in place before this PR and unchanged: canonical tags, `hreflang`
(`x-default`, `pt-BR`, `en` via `?lang=`) on every marketing and blog page,
Open Graph and Twitter cards, and `FAQPage` JSON-LD on `/`, `/vs-discord` and
`/tela` built from the FAQ section each page actually renders. That machinery
lives in `client/src/lib/marketing-meta.ts` and `client/src/lib/blog-meta.ts`,
both injected at the Cloudflare Pages edge (`client/functions/_middleware.ts`)
because this is a static SPA and a crawler never runs the client-side `Seo`
component.

**Added in this PR:**

- An `Organization` JSON-LD node on every marketing page (`marketing-meta.ts`),
  with `sameAs` pointing at the two other public places this product answers
  for itself today: the GitHub repository and the Google Play listing
  (`docs/ANDROID_RELEASE.md` records production access as open for it). The
  App Store is deliberately absent: TestFlight is a beta enrollment, not a
  public listing.
- The landing's `SoftwareApplication` node now carries that same `sameAs` and
  an `operatingSystem` list that names every platform the product actually
  ships on (Web, Windows, macOS, Linux, Android) instead of just "Web".
- `Article` + `FAQPage` + `BreadcrumbList` JSON-LD on the six new guides
  (`blog-meta.ts`'s `jsonLdForArticle`), built from the same FAQ copy the page
  renders, same rule the marketing pages already follow.
- All six guides in `client/public/sitemap.xml`, and in `/blog`'s own `Blog`
  JSON-LD `blogPost` list.

### 3. `/blog` mixed two kinds of content under one changelog title

The route already existed for release notes (What's New), titled "Notas de
versão": a weekly catch-up, not a place for tactical guides (see
`CLAUDE.md`'s rule on release notes). Rather than writing six guides *as*
release notes, which would have meant either lying about their publish date to
satisfy the "newest first" invariant `POSTS` is held to, or giving guides a
`BlogPosting` schema with no `dateModified` when a guide is meant to be
corrected in place, the two are now two separate lists (`blog/posts.ts` for
release notes, `blog/articles.ts` for guides) sharing one `/blog/<slug>` URL
space and one index page, in their own sections: **Guias** first, **Notas de
versão** below. The index's own title changed from "Notas de versão · pqp" to
"Blog · pqp" to describe what is actually on the page now.

### 4. Robots/sitemap consistency, pinned

`client/src/lib/seo-files.test.ts` reads the real `robots.txt` and
`sitemap.xml` and asserts every sitemap URL is crawlable under every named
rule group (the default one and the AI-crawler one, which are meant to
match). This is the guard that would have caught the `/app` contradiction
above before it reached Search Console.

## What Search Console's other buckets probably are

Rafael's snapshot named a few more buckets without exact URLs yet. Best
explanation for each, to revisit once the exact URLs are in hand:

- **"Alternate page with proper canonical" (25).** The likely majority is the
  `?lang=pt-BR` / `?lang=en` hreflang alternate URLs `Seo` and the edge
  injectors emit, each correctly canonicalising back to the bare path, plus
  `/claim` canonicalising to `/garanta`. This is Google doing exactly what
  hreflang is for, not a defect: worth spot-checking the exact URLs once
  Rafael has them, but not something to "fix" on the current evidence.
- **"Blocked by robots.txt" (5).** Plausibly the pre-fix `/app/*` crawl
  attempts recorded before this PR; should shrink after the `Disallow: /app`
  removal above propagates and Google recrawls.
- **"Excluded by noindex" (3).** Expected for `/app/invite/<code>` links that
  got shared and crawled: they are supposed to be excluded, that is the
  point of `injectInviteHead`'s meta tag.
- **"Page with redirect" (3)** and **"Crawled, currently not indexed" (4)**:
  no strong theory without the URLs. Worth a follow-up once Rafael has them:
  the redirect bucket in particular is worth checking for a trailing-slash or
  scheme redirect nothing here currently audits.
- **"Page indexed without content" (1).** Likely one of the two `/app/*` URLs
  named above, or its sibling; should resolve the same way.

## What is not fixed in this PR, on purpose

- **The SPA still renders titles client-side for everything outside the
  edge-covered surfaces** (marketing pages, `/blog/*`, `/@handle`, `/c/<slug>`,
  invites). Every route this PR touches is already edge-covered. A route added
  later that is meant to be indexed needs its own head builder the same way:
  there is no generic prerender step, by design (see `marketing-meta.ts`'s file
  comment on why the builders are kept separate rather than unified).
- **The Search Console buckets without exact URLs** (see above) are read from
  Rafael's count snapshot, not verified against the live Search Console UI.
  Confirm the exact URLs before spending more effort on any one bucket.
- **Play Store and TestFlight are not full public store listings yet.** The
  Play listing has production access open (per `docs/ANDROID_RELEASE.md`) and
  is linked from the new guides and from `Organization.sameAs`; TestFlight is
  a beta enrollment and is deliberately kept out of structured data for that
  reason. Update `ORGANIZATION_SAME_AS` in `marketing-meta.ts` once an App
  Store listing exists.

## Keyword plan

Fifteen target queries, grouped by intent, pt-BR first. "Current state" is
what actually ranks or answers that query on `pqp.gg` today, checked against
this repository, not assumed.

### pt-BR: comparação e alternativa

| Query | Intent | Target page | Current state |
|---|---|---|---|
| alternativa ao discord | Comparação | `/vs-discord`, `/blog/pqp-vs-discord-2026` | `/vs-discord` already targets this explicitly (`robots.txt` calls it out by name); the new guide adds a second, longer-form answer with an FAQ Google can quote directly |
| discord alternativa brasileira | Comparação, geo | `/vs-discord`, `/` | Landing copy already says "Feito no Brasil"; no page targets the Brazilian-specific phrasing directly yet |
| qual a melhor alternativa ao discord em 2026 | Pergunta estilo IA | `/blog/pqp-vs-discord-2026` | New: the guide's title and FAQ are written for this exact question shape |
| discord sem lag | Dor específica | `/vs-discord`, `/blog/pqp-vs-discord-2026` | Not a dedicated page; the comparison page's honesty about what still favors Discord (bots, directory size) is the closest existing answer |
| servidor de voz gratis | Navegacional, genérico | `/`, `/garanta` | Landing already leads with "De graça"; no dedicated "free voice server" page |

### pt-BR: watch party e tela

| Query | Intent | Target page | Current state |
|---|---|---|---|
| assistir filme junto online com amigos | Como fazer | `/blog/watch-party-assistir-filme-com-amigos` | New: this is the guide's primary query |
| watch party com amigos | Como fazer, navegacional | `/blog/watch-party-assistir-filme-com-amigos` | New |
| compartilhar tela com áudio | Como fazer, troubleshooting | `/tela`, `/blog/compartilhar-tela-com-audio` | `/tela` already targets screen sharing broadly (`robots.txt` calls it out by name); the new guide is the audio-specific, per-platform troubleshooting answer `/tela` does not go deep on |
| watch party discord não funciona | Troubleshooting, comparativo | `/blog/watch-party-assistir-filme-com-amigos`, `/blog/pqp-vs-discord-2026` | No page names this Discord pain point directly; the watch party guide answers "how do I do this instead" |

### pt-BR: comunidade e migração

| Query | Intent | Target page | Current state |
|---|---|---|---|
| chat de voz para comunidade de streamer | Como fazer, público específico | `/blog/chat-de-voz-para-comunidade-de-streamer` | New |
| criar comunidade online | Como fazer | `/garanta`, `/blog/chat-de-voz-para-comunidade-de-streamer` | `/garanta` is the signup CTA; no content page walks through *why* before *how* until this guide |
| migrar servidor do discord | Como fazer | `/blog/migrar-servidor-discord-para-pqp` | New. `docs/DISCORD_IMPORT.md` documents the feature but is not a public-facing page |
| servidor de voz gratis para comunidade | Navegacional | `/`, `/blog/chat-de-voz-para-comunidade-de-streamer` | Same gap as "servidor de voz gratis" above, narrowed to the community use case |

### pt-BR: instalação

| Query | Intent | Target page | Current state |
|---|---|---|---|
| pqp android apk | Navegacional | `/android`, `/blog/instalar-pqp-android-iphone-pc` | `/android` already exists and is the primary CTA; the guide adds the cross-platform "which one do I install" answer and is a second entry point that can rank on its own |
| pqp iphone beta | Navegacional | `/beta`, `/blog/instalar-pqp-android-iphone-pc` | Same pattern as Android |

### English: the two most global queries

Only these two guides ship in English, chosen because they are the two topics
with the largest global (non-Brazil) search volume for this product category:
a Discord-alternative comparison and a "watch a film together online" how-to
are both high-volume English queries on their own; screen-share
troubleshooting, Discord migration, streamer communities and install guides
are comparatively support-shaped and rank better as long-tail pt-BR content
for now.

| Query | Intent | Target page | Current state |
|---|---|---|---|
| discord alternative | Comparação | `/vs-discord`, `/blog/pqp-vs-discord-2026` | English copy on `/vs-discord` already exists; the new guide is the long-form, FAQ-quotable version |
| best discord alternative 2026 | Pergunta estilo IA | `/blog/pqp-vs-discord-2026` | New |
| how to watch a movie together online with friends | Como fazer | `/blog/watch-party-assistir-filme-com-amigos` | New |
| watch party app free | Navegacional | `/blog/watch-party-assistir-filme-com-amigos`, `/` | New; landing already leads with "free" |

## The six guides

| Slug | pt-BR | en | Primary query |
|---|---|---|---|
| `pqp-vs-discord-2026` | Yes | Yes | alternativa ao discord / discord alternative |
| `watch-party-assistir-filme-com-amigos` | Yes | Yes | assistir filme junto online com amigos / watch a movie together online |
| `compartilhar-tela-com-audio` | Yes | No | compartilhar tela com áudio |
| `migrar-servidor-discord-para-pqp` | Yes | No | migrar servidor do discord |
| `chat-de-voz-para-comunidade-de-streamer` | Yes | No | chat de voz para comunidade de streamer |
| `instalar-pqp-android-iphone-pc` | Yes | No | instalar pqp android / iphone |

Metadata (title, summary, FAQ) lives in `client/src/lib/blog/articles.ts`;
prose in `client/src/content/blog/<slug>.<locale>.md`, loaded through
`client/src/lib/blog/article-bodies.ts`. See that file's header comment
before adding a seventh guide: the split from `posts.ts` / `bodies.ts` is
load-bearing, not stylistic (wrangler's esbuild cannot parse a `.md` import
anywhere in the Pages middleware's graph).

## History: the 2026-08-20 research, and what happened to it

The section below is the original version of this document, written during
the Discord screen-share suspension window and kept rather than deleted: it
is a real record of what was researched and decided, and the technical layer
it describes (edge-injected heads, canonicals, hreflang, JSON-LD) is still
exactly how §2 above builds on it.

**What shipped from its roadmap, and what did not.** Roadmap item 4 (a dated
explainer blog post) effectively happened, just generalised: `/blog` grew far
past one post into the release-notes feed it is today, plus the six guides
this PR adds. Items 1 through 3 (`/rpg`, `/chat-de-voz`, `/watch-party` as
dedicated marketing landing pages) were never built as standalone routes:
`git grep 'path="/'` in `client/src/main.tsx` confirms none of the three
exist. Two of the three intents are covered a different way in this PR:
`/blog/chat-de-voz-para-comunidade-de-streamer` and
`/blog/watch-party-assistir-filme-com-amigos` answer the same queries as
guides rather than landing pages. The RPG angle (item 1) is still an open
gap: nothing in this repository targets "mesa de RPG" queries today.

---

# SEO: what pqp.gg targets, what ships, and what to build next

**Date:** 2026-08-20. Written during the Discord suspension window (screen
share / video / Go Live suspended in Brazil since 17 Aug 2026 by ANPD order,
the verified fact sheet lives in
`docs/superpowers/specs/2026-08-20-vs-discord-and-testflight-design.md`; never
ship a claim that file marks false, and never put `Fly`, `gru`, `Railway`,
`mesh`, `SFU`, or `Clerk` in end-user copy).

## 1. The technical layer (shipped)

The site is a static SPA, so for every crawler that does not run JavaScript,
Bing, most unfurlers, Google's first pass, a route's head was whatever
`index.html` ships: the landing title and, fatally, `<link rel="canonical"
href="https://pqp.gg/">` on **every** URL. `/vs-discord` was telling search
engines it was a duplicate of the homepage.

What ships now:

- **Edge-injected heads for the marketing routes** (`/`, `/vs-discord`,
  `/garanta`, `/claim`, `/privacy`, `/terms`, `/cookies`, `/status`): the
  Pages middleware (`client/functions/_middleware.ts`) rewrites the head at
  the edge exactly as it already did for `/@handle` and `/c/slug`, from
  `client/src/lib/marketing-meta.ts`. Per-route title, description, canonical,
  hreflang, OG/Twitter, JSON-LD, crawler-visible without JS, in the locale
  `Accept-Language` / `?lang=` asks for. No API fetch involved; every failure
  path serves the page unchanged.
- **Canonicals pinned to `https://pqp.gg`** in the edge-injected heads, so the
  `pqp-3yr.pages.dev` twin votes for pqp.gg instead of competing with it.
  `/claim` canonicalises to `/garanta` (one page, two names).
- **hreflang**: one URL serves both languages by negotiation; `?lang=pt-BR` /
  `?lang=en` are the crawlable variants, `x-default` is the bare negotiated
  URL. That is the honest ceiling of this architecture, separate per-language
  URLs would need per-language routes (see §4).
- **`robots.txt` + `sitemap.xml`** (`client/public/`): sitemap now lists all
  eight public routes including `/vs-discord` and `/status`.
- **JSON-LD**: `WebSite` everywhere, `SoftwareApplication` on `/` only,
  `FAQPage` on `/vs-discord` only, and only because the page renders that FAQ
  as real copy (`vsDiscord.faq.*` in the i18n catalogue). Schema for copy a
  visitor can read, never schema alone.
- **Duplication is test-pinned**: `marketing-meta.ts` cannot import the
  catalogue (esbuild outside the workspace), so its strings are duplicates and
  `client/src/lib/marketing-meta.test.ts` pins every pair.

## 2. Target queries (research, 2026-08-20)

Intent guesses are relative (this product has no keyword-tool data); "winner
today" is what a US-proxied SERP showed, verify from a Brazilian IP.

| Query | Lang | Intent volume (guess) | Who wins today | Winnable? |
|---|---|---|---|---|
| discord tela compartilhada suspenso | pt-BR | High now, decaying with the news cycle | G1, Terra, O Tempo, Migalhas, gov.br/anpd | **No** for the head term (news domains), **yes** for the "e agora?" follow-up, press answers *what happened*, nobody answers *what to use instead*. `/vs-discord` sits exactly there. |
| alternativa ao discord (com tela) | pt-BR | Medium, rising | Listicles: Lark, EaseUS, flowgames, all predate 17 Aug and none mention the suspension | **Yes, long-tail**: "alternativa ao discord com compartilhamento de tela funcionando no brasil". The incumbents' staleness is the opening. |
| discord screen share brazil (suspended / alternative) | EN | Low-medium | TechPolicy.press, HardwareCanucks forum, Discord's own letter, a GitHub gist "unblocker" | **Yes**, a gist ranking on page 1 means the "alternative" modifier is nearly uncontested. `/vs-discord` EN variant targets it. |
| quando volta o compartilhamento de tela do discord | pt-BR | Medium, question-shaped | Nobody directly; news articles obliquely | **Yes**, the `/vs-discord` FAQ answers it verbatim (honestly: "no date announced"). |
| chat de voz para grupos / app de chat de voz | pt-BR | Medium, evergreen | Generic app-store listicles | **Partially**, needs its own page (the landing half-covers it). Roadmap #2. |
| chat para mesa de RPG (voz + tela) | pt-BR | Low-medium, evergreen, loyal | Content sites (theenemy, promobit), VTT docs; every guide says "use o Discord" for voice | **Yes**, post-suspension those guides recommend a tool that cannot share the map. A dedicated guide page wins the vacuum. Roadmap #1. |
| watch party sem discord / como fazer watch party | pt-BR | Medium, spiking | Tecnoblog, Teleparty-centric guides | **Long-tail only** ("watch party sem discord"). Honesty constraint: DRM'd players can black out browser capture, a watch-party page must sell *sync via screen share of what screen share can carry* (YouTube, local files, the game), not promise Netflix. |
| group chat app / web chat | EN | High, evergreen | Discord, WhatsApp, Google | **No**, do not spend on these. |
| discord alternativa open source | pt-BR/EN | Low, evergreen | Revolt, Element, alternativeto | **Yes, slowly**, "open source" + "brasileiro" + "auto-hospedável" is a niche pqp genuinely occupies. |

## 3. Content roadmap (2026-08-20; superseded by §"History" above for items 1-3)

Rules for every page: claims verified against the fact sheet; pt-BR is the
source language, EN follows; every string through the i18n catalogue; edge
head via `marketing-meta.ts` (add the route to `PAGE_COPY` + sitemap +
router); internal links from the footer and from `/vs-discord`.

1. **`/rpg`: "mesa de RPG online: voz e tela compartilhada"** (target:
   "chat para mesa de rpg", "rpg de mesa online voz", "compartilhar tela mesa
   de rpg"). The RPG community is the most acute victim of the suspension
   (maps, tokens, rulebooks are all *screens*), the queries are evergreen, and
   the current winners are guides that now recommend a broken tool. Shape: a
   guide, not a listicle, how to run a table on pqp (voice channel + screen
   share + a VTT in another tab). Do **not** sell a small-room ceiling: voice
   holds the whole room now, so a table of six is comfortable rather than
   constrained, and a claim about a 5-8 person limit is a claim the fact sheet
   marks false. **Not built. Still open.**
2. **`/chat-de-voz`: "chat de voz para grupos, no navegador"** (target:
   "chat de voz para grupos", "chat de voz online", "voice chat navegador").
   The landing sells the product; this page answers the query, no download,
   no account for guests? (do not claim guest access; it does not exist),
   works on the phone's browser, free. **Not built as a landing page; the
   intent is now covered by `/blog/chat-de-voz-para-comunidade-de-streamer`.**
3. **`/watch-party`: "assistir junto: watch party sem o Discord"** (target:
   "watch party sem discord", "assistir filme junto online"). Highest
   news-adjacency after /vs-discord, but write inside the DRM constraint above,
   sell YouTube/local/game sessions, name the streaming-DRM caveat out loud
   (honesty is the brand; it also matches the searcher's lived experience).
   **Not built as a landing page; the intent is now covered by
   `/blog/watch-party-assistir-filme-com-amigos`.**
4. **Blog post: "O que aconteceu com a tela compartilhada do Discord no
   Brasil", only if a `/blog` shape is wanted at all.** A dated explainer
   (facts from the sheet, linking Discord's letter and the gov.br notice) can
   catch the news long-tail while it lasts and hand its link equity to
   `/vs-discord`. Decays; build after the evergreen pages, or skip. **`/blog`
   shipped, generalised well past one post; this specific explainer was never
   written and the news cycle it targeted has mostly passed.**
5. **EN mirror decision.** If EN queries convert (check Search Console after
   2-3 weeks), consider `/en/…` routes so hreflang can point at real URLs
   instead of `?lang=` variants. Costs router + middleware work; do it only
   with data. **Still `?lang=` variants today; no data-driven decision made
   yet.**

Not content, but do alongside: **register pqp.gg in Google Search Console and
Bing Webmaster Tools and submit the sitemap** (owner action, ~15 min, it is
how every claim in §2 gets measured), and keep the footer linking every new
page (crawl paths need internal links, and the footer already links
`/vs-discord`). **Done**: Search Console is live and is what produced the
2026-09-14 snapshot at the top of this document.

## 4. Known limits (deliberate)

- **One URL, two languages.** Content negotiation means Google mostly indexes
  the pt-BR head (crawlers send no `Accept-Language`; `preferredLocale`
  defaults pt-BR) with `?lang=` alternates. Correct for a Brazilian-first
  product; revisit only per roadmap #5.
- **The SPA body is still JS-only.** Edge injection fixes the *head*; the
  page copy itself is rendered client-side, so non-Google engines index title
  + description + JSON-LD only. Full SSR/prerender of marketing routes is the
  next step up in cost; not worth it before the content in §3 exists.
- **`/app` is noindexed by robots** and must stay that way. **Superseded
  2026-09-17: it is noindexed by an edge `X-Robots-Tag` header now, not by
  `robots.txt`, because a `Disallow` a crawler never fetches could not
  actually keep an externally-linked URL out of the index. See "What this PR
  fixes" §1 above.**
- **Profiles/communities stay out of the sitemap**, see the comment in
  `client/public/sitemap.xml`; the enumeration-surface argument outranks SEO.
