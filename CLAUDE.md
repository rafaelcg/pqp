# CLAUDE.md — agent guidance for pqp

Open-source Discord-like voice + text chat (**pqp.gg**). Repo: [rafaelcg/pqp](https://github.com/rafaelcg/pqp).

For current product status and open work, see [`docs/HANDOVER.md`](./docs/HANDOVER.md). Deeper design: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Deploy: [`docs/DEPLOY.md`](./docs/DEPLOY.md), [`docs/deploy-fly.md`](./docs/deploy-fly.md).

## Stack

- **Monorepo:** pnpm workspaces (`pnpm-workspace.yaml`)
- **Client:** React 19 + Vite + Tailwind + Clerk (`@clerk/clerk-react`)
- **Server:** Node HTTP API + WebSocket (`/ws`) + Postgres
- **Shared:** Zod schemas / protocol types (`@pqp/shared`)
- **Desktop:** Electron shell (loads web client)
- **Auth:** Clerk JWT (Bearer on HTTP; first WS message `{ type: "auth", token }`)
- **Voice:** the server picks the media path per room and pins it: peer-to-peer WebRTC for DM calls and small servers, a LiveKit SFU for communities and servers of ten or more (live on `pqp-api`). Signaling and presence stay on the same WS in both

## Monorepo layout

| Path | Package | Role |
|---|---|---|
| `client/` | `@pqp/client` | SPA (landing + `/app`) |
| `server/` | `@pqp/server` | API, WS chat + voice signaling, optional static serve |
| `packages/shared/` | `@pqp/shared` | Shared types / Zod / voice config |
| `electron/` | `@pqp/electron` | Desktop shell |
| `ios/` | (Xcode) | Native SwiftUI iOS client |
| `android/` | (Gradle) | Native Kotlin + Compose Android client |

## How to run (local)

```bash
pnpm install
cp .env.example .env
cp .env.example client/.env
# Fill Clerk keys, or enable DEV_AUTH_BYPASS (see below)

docker compose up -d postgres
pnpm dev
# Client http://localhost:5173 — Server http://localhost:3001 — WS /ws

# Optional MinIO for file attachments (creates the bucket too)
docker compose --profile storage up -d postgres minio minio-init

# Optional desktop shell (Vite must be up)
pnpm electron:dev
```

**Dev auth bypass** (no Clerk): set `DEV_AUTH_BYPASS=true` in root `.env` and `VITE_DEV_AUTH_BYPASS=true` in `client/.env`, then restart server.

With the bypass on, API boot seeds a **Sandbox** hall (text + voice, dummy members, a few messages, one bot). Opt out with `DEV_SEED=false`. Vitest suites truncate: set `TEST_DATABASE_URL` to a copy (`pqp_test`), never to `DATABASE_URL`.

**A second local user** (voice, watch party, DMs, friends, reactions — anything that needs two people). The bypass signs *every* browser in as one shared "Dev User", so two windows are the same account and a two-person feature looks broken rather than untested. To get a genuinely separate account, set a suffix in the second window's console **before** loading `/app`:

```js
localStorage.setItem("pqp:dev-user-suffix", "bob")  // then reload
```

That window becomes `dev_user_bob`, a real row in the database with its own onboarding, presence and seat in a voice room. The first window is untouched. Any `[a-z0-9_-]{1,32}` suffix works, so `alice` / `bob` / `carol` give you three. The server half is `devBypassIdentity` in `server/src/auth/clerk.ts`; the client half is `devAuthToken` in `client/src/lib/dev-auth.ts`.

Same-machine testing needs no second browser profile and no private window, because the suffix lives in `localStorage`, which is per-origin *and* per-profile — but two normal tabs on the same profile share it, so set the suffix in one and **only** one.

## Env vars (names only — never commit `.env`)

See `.env.example`. Important names:

| Area | Names |
|---|---|
| Server | `DATABASE_URL`, `TEST_DATABASE_URL`, `CLERK_SECRET_KEY`, `PORT`, `DEV_AUTH_BYPASS`, `DEV_SEED`, `CHARACTER_ACCOUNTS_ENABLED`, `INSTANCE_MODERATOR_CLERK_IDS`, `ADMIN_METRICS_TOKEN` (machine token for `GET /api/admin/metrics` and `GET /api/admin/voice-occupancy`, the operator dashboard's two feeds; see `tools/admin-dashboard/README.md`), `LOAD_TEST_TOKEN` (**staging only**: a scoped auth path that resolves `Bearer <token>:<suffix>` to a throwaway identity per suffix, so a load harness can drive hundreds of accounts against a public host without the repo-constant dev bypass. Inert unset; refused on any Fly app not named `-staging`, and off Fly under `NODE_ENV=production`. See `server/src/auth/load-test.ts` and `docs/STAGING.md`), `RATE_LIMIT_ANON_CAPACITY` / `RATE_LIMIT_ANON_REFILL` / `RATE_LIMIT_SOCKET_CAPACITY` / `RATE_LIMIT_SOCKET_REFILL` (the two address-keyed backstops; defaults unchanged, tunable because a load harness runs from one IP) |
| Multi-instance (both default off; one machine in production) | `CLUSTER_BUS` (`postgres` shares chat fan-out over LISTEN/NOTIFY), `VOICE_REGISTRY` (`postgres` copies the voice peer map and transport pins into the `voice_*` tables and builds rosters from them; with `CLUSTER_BUS` also on, room events cross instances. M1 and M2 of `docs/plans/MULTI_INSTANCE_VOICE.md`; not yet enough to run two machines, M3 and M5 first) |
| Game connections | `PUBLIC_APP_URL`, `STEAM_WEB_API_KEY`, `BATTLENET_CLIENT_ID`, `BATTLENET_CLIENT_SECRET`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (off per provider until set; see `docs/CONNECTIONS.md`) |
| Ambient runner (`tools/ambient`) | `PQP_API_URL`, `AMBIENT_TOKENS_FILE`, `AMBIENT_STATE_DIR`, `AMBIENT_CONFIG`, `AMBIENT_MODEL`, `ANTHROPIC_API_KEY`, `AMBIENT_KILL_SWITCH` |
| Client | `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`, `VITE_DEV_AUTH_BYPASS`, `VITE_VOICE_BACKEND` (leave empty to follow the server; `mesh` forces peer-to-peer) |
| Beta join links (public, never secrets) | `VITE_TESTFLIGHT_URL` (iOS; a public default lives in `client/src/lib/testflight.ts`, so this only overrides it). `VITE_ANDROID_APK_URL` (Android APK; empty uses GitHub `releases/download/android-beta/pqp.apk`, a single space hides the button). Do not point this at `/releases/latest` — that tag is Electron. The join surfaces are `/beta` and `/android`. |
| Hosted-only tags (never set on a self-host) | `VITE_UMAMI_WEBSITE_ID` / `VITE_UMAMI_SRC`, `VITE_GOOGLE_ADS_ID` / `VITE_GOOGLE_ADS_SIGNUP_LABEL`, `VITE_ANDROID_APK_CLICK_URL`. The first two pairs gate a third-party tag that a Vite plugin injects into `index.html` at build time; unset means the tag is absent from the built HTML, which is the point (AGPL, self-hosters must not inherit our analytics or our advertising). Google Ads also needs the label, and only reports one event: an account being created. `VITE_ANDROID_APK_CLICK_URL` is a public POST on `pqp-admin` that counts taps on the `/android` download button; empty means the client never beacons. See `client/src/lib/google-ads-tag.ts`, `client/src/lib/google-ads.ts`, `client/src/lib/android-apk-click.ts` |
| Donations page (hosted-only, never set on a self-host) | `VITE_SPONSOR_URL`, `VITE_PIX_KEY`, `VITE_PIX_BRCODE` (optional "Pix copia e cola" string). Public values, never secrets. `/apoie` and `/support` plus the footer link exist only while the sponsor URL or the Pix key is non-empty; both empty redirects the routes to `/` and hides the link, which is what a self-host wants (same reasoning as the row above: nobody inherits our donation links). Donating unlocks nothing. See `client/src/lib/support-links.ts` |
| ICE / TURN (API preferred) | `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `METERED_API_KEY`, `METERED_DOMAIN`, `TURN_PREFER_STATIC` (rollback switch, see below) |
| Client TURN fallback (avoid in prod) | `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` |
| SFU | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (implemented); `CLOUDFLARE_REALTIME_*` (stub); `VOICE_PROMOTION_MAX_SFU_MBPS` (default 600, the ceiling past which a mesh room is *not* moved to the SFU to fit another camera; 0 turns promotion off) |
| Attachments (S3/R2) | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`, `MAX_ATTACHMENT_BYTES`, `ATTACHMENT_URL_TTL_SECONDS` |
| Communities | `COMMUNITIES_ENABLED` (default off — read `docs/CONTENT_SAFETY.md` §Communities first; it changes the instance's legal category, not just its features) |
| Baú (Community Home) | `COMMUNITY_HOME_ENABLED`, `COMMUNITY_HOME_VIP_ENABLED` (both default off; server-side, read per request; the client follows `GET /api/community-home/config`. Not `COMMUNITIES_ENABLED`. See `docs/COMMUNITY_HOME.md`) |
| WebSocket compression | `WS_COMPRESSION` (**on by default**; `off` / `false` / `0` is the rollback switch). `permessage-deflate` on `/ws`, measured at ~3x fewer bytes on the wire for ~2.5x the processor on the fan-out. Every stack that connects negotiates it (Chromium, Firefox, WebKit, iOS `URLSessionWebSocketTask`, Android OkHttp 5); a client that does not offer the extension is served uncompressed and connects normally. Settings and the measurements behind each one: `server/src/lib/ws-compression.ts`. The operator dashboard shows what fraction of live sockets actually negotiated it |
| Process role | `WORKER_MODE` (unset = one process does everything, today's default; `api` = listeners only, batch jobs skipped, set on `pqp-api` only after `pqp-worker` exists; `worker` or `1` = batch jobs + `/health` only, set on `pqp-worker`). Inventory of what moved: `docs/plans/COLD_PATHS.md` |
| Electron | `VITE_APP_URL` |
| DB backup (Fly secrets on app `pqp-db-backup`, `tools/db-backup/`) | `BACKUP_DATABASE_URL` (production `fly-db` on `pqp-db-2` via its `direct.<cluster>.flympg.net` host, ideally a read-only role), `R2_BACKUP_BUCKET`, `R2_ACCOUNT_ID` or `R2_BACKUP_ENDPOINT`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`. A scheduled Fly machine (`fly machine run --schedule daily`, region `gru`) runs `pg_dump` inside the private network and uploads to a private R2 bucket, 30-day retention. Managed Postgres is not reachable from GitHub runners. See `docs/DB_RUNBOOK.md` |

**Rule:** never commit `.env` / secrets. Prefer serving ICE via `GET /api/ice-servers` (the API) over baking TURN into the Pages build.

## Architecture (short)

```
Browser/Electron → Clerk (auth)
                 → HTTPS API (servers, channels, messages, /api/ice-servers)
                 → WSS /ws (chat + presence + WebRTC offer/answer/ICE relay)
                 → P2P mesh (audio); TURN when cross-NAT
                 → S3/R2 direct (attachment bytes, presigned; never via the API)
```

- **Transport per room:** mesh caps at `MESH_VOICE_LIMIT` (8) and is what DM calls and servers under `LARGE_SERVER_MEMBER_THRESHOLD` (10) get; listed communities and larger servers go to LiveKit automatically (`server/src/voice/transport-policy.ts`), which is **configured on `pqp-api` today** (`/ready` reports it). **LiveKit SFU is implemented** — set `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` and the server advertises it via `GET /api/voice/backend` (no client rebuild). Presence stays on `/ws` in both modes; only media moves. A room's transport is decided by the server, pinned for the room's lifetime and stated in `welcome` — a client that cannot use it is refused rather than silently split off from the call. `cloudflare-sfu` is still a stub that falls back to mesh. See [`docs/voice-backends.md`](./docs/voice-backends.md).
- **Attachments:** S3-compatible storage (R2 hosted, MinIO local). The API only signs URLs — the browser PUTs and GETs the bytes itself. Off entirely unless `S3_*` is configured. Size is enforced twice: `Content-Length` is signed into the presigned PUT (verified against MinIO, not yet against R2), and the claim `HEAD`s the object — which is also what catches "never uploaded" and a stored type that differs from the signed one. That HEAD runs *before* the claim transaction opens; nothing between `BEGIN` and `COMMIT` may touch the network. See [`docs/ATTACHMENTS.md`](./docs/ATTACHMENTS.md).
- **Communities:** a public directory of joinable servers, entirely behind `COMMUNITIES_ENABLED` (default off, exposed to the client via `GET /api/communities/config` like the attachments/GIF configs). A community is a `servers` row with two switches: `is_community` is the **public address** (`pqp.gg/c/<slug>` answers, whoever holds the link joins with one tap, Manage Server may set it) and `is_community_listed` is the **directory** (browsable and searchable by any account, owner-only, requires an address). Every directory read runs auth and hides servers the viewer is banned from; joining reuses `redeemInvite`'s semantics without an invite row. Reports about a community go to the **instance** queue, never to that community's own owner, and the operator can unlist one with a single `UPDATE servers SET is_community_suspended = TRUE`. See [`docs/CONTENT_SAFETY.md`](./docs/CONTENT_SAFETY.md) §Communities — turning it on moves the instance out of Brazil's private-messaging liability exemption (STF, Art. 19, 26 Jun 2025).
- **Handles:** `users.handle` is a *second*, genuinely unique name (`username` is only unique paired with `discriminator`), claimed first-come, NULL for most accounts, one rename per 30 days. It addresses `pqp.gg/@rafa` — the public profile page, served by the unauthenticated endpoint that answers with a person: display name, avatar, an optional uploaded banner (`users.banner_key/banner_url`, on the avatar machinery), public-community badges, **opt-in** Steam / Battle.net / Twitch connections (`visibility = public`), the newest six **approved** depoimentos, and a join month. No id, no tag, no email, no presence. Communities get the same treatment at `pqp.gg/c/<slug>` (`servers.community_slug`, derived from the name when the address goes on, unique among addressed communities); that page is a poster — name, tagline, category, member count, pictures — and never a member list. Open Graph tags for both are injected at the edge by a Cloudflare Pages middleware (`client/functions/`), because a static SPA's client-side `<head>` is invisible to every unfurler. Both public CTAs carry an intent through sign-up (`?add=<handle>`, `?join=<slug>` + a `localStorage` stash — `client/src/lib/handle-intent.ts`). See [`docs/HANDLES.md`](./docs/HANDLES.md) and [`docs/CONNECTIONS.md`](./docs/CONNECTIONS.md).
- **Data model:** Server → Channels (`text` \| `voice`) → Messages (+ `message_attachments`); a compatibility rank of `owner` / `admin` / `member` under a staff ladder of cargos whose real authority is permission bits plus per-channel overwrites; usernames `name#1234`.

## Deploy targets (hosted)

| Piece | Where | URL (as of 2026-08-20) |
|---|---|---|
| Static SPA | Cloudflare Pages project `pqp` | https://pqp-3yr.pages.dev |
| API + WS | Fly.io app `pqp-api`, region `gru` (São Paulo) | https://api.pqp.gg — `wss://api.pqp.gg/ws` |
| Worker (batch jobs) | Fly.io app `pqp-worker`, region `gru`, `WORKER_MODE=worker`, no public service (`fly.worker.toml`; optional, see `docs/deploy-fly.md` §7f) | private `/health` only |
| Staging SPA | Cloudflare Pages branch `staging` of project `pqp` | https://staging.pqp-3yr.pages.dev |
| Staging API + WS | Fly.io app `pqp-api-staging`, region `gru` | https://pqp-api-staging.fly.dev — `wss://pqp-api-staging.fly.dev/ws` |

CI workflows: `.github/workflows/ci.yml`, `deploy-web.yml`, `deploy-api-fly.yml` (API auto-deploys from `main` — a merged schema/endpoint change is live minutes later), `electron.yml`, `deploy-staging.yml` (staging web + API from the `staging` branch or `workflow_dispatch`; see `docs/STAGING.md`).

**GitHub Actions secrets (names):** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`; staging adds secret `FLY_API_TOKEN_STAGING` and repo variable `STAGING_CLERK_PUBLISHABLE_KEY`.

**API secrets on Fly (names):** `DATABASE_URL`, `CLERK_SECRET_KEY`, plus TURN/ICE vars above, `S3_*` if attachments are wanted, and `PUBLIC_APP_URL` plus `STEAM_WEB_API_KEY` / `BATTLENET_*` / `TWITCH_*` if game connections are wanted. **Worker secrets on Fly (names):** `DATABASE_URL`, `CLERK_SECRET_KEY`, `S3_*` if attachments are on (`DATABASE_SSL` if the API has it); nothing else. CI needs `FLY_API_TOKEN_WORKER` to deploy it, and skips the worker when that is unset. A stale Railway copy may still answer at api-production-206d.up.railway.app; nothing points at it. Do not put Clerk secret, TURN credentials, S3 keys, or those provider secrets in Pages/client secrets.

## Pitfalls already hit

1. **Cross-NAT voice FAILED** — STUN-only is not enough; dead Open Relay creds were unreliable. **Fixed (2026-07-11):** Railway `TURN_*` (ExpressTURN) via `/api/ice-servers`, plus client Retry / ICE restart. Retest: hard-refresh both clients and rejoin voice.
2. **Clerk `getToken` remount loop** — unstable token getter in React deps caused remount storms; keep token access stable (ref / memoized callback), don’t put a fresh `getToken` identity in effect deps every render.
3. **Pages without API URLs** — empty `VITE_API_URL` / `VITE_WS_URL` makes `/app` hit same-origin Pages (no API). Set GH secrets and redeploy web.
4. **Clerk origins** — allow Pages + API origins in the Clerk dashboard.
5. **`@pqp/shared` on Railway** — production resolution needed a dedicated fix; rebuild/shared packaging matters for Docker deploys.
6. **pnpm version** — CI uses pnpm matching the lockfile (pnpm 10); don’t downgrade casually.
7. **Electron Linux artifacts** — scoped package name broke `.deb` paths; fixed in CI metadata.
8. **`curl` against `/api/...` returns 401** — there is no public-route allowlist; `handleApi` resolves a Bearer token before the router runs, so even `/api/attachments/config` and `/api/gifs/config` need one. Locally: `-H "Authorization: Bearer dev-local-token"` with `DEV_AUTH_BYPASS=true` (the bypass is ignored when `NODE_ENV=production`). The exceptions, all handled *before* that resolution and none of them router routes: `/health` (Fly's check, stays shallow), `/ready` (the deep check for external monitors: Postgres, pool, LiveKit, storage; 503 when any is not ok; see `docs/MONITORING.md`), `/up`, `/status.json`, the embed-image proxy, `/api/avatars/:userId`, `/api/users/:userId/banner`, webhook execution, `GET /api/public/profiles/:handle`, and `GET /api/public/communities/:slug` (the last also behind `COMMUNITIES_ENABLED`, and 404 when it is off).
9. **Cloudflare TURN was configured, deployed and never once used**. `getIceServers` returned on the first match and static `TURN_*` was first, so the Cloudflare credentials sitting on the API were dead code, and a static relay that was throttled or down took cross-network voice with it because nothing else was ever consulted. Compounding it, the Cloudflare response parser required `iceServers` to be an **array** and tested `.length`, but Cloudflare answers with a single object, so even when it was reached it returned null. Two silent failures that looked identical to "working, on the other provider". **Fixed (2026-08-26):** order is now Cloudflare, then Metered, then static as the fallback; the parser accepts either shape; `TURN_PREFER_STATIC=true` restores the old order in one command without a deploy. Pinned by `server/src/services/ice.test.ts`, which asserts *which* relay comes back rather than that the list is well formed.
10. **Persistent "Realtime connection closed" on hosted deploy** — no WS heartbeat/reconnect, plus any thrown WS handler error crashed the whole server (unhandled rejection → Railway restart → every client dropped). **Fixed (2026-07-11):** server ping/pong heartbeat + try/catch around WS handlers + `pool.on("error")`; client auto-reconnect with backoff that resolves a fresh Clerk token per attempt (`client/src/lib/realtime.ts`).
11. **Merging to `main` restarts `pqp-api`.** `deploy-api-fly.yml` auto-deploys from `main`. A server or `packages/shared` change is `restarts-api`: Fly redeploys and every `/ws` closes. Since M5 the closing machine drains rather than drops: `/health` goes 503 first so the proxy stops routing to it, then the sockets get 1001 in batches of 50 every 100 to 150 ms (`server/src/lib/drain.ts`), and with two machines (`docs/deploy-fly.md` 6a-bis) the reconnects land on the one that stayed up. After #162, refreshed **web and Electron** keep the media session and resume the same peer id (90s orphan window in-process; HMAC token lasts hours so a long call still reconstructs after a Fly restart). **iOS in a LiveKit room** keeps its media across the restart the same way (it declares `resume` and presents the token). **iOS in a mesh room, Android**, failed resume, and tabs that have not refreshed still drop out of voice. Client-only Pages deploys do not restart the API. This is the usual case. It is not a hangup. Apply `drops-voice` only when the change itself will hang up a live call even after resume. An API restart alone does not earn that label. Say `restarts-api` in the PR when it applies, before claiming the PR is safe to merge. Provider keys (Steam, Twitch, Battle.net) live on Fly, not in git; merging connection code without those secrets must not 500 production.
12. **Roster deltas were deployed and never once sent in production.** `sendRoster` had `registryOn() ? null : foldRoomEvents(events)`, production runs with `VOICE_REGISTRY=postgres`, and every delta test ran with it off. `voice.roster.deltas` read 0 for days and was blamed on browsers that had not reloaded. Same shape as pitfall 9: the flag that changes the code path was not the flag the tests exercised. **Fixed (2026-09-07):** with the registry on the delta is a diff of the rows against what the process last sent (`diffSentRoster`), pinned on a real Postgres by `server/src/ws/voice-roster-delta-registry.test.ts`. When a feature is gated by a flag that production sets, test it with the flag set, and read the counter that proves it runs.

## Agent norms

- Do not invent secret values in docs or commits.
- Shipping and PR loop: [`AGENTS.md`](./AGENTS.md) (run locally, one feature per branch, babysit CI/Farol, do not merge unless asked, say `restarts-api` when the PR redeploys `pqp-api`). Release notes (What's New and `/blog` are the same files) are a weekly catch-up, not a per-PR duty. Do not write one in an unrelated PR. When Andre asks, follow `.cursor/skills/whats-new/SKILL.md`. Never edit a note already on `main`.
- Point humans to `docs/DESIGN.md` for the design system (tokens, the `ui/` primitives, the rules the bench enforces, and the `/qa/ui` token sheet under the dev bypass); `docs/I18N.md` for adding UI copy (i18next, `{name}` slots, `_one`/`_other`, Electron menus); `docs/ONBOARDING.md` for every first-run, hint and corner-card surface (one shell, one queue, one store); `docs/HANDLES.md` for public handles, the `/@` profile page and its edge-injected SEO; `docs/CONNECTIONS.md` for Steam / Battle.net / Twitch linking; `docs/DISCORD_IMPORT.md` for copying a Discord Guild Template layout; `docs/WATCH_PARTY.md` for watch party channels (the `watch_party` type, `START_WATCH_PARTY`, the HLS seam, `VITE_WATCH_PARTY_CHANNELS`); `docs/RAISED_HANDS.md` for raising your hand in a voice call (the roster's `handRaisedAt`, the server-stamped queue order, `voice_raised_hands`, and what lowers a hand); `docs/COMMUNITY_HOME.md` for Baú, the durable media feed (`COMMUNITY_HOME_ENABLED` / `COMMUNITY_HOME_VIP_ENABLED`, not `COMMUNITIES_ENABLED`) and `docs/BAU_VIP_STRATEGY.md` for the VIP pricing analysis; `docs/ambient-deploy.md` for character accounts and the ambient-life runner (the house cast); `docs/BOT_SEND.md` for the character HTTP send (`POST /api/channels/:id/messages`); `tools/support-bot/README.md` for the QG support bot, its fact file and the disclosure seam (it is a **disclosed bot**, not a resident, and the QG still gets no AI residents); `docs/CLERK_SETUP.md` for Clerk CLI setup; `docs/STAGING.md` for the staging environment (separate Clerk dev instance, `pqp-api-staging`, Pages branch deploy); `docs/SSO.md` for SAML/enterprise domain joining; `docs/voice-backends.md` for SFU notes; `tools/sfu/README.md` for the self-hosted LiveKit box (every config file on it, the installer that rebuilds it from a fresh Ubuntu image, and how the API key pair is kept out of git) with the rebuild runbook in `docs/plans/SELF_HOSTED_LIVEKIT.md` §7; `docs/ATTACHMENTS.md` for R2/MinIO setup; `docs/CONTENT_SAFETY.md` for image scanning, what is
 *not* scanned, and the CSAM reporting runbook; `docs/MONITORING.md` for what watches production (GitHub Actions probes, `/ready`, and the Grafana Cloud Loki dashboard and alert rules fed by `tools/log-shipper/`); `docs/PWA.md` for the mobile/installable app; `docs/ANDROID.md` for the native Android client, why it is native rather than a TWA, and what is actually verified; `docs/TESTFLIGHT.md` for the iOS beta / App Review demo account; `tools/admin-dashboard/README.md` for the operator dashboard (`pqp-admin` Worker) and its `ADMIN_METRICS_TOKEN` / Basic Auth secrets.
- Production Postgres: `docs/DB_RUNBOOK.md` for the nightly backup (Fly app `pqp-db-backup`, `tools/db-backup/`), how to verify a dump restores, the rehearsed "cluster degraded, restore into a fresh Fly MPG cluster and repoint the API" procedure, and the `PG_POOL_MAX` connection budget. Never resize the managed cluster during a live event.
- Update `docs/HANDOVER.md` + `docs/PLAN_STATUS.md` when phase status changes.
