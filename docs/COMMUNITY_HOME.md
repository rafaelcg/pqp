# Community Home (client-only experiment)

Patreon-like durable media timeline inside a **community** server. **Mock only.**
No Stripe, no Clerk Billing, no schema, no `pqp-api` restart.

## Flag: `VITE_COMMUNITY_HOME_ENABLED`

Own flag. **Default off.** Do **not** reuse `COMMUNITIES_ENABLED` (that one
changes the instance's legal category under STF Art. 19).

Production Pages must leave this unset so Home never appears for real users.

### Enable locally (any one)

1. In `client/.env`:

   ```bash
   VITE_COMMUNITY_HOME_ENABLED=true
   ```

   Restart Vite (`pnpm dev`).

2. Or in the browser console:

   ```js
   localStorage.setItem("pqp:community-home", "1")
   // then reload
   ```

3. Or open `/app?communityHome=1` (also sticky-writes localStorage).

Turn off: `localStorage.removeItem("pqp:community-home")` or `?communityHome=0`.

## Who publishes / who sees

| Role | Behaviour |
|---|---|
| `MANAGE_SERVER` | Compose / edit / delete, draft vs publish, turn comments off, delete comments |
| VIP cargo alone (`system_key=vip`) | **Cannot** publish. Sees members-only posts. |
| Everyone else | Free posts full; VIP posts = title + teaser + lock |

Staff CMS is **Compose | Preview**. Compose stays available while Preview flips
`auto` / `owner` / `free` / `VIP` — the composer must not vanish when checking
Free/VIP. Same overrides via `localStorage` `pqp:community-home-viewer` or
`?homeViewer=`.

Unlock CTA does nothing on purpose. There is no checkout.

## Media types (client-only)

Image, native short video (`mp4`/`webm` via `<video>`, 10 MiB), YouTube/embed
(watch / youtu.be / shorts iframe), text, file (PDF etc download card).

Locked members-only posts must **not** put the embed URL in the free DOM —
title + teaser + lock only. Over-limit video asks for a YouTube link instead.

Home is durable media, **not** a call invite. There is no "Join the call" /
"entrar na call" primary CTA in this pass.

## What you should see when on

- Only on **community** servers (`isCommunity`): pinned **Home / Início** above TEXT
- Those servers default-land on Home (not first `#geral`)
- Feed from `localStorage` key `pqp:community-home-posts:{serverId}` (versioned envelope)
- Flat comments on published posts; staff can delete / disable per post
- Sentinel channel id `__community_home__` — **not** a real channel type
- Flag off: identical to today

## Out of scope (hard nos)

- Migrations / new tables / API routes
- Second Fly machine, Stripe, Patreon OAuth, pub/sub
- New permission bits (VIP stays `0n`)
- Turning the flag on in production
- Merging this to `main` / restarting production `pqp-api`
