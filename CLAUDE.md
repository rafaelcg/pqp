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
- **Voice:** full-mesh WebRTC per voice channel; signaling over the same WS

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
| Server | `DATABASE_URL`, `CLERK_SECRET_KEY`, `PORT`, `DEV_AUTH_BYPASS`, `CHARACTER_ACCOUNTS_ENABLED`, `INSTANCE_MODERATOR_CLERK_IDS`, `ADMIN_METRICS_TOKEN` (machine token for `GET /api/admin/metrics`, the operator dashboard feed; see `tools/admin-dashboard/README.md`) |
| Game connections | `PUBLIC_APP_URL`, `STEAM_WEB_API_KEY`, `BATTLENET_CLIENT_ID`, `BATTLENET_CLIENT_SECRET`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (off per provider until set; see `docs/CONNECTIONS.md`) |
| Ambient runner (`tools/ambient`) | `PQP_API_URL`, `AMBIENT_TOKENS_FILE`, `AMBIENT_STATE_DIR`, `AMBIENT_CONFIG`, `AMBIENT_MODEL`, `ANTHROPIC_API_KEY`, `AMBIENT_KILL_SWITCH` |
| Client | `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`, `VITE_DEV_AUTH_BYPASS`, `VITE_VOICE_BACKEND` (leave empty to follow the server; `mesh` forces peer-to-peer) |
| Beta join links (public, never secrets) | `VITE_TESTFLIGHT_URL` (iOS; a public default lives in `client/src/lib/testflight.ts`, so this only overrides it). **Android has no web join surface**: the `/android` page and the in-app beta prompt were removed on 2026-08-28 because the Android release is being handled differently. `VITE_ANDROID_BETA_GROUP_URL` / `VITE_ANDROID_BETA_URL` are gone from the client and from `deploy-web.yml`; the repository variables still exist and are simply unread. |
| Hosted-only tags (never set on a self-host) | `VITE_UMAMI_WEBSITE_ID` / `VITE_UMAMI_SRC`, `VITE_GOOGLE_ADS_ID` / `VITE_GOOGLE_ADS_SIGNUP_LABEL`. Each pair gates a third-party tag that a Vite plugin injects into `index.html` at build time; unset means the tag is absent from the built HTML, which is the point (AGPL, self-hosters must not inherit our analytics or our advertising). Google Ads also needs the label, and only reports one event: an account being created. See `client/src/lib/google-ads-tag.ts` and `client/src/lib/google-ads.ts` |
| ICE / TURN (API preferred) | `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `METERED_API_KEY`, `METERED_DOMAIN`, `TURN_PREFER_STATIC` (rollback switch, see below) |
| Client TURN fallback (avoid in prod) | `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` |
| SFU | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (implemented); `CLOUDFLARE_REALTIME_*` (stub) |
| Attachments (S3/R2) | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`, `MAX_ATTACHMENT_BYTES`, `ATTACHMENT_URL_TTL_SECONDS` |
| Communities | `COMMUNITIES_ENABLED` (default off — read `docs/CONTENT_SAFETY.md` §Communities first; it changes the instance's legal category, not just its features) |
| Electron | `VITE_APP_URL` |

**Rule:** never commit `.env` / secrets. Prefer serving ICE via `GET /api/ice-servers` (the API) over baking TURN into the Pages build.

## Architecture (short)

```
Browser/Electron → Clerk (auth)
                 → HTTPS API (servers, channels, messages, /api/ice-servers)
                 → WSS /ws (chat + presence + WebRTC offer/answer/ICE relay)
                 → P2P mesh (audio); TURN when cross-NAT
                 → S3/R2 direct (attachment bytes, presigned; never via the API)
```

- **Mesh limit:** ~5–8 peers per voice channel. **LiveKit SFU is implemented** — set `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` and the server advertises it via `GET /api/voice/backend` (no client rebuild). Presence stays on `/ws` in both modes; only media moves. A room's transport is decided by the server, pinned for the room's lifetime and stated in `welcome` — a client that cannot use it is refused rather than silently split off from the call. `cloudflare-sfu` is still a stub that falls back to mesh. See [`docs/voice-backends.md`](./docs/voice-backends.md).
- **Attachments:** S3-compatible storage (R2 hosted, MinIO local). The API only signs URLs — the browser PUTs and GETs the bytes itself. Off entirely unless `S3_*` is configured. Size is enforced twice: `Content-Length` is signed into the presigned PUT (verified against MinIO, not yet against R2), and the claim `HEAD`s the object — which is also what catches "never uploaded" and a stored type that differs from the signed one. That HEAD runs *before* the claim transaction opens; nothing between `BEGIN` and `COMMIT` may touch the network. See [`docs/ATTACHMENTS.md`](./docs/ATTACHMENTS.md).
- **Communities:** a public directory of joinable servers, entirely behind `COMMUNITIES_ENABLED` (default off, exposed to the client via `GET /api/communities/config` like the attachments/GIF configs). A community is just a `servers` row with `is_community` set. Every directory read runs auth and hides servers the viewer is banned from; joining reuses `redeemInvite`'s semantics without an invite row. Reports about a community go to the **instance** queue, never to that community's own owner, and the operator can unlist one with a single `UPDATE servers SET is_community_suspended = TRUE`. See [`docs/CONTENT_SAFETY.md`](./docs/CONTENT_SAFETY.md) §Communities — turning it on moves the instance out of Brazil's private-messaging liability exemption (STF, Art. 19, 26 Jun 2025).
- **Handles:** `users.handle` is a *second*, genuinely unique name (`username` is only unique paired with `discriminator`), claimed first-come, NULL for most accounts, one rename per 30 days. It addresses `pqp.gg/@rafa` — the public profile page, served by the unauthenticated endpoint that answers with a person: display name, avatar, an optional uploaded banner (`users.banner_key/banner_url`, on the avatar machinery), public-community badges, **opt-in** Steam / Battle.net / Twitch connections (`visibility = public`), the newest six **approved** depoimentos, and a join month. No id, no tag, no email, no presence. Communities get the same treatment at `pqp.gg/c/<slug>` (`servers.community_slug`, derived from the name on opt-in, unique among listed communities); that page is a poster — name, tagline, category, member count, pictures — and never a member list. Open Graph tags for both are injected at the edge by a Cloudflare Pages middleware (`client/functions/`), because a static SPA's client-side `<head>` is invisible to every unfurler. Both public CTAs carry an intent through sign-up (`?add=<handle>`, `?join=<slug>` + a `localStorage` stash — `client/src/lib/handle-intent.ts`). See [`docs/HANDLES.md`](./docs/HANDLES.md) and [`docs/CONNECTIONS.md`](./docs/CONNECTIONS.md).
- **Data model:** Server → Channels (`text` \| `voice`) → Messages (+ `message_attachments`); roles `owner` / `admin` / `member`; usernames `name#1234`.

## Deploy targets (hosted)

| Piece | Where | URL (as of 2026-08-20) |
|---|---|---|
| Static SPA | Cloudflare Pages project `pqp` | https://pqp-3yr.pages.dev |
| API + WS | Fly.io app `pqp-api`, region `gru` (São Paulo) | https://api.pqp.gg — `wss://api.pqp.gg/ws` |

CI workflows: `.github/workflows/ci.yml`, `deploy-web.yml`, `deploy-api-fly.yml` (API auto-deploys from `main` — a merged schema/endpoint change is live minutes later), `electron.yml`.

**GitHub Actions secrets (names):** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`, `VITE_WS_URL`.

**API secrets on Fly (names):** `DATABASE_URL`, `CLERK_SECRET_KEY`, plus TURN/ICE vars above, `S3_*` if attachments are wanted, and `PUBLIC_APP_URL` plus `STEAM_WEB_API_KEY` / `BATTLENET_*` / `TWITCH_*` if game connections are wanted. A stale Railway copy may still answer at api-production-206d.up.railway.app; nothing points at it. Do not put Clerk secret, TURN credentials, S3 keys, or those provider secrets in Pages/client secrets.

## Pitfalls already hit

1. **Cross-NAT voice FAILED** — STUN-only is not enough; dead Open Relay creds were unreliable. **Fixed (2026-07-11):** Railway `TURN_*` (ExpressTURN) via `/api/ice-servers`, plus client Retry / ICE restart. Retest: hard-refresh both clients and rejoin voice.
2. **Clerk `getToken` remount loop** — unstable token getter in React deps caused remount storms; keep token access stable (ref / memoized callback), don’t put a fresh `getToken` identity in effect deps every render.
3. **Pages without API URLs** — empty `VITE_API_URL` / `VITE_WS_URL` makes `/app` hit same-origin Pages (no API). Set GH secrets and redeploy web.
4. **Clerk origins** — allow Pages + API origins in the Clerk dashboard.
5. **`@pqp/shared` on Railway** — production resolution needed a dedicated fix; rebuild/shared packaging matters for Docker deploys.
6. **pnpm version** — CI uses pnpm matching the lockfile (pnpm 10); don’t downgrade casually.
7. **Electron Linux artifacts** — scoped package name broke `.deb` paths; fixed in CI metadata.
8. **`curl` against `/api/...` returns 401** — there is no public-route allowlist; `handleApi` resolves a Bearer token before the router runs, so even `/api/attachments/config` and `/api/gifs/config` need one. Locally: `-H "Authorization: Bearer dev-local-token"` with `DEV_AUTH_BYPASS=true` (the bypass is ignored when `NODE_ENV=production`). The exceptions, all handled *before* that resolution and none of them router routes: the embed-image proxy, `/api/avatars/:userId`, `/api/users/:userId/banner`, webhook execution, `GET /api/public/profiles/:handle`, and `GET /api/public/communities/:slug` (the last also behind `COMMUNITIES_ENABLED`, and 404 when it is off).
9. **Cloudflare TURN was configured, deployed and never once used**. `getIceServers` returned on the first match and static `TURN_*` was first, so the Cloudflare credentials sitting on the API were dead code, and a static relay that was throttled or down took cross-network voice with it because nothing else was ever consulted. Compounding it, the Cloudflare response parser required `iceServers` to be an **array** and tested `.length`, but Cloudflare answers with a single object, so even when it was reached it returned null. Two silent failures that looked identical to "working, on the other provider". **Fixed (2026-08-26):** order is now Cloudflare, then Metered, then static as the fallback; the parser accepts either shape; `TURN_PREFER_STATIC=true` restores the old order in one command without a deploy. Pinned by `server/src/services/ice.test.ts`, which asserts *which* relay comes back rather than that the list is well formed.
10. **Persistent "Realtime connection closed" on hosted deploy** — no WS heartbeat/reconnect, plus any thrown WS handler error crashed the whole server (unhandled rejection → Railway restart → every client dropped). **Fixed (2026-07-11):** server ping/pong heartbeat + try/catch around WS handlers + `pool.on("error")`; client auto-reconnect with backoff that resolves a fresh Clerk token per attempt (`client/src/lib/realtime.ts`).
11. **Merging to `main` restarts `pqp-api`.** `deploy-api-fly.yml` auto-deploys from `main`. A server or schema change drops every live WebSocket and kicks people out of voice. Client-only Pages deploys do not. Say which before claiming a PR is safe to merge. Provider keys (Steam, Twitch, Battle.net) live on Fly, not in git; merging connection code without those secrets must not 500 production.

## Agent norms

- Do not invent secret values in docs or commits.
- Shipping and PR loop: [`AGENTS.md`](./AGENTS.md) (run locally, one feature per branch, babysit CI/Farol, do not merge unless asked, warn if the PR restarts `pqp-api`).
- Point humans to `docs/I18N.md` for adding UI copy (i18next, `{name}` slots, `_one`/`_other`, Electron menus); `docs/HANDLES.md` for public handles, the `/@` profile page and its edge-injected SEO; `docs/CONNECTIONS.md` for Steam / Battle.net / Twitch linking; `docs/DISCORD_IMPORT.md` for copying a Discord Guild Template layout; `docs/ambient-deploy.md` for character accounts and the ambient-life runner (the house cast); `tools/support-bot/README.md` for the QG support bot, its fact file and the disclosure seam (it is a **disclosed bot**, not a resident, and the QG still gets no AI residents); `docs/CLERK_SETUP.md` for Clerk CLI setup; `docs/SSO.md` for SAML/enterprise domain joining; `docs/voice-backends.md` for SFU notes; `docs/ATTACHMENTS.md` for R2/MinIO setup; `docs/CONTENT_SAFETY.md` for image scanning, what is
 *not* scanned, and the CSAM reporting runbook; `docs/PWA.md` for the mobile/installable app; `docs/ANDROID.md` for the native Android client, why it is native rather than a TWA, and what is actually verified; `docs/TESTFLIGHT.md` for the iOS beta / App Review demo account; `tools/admin-dashboard/README.md` for the operator dashboard (`pqp-admin` Worker) and its `ADMIN_METRICS_TOKEN` / Basic Auth secrets.
- Update `docs/HANDOVER.md` + `docs/PLAN_STATUS.md` when phase status changes.
