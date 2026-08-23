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

- **i18n (en + pt-BR):** i18next core, JSON catalogues, lazy Portuguese, Electron menus. See [`I18N.md`](./I18N.md).
- **More than one person can share a screen (2026-08-23):** the exclusive presenter lock is gone. Caps are **2 concurrent shares on mesh, 4 on LiveKit** (`SCREEN_SHARE_LIMIT`). The web layout auto-shows every share (split on a wide window for two; focus + chips otherwise). Screen audio follows hook state: one share is that share, two are both, three-plus is the focused share only. Old clients that still take the first `sharingScreen` roster entry see only that first sharer.
- **Screen share carries the machine's audio (2026-08-22):** `getDisplayMedia` now asks for audio (`systemAudio: "include"`, plus `selfBrowserSurface: "exclude"` so the call's own tab cannot be shared back into itself). Mesh publishes the system-audio track alongside the video under the same capture msid and the roster's new `screenAudioStreamId` is what lets receivers tell it from the presenter's microphone; LiveKit publishes it as `Track.Source.ScreenShareAudio`. Receivers play it through a second `<audio>` in `VoiceAudioSinks`, so deafen, output device and the per-person volume all apply. A capture with no audio track is the normal case (Safari, Firefox, any macOS screen or window share, box left unticked) and degrades to exactly the old behaviour, with a quiet pt-BR hint under the share control. Not yet verified with two real browsers in one call.
- **Operator dashboard is live-capable (2026-08-21):** `tools/admin-dashboard/` (Cloudflare Worker `pqp-admin`, Basic Auth in front of everything) renders `GET /api/admin/metrics`, a new moderator-or-`ADMIN_METRICS_TOKEN` gated aggregate-counts endpoint (30s in-memory cache, 404 to everybody else, never on status.json). Secrets to set before it goes live are listed in its README; until then the page shows seed numbers labelled as such.
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
(SFU), `S3_*` (attachments — see [`ATTACHMENTS.md`](./ATTACHMENTS.md)), `STEAM_WEB_API_KEY` /
`BATTLENET_*` / `TWITCH_*` plus `PUBLIC_APP_URL` (game connections — see [`CONNECTIONS.md`](./CONNECTIONS.md)).

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
| [`CONNECTIONS.md`](./CONNECTIONS.md) | Steam / Battle.net / Twitch account linking |
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
## Native iOS notifications and invite links (2026-08-08)

APNs shipped as a **second leg of the existing push feature**, not as a parallel system. Every
decision about who gets a notification stays in `sendChannelPush` / `sendCallPush` — mentions,
replies, DMs and rings only, only when the recipient has no live socket anywhere in the cluster,
respecting stored DND and per-channel levels — and `deliverToUsers` now fans out to Web Push *or*
APNs per row. That is the whole integration: one query, one payload, two envelopes. A platform
added later is a branch there, not a pipeline.

**`push_subscriptions` holds both shapes**, discriminated by a new `platform` column and kept
honest by a `CHECK`: a `web` row has an endpoint and keys, an `apns` row has a device token and
none of them. A second table would have meant a second query on every fan-out and two places that
could disagree about the per-user cap (which is now deliberately shared — a phone's token costs
the same round trip as a laptop's endpoint). Uniqueness on `token` is a *partial* index, so
`ON CONFLICT (token) WHERE platform = 'apns'` is required, not optional — omit the predicate and
every insert fails.

**No APNs dependency.** `server/src/services/apns.ts` is an ES256 provider JWT (cached 40
minutes) plus one reused HTTP/2 session. The `web-push` dependency is justified by RFC 8291
payload encryption; APNs has none — the body is plain JSON over TLS — so there is nothing here
this codebase should not hand-roll. Two things in it are easy to get wrong and fail only against
the real gateway: the signature must be raw P1363 rather than DER (`dsaEncoding: "ieee-p1363"`),
and `400 BadDeviceToken` is *also* what the production gateway says about a valid **sandbox**
token — so pruning it is right, and the log line beside the prune is the only thing that points at
a misconfigured `APNS_ENVIRONMENT`.

**VoIP / PushKit is out of scope.** A ring arrives as an ordinary alert push (priority 10,
expiring with the 50s ring, collapsed on the conversation). CallKit would be better and costs a
second push type, a `PKPushRegistry`, and a hard OS rule that every VoIP push reports a call or
the app is killed.

On the phone: permission is asked **once, after a real sign-in reaches `.ready`**, behind an
explainer — the system dialog is one-shot per install and a refusal is permanent, so the timing
*is* the feature. The token is re-sent every launch because iOS rotates it silently. Sign-out
unregisters first, while the call can still authenticate, or a shared phone keeps buzzing with the
previous account's DMs.

**Invite links** reuse the shape the web already copies (`/app/invite/<code>`) — universal links
via `applinks:pqp.gg` and an AASA claiming *only* that path, plus `pqp://invite/<code>` for where
universal links do not fire. A pending invite is stashed in `UserDefaults`, not a property:
Clerk sign-in can hand off to a web flow and return through a relaunch, which is exactly the
brand-new-user case the feature exists for. Notification taps and invite links share one parser
(`DeepLink`), which reads the same paths the server emits and the web SPA parses.

Details, env names and the end-to-end device check: [`IOS.md`](./IOS.md).

## Ambient life: character accounts and the five launch communities (2026-08-08)

The spike in `tools/ambient/` is production-ready. Two halves, and the first one is auth work.

**Character accounts** (§02 Option C of `docs/research/ambient-agents.html`) are the production
identity the runner was missing: an ordinary `users` row that a long-lived bearer token can
authenticate as. `character_accounts` holds `user_id`, a unique operator `label`, the SHA-256 of a
256-bit secret, and `revoked_at`. One branch in `verifyAuthHeader`, between the dev bypass and
Clerk, accepts `Bearer character:<token>` — and **only** when `CHARACTER_ACCOUNTS_ENABLED=true`,
which is off by default and checked before the branch touches the database. The token is never
stored and never logged; the lookup is an index probe on the digest followed by a constant-time
compare, so a hand-edited `token_hash` fails closed instead of authenticating whoever the row now
names. Revocation is one UPDATE and takes effect on the next request.

`users.is_character` is a real column, not an inference from the `clerk_id` prefix, and it is what
the guardrails name. A character clears the age gate and the onboarding flag **at creation** —
otherwise its socket closes 4401 and nothing says why — and a fingerprint-guarded block in
`schema.sql` repairs those invariants on boot the same way the email scrub and the search-vector
migration do. Deliberately **not** `is_webhook`: that flag carries the client's "not a member"
badge, a disabled profile popover, and no reactions, presence or typing, which is the opposite of
what a cast member needs. A `CHECK` refuses a row claiming both.

**What a character cannot do**, all enforced on the server so a config mistake cannot switch one
off: send or receive a DM (`dm_privacy = 'nobody'` at creation, plus an actor check in `dms.ts`),
join voice (refused at the `join-voice-room` chokepoint), be friended in either direction (refused
with the *same generic message as a block*, so it is not an oracle — a silent no-op was rejected
because a request pending forever is both worse to use and a louder tell), appear in user search or
handle lookup outside a shared server (`discoverableSql`), delete or export its own account, or
**own a server** — a character joins communities, it never becomes the landlord of one, which is
the last way a leaked token could create a durable public artifact.

**Provisioning is a script against `DATABASE_URL`**, not an API route: an operator endpoint would
put a second, permanent, credential-minting surface in the API to save a `fly ssh console` on an
operation that happens a handful of times ever. `tools/ambient/scripts/provision.mjs` imports the
server's own `characters.js` rather than writing SQL, so there is exactly one implementation of how
an account is minted — the one under test.

**The five communities** are real content in `tools/ambient/personas.yaml`: Resenha FC (futebol),
Maratona (séries e filmes), Fone com Fio (música), Sala de Espera do Ranked (games), Véspera de
Prova (estudos) — 25 personas, five each, with channel structures, topics and pinned welcome posts
created by `scripts/seed-servers.mjs` over the real API and WebSocket.

**The runner** now schedules all five from one process, authenticates from a mounted secrets file,
and screens inbound human messages before planning a reply — hostility, banned topics, advice
requests, off-platform approaches, and *identity probes*, which are answered with silence because a
persona may neither claim to be human nor volunteer being software. The model's own verdict rides in
the same generation call. A per-human hourly cap stops one chatty visitor draining the budget. The
kill switch is checked before **every line**, and `SIGTERM` engages it in-process, so a
`fly secrets set` restart finishes the line being typed and stops rather than publishing half a
conversation.

Runbook, exact first-run commands and the guardrail table: [`ambient-deploy.md`](./ambient-deploy.md).
Owner decision: launch personas ship `disclosure: undisclosed`. §04 of the design doc argues against
that and the argument stands; the flag is one line so the decision stays one line.

## Sectioned server settings + server icon and banner (2026-08-08)

**Server settings is a sectioned dialog now**, the same category-rail-plus-one-pane shape the
account settings modal got (`Dialog size="xl" fill`, a real `role="tablist"` rail, arrow keys, phone
strip above the pane). Five sections for an owner — **Overview** (name, icon, banner, community
listing), **Access** (SSO email domain), **Moderation** (reports queue, message retention),
**Audit log**, **Danger zone** (export, transfer, delete) — and two for an admin (Moderation, Audit
log). Nothing was dropped and nothing invented; there is no Channels, Members or Webhooks section
because all three already have their own surfaces. Every string is in the catalogue with a pt-BR
translation, including the audit-action verb phrases, which were hardcoded English before.

**Servers have an icon and a banner.** Four nullable columns (`icon_key`/`icon_url`,
`banner_key`/`banner_url`) added boot-idempotently, and the whole upload path is the avatar path
with one structural difference: an avatar key contains the claiming account's own id and therefore
authorises itself, while a server key names a server many people belong to — so `requireOwner` gates
the mint, the claim and the delete, and the prefix check only ever proves "this object belongs to
this server". Caps are per kind (5 MiB icon, 8 MiB banner) and applied in the route, since the
shared schema does not know which kind it is parsing. Both are served through unauthenticated 302s
(`GET /api/servers/:id/icon|banner`) exactly as `/api/avatars/:userId` is, and both ride in
`SERVER_COLUMNS` so they reach every server payload and the communities directory card.

In the client: the banner is a ~120px band above the channel list with the name over a scrim, absent
entirely when unset; the icon draws in the rail and the channel-list header (desktop only there —
the 390px drawer has one more control and the icon was what truncated the name). Cropping is
client-side and reuses the avatar machinery — `centerCropRectForAspect` is the square crop
generalised, and `cropImageToRect` is `cropImageToSquare` with two dimensions.
## Depoimentos and community badges on profiles (2026-08-08)

Concept 2 of `docs/research/communities-orkut.html` (§05), the one the doc recommends building
first. A friend writes a short thing about you; it lands in **your** queue, invisible to everyone —
its author after sending very much included — until **you** publish it. Published ones sit on your
profile card newest-accepted first, and you can take any of them down at any time without notice.

**The load-bearing decision is what happens to a refusal, and it is the "Não aceita!" fix.** §02
documents the failure: because Orkut's pending queue was readable by the recipient *indefinitely*,
Brazilians worked out that a depoimento was a private message and wrote confessions into it opening
with "don't accept this" — and the canonical folklore is the recipient publishing one anyway. An
approval queue that **retains** what it refuses is a covert DM channel with a publish button on it.
So two things ship together: **refusing DELETES the row** (no `status`, no graveyard, nothing to
mine or to publish later), and the compose sheet carries a **real DM fork** — "isso vai ser público
no perfil — quer mandar por DM?" — that opens the conversation *carrying what was already typed*.
An escape hatch that makes you retype is one nobody takes.

**Schema** (`depoimentos`): `author_id`, `subject_id`, `body`, `created_at`, `approved_at` nullable,
`UNIQUE (author_id, subject_id)`, `CHECK (author_id <> subject_id)`, both FKs cascading.
`approved_at` **is** the state machine — NULL is pending — so there is no second column to disagree
with it. Writing again replaces the standing row and returns it to pending, which is also how
"editable while pending" is spelled without an edit route. Two triggers, both beside
`friendships_end_on_block()` and for its reasons: a **block** deletes the pair's depoimentos in both
directions, published or not; an **unfriend** withdraws only the **pending** one, because an
approved one is the subject's — they published it, and a falling-out must not silently rewrite
somebody's profile.

**Gates.** Only FRIENDS write (`areFriendsSql` verbatim, and the predicate rides *inside* the
INSERT so an unfriend cannot be raced); only the SUBJECT publishes; characters neither write nor
receive. Every refusal answers one sentence, so the route is not an oracle for who has blocked you.
Budgets: `depoimentoLimiter` (5, refill 0.05/s) plus `DEPOIMENTOS_PER_DAY = 10` counted in Postgres
— a count of ROWS, which bounds *breadth* (ten people a day) and deliberately not depth, since
anything stronger would need a log of depoimentos that no longer exist.

**Routes.** `POST /api/users/:id/depoimentos` · `GET /api/users/:id/depoimentos` (approved only;
**empty list, not 403**, for somebody outside the audience — friends or a shared server, matching
the profile card's own visibility) · `GET /api/me/depoimentos/pending` · `POST
/api/depoimentos/:id/approve` · `DELETE /api/depoimentos/:id` (refuse / take down / withdraw, one
route, silent either way). Realtime rides the existing content-free friend frame with a new kind,
`depoimento` — sent to the subject on a write and to the author on a publish, and **never** on a
refusal, which would hand the author the one fact the deletion exists to withhold.

**Community badges.** `server_members.show_on_profile` (default TRUE), `GET
/api/users/:id/communities` and `PATCH /api/servers/:id/profile-visibility` — the member's own
switch, deliberately not the owner's server PATCH. Only `is_community AND NOT
is_community_suspended` memberships are ever chipped, so a private server can never leak through a
profile and the operator's kill switch reaches every card at once. Capped at six with a "+N".

**UI.** The profile popover grew both sections (hidden entirely when empty — §05's
"auge ou ostracismo" note: never render a zero, and no count anywhere but the subject's own queue).
The queue lives in the friends view's Pending tab and shares the friends store, so one badge on the
front door counts both errands. Publishing is two taps over a preview of the exact text. pt-BR is
the source language for this feature's copy; English follows it.

## The public pages: `/@handle` redesigned, and `/c/<slug>` (2026-08-08)

The two surfaces this product serves to people with **no account**, treated as pages rather than as
cards. The brief was "profile pages need to look rad — think MySpace, Orkut, Twitter" plus a new
address for discovery.

**`/@rafa` is now a page, not a card.** Full-bleed hero (an uploaded banner, or a gradient generated
from the *handle's* hue — seeded from the handle rather than the display name so a rename does not
recolour a page already in screenshots), a large overlapping avatar, the name at headline size, a
quiet "no pqp desde julho de 2026", one CTA, then the two things that make somebody that person: the
**community badges as a proud grid** under the sentence "membro de 5 comunidades", and the
**depoimentos rendered** — the words, not a count.

**Why rendering depoimentos publicly is safe**, having previously been a deliberate refusal: a
depoimento is the one feature here whose mechanic is an act of approval. The author wrote it *for a
profile*; the subject published it from a preview that said exactly where it would go. Two people
consented to this page. What still does not travel is the author's id or tag — a name, a picture,
and a handle only if they claimed one, because a depoimento must never become a way to enumerate the
people who know somebody. Pending ones are, of course, still invisible to everyone but the subject.

**New columns.** `users.banner_key` / `banner_url` (the avatar machinery, self-scoped key, its own
`banners/<id>/` prefix so the 5 MiB avatar cap cannot be spent through the 8 MiB banner signature),
uploadable in Settings → Profile above the avatar. `servers.community_slug`, **unique among LISTED
communities** (partial on `is_community`, so unlisting frees the address rather than squatting it),
derived from the name on opt-in by `slugifyCommunityName` (accent-folding, hyphenating, capped at
40). A collision **refuses the listing** with a 409 and a field to pick another; a name that cannot
fold into a slug refuses with 422. Nothing is ever auto-suffixed — `valorant-2` is a URL nobody
chose and nobody would share. Existing listings get a one-shot backfill in schema.sql; collisions
there are left NULL (the card simply has no share button) rather than suffixed.

**`/c/<slug>` is a poster, not a window.** Name, address, tagline, category pill, member count big,
the two pictures, a month, and one button. **No member list** — who is in a room is a fact about
those people — no messages, no channels, no owner, and **no id**: withholding the id is what forces
the join intent to travel as a slug and be resolved behind auth. Suspended, unlisted, unknown and
"communities are off on this deployment" are one byte-identical 404.

**The intent flow**, reusing `?add=<handle>`'s machinery exactly: the CTA is `/app?join=<slug>` for
somebody signed in, and for somebody signed out the slug is stashed in `localStorage` *before* Clerk
takes over (a modal is a navigation the component does not survive) with the same URL as
`forceRedirectUrl`. At `bootstrapReady` — after the account exists and after the 18+ gate — the app
resolves the slug through `GET /api/communities/by-slug/:slug` and posts the **ordinary** join.
There is deliberately no join-by-slug route: a second door into the same room is a second door to
remember to lock.

**Edge SEO.** `client/src/lib/community-meta.ts` is the `/c/` half of the Pages middleware, a
separate head builder rather than a parameterised one because the cards genuinely differ — a profile
image is a square avatar and gets `summary`, a community banner is 3:1 and gets
`summary_large_image`. The directory card in-app grew a share button that copies `pqp.gg/c/<slug>`.

**Tokens.** `--hero-tint-near` / `--hero-tint-far`, `--scrim-hero`, `--shadow-hero-avatar`,
`--shadow-testimonial`, `--glow-accent-soft`, with light-mode overrides. Every colour literal stays
in the token layer; `client/src/lib/hero-tint.ts` emits custom properties and a gradient and never
names a colour, which is what keeps `BENCH_MAX_LEAKS=0` at zero.

## Game connections: Steam, Battle.net, Twitch (2026-08-23)

Discord-style Connections, not a second login. Clerk stays how people sign in. Full setup:
[`CONNECTIONS.md`](./CONNECTIONS.md). Decision: [`DECISIONS.md`](./DECISIONS.md).

- **Off per provider** until that provider's credentials are set. `GET /api/connections/config`
  is the same contract as GIFs and attachments.
- **The SPA keeps the session.** Connect → provider → `/app/connections/callback/:provider` →
  POST the query string with the existing Bearer token. Access tokens are discarded after the
  identity snapshot. Refreshing a nick is Connect again.
- **Visibility** defaults to `shared` (in-app profile card). `public` is opt-in on `pqp.gg/@handle`.
  `hidden` is Settings only. One Steam (or Battle.net, or Twitch) per pqp user, and the reverse.
- **In-app card audience** matches approved depoimentos: self, friends, or a shared server, and
  never a blocked pair. A stranger gets `[]`, not 403. The public page still filters to `public`.
- **Unconfigured providers** show as coming soon in Settings, with no Connect button.
- **Reconnect** of the same provider account keeps visibility. A different account on that slot
  resets it to `shared`. Steam OpenID `openid.signed` must include `claimed_id`.
- **Callback errors** are stashed in `sessionStorage` (`pqp.connection.error`) and shown on
  Settings → Connections after the overlay returns.
- **Characters cannot connect.** Included in `GET /api/me/export` (with `avatarUrl`). iOS Settings
  UI is not built. Electron only allows Steam OpenID and Battle.net login paths in-window.

## Verification status

| Checked | How |
|---|---|
| Public profile + `/c/<slug>`: payload key sets, month truncation, pending depoimentos never rendered, author identity withheld, the six-plus-remainder cap, banner reaching `/api/me` but not `publicUserSchema`, slug derivation / collision / reserved / unlisting-frees-the-address, the audit entry for a slug nobody typed, suspended-equals-unknown, cacheability, and the by-slug lookup 404ing for a banned viewer | 58 tests in `server/src/services/communities.test.ts`, 32 in `server/src/api/profiles.test.ts`, 39 in `server/src/api/avatars.test.ts`, all against real Postgres and the real router; plus 30 contract tests in `packages/shared` |
| The public pages in a real browser, signed out | 8 Playwright specs (`client/e2e/public-pages.spec.ts`): depoimentos rendered to a fresh context with no storage/cookie/token; a pending one absent from the same page; the badge grid and the tenure line; `/c/<slug>` rendering with no session and deriving its address; the join CTA carrying the intent through to an actual membership; a collision refused and the retry accepted; a pulled listing 404ing byte-identically to an unknown slug. Screenshots at `/tmp/rad-{profile,community}-{1440,390}.png` |
| The `/c/` edge SEO | 24 unit tests (`client/src/lib/community-meta.test.ts`) against the real `index.html`, including the `summary_large_image`-only-with-a-banner rule, escaping, and the JSON-LD that must not imply a member list |
| **The public pages against a hosted deploy** | **Not verified** — the Pages middleware's `/c/*` branch has only been exercised as its pure half; no wrangler runtime has run it, exactly as was true of the `/@` branch when it shipped |
| **A user banner against R2** | **Not verified** — same gap as attachments and server images; signing is exercised on MinIO only |
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
| APNs JWT, headers, token pruning, disabled-when-unconfigured | 16 tests in `server/src/services/apns.test.ts` (the JWT is cryptographically *verified*, not shaped) + 18 in `push.test.ts` against a real database |
| Deep-link parsing and pending-invite ordering | 29 iOS unit tests (`DeepLinkTests`, `PushNotificationTests`) |
| **A real APNs push on a real device** | **Not verified** — simulators cannot receive APNs and no signed device build was made. The whole transport is exercised against a faked HTTP/2 layer. Runbook: the "Checking a real push end to end" section of `IOS.md` |
| Character accounts: gate off/on, unknown token, tampered hash, revoke/rotate, age-gate bypass, discovery, DM/friend/voice refusals | 16 tests against real Postgres and the real router (`server/src/services/characters.test.ts`) |
| Ambient runner: multi-community config, inbound screen, identity seam, kill switch | 29 tests added to `tools/ambient` (114 total, no network, no key) |
| Ambient end to end, locally | 5 characters provisioned, Resenha FC seeded (5 channels + pinned welcome), 3 scenes posted over the real WS as character accounts, read back through the API; reply-to-human answered by name; identity-probe / hostile / banned-topic / per-human-cap all declined with a logged reason; `SIGTERM` halted a scene at `posted=2 remaining=2` |
| **A live Claude generation** | **Not verified** — no `ANTHROPIC_API_KEY` was available in the environment, so every run above was `--canned`. The live path differs only in where the transcript string comes from (`generate.js`), but it has not been exercised since the spike |
| **Ambient against a deploy** | **Not verified** — character accounts have never authenticated against a hosted API, and no Fly app exists yet |
| Server icon/banner: auth, owner gate, per-kind caps, claim HEAD, cross-server and cross-kind key theft, payload + directory presence, orphan cleanup, the unauthenticated image route | 38 tests against real Postgres and the real router (`server/src/api/server-images.test.ts`) |
| Server icon/banner in a browser, against MinIO | 6 Playwright specs (`client/e2e/server-identity.spec.ts`) — real crop, real direct-to-storage PUT, real claim, picture appearing in the column, on the card, and at 390px. Skips itself when the API under test has no `S3_*`; `playwright.config.ts` passes them through |
| Sectioned server settings: every section reachable, arrow keys, a setting that persists across close/reopen, Esc, 1440 and 390 layouts | 7 Playwright specs (`client/e2e/server-settings-sections.spec.ts`) |
| **Server icon/banner against R2** | **Not verified** — same gap as attachments; signing is exercised on MinIO only |
| **Universal links** | **Not verified** — Apple's CDN must fetch `/.well-known/apple-app-site-association` from `pqp.gg` first, so this cannot work until the web deploy lands. `pqp://invite/<code>` is testable now |
| Depoimentos: friend gate, half-a-handshake, approve/refuse-deletes, replace-returns-to-pending, character exclusion, block both ways, unfriend withdraws only the pending one, audience, ordering, and the badge opt-out / suspended-community / ban / cap cases | 34 tests against real Postgres and the real router (`server/src/services/depoimentos.test.ts`), plus 16 contract tests in `packages/shared` and 14 client model tests |
| Depoimentos in two real browsers | 3 Playwright specs (`client/e2e/depoimentos.spec.ts`): A writes from B's card → B's front door badges with no reload → B publishes from the two-tap preview → it renders on B's profile for A; the DM fork opens the conversation carrying the typed text *and writes no depoimento*; the community chip appears and the per-membership opt-out hides it. Screenshots at `/tmp/depo-*.png` |
| **Depoimentos on iOS** | **Not verified** — `UserProfileSheet.swift` has no parity for either section yet |
| Game connections: origin allowlist, uniqueness, visibility, Steam OpenID checks, config-off-until-env, public page key set and public-only filter | Unit + API tests in `packages/shared`, `server/src/services/connections*.test.ts`, `server/src/api/connections.test.ts`, `server/src/api/profiles.test.ts` |
| **Game connections against live Steam / Battle.net / Twitch apps** | **Not verified** — needs operator keys on Fly and a real hop from Settings |

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
