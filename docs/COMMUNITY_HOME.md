# Community Home (Baú / Home)

Patreon-like durable media timeline inside a server. Posts, comments, likes,
drafts, schedules, and the per-server opt-in are stored in Postgres; media uses
the configured S3/R2 storage.

## Flag: `VITE_COMMUNITY_HOME_ENABLED`

Own flag. **Default off.** Do **not** reuse `COMMUNITIES_ENABLED` (that one
changes the instance's legal category under STF Art. 19).

The flag only makes the feature available. Each server still defaults to OFF
and a member with `MANAGE_SERVER` must enable **Baú / Home** in Server Settings
→ Overview. With the flag/latch off, neither the setting nor the channel-list
row exists.

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
`auto` / `owner` / `members` — the composer must not vanish when checking the
member lock. Same overrides via `localStorage`
`pqp:community-home-viewer` or `?homeViewer=`.

Unlock CTA does nothing on purpose. There is no checkout.

## Media types

Image, native short video (`mp4`/`webm` via `<video>`, 10 MiB), YouTube/embed
(watch / youtu.be / shorts iframe), text, file (PDF etc download card).

Locked members-only posts must **not** put the embed URL in the free DOM —
title + teaser + lock only. Over-limit video asks for a YouTube link instead.

Home is durable media, **not** a call invite. There is no "Join the call" /
"entrar na call" primary CTA in this pass.

## What you should see when available and enabled

- Pinned **Home / Baú** above TEXT after that server opts in
- **Landing** is community-only: opted-in `isCommunity` servers default-land
  on Home; opted-in private halls show the row but still land on the first text
  channel
- Feed and mutations through `/api/servers/:serverId/home/*`; no posts are
  stored in `localStorage`
- Flat comments on published posts; staff can delete / disable per post
- Sentinel channel id `__community_home__` — **not** a real channel type
- Flag off: identical to today

The `NEW` markers are local discovery state only:

- `pqp:community-home-settings-seen`
- `pqp:community-home-row-seen:{serverId}`

## Out of scope (hard nos)

- Stripe, Clerk Billing, Patreon OAuth
- A second Fly machine
- New permission bits (VIP stays `0n`)
- Turning the flag on in production
- Merging this to `main` / restarting production `pqp-api`
