# Plan status

> **Handover (2026-07-11):** live URLs, secrets checklist, voice FIXED → [`HANDOVER.md`](./HANDOVER.md). Agent quickstart → [`../CLAUDE.md`](../CLAUDE.md).

## Original roadmap

| Phase | Status | Notes |
|---|---|---|
| 0 Shell + docs | Done | Monorepo, Tailwind, ARCHITECTURE |
| 1 Auth + DB + API | Done | Clerk, Postgres, servers/channels |
| 2 Text chat | Done | WS + markdown + presence |
| 3 Voice per channel | Done | Mesh + chat on voice channels; cross-NAT FIXED (ExpressTURN / ICE, 2026-07-11) |
| 4 Self-host / Railway | Done | Docker Compose + docs; hosted Pages + Railway live |
| 5 SFU | LiveKit done (unverified) | LiveKit token + client adapter + compose profile; Cloudflare Realtime still a stub |
| 6 Electron + billing | Partial | Electron shell + CI artifacts + deep links wired end-to-end; no app icon, no Stripe UI |

## Hardening + product pass (2026-07-31)

| Area | What changed |
|---|---|
| Voice signalling | Relay is scoped to the sender's own voice room; rosters go only to members who can see the channel |
| Auth | `DEV_AUTH_BYPASS` refuses to run under `NODE_ENV=production`; Clerk profile + DB user cached per request instead of a network call and an UPDATE every time |
| Abuse | Per-identity rate limits (HTTP + WS), body size cap, `CORS_ALLOWED_ORIGINS` CORS allowlist, security headers, UUID validation on path params, clamped `?limit` |
| Crash paths | pg pool `error` listener, WS handler rejections caught, `unhandledRejection` backstop, graceful shutdown |
| Realtime | Client reconnects with jittered backoff, app-level ping/pong, resubscribes and re-syncs history; fresh Clerk token per request (fixed 401s after ~1 min) |
| Chat | Optimistic send with retry, message edit/delete, keyset pagination + infinite scroll, typing indicators, unread + mention badges, mentions, multi-line composer, grouping and date separators |
| Moderation | Kick, ban with an invite-proof ban list, ownership transfer, server rename and delete |
| A11y | One `Dialog` primitive with focus trap, Escape, focus restore, scroll lock — used by every modal |
| Perf | Route + emoji-data code splitting (initial JS 351 KB → 125 KB gzip), shared AudioContext, dropped duplicate indexes |
| Tests | Vitest across three packages: 92 tests, including 24 API authorization tests against real Postgres |
| CI | Lint + typecheck + tests (with a Postgres service) + build; deploy workflows fail on missing env instead of shipping broken |

## Added since roadmap

| Feature | Status |
|---|---|
| Voice channel text chat | Done |
| User panel + settings | Done |
| Mobile nav polish | Done |
| UI design system (signal desk) | Done |
| Usernames `name#1234` | Done |
| Server invites | Done |
| Roles `owner` / `admin` / `member` | Done |
| Private channels | Done (create + ACL + member picker UI) |
| Channel delete | Done |
| Channel rename UI | Done (context menu → prompt, prefills current name) |
| Promote/demote admins UI | Done (members panel: context menu + inline buttons) |
| Deep links / shareable URLs | Done (`/app/server/<id>/channel/<id>`, `/app/invite/<code>`) |
| Dev auth bypass | Done (agent testing) |

## Product roadmap

Feature gaps versus Discord are ranked with implementation sketches in
[`DISCORD_GAPS.md`](./DISCORD_GAPS.md); the theming entry is scoped separately in
[`THEMING.md`](./THEMING.md). Three items in that report are **shipped-but-broken** rather than
missing, and are the cheapest work available: the "Copy message link" URL is not a route the
router parses, the composer has no `key` so drafts follow you between channels, and `@mention`
autocomplete was never wired to the mention pipeline that already exists end to end.

## Still open (operational)

1. **Verify LiveKit end-to-end** — bring up `docker compose --profile livekit`, join from two clients
2. **Verify voice in a real browser** — the 2026-07-31 pass could not exercise mic capture; mesh
   join, deafen, and per-peer volume are untested against real hardware
3. **`pqp.gg` is unregistered** — canonical/OG tags point at a domain nobody owns
4. **Electron app icon** — no `electron/build` icons, so packaged apps ship the default Electron icon
5. **Redis-backed rate limiting and presence** — both are in-process, so the API cannot scale past one instance
6. **Cloudflare Realtime SFU** adapter (LiveKit covers the SFU need today)
7. **Plus/Pro billing** (Clerk Billing)
