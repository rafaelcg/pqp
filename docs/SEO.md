# SEO — what pqp.gg targets, what ships, and what to build next

**Date:** 2026-08-20. Written during the Discord suspension window (screen
share / video / Go Live suspended in Brazil since 17 Aug 2026 by ANPD order —
the verified fact sheet lives in
`docs/superpowers/specs/2026-08-20-vs-discord-and-testflight-design.md`; never
ship a claim that file marks false, and never put `Fly`, `gru`, `Railway`,
`mesh`, `SFU`, or `Clerk` in end-user copy).

## 1. The technical layer (shipped)

The site is a static SPA, so for every crawler that does not run JavaScript —
Bing, most unfurlers, Google's first pass — a route's head was whatever
`index.html` ships: the landing title and, fatally, `<link rel="canonical"
href="https://pqp.gg/">` on **every** URL. `/vs-discord` was telling search
engines it was a duplicate of the homepage.

What ships now:

- **Edge-injected heads for the marketing routes** (`/`, `/vs-discord`,
  `/garanta`, `/claim`, `/privacy`, `/terms`, `/cookies`, `/status`): the
  Pages middleware (`client/functions/_middleware.ts`) rewrites the head at
  the edge exactly as it already did for `/@handle` and `/c/slug`, from
  `client/src/lib/marketing-meta.ts`. Per-route title, description, canonical,
  hreflang, OG/Twitter, JSON-LD — crawler-visible without JS, in the locale
  `Accept-Language` / `?lang=` asks for. No API fetch involved; every failure
  path serves the page unchanged.
- **Canonicals pinned to `https://pqp.gg`** in the edge-injected heads, so the
  `pqp-3yr.pages.dev` twin votes for pqp.gg instead of competing with it.
  `/claim` canonicalises to `/garanta` (one page, two names).
- **hreflang**: one URL serves both languages by negotiation; `?lang=pt-BR` /
  `?lang=en` are the crawlable variants, `x-default` is the bare negotiated
  URL. That is the honest ceiling of this architecture — separate per-language
  URLs would need per-language routes (see §4).
- **`robots.txt` + `sitemap.xml`** (`client/public/`): sitemap now lists all
  eight public routes including `/vs-discord` and `/status`.
- **JSON-LD**: `WebSite` everywhere, `SoftwareApplication` on `/` only,
  `FAQPage` on `/vs-discord` only — and only because the page renders that FAQ
  as real copy (`vsDiscord.faq.*` in the i18n catalogue). Schema for copy a
  visitor can read, never schema alone.
- **Duplication is test-pinned**: `marketing-meta.ts` cannot import the
  catalogue (esbuild outside the workspace), so its strings are duplicates and
  `client/src/lib/marketing-meta.test.ts` pins every pair.

## 2. Target queries (research, 2026-08-20)

Intent guesses are relative (this product has no keyword-tool data); "winner
today" is what a US-proxied SERP showed — verify from a Brazilian IP.

| Query | Lang | Intent volume (guess) | Who wins today | Winnable? |
|---|---|---|---|---|
| discord tela compartilhada suspenso | pt-BR | High now, decaying with the news cycle | G1, Terra, O Tempo, Migalhas, gov.br/anpd | **No** for the head term (news domains), **yes** for the "e agora?" follow-up — press answers *what happened*, nobody answers *what to use instead*. `/vs-discord` sits exactly there. |
| alternativa ao discord (com tela) | pt-BR | Medium, rising | Listicles: Lark, EaseUS, flowgames — all predate 17 Aug and none mention the suspension | **Yes, long-tail**: "alternativa ao discord com compartilhamento de tela funcionando no brasil". The incumbents' staleness is the opening. |
| discord screen share brazil (suspended / alternative) | EN | Low-medium | TechPolicy.press, HardwareCanucks forum, Discord's own letter, a GitHub gist "unblocker" | **Yes** — a gist ranking on page 1 means the "alternative" modifier is nearly uncontested. `/vs-discord` EN variant targets it. |
| quando volta o compartilhamento de tela do discord | pt-BR | Medium, question-shaped | Nobody directly; news articles obliquely | **Yes** — the `/vs-discord` FAQ answers it verbatim (honestly: "no date announced"). |
| chat de voz para grupos / app de chat de voz | pt-BR | Medium, evergreen | Generic app-store listicles | **Partially** — needs its own page (the landing half-covers it). Roadmap #2. |
| chat para mesa de RPG (voz + tela) | pt-BR | Low-medium, evergreen, loyal | Content sites (theenemy, promobit), VTT docs; every guide says "use o Discord" for voice | **Yes** — post-suspension those guides recommend a tool that cannot share the map. A dedicated guide page wins the vacuum. Roadmap #1. |
| watch party sem discord / como fazer watch party | pt-BR | Medium, spiking | Tecnoblog, Teleparty-centric guides | **Long-tail only** ("watch party sem discord"). ⚠ Honesty constraint: DRM'd players can black out browser capture — a watch-party page must sell *sync via screen share of what screen share can carry* (YouTube, local files, the game), not promise Netflix. |
| group chat app / web chat | EN | High, evergreen | Discord, WhatsApp, Google | **No** — do not spend on these. |
| discord alternativa open source | pt-BR/EN | Low, evergreen | Revolt, Element, alternativeto | **Yes, slowly** — "open source" + "brasileiro" + "auto-hospedável" is a niche pqp genuinely occupies. |

## 3. Content roadmap (build next, in order)

Rules for every page: claims verified against the fact sheet; pt-BR is the
source language, EN follows; every string through the i18n catalogue; edge
head via `marketing-meta.ts` (add the route to `PAGE_COPY` + sitemap +
router); internal links from the footer and from `/vs-discord`.

1. **`/rpg` — "mesa de RPG online: voz e tela compartilhada"** (target:
   "chat para mesa de rpg", "rpg de mesa online voz", "compartilhar tela mesa
   de rpg"). The RPG community is the most acute victim of the suspension
   (maps, tokens, rulebooks are all *screens*), the queries are evergreen, and
   the current winners are guides that now recommend a broken tool. Shape: a
   guide, not a listicle — how to run a table on pqp (voice channel + screen
   share + a VTT in another tab), honest about the 5–8 person voice ceiling,
   which is a *feature* for a table of six.
2. **`/chat-de-voz` — "chat de voz para grupos, no navegador"** (target:
   "chat de voz para grupos", "chat de voz online", "voice chat navegador").
   The landing sells the product; this page answers the query — no download,
   no account for guests? (do not claim guest access; it does not exist),
   works on the phone's browser, free.
3. **`/watch-party` — "assistir junto: watch party sem o Discord"** (target:
   "watch party sem discord", "assistir filme junto online"). Highest
   news-adjacency after /vs-discord, but write inside the DRM constraint above
   — sell YouTube/local/game sessions, name the streaming-DRM caveat out loud
   (honesty is the brand; it also matches the searcher's lived experience).
4. **Blog post: "O que aconteceu com a tela compartilhada do Discord no
   Brasil" — only if a `/blog` shape is wanted at all.** A dated explainer
   (facts from the sheet, linking Discord's letter and the gov.br notice) can
   catch the news long-tail while it lasts and hand its link equity to
   `/vs-discord`. Decays; build after the evergreen pages, or skip.
5. **EN mirror decision.** If EN queries convert (check Search Console after
   2–3 weeks), consider `/en/…` routes so hreflang can point at real URLs
   instead of `?lang=` variants. Costs router + middleware work; do it only
   with data.

Not content, but do alongside: **register pqp.gg in Google Search Console and
Bing Webmaster Tools and submit the sitemap** (owner action, ~15 min, it is
how every claim in §2 gets measured), and keep the footer linking every new
page (crawl paths need internal links, and the footer already links
`/vs-discord`).

## 4. Known limits (deliberate)

- **One URL, two languages.** Content negotiation means Google mostly indexes
  the pt-BR head (crawlers send no `Accept-Language`; `preferredLocale`
  defaults pt-BR) with `?lang=` alternates. Correct for a Brazilian-first
  product; revisit only per roadmap #5.
- **The SPA body is still JS-only.** Edge injection fixes the *head*; the
  page copy itself is rendered client-side, so non-Google engines index title
  + description + JSON-LD only. Full SSR/prerender of marketing routes is the
  next step up in cost; not worth it before the content in §3 exists.
- **`/app` is noindexed by robots** and must stay that way.
- **Profiles/communities stay out of the sitemap** — see the comment in
  `client/public/sitemap.xml`; the enumeration-surface argument outranks SEO.
