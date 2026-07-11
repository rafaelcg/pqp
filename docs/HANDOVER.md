# Handover — pqp (as of 2026-07-11)

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
```

Never commit `.env`. Template: [`.env.example`](../.env.example).

## Phase status

| Phase | Status |
|---|---|
| 0 Shell + docs | Done |
| 1 Auth + DB + API | Done |
| 2 Text chat | Done |
| 3 Voice (mesh) | Done-ish — see **known issue** |
| 4 Self-host / Railway + Pages | Done (live) |
| 5 SFU | **Deferred** (stubs → mesh fallback) |
| 6 Electron + billing | **Partial** (shell + CI artifacts; no Stripe UI) |

Detail and “still open” list: [`PLAN_STATUS.md`](./PLAN_STATUS.md).

## Recent shipped work (context for next agents)

- Discord-like **voice sidebar** + **speaking rings**
- Channel **topics / icons**
- **Avatar presets**
- Fix: Clerk **`getToken` remount loop**
- Production voice plumbing: ICE via `/api/ice-servers`, TURN_* on Railway, Open Relay / Metered / Cloudflare TURN options documented

## Known issue (active)

**Cross-NAT mesh: remote peer shows FAILED.**

- Root cause class: ICE / TURN not completing across NATs (STUN-only or bad/expired TURN).
- Preferred fix path: Railway TURN env → `/api/ice-servers` → client refresh on voice join.
- **Another agent may be mid-fix** (dirty working tree possible under `client/src/hooks/use-voice.ts`, `peer-connection-manager.ts`, `server/src/services/ice.ts`, etc.). Prefer docs-only or non-overlapping commits; coordinate before rewriting voice ICE.

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

- `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`, or
- `METERED_API_KEY` (+ optional `METERED_DOMAIN`), or
- `TURN_URL` + `TURN_USERNAME` + `TURN_CREDENTIAL`

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
| [`billing.md`](./billing.md) | Future Plus/Pro |
| [`PLAN_STATUS.md`](./PLAN_STATUS.md) | Phase checklist |

## Suggested next work (priority)

1. Finish **cross-NAT voice** (TURN + ICE) — unblock FAILED peers
2. Channel rename UI + private-channel member picker
3. Promote/demote admins UI
4. Electron packaging / deep links polish
5. SFU (Phase 5) when mesh limits hurt
6. Clerk Billing (Plus/Pro) when ready
