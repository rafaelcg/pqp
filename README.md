# pqp — open-source Discord alternative

[![CI](https://github.com/rafaelcg/pqp/actions/workflows/ci.yml/badge.svg)](https://github.com/rafaelcg/pqp/actions/workflows/ci.yml)
[![Deploy Web](https://github.com/rafaelcg/pqp/actions/workflows/deploy-web.yml/badge.svg)](https://github.com/rafaelcg/pqp/actions/workflows/deploy-web.yml)

> Hosted static site: [pqp-3yr.pages.dev](https://pqp-3yr.pages.dev) (Cloudflare Pages). See [docs/DEPLOY.md](./docs/DEPLOY.md). API/WebSocket are separate (e.g. Railway).

Real-time voice + text chat. Full mesh WebRTC per voice channel. Clerk auth. Postgres persistence. Self-host or use [pqp.gg](https://pqp.gg).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system design and [docs/PLAN_STATUS.md](./docs/PLAN_STATUS.md) for what's done vs left.

**Model:** servers (invite codes) → public/private channels → text + mesh voice. Roles: owner / admin / member. Usernames: `name#1234`.

## Quick start (development)

### Prerequisites

- Node 20+
- pnpm 9+
- PostgreSQL
- [Clerk](https://clerk.com) application (publishable + secret keys)

## Local dev without Clerk

For quick testing, enable auth bypass in **both** root `.env` and `client/.env`:

```
DEV_AUTH_BYPASS=true
VITE_DEV_AUTH_BYPASS=true
```

Restart the server after changing `.env`. You'll auto-login as **Dev User** — no Clerk account needed.

```bash
pnpm install
cp .env.example .env
cp .env.example client/.env

# Clerk (run in your host terminal — see docs/CLERK_SETUP.md)
pnpm clerk:login
pnpm clerk:init
pnpm clerk:env

# Start Postgres (Docker)
docker compose up -d postgres

pnpm dev
```

- **Client:** http://localhost:5173
- **Server:** http://localhost:3001 (API + WebSocket at `/ws`)

### First use

1. Sign in (or use dev bypass)
2. Create a server, or **Join** with an invite code (person icon on the rail)
3. **Invite** from the channel sidebar to share a code
4. Chat in `#general`; voice channels include chat + Join Voice
5. Settings (bottom-left gear): username, mute-on-join, etc.

## Environment variables

### Server (`.env`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key |
| `PORT` | No | Default `3001` |

### Client (`client/.env`)

| Variable | Required | Description |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key |
| `VITE_API_URL` | No | API base (empty = same origin / Vite proxy) |
| `VITE_WS_URL` | No | WebSocket URL (empty = `ws(s)://host/ws`) |
| `VITE_TURN_URL` | No | TURN for mesh voice across NATs |
| `VITE_TURN_USERNAME` | No | TURN username |
| `VITE_TURN_CREDENTIAL` | No | TURN credential |
| `VITE_VOICE_BACKEND` | No | `mesh` (default), `cloudflare-sfu`, `livekit` |

## Self-host

### Docker Compose

```bash
cp .env.example .env
# Set DATABASE_URL, CLERK keys, TURN vars
docker compose up -d
```

App serves API, WebSocket, and built client on port 3001.

### Railway

Use the [Railway template](./railway.toml) — deploy from repo, attach Postgres plugin, set env vars.

You get an **independent copy**: own URL, data, and Clerk instance. Not linked to pqp.gg.

## Voice limits

| Mode | Capacity | Cost |
|---|---|---|
| Mesh (default) | ~5–8 per voice channel | Free (P2P + optional TURN) |
| Cloudflare SFU (hosted, Phase 5) | Dozens+ | $0.05/GB after 1 TB/mo free |
| LiveKit (self-host, Phase 5) | Dozens+ | OSS + your infra |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/me` | Current user |
| GET | `/api/servers` | List servers |
| POST | `/api/servers` | Create server (+ default channels) |
| GET | `/api/servers/:id/channels` | List channels |
| POST | `/api/servers/:id/channels` | Create channel |
| GET | `/api/channels/:id/messages` | Message history |

All endpoints require `Authorization: Bearer <clerk_session_token>`.

## Electron

```bash
# Terminal 1
pnpm dev

# Terminal 2 — waits for Vite on :5173
pnpm electron:dev
```

Loads the web client in a desktop shell. See [`electron/README.md`](electron/README.md) for remote URL, static packaging, and deep links (`pqp://`).

## Plus / Pro (future)

Hosted tiers on pqp.gg via Clerk Organizations + Billing. Self-host remains unlimited OSS. Not implemented yet — see ARCHITECTURE.md.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start client + server |
| `pnpm build` | Build all packages |
| `pnpm start` | Run production server (after build) |
| `pnpm electron:dev` | Open Electron shell against Vite |
| `pnpm electron:dist` | Build client + package Electron app |

## Known limitations

- Mesh voice ~5–8 users per channel
- No DMs, roles beyond owner/member, file uploads, reactions
- SFU backends stubbed (mesh fallback)
- No mobile app yet
