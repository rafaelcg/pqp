# Community Home (client-only experiment)

Patreon-like durable owner-post timeline inside a server. **Mock only.** No
Stripe, no Clerk Billing, no schema, no `pqp-api` restart.

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

## Viewer states (no billing)

VIP cargo (`system_key=vip`, permissions `0n`) is the cosmetic stand-in for a
paid plan. Flip the mock without assigning cargos:

| How | Values |
|---|---|
| Header toggles on the Home feed | `auto` / `owner` / `free` / `VIP` |
| `localStorage` | `pqp:community-home-viewer` = `auto`\|`owner`\|`free`\|`vip` |
| Query | `?homeViewer=free` (etc.) |

- **owner** — compose + set free vs VIP visibility
- **free** — free posts full; VIP posts show teaser + lock
- **VIP** — sees members-only posts
- **auto** — owner rank, else VIP cargo, else free

Unlock CTA does nothing on purpose. There is no checkout.

## What you should see when on

- Pinned **Home / Início** at the top of the channel list (above TEXT)
- Default land on Home (not first `#geral`)
- Feed of fixture posts (localStorage per server); comments are counts
- Voice CTA ("entrar na call") joins the first voice channel
- Flag off: identical to today

## Out of scope (hard nos)

- Migrations / new tables / API routes
- Second Fly machine, Stripe, Patreon OAuth
- New permission bits (VIP stays `0n`)
- Turning the flag on in production
