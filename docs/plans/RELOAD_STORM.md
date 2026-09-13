# Reload storm: taking the HLS playlist hot path off the API

## The problem, in tonight's numbers

A deploy restarted `pqp-api` mid-party. `server/src/lib/drain.ts` closed the old
machine's sockets in batches, and 141 of them reconnected inside a few
seconds. The Postgres pool pinned at its ceiling of 70 with 79 connection
requests queued behind it — every reconnecting socket re-authenticates, rejoins
its voice room and re-reads channel state, each a handful of queries, all
landing in the same window. `/ready` and ordinary API reads queued behind the
same pool. This is CLAUDE.md pitfall 13's shape one layer up: a burst that is
normal in isolation becomes the wall when 141 copies of it land in the same
second.

That reconnect burst is not this PR's fix (see "jittered reconnect" below),
but it is what put a spotlight on a second, standing cost that has nothing to
do with deploys: **every watch-party viewer polls the API's HLS playlist proxy
every 2 to 4 seconds**, for as long as they watch. hls.js and the native
players re-fetch the current rendition's media playlist on a timer close to
the segment duration; `server/src/api/index.ts`'s playlist route,
`hls-live-window.ts`'s 30 s window and `hls-viewer-token.ts`'s per-viewer `?t=`
all run on **every one of those requests**, on the API process, competing with
the pool for the same connections a reconnect storm needs.

At 500 concurrent viewers that is **125 to 250 identical requests per second**
against the API for a given channel's playlist — "identical" because the
*body* of a rung's media playlist is a pure function of (channel, session,
rung, current 2 s render) and does not depend on which viewer asked, only the
per-viewer `?t=` token differs. Segment bytes already go straight to R2
(presigned URLs, never through the API); the playlist itself is the thing 500
browsers keep re-deriving from the same handful of database and R2 reads,
one-by-one, on the process that also owns the connection pool the rest of the
product needs.

A moonkase-sized party (2026-09-05, 212 signups in 20 minutes) or the
2026-09-12 party (~200 watching) sit well under 500; the number is chosen
because it is where the API's polling cost alone approaches the size of the
141-socket reconnect burst above, on a machine that has not grown since. The
fix does not wait for a party that size — it removes a cost that scales with
viewers on every party from here on, reconnect storm or not.

## The plan, in order

1. **Edge Worker for playlists — this PR.** A Cloudflare Worker at
   `hls.pqp.gg` (`tools/hls-edge/`) validates the viewer token itself and
   fetches a rendition's playlist from the API once per 2 seconds per rung,
   shared across every viewer of that rung, instead of once per viewer. Cuts
   the 125–250 req/s above to roughly one request every 2 s per rung per
   Cloudflare colo the audience is spread across — for a single-city audience,
   effectively one origin fetch per rung per cache window. The token check
   stays authoritative: it is the same HMAC scheme as
   `hls-viewer-token.ts`, and every cached response is still gated on a valid
   token before it is served. See `tools/hls-edge/README.md` for why only the
   per-rung media playlist is cached and the top-level session URL is always
   passed through uncached.

2. **Jittered reconnect — client, separate PR.** The 141-socket burst above
   is a reconnect storm, not a polling cost, and it needs its own fix:
   `client/src/lib/realtime.ts`'s backoff currently has no jitter, so a drain
   batch reconnects in the same tight cluster it was released in. Spreading
   reconnects over a window turns one 141-wide spike into a shorter, lower one
   without changing how fast any single client recovers. Does not touch the
   server.

3. **Per-channel read caches — server, separate PR.** Some of what a
   reconnecting socket re-reads (channel list, role/permission state, recent
   presence) is the same for every member of a server and changes rarely
   compared to how often a reconnect burst re-reads it. A short-lived
   per-channel cache in front of those specific queries — not a general
   read-through cache — cuts the pool cost of a reconnect burst the way step 1
   cuts the pool cost of a watch party. Scoped narrowly on purpose: a cache
   with unclear invalidation is how pitfall 13's shape happens again.

4. **Cloudflare proxy in front of the API, with edge caching of public
   GETs — comes with the Vultr move.** `docs/deploy-vultr.md` already puts
   Cloudflare in front of `api.pqp.gg` for TLS and DDoS once the API moves off
   Fly; edge-caching the API's genuinely public, cacheable GETs (`/api/*config`
   endpoints, `/status.json`, public profile/community pages) is close to free
   once that proxy exists, and closes a wider class of the same problem this
   PR closes for one hot path. Sequenced after the move because it is the
   move's proxy doing the caching, not a second one.

5. **PgBouncer — later.** The actual ceiling in tonight's incident was the
   Postgres pool, not any one endpoint. Steps 1–4 all reduce how much reaches
   that pool; PgBouncer (or the equivalent on managed Postgres) raises the
   ceiling itself, and is worth doing once the demand side has already been
   cut — sizing a pooler for today's query shape and then changing the query
   shape underneath it is how you end up tuning twice.

Each step stands alone and ships as its own PR. This document tracks order,
not a single branch.
