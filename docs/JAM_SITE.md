# The public jam site

`jam.pqp.gg`: songs anybody can listen to and watch with no account, and the
door into the app for everything that needs one. The contract and the server are
`packages/shared/src/jam-public.ts` and `docs/JAM_PUBLIC.md`; this page is the
website. It is dark until the runtime flag `jam_public` is turned on.

## Addresses and how they are served

| Address | Page |
|---|---|
| `jam.pqp.gg/` | the home |
| `jam.pqp.gg/m/<songId>` | a song |
| `<any host>/jam`, `/jam/m/<songId>` | the same two pages (pqp.gg, a Pages preview, localhost) |

It is **its own HTML entry**, not a route of the app: `client/jam-site/index.html`
and `src/jam-site/entry.tsx`, emitted as `dist/jam-site/index.html`. It loads no
Clerk, no router, no app shell, no socket, no service worker registration and no
analytics tag. A signed-out visitor downloads about 100 kB of JavaScript
gzipped (React, the site at about 22 kB, one shared chunk) and the app's CSS (66
kB gzipped, the cost of the shared tokens: a jam-only Tailwind entry is a
follow-up). The site draws its own eighteen icons (`src/jam-site/icons.tsx`)
instead of loading the app's whole icon chunk, and React sits in a chunk of its
own (`react-core` in `vite.config.ts`) so it is not dragged in with the icons.
The jam engine is
fetched when a song page opens (its JavaScript, not any audio) so the first play
press can unlock the audio inside the gesture (the home fetches it when idle).

The Pages middleware (`client/functions/_middleware.ts`, `handleJam`) is what maps
the addresses to the page, because `_redirects` cannot key on a hostname. It
fetches `/jam-site/` from the asset binding and writes the head
(`src/lib/jam-meta.ts`). The Vite dev and preview servers do the same rewrite
(`jamSiteRouting` in `vite.config.ts`), so `localhost:5173/jam` and
`jam.localhost:5173` behave like the real thing.

Verified with `wrangler pages dev` (4.149.0, the CI version) against a seeded API:
the host mount, `/jam`, a song's head, `noindex`, HEAD, and an unrelated page of
`jam.pqp.gg` passing through.

**Nothing else lives on the host.** A Pages project has one asset set, so
`jam.pqp.gg/download` used to answer with the whole app, indexable, a duplicate of
`pqp.gg/download`. The middleware now answers a 301 to the same path (and query)
on the main site for any path of a `jam.*` host that is not `/`, `/m/<id>` or a
static file (`/assets/`, `/icons/`, `/images/`, or a name with an extension: the
icon, the manifest, robots). `jamHostRedirect` in `src/lib/jam-meta.ts`, tested in
`src/lib/jam-host-redirect.test.ts`. `/jam` and `/jam/m/<id>` on every other host
are unchanged.

**Pictures the API points at.** A person's `avatarUrl` is `/api/avatars/<id>` for
an uploaded photo: root-relative, because the server does not know its own public
origin. `jam.pqp.gg` and `api.pqp.gg` are two origins and a production build has no
dev proxy, so the bare path resolved against the site, 404ed, and every face in the
mosaic was an initial. `api.ts` now resolves every root-relative address of a
payload (the people on a song, its parts and tracks, the origin's icon, the cover)
against `VITE_API_URL` (`resolveApiUrl`, tested in `api.test.ts`); an absolute URL
(a signed bucket address, a Clerk picture) passes through, and with no API base
(the API serves the page) nothing changes.

**Fonts.** The entry imports `fonts.css` (Gabarito for headlines, Instrument Sans,
Dela Gothic for the wordmark), so the faces are there; what the page lacked was
the early request. A browser asks for a face only once a rendered word needs it,
and here that is after HTML, script, catalogue and render, so the headline of the
"not open yet" page was drawn in the Arial-metric fallback first (`font-display:
swap`). `jam-site/index.html` now preloads the three Latin files, like the app's
`index.html`.

**Hostname step still owed (not done in the PR):** add `jam.pqp.gg` as a custom
domain on the Pages project `pqp` (DNS and the Pages dashboard). Until then the
site is reachable at `pqp.gg/jam`. Accepted as a known gap for launch
(2026-11-20), to follow up after: `docs/JAM_PUBLIC.md` §"Launch gaps accepted
(2026-11-20)".

## The flag

Everything hides behind `GET /api/public/jams/config`. Off, the routes render a
small "em breve" page, make no other data call, and say `noindex` (in the head
and, at the edge, `X-Robots-Tag`). The edge writes the head from the same API:
a song that is not public (a 404, or the 401 a switched-off flag answers) gets
the generic `noindex` card.

## What the pages draw

- **Home (Palco).** A featured song, a three-step "Como funciona" strip, tabs,
  cards. **The featured slot prefers an original**: of the first six of Em alta,
  the first song with a part to show whose `artist` is null, else the first with
  a part (`pickFeatured`, `src/jam-site/featured.ts`), so the showcase is never
  somebody else's hit when an original is on the page. It also prefers a song
  that takes a part (`joinMode` not `closed`, below): first original that takes
  one, else first original, else first that takes one, else the first song. A
  closed original still beats an open cover (the cover is the rights risk), and
  its page says plainly that it takes no part. When the hero IS closed and other
  songs take a part, up to three of them (those asking for an instrument first,
  `pickWantingParts`) sit under it as "Essas tão pedindo gente" (`wants.*`), with
  "Ver todas" opening Falta alguém, so a visitor always has something to record
  on; nothing extra when the hero takes a part or none does. The hero reads the
  top twelve (`FEATURED_WINDOW`) so a closed hero still finds some. **The strip**
  (`how-it-works.tsx`, `intro.*` in the catalogues) says "Ouve. Não precisa de
  conta." / "Grava a parte que falta, de fone, em cima da banda." / "Quem começou
  escolhe o que entra na mistura." with the site's own icons on instrument-hue
  chips; static, no request, and it is also on the empty home. It sits under the
  hero from `lg` up, and ABOVE it on a phone (the hero's play button is a screen
  down there, and a cold visitor should know what a jam is before it). The server sorts (`top`,
  `new`); `needs=` filters an instrument. **Em alta** is `top`, **Novas** is
  `new`, **Falta alguém** is `new` with the songs that ask for nobody dropped
  (and a row of instrument chips that become `needs=`), **Prontas** is `new`
  keeping the songs that ask for nobody. A filtered tab reads on until it has a
  dozen to show. Cursor paging by an observer at the end of the list, with a
  "Ver mais" button that does the same. A card's art is a small mosaic of the
  band: a square per part, the person alone on a neutral tile with the
  instrument's chip (no strip: a card is at rest), one dashed square per instrument still asked for, and one
  "+N" square (the number and the instruments behind it) for what did not fit.
  **The cover is not one of the squares**: it is a small thumbnail beside the
  title (the hero's "Em destaque" line, a card's title row), the way the song
  page has it, because a painting drawn as a tile read as a part somebody
  played. Nothing on the home downloads audio or video (pinned by
  `e2e/jam-site/jam-site.spec.ts`).
- **Song.** The mosaic is the page. One tile per public part: its video when the
  payload has one (`pickJamVideoUrl`, `canPlayType`, the same function the app
  uses; every video shows its first frame before the first press, a song of
  more than four parts loading only that frame per part), otherwise the person
  (their picture, or an initial) large on the ONE neutral tile ground with the
  instrument's chip, and, only while the song plays, a level strip under them
  that scrolls with the song clock from the track's `peaks` (none at rest). The
  look of a tile is the app's too (`lib/jam-tile-look.ts`,
  `lib/jam-tile-parts.tsx`: the neutral `--color-tile`, a `--color-tile-*-ink`
  per instrument, `other` a violet). The dashed tile
  takes the smallest cell, never a larger one than a recorded part. A dashed tile when `needs` is not
  empty. Layouts for 1 to 9+ tiles, wide and upright (`src/jam-site/mosaic.ts`,
  pure and tested). Tap a tile to hear only that part, large, the band small
  beside it; Escape or the pill's x goes back. One play button, time, a seek
  slider, like, share (Web Share API, else a copied link), the record button
  named for the missing instrument, "Quem tocou o quê" lanes (a part's report is
  in its lane's small "more" menu, reachable by keyboard: Enter or the down arrow
  opens it, Escape closes it and gives the focus back; no flag on every row),
  where it was born, report.
- **A song that takes no part.** The public song carries `joinMode` (`open`,
  `wanted`, `closed`: the song's own value, `packages/shared/src/jam-public.ts`,
  filled by `mapPublicSong`), because `needs` is empty for `open` and `closed`
  alike and the page could not tell them apart: in user test round 1 (B2) people
  signed up to record on a closed song and met "Essa música tá fechada" in the
  app. A three-value field rather than `acceptsParts: boolean` because it is the
  song's real vocabulary (the app, both phones and the operator already speak
  it) and costs the same on the wire; the site derives `takesParts` (not
  `closed`). Additive: absent from an older server it reads `open`, which is
  what every client assumed, and an unknown value from a newer one reads `open`
  too. On a `closed` song the page draws no record button, no dashed tile and no
  "Como entra uma parte" block; in their place one calm line, "Essa música tá
  completa.", and "Começar a tua", which opens the "Começar uma jam" sheet
  (`song.closed.*`). `wanted` with nothing missing still takes a part of the
  listed instruments (the server's `addableInstruments`), so it keeps the
  button. Tested on a real Postgres in `server/src/api/jam-public-join-mode.test.ts`.
  The app, the phones and `docs/JAM_PUBLIC.md` can read the same field; none of
  them do yet. This is a `packages/shared` and `server` change: `restarts-api`.

## Playing

The same engine as the app (`lib/jam-session.ts`: `getJamEngine`,
`syncJamStems`, `unlockJamAudio`), through `src/jam-site/player.ts`. Stems are
placed by `offsetMs` / `trimStartMs` / `trimEndMs`; a video's file time is the
song's time minus its take's `offset` (`JamPlayer.attachVideo`). `syncJamStems`
now takes a `StemTrack` (the five numbers plus `inMix`) so a `PublicJamTrack`
goes through it; the in-app player is unchanged. Audio is fetched and decoded on
the first press, never on the page view. A play is noted (`POST .../play`) on
the first successful start.

## Signed-out actions and the intent hand-over

Listening and watching need no account. Like, report (the contract requires one),
record and "Começar uma jam" open one sheet (`auth-sheet.tsx`) that says why and
continues to `/app` with an intent (`src/lib/jam-intent.ts`):

| Intent | URL | Meaning |
|---|---|---|
| record | `/app?jam=<songId>&record=1[&instrument=bass]` | record a part on this public jam |
| song | `/app?jam=<songId>` | take me to this jam |
| like | `/app?jam=<songId>&act=like` | like this jam once I am in |
| report | `/app?jam=<songId>&act=report[&track=<trackId>]` | report this jam, or the one part `track` names |
| copyright | `/app?jam=<songId>&act=report[&track=<trackId>]&reason=copyright` | the same report, and the dialog opens on "Copyright" (the site's "Problema de direitos autorais" item, on the song and in each part's menu) |
| new | `/app?jam=new` | let me start a jam |

The URL is the carrier because the hosted pages live on `jam.pqp.gg` and the app
on `pqp.gg` (two origins, so a `localStorage` stash is invisible across them).
`main.tsx` stashes it at boot (`rememberJamIntentFromLocation`, key
`pqp:pending-jam`, one hour, consumed on read) so it survives Clerk's redirect,
exactly like `?add=` and `?join=`.

**What the app does.** At `bootstrapReady`, `App.tsx` (the block marked "A public
jam somebody came from") takes the intent and calls `openPublicJam`
(`lib/jam-public-nav.ts`); `JamPublicHost` navigates to `/app/jam/<songId>` (or
`/app/jam/new`) and `JamPublicView` acts on it: `record` opens the studio on
`instrument` when `viewer.addableInstruments` allows it (else the first addable
one), `act: "like"` likes once before the view paints, `act: "report"` opens the
report dialog for the song or the one part, `new` opens the start sheet and the
studio, and the take creates a standalone public jam. The intent is dropped after
it is acted on, and `JAM_INTENT_PARAMS` are stripped from the address. The
public page never knows it is signed in (it loads no auth): a returning
signed-in visitor sees the sheet and continues to `/app`, where the intent is
acted on at once. `jamReturnPath` and the site's `?from=app` notice are no
longer used by the app and are kept for an older build still in a tab.
`docs/JAM_PUBLIC.md` section "In the app" says what the view is made of.


## Where visitors came from (attribution)

**Decision D7: no third-party analytics on the site.** It has no tag, pixel or
beacon, and none is to be added. What it has is Cloudflare's own zone analytics
for `pqp.gg`, which reads the edge's logs and needs no code in the page, plus
`ref=jam` on every hand-over, which is how a signup is tied back to the site.

**What Cloudflare zone analytics can answer** (dashboard, zone `pqp.gg`,
filtered to the host `jam.pqp.gg`): requests and unique visitors over time,
countries, top paths (so which `/m/<songId>` pages are visited), top referrers,
and status codes. Counts of visits, and where they came from at the country and
referrer level.

**What it cannot answer**: signups (an account is made on `pqp.gg`, a different
host and a different page, after Clerk's redirect), who anybody is, whether a
visit became a recording, a like or a report, or which visits belong to the same
person. Unique visitors there is an approximation from the edge, not a person.

**How `ref=jam` closes the gap.** The site is one link away from the app, and the
account is where the question can be answered, so the link carries the answer:

- Every sign-up button on the site (the sheet in `auth-sheet.tsx`) and the plain
  links to the main site (sign in, the pqp wordmark in the footer, "Visit" on a
  song's origin) append `ref=<x>` and any `utm_source`, `utm_medium`,
  `utm_campaign` the site was opened with. When the site was opened with no `ref`
  the value is `ref=jam`. Nothing else in the address is forwarded (no `gclid`,
  no `fbclid`). Values are trimmed and cut at 100 characters.
- The site was probably opened on a page and the button is pages away, and it
  moves with `pushState`, so `entry.tsx` writes the arrival's `ref` / `utm_*`
  down at boot (`pqp:jam-attribution` on the site's own origin, first touch, 30
  days, `lib/jam-intent.ts`). A button reads that, else the current address,
  else `jam`.
- The app already has an acquisition mechanism, and this is a door into it, not
  a second one. At boot `main.tsx` stashes the campaign parameters on whatever
  URL it loaded with (`lib/acquisition.ts`), sends them once after the account
  exists, and the server keeps them as first touch on the new account
  (`services/acquisition.ts`, `users.acquisition_ref`, `acquisition_source`,
  `acquisition_medium`, `acquisition_campaign`). So `/app?jam=...&ref=jam` lands as
  `ref = jam`, and a clip's own link `jam.pqp.gg/m/<id>?ref=clip-ana` lands as
  `ref = clip-ana`. No new table, no new endpoint.
- Read it as signups by source from `GET /api/admin/acquisition` (the dashboard's
  acquisition card, grouped by `ref` and by `source / medium / campaign`), and
  retention by channel in the same service (`retentionBySource`). The landing
  recorded is `/app`, because that is the page the account first loaded; the
  `ref` is the signal.

**Shared links carry `ref=share`.** The song page's Compartilhar (Web Share API,
else a copied link) hands out `<origin>/<path>?ref=share` (`jamShareHref`,
`src/jam-site/share-url.ts`), so the people who come in through a shared link
show up as their own row in the acquisition report. When the page was opened
with a `ref` already (a clip, a post, an earlier share) that one is kept: it is
who brought them. The arrival's `utm_*` are not copied onto the link. A visitor
who arrives on `/m/<id>?ref=share` and presses Gravar goes to
`/app?jam=<id>&record=1&instrument=...&ref=share` (the arrival's `ref` is
remembered first-touch like any other), which `lib/acquisition.ts` stores as
`users.acquisition_ref`. Tested in `share-url.test.ts` and
`e2e/jam-site/jam-site.spec.ts`.

Zone analytics says how many people looked, the acquisition report says how many
of them signed up. Put a `?ref=` on every link you hand out for the site (a clip's
caption, a post) and each one shows up as its own row.

## Sharing and SEO

The edge (`handleJam`, `src/lib/jam-meta.ts`) writes the head of `/m/<id>`:
title, who played, "Falta baixo: grava a tua parte", canonical to
`https://jam.pqp.gg/m/<id>` whichever mount served the page, JSON-LD
`MusicRecording`. The language is chosen as for every public page
(`preferredLocale`: `?lang=`, then `Accept-Language`, Portuguese when a crawler
sends neither, Spanish for `es` and `es-*`).

**The page's language and the card's are two things.** The edge writes the
NEGOTIATED language, Spanish included, into `<meta name="pqp:locale">` and into
`<html lang>` (the shell ships `lang="en"`; `injectJamHead` rewrites it), because
the client trusts `pqp:locale` before `navigator.languages`
(`fromServedDocument`, `lib/locale.ts`, which is unchanged). Writing `en` there
for a Mexican browser, as it once did, rendered the whole site in English. The
CARD (title, description, `og:locale`, the picture and its alt) has no Spanish
catalogue, so for Spanish readers it stays English (`cardLocaleOf`): a Spanish
unfurl reads `en_US` and `og-jam-en.png`. Writing a Spanish card is a catalogue
and a third picture, and nothing else to change. Pinned by `lib/jam-edge.test.ts`
(es, pt-BR, en, no header, a junk header, a language the site lacks, `?lang=`
over the header, on the home and a song, on both mounts).

**The picture** is one of two, and never a signed URL:

- **A song with a public cover** (public, and its cover passed the image
  scanner: the song JSON's `coverUrl` is non-null) points `og:image` at
  `<api>/api/public/jams/<id>/cover`, a stable address that serves the CURRENT
  object from our origin (200 with type and length, `ETag`, ranges, 304, HEAD;
  the Baú cover's `serveCover`, `docs/COMMUNITY_HOME.md`). `public, max-age=300,
  s-maxage=300`: a song taken down keeps its cached picture at most five
  minutes. Unknown, malformed, private, unpublished, unscanned, rejected and
  cover-less ids are the same `404 no-store`, byte for byte, behind its own
  address bucket, and the route is not matched at all while `jam_public` is off.
  The signed URL in the JSON is for the page's own player; an unfurler that
  cached it would hold a dead link within the hour, which is why no tag carries
  it. The cover is a square, so the card is `summary`; no size is stated (the
  JSON does not carry one, and a wrong size is worse than none).
- **Everything else** (a song with no cover yet, which until the scanner has run
  is every song; the home; a page that is not public) gets the jam card,
  `/images/og-jam.png` (pt-BR) or `/images/og-jam-en.png`: 1200x630, the band as
  a mosaic in the six `--color-inst-*` fills with one empty dashed seat, "Toca
  junto." / "Play along.". `og:image:width/height/type/alt` are stated and the
  card is `summary_large_image`. It names no song, so a private or unknown page
  reveals nothing. Drawn by `client/scripts/og-image/jam-template.html`
  (`pnpm --filter @pqp/client og:image` re-renders it, with the fonts read from
  `src/assets/fonts`, no network).

Not verified against the real unfurlers (WhatsApp, X, Discord, Slack): there is
no way to run them from a laptop, so check a live link with each once `jam_public`
is on, and `curl -I` the cover address.
There is no sitemap entry: the sitemap generator is
static-only on purpose (`docs/HANDLES.md`), and a song list from the database is
the enumeration surface it refuses to be.

## Copy

Three small catalogues, `src/locales/jam-site/{en,pt-BR,es}.json`, with their own
i18next instance (`lib/i18n/jam-site.ts`) so the site does not carry the app's
500 kB English catalogue. `i18n:check` compares them like the main ones. pt-BR is
`tu`.

**Which language shows** is `detectLocale` (`lib/locale.ts`), the app's own rule,
not a second one: `?lang=`, then the saved choice (`localStorage` `pqp:locale`,
the key the app writes, so on the `/jam` mount the two agree), then the
`pqp:locale` the edge wrote, then `navigator.languages`, then English.

**The language switch** is in the footer (`LanguageSwitch` in `shell.tsx`,
`jam-site/language.ts`): three buttons, Português, English and Español, each
named in its own language and marked with `lang`, in a group labelled
`footer.language`, the current one `aria-pressed`, 44 px tall, no motion. A click
is the app's language picker: save the choice, reload the same path, query and
hash, with `?lang=` removed once the choice is stored (it would outrank the very
choice) and set when storage is blocked (so that load still honours the click).
It is not in the header: at 320 px the wordmark, "Começar" and the theme toggle
already fill it.

**What the hand-over carries.** A language the visitor ASKED for (a `?lang=` on
the address they arrived on, a saved choice, or a click on the switch) is added
as `lang=<locale>` to every link to the app (`mainHref`, the sign-up sheet's
button). The app already reads `?lang=` first, so its first screen speaks it; on
`jam.pqp.gg` the two origins do not share `localStorage`, so without it a
Português pick would be forgotten at the door. A language only implied by the
browser is not added: the app infers the same one from the same browser. The app
does not keep `?lang=` across the sign-up redirect; that is the app's, and
nothing was added there.

## Try it

1. `docker compose --profile storage up -d postgres minio minio-init`, a database
   of your own, the server with `DEV_AUTH_BYPASS=true JAM_CHANNELS=true
   JAM_PUBLIC=true COMMUNITIES_ENABLED=true JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS=0`
   and the `S3_*` of the MinIO.
2. `node tools/jam-site-seed/seed.mjs --api http://localhost:3001 --db <your db>
   --out /tmp/jam-seed`: sixteen songs, real synthetic audio and video, and the
   states the contract hides.
3. `pnpm dev`, open `http://localhost:5173/jam` or `http://jam.localhost:5173/`.

Tests: `src/jam-site/*.test.ts`, `src/lib/jam-intent.test.ts`,
`src/lib/jam-edge.test.ts`, and `pnpm --filter @pqp/client e2e:jam-site` (the API
mocked in the browser; with `JAM_SITE_API` and `JAM_SITE_IDS` it also checks the
hidden states against a seeded server).
