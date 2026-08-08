# Handles and public profiles

`pqp.gg/@rafa`. One claimable name per account, a deliberately thin public page
behind it, and a landing page whose whole job is to get somebody to claim one.

## Why a new column and not `username`

`username` is **not unique**. Uniqueness lives on the pair
(`username`, `discriminator`) — that is what `idx_users_username_discrim`
enforces and what `name#1234` exists to express. A dozen accounts can be `rafa`,
so `pqp.gg/rafa` has no answer that does not invent a winner.

`users.handle` is a second name that **is** unique, claimed first-come, and
`NULL` for almost everybody. Nothing in the product requires one; the only thing
it unlocks is a public URL.

| | `username` | `handle` |
|---|---|---|
| unique | only with `discriminator` | yes, on its own |
| required | yes (auto-assigned) | no |
| used for | mentions, the tag, discovery | one public URL |
| changeable | freely | once per 30 days |

## The rules

Defined once, in `packages/shared/src/profiles.ts`, and consumed by the client,
the server and the database:

- 3–20 characters, `^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$` (the same expression is
  a `CHECK` constraint in `schema.sql`; `profiles.test.ts` pins the two as equal)
- normalised on input — `@João Silva` becomes `joao_silva` rather than being
  refused
- a reserved list covering routes, infrastructure words, and the authority words
  a phisher wants (`suporte`, `admin`, `oficial`, `seguranca`, `pqp`, …)
- a slur blocklist, split into substring-matched (unambiguous) and exact-matched
  (`macaco` alone is the slur; `macacos_fc` is a supporters' club). Swearing is
  deliberately allowed — the product is named after an expletive
- one rename per 30 days (`handle_changed_at`), which is the anti-squatting rule

**The unique index is the arbiter.** Two people can both be told a handle is
free; the availability check is a read and a read reserves nothing.
`claimHandle` attempts the write and converts the `23505` into a 409 for the
loser. Do not add a pre-check — it would look safer and be exactly as racy.

## Routes

| Path | Auth | What |
|---|---|---|
| `GET /api/public/profiles/:handle` | **none** | the profile; 404 = free |
| `GET /api/users/:userId/banner` | **none** | the banner bytes, as a redirect |
| `GET /api/users/by-handle/:handle` | session | handle → `publicUserSchema`, for "add me" |
| `PATCH /api/me` `{ handle }` | session | claim or rename |
| `POST /api/me/banner` → `…/claim`, `DELETE /api/me/banner` | session | the banner, mint / claim / clear |

The public profile route is one of the deliberately-unauthenticated routes in
`server/src/api/index.ts` (see CLAUDE.md pitfall #8). It carries **only**:
`handle`, `displayName`, `avatarUrl`, `bannerUrl`, public-community badges, an
approved `depoimentoCount`, the newest six approved `depoimentos`, and
`memberSince` as `YYYY-MM`. No id, no `name#1234` tag, no email, no presence, no
message content, no private servers. Characters and webhook rows 404.

**Why depoimentos are rendered rather than counted.** A depoimento is the one
feature in this product whose mechanic is an act of approval: a friend wrote it
for a profile, and the subject published it from a preview that said exactly
where it would go. Two people consented to this page. What still does not travel
is the author's id or tag — they appear as a name, a picture, and (only if they
claimed one) a handle, because a depoimento must never become a way to enumerate
the people who know somebody.

**Why the join date is a month.** `memberSince` is truncated to `YYYY-MM` on the
server, before it is serialised. A timestamp on a surface served to the open
internet is a fact about when somebody was at a computer; "no pqp desde julho de
2026" is a badge. `monthStamp` / `monthStampToDate` in `@pqp/shared` are the one
definition, so the two ends cannot disagree about what the string means.

**The banner** rides the avatar machinery — same bucket, same signer, same
presign-then-HEAD — because its key carries the owning account's id and is
therefore self-authorising, exactly as an avatar key is. It uses its own
`banners/<id>/` prefix rather than a folder inside `avatars/`, so the smaller
avatar cap cannot be spent through the larger banner signature. With no `S3_*`
there is no upload and the page draws a gradient generated from the handle's own
hue (`client/src/lib/hero-tint.ts`), which is a design rather than a placeholder.

## SEO on a static SPA

The site is a static SPA: every route is served the same `index.html`, and
`Seo` fixes the head **in the browser**. WhatsApp, Instagram, Twitter and
Discord unfurlers never run that script, so without help every profile link
would unfurl as the generic product card.

`client/functions/_middleware.ts` is a Cloudflare Pages middleware that runs at
the edge in front of the asset, fetches the profile JSON, and rewrites the head
(`<title>`, description, canonical, `og:*`, `twitter:*`, `ProfilePage` JSON-LD)
before the bytes leave. Everything that could actually be wrong lives in
`client/src/lib/profile-meta.ts`, which is typechecked, linted and unit-tested
against the real `index.html`.

Two things make it work with no new configuration:

- `dist/edge-config.json`, emitted by a small Vite plugin from `VITE_API_URL`, so
  the middleware and the SPA are pointed at the same API by construction. A Pages
  variable `PQP_API_URL` overrides it if a deploy needs repointing without a
  rebuild.
- the deploy step runs `wrangler pages deploy` **from `client/`**, because
  wrangler resolves `functions/` relative to the working directory. Deploying
  from anywhere else ships the site with no middleware and no other symptom.

Every failure path (no API origin, API down, 404, timeout, malformed body)
serves the page unchanged.

The same middleware also handles `/c/<slug>` through
`client/src/lib/community-meta.ts` — a separate head builder rather than one
parameterised function, because the two cards differ where it matters: a
profile's image is a square avatar and gets `summary`, a community's is a 3:1
banner and gets `summary_large_image`. See `docs/CONTENT_SAFETY.md` §Communities
for what that page may and may not carry.

`robots.txt` allows `/@`, `/c/`, `/garanta` and `/claim`. The sitemap lists
static pages only — generating one from the database would be a public,
complete, machine-readable list of everybody on the service, which is exactly
the enumeration surface the profile endpoint refuses to be.

## The claim flow, end to end

1. `pqp.gg/garanta` (or `/claim`). Type a name; the availability check is a
   debounced `GET /api/public/profiles/:handle` and a 404 means free.
2. The chosen name travels to `/app` **twice**: as `?claim=<handle>` on Clerk's
   `forceRedirectUrl`, and as a one-hour `localStorage` stash
   (`lib/handle-intent.ts`) for the flows that eat query strings.
3. `App` acts on it at `bootstrapReady` — after the account exists and after the
   18+ gate — then wipes the query string and consumes the stash so it can never
   repeat.
4. Existing accounts claim from **Settings → Profile**, which also shows the
   link and a copy button, and disables the field while the cooldown stands.

`pqp.gg/@rafa` → "Me adiciona no pqp" is the same machinery with `?add=<handle>`:
the app resolves the handle through `/api/users/by-handle/:handle` and sends the
friend request.

## Not built (deliberately)

- **A generated OG card image.** `og:image` is the avatar today. A rendered card
  (name + handle + badges on a branded background) needs a Worker with a font,
  an SVG-to-PNG path, and a cache — roughly a day, and it buys a nicer thumbnail
  rather than a working one.
- **A claimed count on the landing.** It needs a public aggregate endpoint, and
  a small honest number early is worse copy than no number.
- **Releasing a handle.** There is no route. Freeing one hands somebody else a
  URL that is already in a hundred screenshots.
