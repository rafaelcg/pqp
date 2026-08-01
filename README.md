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

> The bypass accepts a fixed, publicly known token. The server refuses to start with it enabled
> when `NODE_ENV=production`, and CI never builds artifacts with it on.

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
2. Create a server, or **Join** with an invite link (person icon on the rail)
3. **Invite** from the channel sidebar to copy a shareable `/app/invite/<code>` link
4. Chat in `#general` — markdown, `@username` mentions, edit/delete, reactions, typing
   indicators, unread badges. Shift+Enter adds a line
5. Voice channels keep chat beside them, and a call survives navigating to another channel
6. Settings (bottom-left gear): profile, input/output devices, mute-on-join
7. Server settings (gear beside the server name): rename, transfer ownership, delete;
   Members gives owners and admins kick/ban

## Environment variables

### Server (`.env`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key (unless `DEV_AUTH_BYPASS`) |
| `PORT` | No | Default `3001` |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated CORS allowlist. Empty = permissive `*`; **set it on any public deploy** |
| `TRUST_PROXY` | No | Set `true` on Railway/Fly/Cloudflare so rate limiting reads `X-Forwarded-For`; without it every client shares one bucket |
| `PG_POOL_MAX` | No | Postgres pool size, default `10` |
| `DEV_AUTH_BYPASS` | No | Local only; rejected when `NODE_ENV=production` |

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
| GET / PATCH | `/api/me` | Current user / update profile |
| GET / POST | `/api/servers` | List / create servers |
| PATCH / DELETE | `/api/servers/:id` | Rename, transfer ownership / delete |
| GET | `/api/servers/:id/unread` | Per-channel unread + mention counts |
| GET / POST | `/api/servers/:id/channels` | List / create channels |
| GET / POST | `/api/servers/:id/invites` | List / create invites |
| DELETE | `/api/servers/:id/invites/:inviteId` | Revoke an invite |
| GET | `/api/servers/:id/members` | Members |
| PATCH / DELETE | `/api/servers/:id/members/:userId` | Change role / kick or ban |
| GET | `/api/servers/:id/bans` | Ban list |
| DELETE | `/api/servers/:id/bans/:userId` | Unban |
| PATCH / DELETE | `/api/channels/:id` | Update / delete channel |
| GET / POST / DELETE | `/api/channels/:id/members` | Private channel access list |
| GET | `/api/channels/:id/messages` | History (`?limit=`, `?before=`) |
| POST | `/api/channels/:id/read` | Mark read |
| PATCH / DELETE | `/api/messages/:id` | Edit / delete a message |
| GET / POST | `/api/invites/:code` | Preview / redeem an invite |
| GET | `/api/ice-servers` | ICE / TURN config |
| GET / POST | `/api/voice/backend`, `/api/voice/token` | SFU discovery and session |

All endpoints require `Authorization: Bearer <clerk_session_token>`. Requests are rate
limited per identity; exceeding it returns `429` with `Retry-After`.

### Realtime (`/ws`)

First message must be `{ type: "auth", token }`. After `{ type: "ready" }` the socket carries
chat (`join-channel`, `message-create`, `reaction-toggle`, `typing`), voice signalling
(`join-voice-room`, `offer`, `answer`, `ice-candidate`), and server pushes
(`message-broadcast`, `message-update`, `message-delete`, `presence-update`,
`typing-broadcast`, `channel-activity`, `voice-roster`). `{ type: "ping" }` → `{ type: "pong" }`
keeps proxies from dropping idle connections; the client reconnects with backoff on any drop.

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
| `pnpm test` | Run the test suite |
| `pnpm typecheck` | Typecheck every package |
| `pnpm lint` | ESLint across the repo |
| `pnpm start` | Run production server (after build) |
| `pnpm electron:dev` | Open Electron shell against Vite |
| `pnpm electron:dist` | Build client + package Electron app |

## Tests

```bash
docker compose up -d postgres
createdb pqp_test  # or: docker compose exec postgres psql -U pqp -c 'CREATE DATABASE pqp_test'
DATABASE_URL=postgresql://pqp:pqp@localhost:5432/pqp_test pnpm test
```

Unit tests run anywhere. The API authorization tests need a database and **skip** without
`DATABASE_URL` — CI always provides one, so they always run there.

## Known limitations

- Mesh voice ~5–8 users per channel (LiveKit SFU lifts this; Cloudflare Realtime is still a stub)
- No DMs, no file or image uploads, no message search
- No mobile app yet
- Rate limiting and presence are in-process, so the API is single-instance until they move to Redis
