# Plan status

> **Handover (2026-08-25):** live URLs, secrets checklist, voice FIXED → [`HANDOVER.md`](./HANDOVER.md). Agent quickstart → [`../CLAUDE.md`](../CLAUDE.md).

## Original roadmap

| Phase | Status | Notes |
|---|---|---|
| 0 Shell + docs | Done | Monorepo, Tailwind, ARCHITECTURE |
| 1 Auth + DB + API | Done | Clerk, Postgres, servers/channels |
| 2 Text chat | Done | WS + markdown + presence |
| 3 Voice per channel | Done | Mesh + chat on voice channels; cross-NAT FIXED (ExpressTURN / ICE, 2026-07-11) |
| 4 Self-host / Fly | Done | Docker Compose + docs; hosted Pages + Fly (`pqp-api`, gru) live. Railway is retired; nothing points at it |
| 5 SFU | LiveKit **verified against a live server** (2026-08-07) | Two headless Chromium participants joined a real LiveKit room through `livekit-session.ts` and exchanged audio both ways; mute, screen share, ban eviction, the mesh-cap bypass and the mesh-only 503 all checked. Verification found `revokeTokenTs` to be LiveKit-Cloud-only, so a ban could be defeated by reconnecting on the token already held — fixed with a re-sweep. **Not** verified against LiveKit Cloud, at scale, or cross-NAT; the silent per-client mesh fallback is a known open split. Details and exact scope: [`voice-backends.md`](./voice-backends.md#verification-status). Cloudflare Realtime still a stub |
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
| Roles `owner` / `admin` / `member` | Done (compatibility rank; staff power is cargos) |
| Private channels | Done (create + ACL + member picker UI) |
| Channel delete | Done |
| Channel rename UI | Done (context menu → prompt, prefills current name) |
| Promote/demote admins UI | Replaced (2026-08-28). Profile cargos checklist + Cargos Members tab. iOS Promote/Demote still assigns/strips Admin. |
| Deep links / shareable URLs | Done (`/app/server/<id>/channel/<id>`, `/app/invite/<code>`) |
| Dev auth bypass | Done (agent testing) |
| Per-server message retention policy | Done (owner-configurable window, daily sweep, pinned messages exempt — `servers.message_retention_days`) |
| Per-server data export | Done (owner-only JSON download of channels/members/messages, capped at 50k messages, audit-logged) |
| Incoming webhooks | Done (Discord wire-compatible payload shape; per-channel management UI; pseudo-user authors messages so no read path had to change; audit-logged) |
| i18n (en + pt-BR) | Done (i18next core, lazy pt-BR, Electron menus in `electron/locales/`) |
| Mobile PWA | Done (installable, shell precache + offline fallback, prompted updates, iOS safe-area/`dvh`, SW notification path for Android — `docs/PWA.md`) |
| Native Android app | **Partial** (Kotlin + Compose + Material 3 in `android/`: auth, age gate, servers, channels, text chat all verified against a live local server; mesh voice with a foreground service negotiates between two clients but its media path is unproven for want of TURN; no screen share, no push, no CI job. See `docs/ANDROID.md`) |
| Public status page | Done (`/status` + unauthenticated `/status.json`; per-component probes sampled once a minute, real 24h/7d uptime kept 30 days) |
| SSO / SAML readiness | Done (Clerk federates; app adds verified-email-domain joining per server, owner-only, exact-match, bans still apply — `docs/SSO.md`) |
| Screen share | Done (mesh: second video track + manual renegotiation per peer; SFU: LiveKit `Track.Source.ScreenShare`; concurrent presenters capped at 2 on mesh / 4 on LiveKit) |
| Native iOS push notifications | Done, unverified on device (APNs as a second leg of the existing push fan-out — same triggers, same content-free defaults, HTTP/2 + ES256 JWT with no new dependency; VoIP/PushKit deliberately out of scope — `docs/IOS.md`) |
| Invite links that open the iOS app | Done, universal links unverified until the web deploy lands (`applinks:pqp.gg` + an AASA claiming only `/app/invite/*`, `pqp://invite/<code>` fallback, pending invite survives sign-in) |
| Character accounts | Done, unverified against a deploy (`character_accounts` + one gated branch in `verifyAuthHeader`; hashed 256-bit token, constant-time compare, one-UPDATE revoke; a character cannot DM, be DMed, join voice, be friended, be found outside a shared server, or delete/export itself — all enforced server-side. Off unless `CHARACTER_ACCOUNTS_ENABLED=true`) |
| Public pages: `/@handle` and `/c/<slug>` | Done (profile redesigned as an identity page — hero banner or a generated gradient, overlapping avatar, community badges as a grid, **approved depoimentos rendered**, join month at month granularity; `users.banner_key/banner_url` on the avatar machinery, uploadable in Settings → Profile. New `servers.community_slug`, unique among *listed* communities, derived from the name on opt-in — a collision refuses the listing rather than auto-suffixing. `GET /api/public/communities/:slug` is unauthenticated behind `COMMUNITIES_ENABLED` and carries a poster, never a member list. Both CTAs carry an intent through sign-up; the Pages middleware injects OG for both — `docs/HANDLES.md`) |
| Turma dos 1000 | Code shipped; **not granted until 1,000 human accounts**. Numbered mark (`turma-1000`, `user_badges.ordinal`) for the oldest 1,000 humans by `created_at, id`. Auto-stamps from `insertNewUser`. Medal hidden while the list is empty. In-app card is a contact sheet (rank marks, about tabs). Manual fallback `server/scripts/grant-turma-1000.mjs`. |
| Game connections (Steam, Battle.net, Twitch) | Done as Discord-style Connections, not as a second login (`docs/CONNECTIONS.md`). Off per provider until that provider's env is set. Visibility defaults to in-app only; the public page is opt-in. |
| Copy Discord layout | Paste a Guild Template (`discord.new/…`). Preview, then create a pqp community with the same sidebar. Named permission subset (never Administrator), VIEW/SEND/CONNECT overwrites, server icon when storage is on. Voice bitrate stays dropped. No bot, no members, no messages. Field inventory: `docs/DISCORD_IMPORT.md`. |
| In-app sounds | Demo on `feat/in-app-sounds`. Cinematic UI SFX (CC0): mention=`mention`, voice join/leave=`select`/`deselect`. Join/leave play on click; the mic pipeline waits so capture cannot cut the cue. Samples exclusive; outgoing ring waits. No ordinary-message ping. Incoming ring picker in Settings (Classic plus four motifs). Outgoing still dual-tone. |
| Ambient life — the five launch communities | Done, canned-verified (`tools/ambient/`: 25 personas across Resenha FC / Maratona / Fone com Fio / Sala de Espera do Ranked / Véspera de Prova; provisioning + seed scripts, multi-community scheduling from one process, inbound reply screening with a per-human cap, JSONL audit log, kill switch honoured mid-scene — `docs/ambient-deploy.md`). **No live Claude generation has been made** since the spike; every run so far is `--canned` |
| Roles, nicknames, `@everyone` / `@here` | Done locally (2026-08-24), staff ladder 2026-08-28, VIP seed 2026-08-30. Discord 8-step overwrites, 20 permission bits as decimal strings / `bigint`, seeded Owner / Admin / Manager / Moderator / VIP / `@everyone` with gold / wine / blue / teal / lilac. Bot stays an account mark. Nicknames display-only (mentions stay `@username`). Mass mentions gated on `MENTION_EVERYONE`. Authz uses bits, not rank. Profile card assigns cargos with checkboxes. Channel overwrite editor (allow / inherit / deny). Live `permissions-update` WS frame. Hoist in the member list and the Members dialog. Role colours on message names and the member sidebar. |
| NEW divider, mention rows, `:emoji:` / ArrowUp | Done locally (2026-08-24). `POST /read` returns the previous cursor so the log can keep a NEW rule for the visit. Mentioned rows get an accent wash. Own messages do not wash or ping; a fired `@everyone` / `@here` from someone else does. Composer ArrowUp edits last own message; `:name` autocompletes. |

## Product roadmap

Feature gaps versus Discord are ranked with implementation sketches in
[`DISCORD_GAPS.md`](./DISCORD_GAPS.md); the theming entry is scoped separately in
[`THEMING.md`](./THEMING.md) (stages 1–5 shipped: role tokens, light/dark/system,
synced preferences, Classic / Harmony / Hearth / Night, high contrast, and accent
hue), and choices that shape work not yet built are recorded in
[`DECISIONS.md`](./DECISIONS.md). Gaps marked ✅ in the ranked list have shipped: the three
shipped-but-broken items (permalink route, per-channel drafts, `@mention` autocomplete), plus
replies, theming, message search, desktop notifications, per-server/channel notification
levels, file/image attachments, user search by handle, direct and group messages, blocking
with DM privacy controls, pinned messages, channel categories with drag-to-reorder, link
and image embeds (unfurling), a per-server audit log, message retention policies, per-server
data export, incoming webhooks (#23, Discord wire-compatible), screen share (#11), and
SSO/SAML readiness, a public status page, and the mobile PWA. Role bitfields,
nicknames, `@everyone`/`@here`, the channel overwrite editor, hoist, and live
`permissions-update` (#22 / #71) shipped 2026-08-24.

Two subsystems landed alongside those features and shape what comes next:

- **Object storage** (attachments) is what custom emoji (#26), server icons and real uploaded
  avatars hang off — none of those need a second storage decision now. See
  [`ATTACHMENTS.md`](./ATTACHMENTS.md).
- **One channel-access predicate.** `canAccessChannel` in `server/src/services/users.ts` is now
  the only answer to "may this user see this channel", branching on `channels.kind`. It replaced
  five verbatim copies. Anything new that reads a channel must go through it — a second copy is
  how a private channel or a DM leaks.

The ranked gap list is now worked through (2026-08-05). Mobile PWA (#9) was taken last on
purpose, so its scope reflected the full feature surface rather than guessing at it.

## Still open (operational)

1. ~~**Mixed-transport voice calls**~~ — **fixed 2026-08-07.** A voice room now has one transport,
   the server picks it when the room opens and pins it for the room's life, and it is stated in
   `welcome` and `voice-roster`. Clients declare which transports they can run on `join-voice-room`;
   one that cannot run the room's is refused before a peer exists, and a client whose SFU session
   fails at runtime leaves the call and says so instead of building a mesh nobody else is on.
   Verified end-to-end in real browsers against a live LiveKit. See
   [`voice-backends.md`](./voice-backends.md#one-room-one-transport-fixed). Residual: two instances
   with *different* LiveKit config still pin the same channel differently — one more reason voice
   wants a single instance.
2. **Verify voice in a real browser** — mesh and SFU join, real mic capture, and the transport
   refusal paths are now covered (2026-08-07, headless Chromium with fake devices); deafen and
   per-peer volume are still untested against real hardware
3. **`pqp.gg` is unregistered** — canonical/OG tags point at a domain nobody owns
4. **Electron app icon** — no `electron/build` icons, so packaged apps ship the default Electron icon
5. **Redis-backed rate limiting and presence** — both are in-process, so the API cannot scale past one instance
6. **Cloudflare Realtime SFU** adapter (LiveKit covers the SFU need today)
7. **Plus/Pro billing** (Clerk Billing)
