# pqp-admin: the operator dashboard

One static page (`site/index.html`) and one small Cloudflare Worker
(`src/index.ts`) in front of it, deployed as the existing `pqp-admin` Worker at
`https://pqp-admin.rafaelcg-a0a.workers.dev/`.

It is a read-only view of the hosted instance for the person running it. It is
not part of the product and it is not linked from anywhere.

## What it shows

A strip of **signals** sits directly under the header: one pill per thing that
can need attention (health, **capacity**, message volume, call quality, voice
load, house-cast share, Android APK clicks today), coloured by state, so a scan
does not have to read every figure below.
Under it, one line of provenance: which account kinds the numbers exclude, the
server's cache window (and that the capacity card sits outside it), and the
page's own refresh interval.

Under that, **seven tabs**. The whole payload arrives in one read, so switching
a tab is a pane toggle and never a request; the choice lives in the URL hash, so
a reload or a link to yourself opens where you left off, and arrow keys move
between them.

| Tab | What is on it |
|---|---|
| **visão geral** | health tiles, the six headline metrics with sparklines, **apps e produto** (Android APK clicks + GitHub downloads, friendships, attachments, invites, push), the two 24-hour charts, the five most active servers |
| **usuários** | signups per day over 14 days, who is actually active (24h and 7d), the returning-writer share, accepted friendships and open friend requests, what people filled in (handle / avatar / banner / game account / age check), plus first-touch acquisition and game connections |
| **canais** | text-vs-voice composition, the eight busiest text channels of the last 24h, and the shape of the instance: direct and group conversations, private channels, channels that have never received a message |
| **comunidades** | the directory: listed, suspended, addressed, by category, and the communities themselves. Off by default, and it says so (see below) |
| **voz e chamadas** | the rooms open *right now* with who is sharing a screen, the voice summary against the mesh limit, and the full call-quality distribution with notes |
| **moderação** | the report queue (open / actioned / dismissed / new today), bans, timeouts in force, and the feedback queue with the last eight entries. The tab carries a count badge when anything is open |
| **infra** | **capacity right now** (open WebSockets and the Postgres pool, see below), then the deployed commit, region, database latency, worst-component uptime over 24h and 7d, and availability per component |

### The capacity card is the one live thing on the page

Every other number here is from the API's 30-second cache. The `runtime` block
is not: the API samples it on each request, because a *cached* queue length
reads as calm during the one event it exists to report.

It shows two things, and they are different kinds of number:

- **WebSockets open now**, plus the peak. Every signed-in client holds one for
  its whole session, so this is the closest thing the process has to "people
  connected". The peak is exact rather than sampled — the API measures it on
  every connection, and a maximum is always reached immediately after one opens.
- **The Postgres pool**: one block per connection it may hold (`PG_POOL_MAX`),
  filled by how many are checked out, amber from 80% and red the moment anything
  queues. Beside it: in use, **na fila**, and the peak queue length.

**`na fila` above zero is the earliest honest warning this system can give**:
nothing is broken, nothing is slow enough for anybody to complain, and requests
are already standing in line for a connection.

**It is not, on its own, proof that the pool is exhausted.** pg queues a request
whenever it cannot hand it a connection *in the same tick* — including while the
pool is still opening its first connections, which is every cold start. Measured
locally: a single `/api/admin/metrics` call against a fresh pool queues 14
requests even with `PG_POOL_MAX=40`, where there was never any shortage. So:

| Reading | Means |
|---|---|
| queue > 0, pool **not** full | amber. A burst the pool absorbed. Normal after a deploy. |
| queue > 0, pool **full** | red. The ceiling is the constraint. This is the wall. |
| `pico em uso` == `PG_POOL_MAX` | the wall was hit at some point since the card started counting, even if everything looks calm now. |

Red is reserved for that middle row, because a colour that appears on every
deploy stops being read.

The queue is deliberately not drawn as more blocks — it is unbounded, and 170
people waiting must not render as a wider bar that looks like more capacity.

The peak queue is observed at checkout (there is no event for *joining* the pool
queue), so it can sit slightly below the true instantaneous peak and can never
exceed it. Both peaks reset on deploy and at São Paulo midnight, and the card
says which by naming the time it has been counting from.

### Nothing on this page is illustrative

The page used to boot with a set of plausible seed numbers and swap them for
live ones once `/metrics` answered. Sections with no live source kept them and
were badged "dados representativos". **That is gone.** A plausible number on a
dashboard gets read as a real one, it survives a screenshot, and at a glance it
is indistinguishable from a stale reading.

What happens instead:

- **Before the first read:** skeletons. They draw the shape of the content and
  never a digit.
- **After a successful read:** real numbers only.
- **If the read fails:** an explicit failure box naming the reason, with a retry
  button. The skeletons stay. No figure appears anywhere on the page.
- **If a read fails *after* a good one:** the last real numbers stay on screen
  and the header chip says when they were read.
- **If the API answers without a block this page knows about** — the dashboard
  deploys in seconds and the API restarts every live call, so the two are
  deliberately not released together — that section hides itself and says the
  API is older than the field. It restores itself on the next poll once the
  field arrives; no reload needed.

Empty and off are also kept distinct from broken: "ninguém em chamada agora" is
a result, and a `COMMUNITIES_ENABLED` that is unset gets its own panel
explaining that the zeros mean the feature is off rather than unused.

### Sources

Live, from `GET https://api.pqp.gg/api/admin/metrics` (proxied as `/metrics`):

- **`runtime`**: open WebSockets and the connection pool (`max` / `total` /
  `idle` / `waiting`, plus `busy` and a `pressure` verdict), with peaks for
  sockets, queue and checked-out connections since `peakTrackedSince`. Sampled
  per request, not cached, and it costs nothing: every value is a property
  read, never a query
- users (total, new in 24h, new per hour, new per day over 14 days), servers
- messages in 24h and per hour, last hour, delta against the previous 24h,
  distinct senders, active text channels
- **automated messages in 24h** (webhooks + the house cast), drawn as a share
  of raw traffic beside the human count and never folded into it
- channel composition (text / voice / category / thread), plus the detail
  behind the canais tab: conversations, private channels, never-used channels,
  busiest channels
- user adoption and activity: handle / avatar / banner / age check, active over
  7 days, accounts in the art. 18 deletion window, and a returning-writer share
  over accounts older than 24 hours. **Messages are the only per-user activity
  this schema records**, so somebody who reads without posting counts as
  inactive; the pane says so rather than letting it read as retention
- voice: rooms open now (with names and who is screen-sharing), people in them,
  the largest room now against the practical mesh limit (amber past 6), and the
  largest room today (process-local; it resets on deploy and at São Paulo
  midnight)
- **call quality, last 7 days**: the full 1-to-5 distribution as bars, the
  average, the share that gave 4 or 5, the split by transport (mesh vs the
  LiveKit SFU, both always listed so "no SFU calls yet" is visible), and the
  notes people wrote, which the client only asks for on a 3 or less
- the five most active servers of the last 24h
- first-touch acquisition and landing pages
- **game connections**: per provider, how many accounts linked Steam /
  Battle.net / Twitch and how many chose `public`, plus how many accounts linked
  *anything* — which is not the sum of the rows, since one person can link two
  providers. A provider with no credentials on the API is labelled **desligado**,
  because a zero there means nobody could link rather than nobody wanted to.
  Every share is over `connections.ofUsers`, which is `users.total` in the same
  payload: all human accounts that exist, not a window and not actives
- **communities**: totals, per category, and the listed communities with member,
  channel and message counts. Gated on `COMMUNITIES_ENABLED`
- **moderation**: report and feedback queues by status, bans, unexpired
  timeouts, and the last eight feedback bodies (truncated by the API, never
  attributed)
- the deployed API commit (`APP_VERSION`) and the excluded account kinds
- **product**: accepted friendships and open friend requests, claimed
  attachments (total and last 24h), invites created in 24h plus cumulative
  invite uses, and push subscriptions by platform (`web` / `apns`)

Live, from this Worker (merged onto `/metrics`, never stored on the API):

- **Android APK button clicks**: `POST /apk-click` from the hosted `/android`
  page, counted in KV, São Paulo day bucket. A click is a click, including
  people who never finish the install. Rate-limited per IP. The path is
  public on purpose; the *read* still needs the password.
- **Android APK downloads**: GitHub `download_count` on `pqp.apk` of the
  rolling `android-beta` prerelease, cached five minutes. That is the file
  leaving GitHub, so it can be lower or higher than clicks.

Live, from `GET https://api.pqp.gg/status.json` (proxied as `/health`): the
component health tiles, the headline pill, database latency, and the 24h/7d
uptime behind the infra tab.

The page reads in both light and dark (it follows the system setting; every
colour is a token, so only the palette changes), and nothing scrolls the page
sideways on a phone: wide tables and charts scroll inside their own box, and the
tab bar scrolls rather than wrapping.

Webhook pseudo-accounts and character (house cast) accounts are excluded from
every user and message count, the same way the acquisition report excludes
them; their message volume is reported separately as `messages.automated24h`.

## Why it is behind a password

The repo is open source and a `workers.dev` hostname is guessable. The page is
aggregate counts and holds no id, handle or email, but it is not *only* counts:
the "most active" tables carry the **names of private servers and channels**,
and the call-rating notes and feedback entries are **free text people wrote**.
All of that is more than the public status page is ever allowed to say. So the Worker gates the page, `/metrics` and `/health` behind HTTP Basic Auth, compared in constant time, and refuses to
serve anything at all (503) while the password is unset. The one public path is
`POST /apk-click`: it increments a counter and cannot read one. Every response is
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag:
noindex`, and `/robots.txt` disallows everything.

Recommended upgrade: put the Worker behind **Cloudflare Access** (free for up
to 50 users). Add an Access application for the `workers.dev` hostname (or a
custom hostname), allow your own email, and the login page replaces the Basic
prompt with a real identity check, MFA, and an audit log. Nothing in this
directory needs to change for that; keep the Basic Auth on as a second layer
or drop it once Access is in front. This is not configured yet.

## Secrets and variables

Nothing secret lives in this directory, in `wrangler.jsonc`, or in the HTML.

| Where | Name | Kind | What |
|---|---|---|---|
| Worker | `ADMIN_DASH_PASSWORD` | secret | Basic Auth password. Unset: the Worker serves nothing. |
| Worker | `ADMIN_DASH_USER` | var (in `wrangler.jsonc`) | Basic Auth username, default `operador`. |
| Worker | `ADMIN_METRICS_TOKEN` | secret | Bearer token sent to the API on `/metrics`. Never reaches the page. |
| Worker | `API_ORIGIN` | var (in `wrangler.jsonc`) | `https://api.pqp.gg` |
| Worker | `APK_CLICKS` | KV | Click counter for `POST /apk-click`. Binding in `wrangler.jsonc`. |
| Worker | `GITHUB_REPO` | var | `rafaelcg/pqp` — release looked up for the APK download count. |
| API (Fly) | `ADMIN_METRICS_TOKEN` | secret | The same value. At least 16 characters or the API treats it as unset. |

Generate the token once (`openssl rand -hex 32`) and set it on both sides:

```bash
# Fly (the API). This restarts the machine.
fly secrets set ADMIN_METRICS_TOKEN=... -a pqp-api

# Worker
cd tools/admin-dashboard
npx wrangler secret put ADMIN_METRICS_TOKEN
npx wrangler secret put ADMIN_DASH_PASSWORD
```

An instance moderator (`INSTANCE_MODERATOR_CLERK_IDS`) can also read the same
endpoint with their own Clerk session; the token exists because the Worker has
no session. Everybody else gets a 404, the same answer as a route that does not
exist. Server side: `server/src/services/metrics.ts`, gate in
`server/src/api/index.ts`, tests in `server/src/api/metrics.test.ts`. The
counts are cached in memory for 30 seconds; the `runtime` block is not, and the
cache is typed as `Omit<AdminMetrics, "runtime">` so it cannot become so by
accident. The live values themselves come from `server/src/lib/runtime.ts`
(tested in `runtime.test.ts`), which nothing queries.

## Deploy

```bash
cd tools/admin-dashboard
npm install                     # wrangler + types, local only
npm run check                   # tsc over the Worker
npm run dry-run                 # bundles without deploying
npx wrangler deploy             # updates the existing pqp-admin Worker
```

`wrangler deploy` keeps secrets already set on the Worker; only `vars` in
`wrangler.jsonc` are overwritten. To run locally, put the two secrets in a
`.dev.vars` file here (git-ignored) and `npm run dev`.

Test the API side directly, with the token:

```bash
curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" https://api.pqp.gg/api/admin/metrics | jq .
# without it: 404
```

## Not in the pnpm workspace

Like `tools/ambient`, this directory has its own `package.json` and its own
`npm install`. The repo's root lint covers the TypeScript here; the repo's
typecheck and tests do not, which is what `npm run check` is for.
