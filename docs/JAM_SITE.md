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

**Fonts.** The entry imports `fonts.css` (Gabarito for headlines, Instrument Sans,
Dela Gothic for the wordmark), so the faces are there; what the page lacked was
the early request. A browser asks for a face only once a rendered word needs it,
and here that is after HTML, script, catalogue and render, so the headline of the
"not open yet" page was drawn in the Arial-metric fallback first (`font-display:
swap`). `jam-site/index.html` now preloads the three Latin files, like the app's
`index.html`.

**Hostname step still owed (not done in the PR):** add `jam.pqp.gg` as a custom
domain on the Pages project `pqp` (DNS and the Pages dashboard). Until then the
site is reachable at `pqp.gg/jam`.

## The flag

Everything hides behind `GET /api/public/jams/config`. Off, the routes render a
small "em breve" page, make no other data call, and say `noindex` (in the head
and, at the edge, `X-Robots-Tag`). The edge writes the head from the same API:
a song that is not public (a 404, or the 401 a switched-off flag answers) gets
the generic `noindex` card.

## What the pages draw

- **Home (Palco).** A featured song, tabs, cards. The server sorts (`top`,
  `new`); `needs=` filters an instrument. **Em alta** is `top`, **Novas** is
  `new`, **Falta alguém** is `new` with the songs that ask for nobody dropped
  (and a row of instrument chips that become `needs=`), **Prontas** is `new`
  keeping the songs that ask for nobody. A filtered tab reads on until it has a
  dozen to show. Cursor paging by an observer at the end of the list, with a
  "Ver mais" button that does the same. A card's art is a small mosaic: the cover
  (when it passed the scanner), a square per part in the instrument's colour with
  a strip of the song's own peaks, and one dashed square per instrument still
  asked for. Nothing on the home downloads audio or video (pinned by
  `e2e/jam-site/jam-site.spec.ts`).
- **Song.** The mosaic is the page. One tile per public part: its video when the
  payload has one (`pickJamVideoUrl`, `canPlayType`, the same function the app
  uses), otherwise the instrument's colour with a level strip that scrolls with
  the song clock from the track's `peaks`. A dashed tile when `needs` is not
  empty. Layouts for 1 to 9+ tiles, wide and upright (`src/jam-site/mosaic.ts`,
  pure and tested). Tap a tile to hear only that part, large, the band small
  beside it; Escape or the pill's x goes back. One play button, time, a seek
  slider, like, share (Web Share API, else a copied link), the record button
  named for the missing instrument, "Quem tocou o quê" lanes with a flag per
  part, where it was born, report.

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


## Sharing and SEO

The edge (`handleJam`, `src/lib/jam-meta.ts`) writes the head of `/m/<id>`:
title, who played, "Falta baixo: grava a tua parte", the cover when it is an
absolute https URL (else the site's 1200x630 card), canonical to
`https://jam.pqp.gg/m/<id>` whichever mount served the page, JSON-LD
`MusicRecording`. English for Spanish readers, like the other cards. No
generated image (`docs/HANDLES.md` "Not built"). **Known gap:** a cover URL is a
signed address that expires within an hour; an unfurler that copies the picture
on its first fetch keeps it, one that re-fetches later may not. A stable cover
address is a server change. There is no sitemap entry: the sitemap generator is
static-only on purpose (`docs/HANDLES.md`), and a song list from the database is
the enumeration surface it refuses to be.

## Copy

Three small catalogues, `src/locales/jam-site/{en,pt-BR,es}.json`, with their own
i18next instance (`lib/i18n/jam-site.ts`) so the site does not carry the app's
500 kB English catalogue. `i18n:check` compares them like the main ones. pt-BR is
`tu`.

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
