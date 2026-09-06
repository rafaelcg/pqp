<div align="center">

# pqp

**Voice, chat and screen sharing for your people. Make a server, share the link. That's it.**

[![CI](https://github.com/rafaelcg/pqp/actions/workflows/ci.yml/badge.svg)](https://github.com/rafaelcg/pqp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/rafaelcg/pqp)](https://github.com/rafaelcg/pqp/releases/latest)
[![Sponsor](https://img.shields.io/badge/GitHub-Sponsor-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rafaelcg)

[**pqp.gg**](https://pqp.gg) · [Download for desktop](https://github.com/rafaelcg/pqp/releases/latest) · [Architecture](./ARCHITECTURE.md) · [Deploy your own](./docs/DEPLOY.md) · [Support the project](https://pqp.gg/apoie)

</div>

---

Open-source, Discord-like, and small enough to actually read. Use the hosted
service at [pqp.gg](https://pqp.gg) or self-host an independent copy — your own
URL, your own database, your own rules.

**Model:** servers (invite links) → public/private channels → text + voice.
Roles are permission bits behind a seeded staff ladder (owner, admin, manager,
moderator, VIP, `@everyone`) plus whatever a server invents, with per-channel
overwrites. Usernames are `name#1234`; a claimed `@handle` is a public page.

## What it does

|  |  |
|---|---|
| **Voice channels** | The server picks the media path per room, at the first join: peer-to-peer for DM calls and small servers, a LiveKit SFU for communities and servers of ten or more, so a crowded room is not capped at a handful. Push-to-talk, per-peer volume, device pickers. |
| **Screen sharing** | With the machine's audio. Two presenters at once peer-to-peer, four on the SFU. Send from a browser or the desktop app (Android in peer-to-peer rooms); watch from any client, phones included. |
| **Chat** | Markdown, replies, reactions, pins, edits, typing, unread and mention badges. Link previews, GIF picker. Outgoing webhooks after a human message ([docs](./docs/OUTGOING_WEBHOOKS.md)). |
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
| `VOICE_REGISTRY=postgres` | Puts the voice peer map and transport pins in Postgres so rosters survive a second instance. Off by default; see [docs/plans/MULTI_INSTANCE_VOICE.md](./docs/plans/MULTI_INSTANCE_VOICE.md). |

## Voice backends

The server chooses per room, on the first join, and pins the choice for the
room's lifetime (`server/src/voice/transport-policy.ts`). No client rebuild
switches it, and there are no silent mesh/SFU splits: a client that cannot use
the room's transport is refused rather than left out of the call.

| Mode | When it is used | Capacity | Notes |
|---|---|---|---|
| Mesh | DM calls, and servers under ten members. Everything, on a deployment with no `LIVEKIT_*` | `MESH_VOICE_LIMIT`, 8 per channel | P2P; media never touches the server. TURN only across strict NATs. |
| LiveKit SFU | Listed communities of any size, and servers of ten or more | Big rooms, and live on pqp.gg | Implemented and verified end to end. |
| Cloudflare Realtime | never | n/a | Still a stub; falls back to mesh. |

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
- **Mobile:** native clients in [`ios/`](./ios) (SwiftUI, TestFlight beta at
  [pqp.gg/beta](https://pqp.gg/beta)) and [`android/`](./android) (Kotlin and
  Compose, APK beta at [pqp.gg/android](https://pqp.gg/android)). Neither is on
  a store yet. The PWA still installs from any browser
  ([docs/PWA.md](./docs/PWA.md)).

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

- **A deployment with no `LIVEKIT_*` tops out at 8 per voice channel**, because
  every room is then peer-to-peer. Cloudflare Realtime remains a stub.
- **Single instance unless you opt in.** Chat can go multi-instance with
  `CLUSTER_BUS=postgres` and voice rosters with `VOICE_REGISTRY=postgres`, but
  the pieces are not yet enough to run two machines. Rate limits stay
  per-instance either way.
- **Android has no push server leg.** Web Push and APNs are wired end to end;
  `server/src/services/push.ts` knows `web` and `apns` only, so a closed
  Android app hears nothing.
- **Android has no camera** in either direction, and cannot send a screen share
  into a large room.
- **No AutoMod, no forwarding on the phones.** See
  [docs/DISCORD_GAPS.md](./docs/DISCORD_GAPS.md) for the honest census and
  [docs/PARITY.md](./docs/PARITY.md) for the client-by-client matrix.

## Trust & safety

18+ only, self-declared at first use. In-app reporting routes DM reports to
instance moderators, never server admins. The illegal-content risk assessment,
content-safety runbook and moderation posture live in
[docs/RISK_ASSESSMENT.md](./docs/RISK_ASSESSMENT.md) and
[docs/CONTENT_SAFETY.md](./docs/CONTENT_SAFETY.md). Terms and privacy are
bilingual at [pqp.gg/terms](https://pqp.gg/terms) and
[pqp.gg/privacy](https://pqp.gg/privacy).

## Apoie o projeto / Support the project

pqp.gg is built by two brothers and the hosting comes out of our pockets. If it is
useful to you and you want to help with that bill, there is
[GitHub Sponsors](https://github.com/sponsors/rafaelcg) and, for Pix,
[pqp.gg/apoie](https://pqp.gg/apoie). A donation is a gift toward hosting costs:
it unlocks nothing, there are no tiers and no perks, and self-hosting stays free
with every feature.

## Contributing

Bug reports, questions and patches are all welcome, in English or Portuguese.
Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) ([em português](./CONTRIBUTING.pt-BR.md)):
it covers setup, the handful
of things in this repo that will otherwise waste an hour of your time, and what
the AGPL means for you if pqp ever charges money.

## License

Copyright (C) 2026 [rafaelcg](https://github.com/rafaelcg).

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE)
(`AGPL-3.0-only`). Anyone who modifies the software and runs it as a network
service must make the corresponding source available to users of that service.
