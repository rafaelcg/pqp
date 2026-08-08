# Handover — pqp (as of 2026-08-01)

Cold-start status for agents and humans. Companion: [`../CLAUDE.md`](../CLAUDE.md). Roadmap checklist: [`PLAN_STATUS.md`](./PLAN_STATUS.md).

## Product

**pqp** — open-source Discord-like voice + text chat. Hosted twin aimed at **pqp.gg**; self-host is an independent copy (own URL, DB, Clerk).

- **Repo:** https://github.com/rafaelcg/pqp
- **Model:** servers (invite codes) → public/private channels → text chat + full-mesh voice
- **Roles:** `owner` / `admin` / `member` · usernames `name#1234`

## Live endpoints (hosted)

| Service | URL |
|---|---|
| Web (Cloudflare Pages) | https://pqp-3yr.pages.dev |
| API (Railway) | https://api-production-206d.up.railway.app |
| WebSocket | `wss://api-production-206d.up.railway.app/ws` |

ICE config: `GET https://api-production-206d.up.railway.app/api/ice-servers` (auth as required by current server).

## Monorepo

pnpm workspaces: `client/` · `server/` · `packages/shared/` · `electron/`

```bash
docker compose up -d postgres
pnpm install && pnpm dev          # :5173 + :3001
pnpm electron:dev                 # desktop shell vs Vite

# Optional profiles
docker compose --profile livekit up -d                        # SFU
docker compose --profile storage up -d postgres minio minio-init   # attachments
```

Never commit `.env`. Template: [`.env.example`](../.env.example).

## Phase status

| Phase | Status |
|---|---|
| 0 Shell + docs | Done |
| 1 Auth + DB + API | Done |
| 2 Text chat | Done |
| 3 Voice (mesh) | Done (cross-NAT FIXED 2026-07-11) |
| 4 Self-host / Railway + Pages | Done (live) |
| 5 SFU | **LiveKit implemented 2026-07-30, not yet run against a live server**; Cloudflare Realtime still a stub |
| 6 Electron + billing | **Partial** (shell + CI artifacts + deep links; no app icon, no Stripe UI) |

Detail and “still open” list: [`PLAN_STATUS.md`](./PLAN_STATUS.md).

## Recent shipped work (context for next agents)

- Discord-like **voice sidebar** + **speaking rings**
- Channel **topics / icons**
- **Avatar presets**
- Fix: Clerk **`getToken` remount loop**
- Production voice plumbing: ICE via `/api/ice-servers`, Railway `TURN_*` (ExpressTURN); Metered / Cloudflare TURN still supported as alternatives
- **Fix (2026-07-11):** cross-NAT mesh voice — real TURN + client Retry / ICE restart; dead Open Relay removed

### Audit hardening (2026-07-11)

A full app audit produced a batch of security, robustness, and hygiene fixes:

- **Realtime disconnects fixed:** WS heartbeat (server ping/pong) + client
  auto-reconnect with backoff and fresh-token resolution; WS handlers wrapped
  in try/catch and `pool.on("error")` + process guards so one bad message no
  longer crashes the server (which had shown as "Realtime connection closed").
- **Voice signaling scoped to rooms:** relay and rosters were instance-wide
  (cross-server mic-audio eavesdropping risk); now room/member scoped, with a
  client peer allowlist. Mesh cap enforced server-side; mic released on join
  timeout; old peer managers disposed on rejoin.
- **Auth/abuse:** `DEV_AUTH_BYPASS` ignored in production, request body size
  cap, per-user rate limits (API + WS), Clerk `authorizedParties`, CORS
  allowlist (`CORS_ALLOWED_ORIGINS`).
- **Moderation added:** kick, ban (blocks rejoin), and message delete (live).
- **Infra:** Dockerfile pins pnpm 10 + non-root + `.dockerignore`; pg pool
  config; `/health` checks the DB.
- **Tests + CI:** vitest suite (unit + DB-backed ACL/moderation) run in CI
  against a Postgres service; `deploy-web` gated on CI success.

New env names: `CLERK_AUTHORIZED_PARTIES`, `CORS_ALLOWED_ORIGINS`,
`DATABASE_SSL` / `PG_POOL_MAX`.

### Voice random-disconnect investigation (2026-07-11)

Reported: two phones in the same voice channel (WiFi, screen on, foreground)
get kicked out of the call at random, uncorrelated times.

- **Observability added:** the server now logs greppable WS/voice lifecycle
  lines — `ws.connect` / `ws.auth` / `ws.close` (with close code + `wasInVoice`)
  / `ws.heartbeatTerminate` / `voice.join|leave|roomFull` (`server/src/lib/log.ts`).
  Next repro, `railway logs | grep '\[pqp\]'` names the cause (client close vs
  heartbeat reap vs proxy-injected 1006).
- **Repro tool:** `pnpm soak:voice` (`scripts/voice-soak.mjs`) spawns the
  server, joins N simulated clients to a voice room, and soaks the connections.
  A local 70s soak of 2 idle clients showed **zero drops** — so the cause is
  not a plain server bug; it points at real-network latency and/or the Railway
  edge proxy, which localhost doesn't have.
- **Client hardening (the fix):** the keepalive was dropping a healthy link
  after a single 10s pong gap — each phone's independent timer explains the
  random uncorrelated drops. Now it tolerates missed pongs
  (`MAX_MISSED_PONGS`, ~40s) before declaring the link dead, handles
  `visibilitychange`, and — most importantly — a brief WS reconnect now
  **auto-rejoins the voice room** (`voice.notifyReconnected`) instead of
  ejecting the user (`client/src/lib/realtime.ts`, `client/src/hooks/use-voice.ts`).
  Verified: the transport survives 30s of silence (old code dropped at 10s),
  still detects a truly dead link, and reconnects.

## Resolved (2026-07-11)

**Cross-NAT mesh: remote peer FAILED** — fixed via ExpressTURN on Railway (`TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` → `/api/ice-servers`) plus client Retry and ICE restart. Dead Open Relay creds removed.

**Retest:** hard-refresh both clients, leave and rejoin the voice channel.

## CI / secrets checklist (names only)

### GitHub Actions

| Workflow | File |
|---|---|
| CI | `.github/workflows/ci.yml` |
| Deploy Web (Pages) | `.github/workflows/deploy-web.yml` |
| Electron | `.github/workflows/electron.yml` |

**GH secret names:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`.

Do **not** put `CLERK_SECRET_KEY`, `DATABASE_URL`, or TURN credentials in Pages/client secrets.

### Railway (API)

**Env names:** `DATABASE_URL`, `CLERK_SECRET_KEY`, `PORT` (optional), and one ICE path:

- `TURN_URL` + `TURN_USERNAME` + `TURN_CREDENTIAL` (production: ExpressTURN), or
- `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`, or
- `METERED_API_KEY` (+ optional `METERED_DOMAIN`)

Optional features, each off until its names are set: `GIPHY_API_KEY` (GIF search), `LIVEKIT_*`
(SFU), `S3_*` (attachments — see [`ATTACHMENTS.md`](./ATTACHMENTS.md)).

Do **not** put `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in a `VITE_` variable or a Pages
secret; they would ship in the public bundle.

## Auth notes

- Clerk on client + `@clerk/backend` verify on server.
- Local bypass: `DEV_AUTH_BYPASS` + `VITE_DEV_AUTH_BYPASS` (see README / CLAUDE.md).
- Allow Pages origin(s) and API origin in Clerk dashboard.

## Docs map

| Doc | Use |
|---|---|
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | System design, WS protocols, voice backends |
| [`DEPLOY.md`](./DEPLOY.md) | Pages + GH Actions + client wiring |
| [`deploy-railway.md`](./deploy-railway.md) | Railway + TURN options |
| [`CLERK_SETUP.md`](./CLERK_SETUP.md) | Clerk CLI |
| [`voice-backends.md`](./voice-backends.md) | SFU notes |
| [`ATTACHMENTS.md`](./ATTACHMENTS.md) | File uploads: R2 in prod, MinIO locally, limits, sweeper |
| [`CONTENT_SAFETY.md`](./CONTENT_SAFETY.md) | Image scanning, what is *not* scanned, CSAM runbook, what the operator must apply for |
| [`billing.md`](./billing.md) | Future Plus/Pro |
| [`PLAN_STATUS.md`](./PLAN_STATUS.md) | Phase checklist |
| [`DISCORD_GAPS.md`](./DISCORD_GAPS.md) | Ranked feature gaps vs Discord, with implementation sketches |
| [`THEMING.md`](./THEMING.md) | Theming scope: role tokens, light mode, synced preferences |
| [`DECISIONS.md`](./DECISIONS.md) | Choices that shape work not yet built (attachment storage, DM model) |

## Hardening + product pass (2026-07-31)

A large pass landed across security, reliability, chat UX, moderation, and engineering health.
Full list in [`PLAN_STATUS.md`](./PLAN_STATUS.md). The parts most likely to surprise you:

- **Client API calls no longer take a token.** `client/src/lib/api.ts` holds a provider that
  resolves a fresh Clerk token per request and retries once on 401. Passing a captured token
  around was why actions failed with "Unauthorized" about a minute into a session.
- **The WebSocket reconnects.** `client/src/lib/realtime.ts` owns backoff, an app-level
  ping/pong, and a silence watchdog. `onReady(reconnected)` fires on every connect — that is
  where channel resubscription and history re-sync happen.
- **Routes live in a table.** `server/src/api/index.ts` registers against
  `server/src/lib/router.ts`. Params named `*Id` must be UUIDs or the request 404s before
  reaching Postgres.
- **New env vars:** `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY`, `PG_POOL_MAX`. Set `CORS_ALLOWED_ORIGINS` on
  Railway; without it CORS stays permissive.
- **Rate limiting and chat presence are in-process**, so the API is single-instance for now.
- **Schema additions** apply on boot via `initDb()`: `messages.edited_at`, `message_mentions`,
  `channel_reads`, `server_bans`.

## Search, notifications, and history navigation (2026-08-01)

- **Message search** — `GET /api/servers/:serverId/search?q=`. Postgres full-text: a
  `messages.search_tsv` generated column plus a GIN index, both applied on boot. **Portuguese and
  English, both accent-folded, indexed side by side** (2026-08-07 — it was `'english'` alone,
  which found 2 of 30 Portuguese word pairs). Everything the index and the query must agree on
  lives in one block in `server/src/schema.sql`: the `pqp_pt` / `pqp_en` configurations, the
  column expression, and the `pqp_search_query()` / `pqp_search_headline()` functions the service
  calls — `search.ts` names no configuration, because a query stemmed differently from the index
  matches nothing and raises nothing. Re-running the schema is a no-op: a fingerprint in the
  column's `COMMENT` is what decides whether to rewrite the table. See `docs/DECISIONS.md` for the
  measurements and the known `canal`/`canais` gap. The visibility
  predicate is lifted verbatim into one `VISIBLE_CHANNEL` const in `server/src/services/search.ts`
  so it can never drift from `isChannelMember`. Highlights are delimited with the control characters `U+0002` / `U+0003`,
  which `messageBodySchema` already rejects, so no message body can forge one and the client never
  treats server text as markup. ⌘K opens it.
- **Desktop notifications** ride the existing `user_preferences` JSONB — no new table, no new
  endpoint. Levels are `all` / `mentions` / `none`, resolved channel → server → account default.
  Permission is only ever requested from a click.
- **Notifications fire on the live `channel-activity` frame in `App.tsx`, not on a diff of the
  unread map.** The map also fills in bulk from `loadUnread` when a server is first opened, so
  diffing it announced every channel with a backlog as new. If you move this, keep that property.
- **Permalinks work on a cold load.** They did not before: the bootstrap opened the first text
  channel regardless, and `syncRoute` rewrote the address bar before the deep-link effect read it,
  so a shared `/message/<id>` link only worked in a tab that was already running. Bootstrap now
  yields to a URL that names a channel (`deepLinksChannel` in `App.tsx`).
- **Jumping into history no longer gets yanked back.** While `hasNewer` is true the list stops
  pinning to the bottom and drops live broadcasts rather than faking continuity; "Jump to present"
  reloads the tail. That button scrolls from a layout effect keyed on `messages`, because a tail
  reset swaps the whole window — a scroll scheduled when the fetch resolves runs against the
  outgoing layout and the browser then drops the container to the top.

## File attachments (2026-08-01)

Uploads to S3-compatible object storage — **Cloudflare R2** hosted, **MinIO** locally. Full
setup, R2 CORS and limits: [`ATTACHMENTS.md`](./ATTACHMENTS.md). Rationale:
[`DECISIONS.md`](./DECISIONS.md).

- **Off unless configured.** No `S3_*` env → `GET /api/attachments/config` says
  `{"enabled":false,"maxBytes":10485760}` and the composer hides the attach button. Same shape as
  GIF search.
- **Image dimensions travel with the mint**, not with the send: the browser measures the file
  before `POST …/attachments` and the row carries `width` / `height` from birth, so every reader
  can reserve the box. Display-only and bounded at 65535 px (`ATTACHMENT_MAX_DIMENSION`) — a
  client that lies mis-sizes its own placeholder.
- **Bytes never touch the API.** The server signs a PUT and the browser uploads straight to
  storage; reads are presigned GETs minted per row. Railway egress and Node memory both stay out
  of it.
- **Signing is hand-rolled SigV4** in `server/src/lib/s3.ts` over `node:crypto`. No new
  dependency — the S3 SDK is ~50 packages for one operation.
- **Size is enforced twice, and the two catch different things.** The mint signs
  `Content-Length` as well as `Content-Type` into the presigned PUT, so the store rejects a body
  of any other length — the client's declared `byteSize` can no longer become bytes the bucket
  pays for. The claim then requires `uploader_id` = sender, `channel_id` = the target channel and
  `message_id IS NULL`, and `HEAD`s each object, which is still the only thing that tells "never
  uploaded" from "uploaded", catches an object stored as a type other than the one signed, and
  covers a store that ignores a signed length. An attachment that fails it is dropped from the
  message.
- **The HEAD runs before the claim transaction opens**, on the pool. Inside it, a bucket that
  blackholes packets parks a pooled connection idle-in-transaction for the full ten second
  timeout, and a few concurrent image sends drain `PG_POOL_MAX` — every unrelated query, down to
  the membership check on each WS frame, then queues behind a storage outage. The insert, claim
  and mentions still share one transaction; ownership is re-stated in the claim `UPDATE`'s own
  `WHERE` under its row lock, so verifying on another connection gives up nothing.
- **Deleting a channel or server deletes its objects.** `message_attachments.channel_id` is
  `ON DELETE CASCADE` and the sweeper's predicate is `message_id IS NULL`, so a cascaded row is
  unreachable to it — both delete paths therefore read the storage keys *before* the delete and
  fire the bucket deletes afterwards, unawaited, in batches of 8, capped at 5000 objects
  (`server/src/services/servers.ts`). Past the cap the objects leak; the read is on the request
  path and must not be unbounded. Failures log `[attachments] leaked object <key>`.
- **The sweeper also runs once at boot**, right after `initDb()` and unawaited, on top of the
  hourly interval — a process that redeploys more often than the interval would otherwise never
  sweep once in its life.
- **A caption can be cleared.** `PATCH /api/messages/:id` accepts `body: ""` when the message
  carries attachments and only then; for a text-only message an empty body is a delete wearing an
  edit's clothes, so `updateMessageSchema` keeps its one-character floor.
- **Local:** `docker compose --profile storage up -d postgres minio minio-init`. The `minio-init`
  one-shot exists because a fresh MinIO has no bucket, and the first upload would then 404 on a
  URL that was signed perfectly correctly.
- **New env names:** `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`, `MAX_ATTACHMENT_BYTES`,
  `ATTACHMENT_URL_TTL_SECONDS`. The key and secret are credentials — API only, never `VITE_`.

**The thing that will waste your afternoon:** an R2 bucket has **no CORS policy by default**, and
a browser cannot PUT to it without one. The mint call returns 200, the API logs are silent
because the upload never touches the API, and the browser reports a CORS error against a URL that
is entirely valid. `AllowedHeaders` must include `content-type`, because the presigned PUT signs
it — but *not* `content-length`, which is a forbidden header name the browser sets itself and
which therefore never appears in a preflight. MinIO allows all origins by default, which is
precisely why this only shows up in production.

**The second thing:** every `/api` route needs a Bearer token, including
`/api/attachments/config`. A bare `curl` answers 401 and looks exactly like a broken feature.
Locally use `-H "Authorization: Bearer dev-local-token"` with `DEV_AUTH_BYPASS=true`.

### Verified against a real MinIO (2026-08-01)

`docker compose --profile storage up -d postgres minio minio-init` (naming the services, because
a bare `--profile storage up -d` also starts `app`, which then fights `pnpm dev` for `:3001`),
then the opt-in suite: `S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=pqp-attachments
S3_TEST_ACCESS_KEY_ID=pqpminio S3_TEST_SECRET_ACCESS_KEY=pqpminio-dev-secret pnpm --filter
@pqp/server test s3` — 19 passed, including the three cases that skip without `S3_TEST_*`.

- Full round trip passes for a plain key and for one holding a space, `+ ( ) * ' ! ~` and
  non-ASCII, so the hand-rolled RFC-3986 canonical-URI encoder is right against a real
  implementation.
- **The signed `Content-Length` is enforced.** Same URL with an over-size body → `403
  SignatureDoesNotMatch`; with an under-size body → the same. `Transfer-Encoding: chunked` with no
  length → `411 MissingContentLength`, nothing stored. A lying `Content-Length` header stores only
  the framed bytes, and an `aws-chunked` envelope cannot amplify because the envelope is what is
  signed.
- `presignGet` with a download filename survives a space, a quote and `ó` across both the
  `filename=` fallback and `filename*=UTF-8''`. `deleteObject` is idempotent.

**Caveat, and production runs on R2:** MinIO's enforcement is a side effect of signature
verification (`SignatureDoesNotMatch`, not `EntityTooLarge`), so it only holds where
`content-length` is reconstructed verbatim into the string-to-sign. R2 sits behind Cloudflare's
edge, which is the class of proxy that re-frames request bodies. **Treat the signed length as
verified on MinIO and unverified on R2.** The claim-time HEAD is what makes that tolerable: an
oversized object can never be attached to a message on any backend, so the exposure is one
unclaimed row for one sweeper grace period. A 10-minute check against a real R2 bucket would
close it.

## Direct messages, group DMs, and blocking (2026-08-02)

Gaps #17, #18 and #19 shipped together — #18 needs #17 to find anyone you share no server with,
and #19 stops being optional the moment #18 exists.

**The important structural change is `canAccessChannel`.** The channel-visibility predicate used
to exist as five verbatim copies (`isChannelMember`, `listUnread`, `listChannels`,
`getChannelAudience`, and search's `VISIBLE_CHANNEL`). It is now generated from one fragment in
`server/src/services/users.ts` and branches on `channels.kind`. That refactor was landed on its
own, with the whole existing suite passing untouched, *before* any DM code depended on it — and
the SQL was proved identical to the originals mechanically (`git show HEAD:` + whitespace-
normalised comparison), not by eye.

For `kind` of `dm` or `group`, membership is `channel_members` and nothing else. **There is
deliberately no owner/admin branch**: the server-channel predicate grants access to owners and
admins, and inheriting that unexamined would have put every server admin inside their members'
private conversations.

Conversations are channels with a null `server_id`, so messages, edits, reactions, typing, read
cursors, unread, mentions, attachments and voice all reuse the existing routes unchanged. A 1:1
is made idempotent by `dm_pairs` on the sorted uuid pair; a group deliberately has no pair row.

**Blocking bugs worth knowing about, because they all lived in the same place.** Review found six
defects and every one was in the conversation *lifecycle*, not the happy path — blocking then
sending was correct; blocking, *closing*, then sending was not:

- `isDmSendBlocked` resolved the other party through `channel_members`, which closing a
  conversation deletes. Block-then-close — two items in the same context menu, in the order a
  person actually performs them — silently disabled the block. It reads `dm_pairs` now, which
  survives a close. Pinned by a test that fails if you revert it.
- A group that had shrunk to two people was exempt entirely (the guard was gated on `kind='dm'`,
  and a group never becomes one). Now gated on whether a third participant remains, so one
  person's block still cannot silence a real group.
- `DELETE /api/dms/:channelId` dropped the membership row without evicting the live WS view, so
  leaving a group kept delivering its message bodies.
- Editing is a send: `PATCH /api/messages/:messageId` had no block guard, so a blocked person
  could rewrite a pre-block message into anything and it re-broadcast live. Every WebSocket path
  was guarded and the one HTTP path was not — worth remembering when adding routes.

Server-channel messages are **not** filtered server-side; that would corrupt the keyset
pagination counts. The payload carries `blocked: boolean` and the client collapses it behind a
reveal affordance.

## iOS screen sharing, both directions (2026-08-08)

**Two bugs and one feature.** Reported as "you cannot see a screen share on iOS,
and you cannot share your iPhone screen" against build 9.

1. **Voice channels dropped every remote video track.** `VoiceView`/`VoiceModel`
   predate video entirely: the model never passed `onVideoChange` to
   `VoiceClient`, so `emitVideo` classified each arriving track and handed the
   answer to nobody, and the screen had no surface to draw one on. Reproduced
   with a simulator in a voice channel and a real Chrome peer sharing into it —
   the peer showed `connected` and the screen showed a name and nothing else.
   Fixed: the model now wires the callback, files `cameraStreamId` from
   `welcome` / `peer-joined` / `voice-roster`, and the screen grows a share stage
   (letterboxed, tap for fullscreen) with a presenter line and a per-peer badge.
2. **Every WebSocket send was silently dropped ~30s after connecting.** The
   socket's `URLSession` set `timeoutIntervalForResource = 30`, which is a
   ceiling on the whole resource load — and a WebSocket *is* the resource.
   Buffered frames kept arriving, so the app looked online while nothing it sent
   ever left: answering a DM call sat on "Connecting…" forever because
   `join-voice-room` never went out. Fixed by removing the lifetime ceiling and
   by making an unsendable frame reconnect instead of returning quietly. This
   affected messages, calls and voice equally, not just screen sharing.
3. **Sending a screen** is now a ReplayKit broadcast upload extension
   (`gg.pqp.app.broadcast`) bridged to the app over a Unix domain socket in the
   `group.gg.pqp.app` container. See [`docs/IOS.md`](./IOS.md#screen-sharing).

Verified on a simulator against the local server with a real Chrome peer, in both
rooms and both directions; the extension itself needs a physical device.

## Verification status

| Checked | How |
|---|---|
| Authorization matrix | 24 integration tests against real Postgres (`server/src/api/api.test.ts`) |
| DM access + blocking lifecycle | 25 conversation tests + 20 route tests; the two critical guards are mutation-checked (revert the fix, exactly those tests fail) |
| DMs in a browser | Home view, `/app/dm/:id` routing, opening a 1:1, sending, and switching Home ↔ server both ways — no console errors. Group DMs and two simultaneous clients were not driven |
| Reconnect, optimistic send, chat reducers | 30 client unit tests |
| Send, multi-line, markdown + mentions, reconnect after restart, dialogs | Driven in a browser |
| SigV4 signing + presigned round trip, signed `Content-Length` | 19 tests against a real MinIO (`server/src/lib/s3.test.ts`, opt in with `S3_TEST_*`) |
| **Attachments against R2** | **Not verified** — signing is exercised on MinIO only; the CORS policy and the signed length are unconfirmed on Cloudflare's edge |
| **Voice (mesh, deafen, per-peer volume)** | **Not verified** — no microphone was available |
| iOS screen share, receiving | Simulator + a real Chrome peer sharing, in a voice channel and in a DM call: both drew live frames |
| iOS screen share, sending (wire) | Chrome peer saw `a=msid:pqp-screen-…`, roster `sharingScreen: true`, and decoded 640×360 H.264 frames |
| **iOS screen share, the extension itself** | **Not verified** — ReplayKit broadcast has no simulator equivalent; the extension, the App Group socket and the rotation mapping are device-only |
| Image scanning: fail-closed paths | 36 provider tests (unreachable, timeout, 401, HTML body, unparseable scores, missing verdict) + 13 DB tests for quarantine, reports and the sweepers |
| **Image scanning against a real provider** | **Not verified** — every provider call in the suite is a stubbed `fetch`. No live OpenAI / Sightengine / Worker round trip has been made |

## Suggested next work (priority)

1. **Exercise voice with a real mic** — mesh join, deafen, per-peer volume, and the persistent
   voice bar all changed and none were run against real hardware.
2. **Verify LiveKit end-to-end** — `docker compose --profile livekit up -d`, set `LIVEKIT_*`, join from two clients. Token minting is verified; the browser join/publish path is not.
3. **Confirm the signed `Content-Length` against a real R2 bucket** — PUT a body longer than the
   one that was minted and check it is refused. It holds on MinIO; Cloudflare's edge may re-frame
   the request, and if it does the mint-time size cap is decoration and only the claim-time HEAD
   is real. Ten minutes with a scratch bucket settles it.
4. **Close the CSAM gap — the highest-consequence item on this list.** Nothing scans uploads
   today (`CONTENT_SCAN_PROVIDER` is empty). Three of these cost nothing and one is a legal duty
   that already commenced: register on the **NCA CSEA-IRP** (OSA 2023 s.66, live 7 Apr 2026, no
   size threshold), write the **illegal content risk assessment** (was due 16 Mar 2025), enable
   **Cloudflare's CSAM Scanning Tool** (free, email-only onboarding), and apply for **IWF Image
   Intercept** (free under 1M checks/month — the only one that gives upload-path hash matching).
   Then set `CONTENT_SCAN_PROVIDER=openai` for the classifier half. Full detail, costs and the
   runbook: [`CONTENT_SAFETY.md`](./CONTENT_SAFETY.md).
5. **Set `CORS_ALLOWED_ORIGINS` on Railway** to the Pages origin (and pqp.gg when it exists).
6. **pqp.gg is unregistered** — canonical/OG tags in `client/index.html` and `SITE_URL` in `seo.tsx` point at a domain nobody owns, so shared links render a broken preview. Buy the domain or repoint the metadata.
7. **Electron app icon** — no `electron/build` icons; packaged apps use the default Electron icon.
8. Move rate limiting + presence to Redis before running more than one API instance.
9. Cloudflare Realtime SFU adapter (optional — LiveKit covers the need)
10. Clerk Billing (Plus/Pro) when ready
