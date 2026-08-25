# Decisions

Choices that shape work not yet built. Recorded so a later session does not silently
re-litigate them.

## Attachments: Cloudflare R2 (2026-08-01)

Uploads go to Cloudflare R2 over the S3 API. The server mints presigned upload URLs so bytes
never pass through the API process.

**Why.** Railway's filesystem is ephemeral — anything written to disk is lost on redeploy, so
local disk is not an option for the hosted deployment. R2 has no egress fees and the project is
already on Cloudflare for Pages. Postgres large objects were the alternative; rejected because
they bloat the database and every backup, for the one kind of data that least needs
transactional storage.

**Implications.**
- New Railway env: an R2 bucket name, account id, access key id, secret. Never in a `VITE_` var.
- Self-hosters point the same S3 driver at MinIO or any S3-compatible service, so the
  open-source story stays intact without a second code path.
- Presigned PUT for upload, and either presigned GET or a public bucket with unguessable keys
  for reads. Prefer presigned GET — a public bucket makes every attachment permanently world
  readable regardless of the channel it was posted in, which contradicts private channels.
- Enforce a size cap and an allowlist of content types **server-side when minting the URL**, not
  only in the client.
- Store attachment metadata in Postgres (`message_attachments`): message id, key, content type,
  size, width/height for images. The object store holds bytes; the database stays the index.

## DMs: 1:1 and group from one model (2026-08-01)

Build direct messages with a model that covers both 1:1 and group conversations from the start,
rather than shipping 1:1 and migrating later.

**Why.** The migration from a two-participant assumption to N participants touches permissions,
the sidebar, naming, unread and notifications all at once — the same surfaces twice. Doing it
once is more work now and less work in total.

**Implications.**
- `channels.server_id` becomes nullable, or conversations become their own table. Whichever is
  chosen, the entire message / WebSocket / unread / mention stack should be reused unchanged —
  a parallel messaging path is how this feature turns into a rewrite.
- A participants table with no roles. Group DMs have no owner in Discord's model; anyone can add
  anyone, and that is a deliberate simplification worth copying.
- Naming: a DM has no name. The UI derives it from the other participants, which means the
  sidebar needs the participant list, not just a title.
- Needs user search by handle first (gap #17) — there is currently no way to find someone you do
  not already share a server with.
- Blocking and DM privacy controls (gap #19) stop being optional the moment DMs exist.

## Search: Portuguese and English side by side, accent-folded (2026-08-07)

`messages.search_tsv` holds two tsvectors concatenated —
`to_tsvector('pqp_pt', pqp_pt_plurals(body)) || to_tsvector('pqp_en', body)` — and the query is
the matching OR. `pqp_pt` / `pqp_en` are `portuguese` / `english` with `unaccent` in front of the
stemmer. All of it lives in one block in `server/src/schema.sql`; the service calls
`pqp_search_query()` and `pqp_search_headline()` and names no configuration.

**Why.** The audience is Brazilian and the product's own vocabulary is English, and one
configuration cannot serve both. Measured over 30 Portuguese and 15 English word pairs a reader
would expect to match each other:

| configuration | pt | en |
|---|---|---|
| `english` (what it was) | 2/30 | 15/15 |
| `portuguese` | 10/30 | 2/15 |
| `simple` | 0/30 | 0/15 |
| `portuguese \|\| english` | 10/30 | 15/15 |
| `pqp_pt \|\| pqp_en` | 25/30 | 15/15 |

Switching to `portuguese` would have been the same mistake facing the other way. Half of the
Portuguese failures are not stemming at all: people type `nao`, `voce`, `reuniao` and the message
says `não`, `você`, `reunião`. Per-server configuration (the fourth option) is unreachable
anyway — a generated column cannot depend on another table.

**Cost, measured on 100k chat-length rows.** GIN index 2.5 MB → 3.9 MB, stored vectors 12 MB →
18 MB, ~6 µs more per INSERT. Rank is slightly distorted: `||` shifts the second half's positions,
so `ts_rank_cd` proximity only means anything within a half, and a word both stemmers agree on is
counted twice.

**Implications.**
- Changing a configuration, or `pqp_pt_plurals`, silently invalidates every stored vector —
  Postgres does not recompute generated columns when a text search configuration changes. The
  fingerprint in the column's `COMMENT` is what forces the rebuild; it is derived by running a
  canary string through the real expression, so it cannot fall behind by being forgotten.
- The rebuild drops and re-adds the column, which rewrites the table under `ACCESS EXCLUSIVE`.
  Fine at today's size. A large-table version needs a shadow column filled in batches,
  `CREATE INDEX CONCURRENTLY`, then a swap — none of which fits in `schema.sql`, because the file
  is applied as one implicit transaction and `CONCURRENTLY` cannot run inside one.
- `unaccent` is a trusted extension from PG13 on, so the database owner installs it without
  superuser. If a host refuses, the block warns and search stays accent-sensitive rather than
  putting the server in a boot loop.
- Known gap: the `-l`/`-is` plural (`canal`/`canais`). Its rules need the accent to disambiguate
  — `papéis` is `papel` but `fáceis` is `fácil` — which the spellings people actually type do not
  carry. Doing it properly needs a hunspell pt_BR dictionary, i.e. dictionary files on the
  database host, which managed Postgres does not offer.

## Game connections: Discord-style, not a second login (2026-08-23)

Steam, Battle.net and Twitch are proven badges on a profile. Clerk stays how people sign in.

**Why not Clerk social.** Clerk has no Steam provider. Using Battle.net or Twitch as a Clerk
login would create a second way into the account. Disconnecting a Steam would then be an identity
event, which is the wrong product. Valve documents OpenID 2.0 for third-party linking; Steamworks
OAuth is partner-only. Twitch and Battle.net authorization-code grants are self-serve.

**Why not Xbox / PSN / Riot / Epic / Nintendo in this cut.** Those are partner programmes or
review-gated. A Connect button that 503s forever is worse than not offering it.

**Implications.**
- Tokens are used once to learn who the person is, then discarded. No refresh-token vault.
- Visibility defaults to in-app (`shared`). `public` is an extra tap because a Steam profile URL
  on `pqp.gg/@handle` is a stable identifier and that page was designed not to be one.
- Off per provider until that provider's env is set (`GET /api/connections/config`).
- The SPA keeps the session: Connect → provider → `/app/connections/callback/:provider` → POST
  with the existing Bearer token.
- Unconfigured providers are coming soon in Settings, not a disabled Connect button.
- The in-app card uses the same audience as depoimentos (friends or a shared server).
- Reconnect of the same provider account keeps visibility; a different account resets it.
- See [`CONNECTIONS.md`](./CONNECTIONS.md).

## Appearances: second axis, named presets (2026-08-25)

User-facing looks are named token skins (`signal`, `harmony`, `hearth`,
`night`), not a second brightness value and not a layout clone.

**Why a second axis.** `data-theme` already means resolved brightness
(`light` | `dark`). Stuffing skins into it would break System, the marketing
dark pin, Clerk, emoji-mart, and the Electron window background.

**Why these names.** Signal is the existing chartreuse look, named after the
old `--color-signal` token. Harmony / Harmonia is the pun on the other big
community chat app, without using that app's name. Acordo was rejected: in
Portuguese it also reads as "I wake up". Hearth is the warm workspace look.
Night / Noite is the near-black skin. Not Onyx: that name belongs to another
product. Night is dark-only. Light Night is a contradiction, so the look pins
brightness to dark.

**Why not a two-tone Hearth sidebar.** Channel-list text uses `--color-text`,
which the message pane also uses. Painting the channel column a saturated wine
needs an `--color-on-sidebar` token and class changes. That is a later cut.
v1 only tints `--color-rail`.

**Implications.**
- Storage key `pqp-appearance`, same boot-script rule as `pqp-theme`.
- Validated on `userPreferencesSchema`. Invalid values (including brand names)
  are rejected, not stored.
- Marketing routes still force dark. They do not pin Signal.
- Free-form user CSS stays rejected. See [`THEMING.md`](./THEMING.md).

## Contrast: third axis, not a fourth skin (2026-08-25)

High contrast stacks on Signal / Harmony / Hearth / Night and on light / dark.
It is an accessibility preference, not another named look.

**Why not a Teams clone.** Teams High Contrast is the useful idea. Teams
purple as a fourth skin is a worse Harmony.

**Why `system` is the default.** The OS already has `prefers-contrast: more`.
Starting at `default` would ignore a setting the user already made.

**Implications.**
- Storage key `pqp-contrast`. Attribute `data-contrast="more"` only when
  resolved contrast is high. Delete the attribute at default.
- Validated on `userPreferencesSchema`. Values are `default`, `more`, `system`.
- Token overrides stay unlayered and cover text, muted text, borders and the
  indicator. Do not override `--overlay`.

## Accent hue: fourth axis, not a fifth skin (2026-08-25)

Users pick a hue. Surfaces stay with the named look. This is Linear's lesson
(derive from a hue) without cloning Linear's chrome.

**Why not free-form CSS.** A hue is a number. A stylesheet is untrusted input.
See [`THEMING.md`](./THEMING.md).

**Implications.**
- Storage key `pqp-accent-hue`. Values are `default` or an integer 0–360.
- Attribute `data-accent="custom"` plus `--accent-hue` only when a hue is set.
- Slider writes are debounced. Reset to the look syncs immediately.
