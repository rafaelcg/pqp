<div align="center">

# pqp

**Voice, chat and screen sharing for your people. Make a server, share the link. That's it.**

[![CI](https://github.com/rafaelcg/pqp/actions/workflows/ci.yml/badge.svg)](https://github.com/rafaelcg/pqp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/rafaelcg/pqp)](https://github.com/rafaelcg/pqp/releases/latest)

[**pqp.gg**](https://pqp.gg) · [Download for desktop](https://github.com/rafaelcg/pqp/releases/latest) · [Architecture](./ARCHITECTURE.md) · [Deploy your own](./docs/DEPLOY.md)

</div>

---

Open-source, Discord-like, and small enough to actually read. Use the hosted
service at [pqp.gg](https://pqp.gg) or self-host an independent copy — your own
URL, your own database, your own rules.

**Model:** servers (invite links) → public/private channels → text + voice.
Roles owner / admin / member. Handles are `name#1234`.

## What it does

|  |  |
|---|---|
| **Voice channels** | Peer-to-peer mesh (5–8 per channel), or a LiveKit SFU for bigger rooms. Push-to-talk, per-peer volume, device pickers. |
| **Screen sharing** | One presenter per channel, from desktop or iPhone Safari. |
| **Chat** | Markdown, replies, reactions, pins, edits, typing, unread and mention badges. Link previews, GIF picker. |
| **Search** | Full-text across the server, stemmed for Portuguese *and* English, accent-insensitive. |
| **DMs and groups** | Direct messages and group DMs up to 10, found by handle. |
| **Attachments** | Images inline, video/audio as tap-to-play (nothing downloads until pressed). Direct-to-storage uploads; the API never touches the bytes. |
| **Presence and status** | Online / idle / do-not-disturb / invisible, with shape-differentiated dots. |
| **Moderation** | Timeouts, kick, ban (with voice ejection), delete, pin, in-app reporting with an evidence trail, per-server audit log. |
| **Safety** | 18+ age gate, image scanning hooks, LGPD self-serve export and deletion. |
| **Two languages** | pt-BR and English through the whole funnel, legal pages included — with drift between them failing CI. |
| **Installable** | PWA on mobile, signed + notarized desktop app with auto-update. |

## Quick start (development)

Prereqs: Node 20+, pnpm 10, Docker (for Postgres).

```bash
pnpm install
cp .env.example .env
cp .env.example client/.env

docker compose up -d postgres
pnpm dev
# client http://localhost:5173 · api http://localhost:3001 · ws /ws
```

**No Clerk account?** Set `DEV_AUTH_BYPASS=true` in `.env` and
`VITE_DEV_AUTH_BYPASS=true` in `client/.env`, restart, and you're signed in as
a local dev user. The bypass refuses to run when `NODE_ENV=production`.

With Clerk: `pnpm clerk:login && pnpm clerk:init && pnpm clerk:env` — see
[docs/CLERK_SETUP.md](./docs/CLERK_SETUP.md).

## Configuration

Everything lives in [.env.example](./.env.example), documented inline. The ones
that matter:

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres. `initDb()` applies the schema on boot, idempotently. |
| `CLERK_SECRET_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` | Auth. |
| `CORS_ALLOWED_ORIGINS` | Required on any public deploy — empty falls open to `*` for local dev. |
| `TRUST_PROXY` | Set behind Railway/Fly/Cloudflare, or every client shares one rate-limit bucket. |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Voice across NATs. Served via `/api/ice-servers`. |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Turns on the SFU; the server advertises it, no client rebuild. |
| `S3_*` | R2/MinIO attachments. Off entirely when unset. |
| `CONTENT_SCAN_PROVIDER` / `OPENAI_API_KEY` | Image safety scanning at claim time. |
| `CLUSTER_BUS=postgres` | Fans chat out over LISTEN/NOTIFY for multi-instance. Off = exactly today's single-process behaviour. |

## Voice backends

| Mode | Capacity | Notes |
|---|---|---|
| Mesh (default) | ~5–8 per channel | P2P; media never touches the server. TURN only across strict NATs. |
| LiveKit SFU | Dozens+ | Implemented and verified end to end. A room's transport is decided by the server and pinned — no silent mesh/SFU splits. |
| Cloudflare Realtime | — | Still a stub; falls back to mesh. |

## Self-host

```bash
cp .env.example .env   # set DATABASE_URL, Clerk keys, TURN
docker compose up -d   # api + ws + built client on :3001
```

Or deploy the API to [Fly.io](./docs/deploy-fly.md) / [Railway](./docs/deploy-railway.md)
and the static client to Cloudflare Pages ([docs/DEPLOY.md](./docs/DEPLOY.md)).
A self-host is an independent copy — own URL, data, and Clerk instance, not
linked to pqp.gg.

## Desktop and mobile

- **Desktop:** [latest release](https://github.com/rafaelcg/pqp/releases/latest) —
  macOS signed and notarized with auto-update; Windows/Linux build unsigned
  (SmartScreen will warn). See [docs/DESKTOP.md](./docs/DESKTOP.md).
- **Mobile:** install the PWA from the browser ([docs/PWA.md](./docs/PWA.md)).
  A native iOS app lives in [`ios/`](./ios) and is not yet shipped.

## API

REST under `/api/*` (Bearer auth, rate-limited per identity) and a WebSocket at
`/ws` (`{type:"auth",token}` first, then chat, presence and voice signalling).
The full route list lives in [`server/src/api/index.ts`](./server/src/api/index.ts);
the wire contracts are the Zod schemas in [`packages/shared/`](./packages/shared/src).

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Client + server |
| `pnpm test` | Every package's suite (DB-backed tests need Postgres) |
| `pnpm typecheck` / `pnpm lint` | The obvious |
| `pnpm load:chat` | Chat throughput harness against a built server |
| `pnpm soak:voice` | Voice connection soak |
| `pnpm electron:dev` / `electron:dist` | Desktop shell against Vite / packaged build |

## Known limitations

- **Mesh voice tops out at ~5–8 per channel.** Configure `LIVEKIT_*` to lift it;
  Cloudflare Realtime remains a stub.
- **Single instance unless you opt in.** Chat can go multi-instance with
  `CLUSTER_BUS=postgres`, but mesh voice pins the deployment to one instance —
  multi-instance voice requires the SFU. Rate limits stay per-instance either way.
- **No camera video** in voice channels yet — screen share only.
- **No push notifications yet** — an open tab raises desktop notifications, a
  closed phone hears nothing.
- **No friend system, threads, or AutoMod** — see
  [docs/DISCORD_GAPS.md](./docs/DISCORD_GAPS.md) for the honest census.

## Trust & safety

18+ only, self-declared at first use. In-app reporting routes DM reports to
instance moderators, never server admins. The illegal-content risk assessment,
content-safety runbook and moderation posture live in
[docs/RISK_ASSESSMENT.md](./docs/RISK_ASSESSMENT.md) and
[docs/CONTENT_SAFETY.md](./docs/CONTENT_SAFETY.md). Terms and privacy are
bilingual at [pqp.gg/terms](https://pqp.gg/terms) and
[pqp.gg/privacy](https://pqp.gg/privacy).

## License

Copyright (C) 2026 [rafaelcg](https://github.com/rafaelcg).

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE)
(`AGPL-3.0-only`). Anyone who modifies the software and runs it as a network
service must make the corresponding source available to users of that service.
