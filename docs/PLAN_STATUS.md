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
| 5 SFU | Deferred | Mesh for now; CF Realtime / LiveKit later |
| 6 Electron + billing | Partial | Electron shell + CI artifacts + billing docs; no Stripe UI |

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
| Private channels | Done (create + ACL; member picker basic via API) |
| Channel delete | Done |
| Channel rename UI | API ready; UI still uses create defaults |
| Dev auth bypass | Done (agent testing) |

## Still open (recommended order)

1. **Channel rename UI** + private-channel member picker in the app
2. **Promote/demote admins** UI (API exists)
3. **SFU voice** (Phase 5)
4. **Electron packaging** + deep links
5. **Plus/Pro billing** (Clerk Billing)
6. **Message search / reactions / DMs** — out of original scope
