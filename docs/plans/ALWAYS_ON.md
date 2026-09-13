# Always on: making pqp, and the watch party specifically, downtime-free

Status: plan, written 2026-09-13. Grounded in `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`
(the DB collapse), `docs/plans/MULTI_INSTANCE_VOICE.md` (M1-M5 landed, M6 open),
`docs/deploy-vultr.md`, `docs/DB_RUNBOOK.md`, `docs/PWA.md`, `docs/MONITORING.md`,
`fly.toml`, `server/src/voice/hls-live-window.ts`, `hls-playlist-proxy.ts`,
`hls-viewer-token.ts`, `client/src/lib/realtime.ts`, and the three open PRs
`feat/hls-edge-playlists` (#559), `feat/reconnect-jitter` (#558) and
`feat/offline-drafts-persist` (#481), plus the uncommitted `perf/read-cache`
worktree. Tasks are numbered `A0.1`, `A1.2` style so a PR title can reference
one directly. Effort in agent-days, solo-maintainer-and-agents pace.

Two production facts that shape everything below: Postgres is now **Vultr
Managed PostgreSQL**, plan `vultr-dbaas-startup-cc-hp-amd-2-128-4` (2 dedicated
vCPU, 4 GB, single node, daily backups - HA with a standby needs a higher
plan), and the API is one Fly machine moving to one Vultr box Monday, with Fly
kept as a 30-day rollback per `docs/deploy-vultr.md` §7.

## 1. What a watch party needs, and whether it survives today

| Piece | Where it lives | Survives an API outage | Survives a DB outage | Survives an API deploy today |
|---|---|---|---|---|
| WS: chat, presence, voice signaling | `pqp-api` process, in-memory maps (`fly.toml` banner) | No - one process | No - every DB-backed frame fails | No - drains (`lib/drain.ts`), client reconnects with backoff (pitfall 11) |
| Voice/camera media | LiveKit SFU, separate Vultr box | Yes, once joined - media is a second connection | Yes, the media itself; a *new* join needs `POST /api/voice/token` on the API | Yes - an API restart never touches the SFU |
| HLS segment bytes | R2, presigned URLs | Only while an already-signed URL has not expired; no *new* signs | Same - signing needs no DB, but reaching the sign path does (see below) | Same as an API outage: today the sign path is on `pqp-api` |
| HLS playlist body (the `.m3u8`) | `hls-playlist-proxy.ts` on `pqp-api`: a Postgres row lookup (`hls_sessions`, `ended_at IS NULL`) + an R2 fetch + `LiveWindowHistory`, all per-process | No | No - the session-liveness query is the first thing every render does | No - every reconnecting viewer re-hits it, which is the reload-storm problem (`docs/plans/RELOAD_STORM.md`) |
| Watch-party state (play/pause/seek) | `voice_rooms.watch_party` via WS, Postgres-backed since `VOICE_REGISTRY=postgres` | No | No | Resumes once the socket reconnects; no state is lost, just paused |
| Egress / transcode | Vultr egress box, started via LiveKit `RoomServiceClient` calls the API makes, writes segments straight to R2 once running | Yes for a session already running (pitfall 15's `reapForeignEgresses`/`adoptLiveHlsSession` machinery is built for exactly "the API restarted, the egress didn't") | Bytes keep landing in R2; a *new* session, or `stopRoom`'s bookkeeping (`ended_at`), needs the DB | Yes, unaffected - an existing egress is adopted back, not killed |
| Client shell (SPA) | Cloudflare Pages | Yes | Yes | Yes - a client-only deploy never restarts the API |
| Typed-but-unsent messages | `localStorage` outbox, PR #481 | Persisted, yes; *delivery* still needs the API | Same | Survives a reload; still needs a live socket to flush |

Read down the "API outage" column: everything that is not media-already-flowing
or bytes-already-in-R2 depends on one process. That is the shape this plan
attacks, layer by layer, cheapest first.

## 2. Layer 0: no downtime from a deploy or a crashed process

`docs/plans/MULTI_INSTANCE_VOICE.md`'s own status line: **M1 through M5 are
landed in code** - the Postgres-backed registry (rooms, peers, retired ids,
instance heartbeat), the four bus topics (`voice.room`, `voice.call`,
`voice.moderation`, `voice.signal`) that let roster, rings, moderation and
even mesh signaling cross two processes, the cross-instance resume/adopt plan
with dead-instance reconcile, and the `fly.toml` rolling-deploy/drain
plumbing. None of it is Fly-specific - it is all mediated by Postgres
(`CLUSTER_BUS=postgres`, `VOICE_REGISTRY=postgres`), which is already the
production setting. **Only M6 - rehearse it for real, then run two - is open.**
Layer 0 is M6, retargeted at Vultr instead of a second Fly machine, plus the
cheapest topology that gets there.

**A0.1 - Staging rehearsal of M1-M5 (a separate agent is running this now;
check its result before building on it, do not duplicate it).** The checklist
is `docs/STAGING.md` "Rehearsing two machines" with `LIVEKIT_*` set: two live
processes sharing `CLUSTER_BUS`/`VOICE_REGISTRY`, `voice.hello` self-echo
green on both, a mesh room crossing the bus, a cross-instance resume adopted,
`voice.cluster.framesRelayed`/`framesReceived` climbing. This validates the
*code path*, independent of which infrastructure hosts the two processes -
which is why it can run on Fly staging today even though production is moving
to Vultr.

**A0.2 - Two API containers on ONE Vultr box, behind Caddy, as the cheap
first step. Status: in PR.** `tools/api-host/compose.yaml` runs one `api` service today;
split it into `api-a` / `api-b` on two internal ports, both reading the same
`/opt/pqp/.env` (same `DATABASE_URL`, `CLUSTER_BUS=postgres`,
`VOICE_REGISTRY=postgres`), with Caddy load-balancing `/api/*` and `/ws`
across both. `pqp-deploy.sh` (`tools/api-host/pqp-deploy.sh`) becomes: pull
the new image, restart `api-a`, wait for its `/health` to go green, restart
`api-b`. A container crash fails over to its sibling; a **host** crash is
still full downtime, since there is only one box. Cost: **$0** - same box,
same plan, two processes instead of one.

**A0.3 - A second Vultr box plus a Vultr Load Balancer, for host-level
failover.** Once A0.2 is soaking cleanly, add a second `vhp-4c-8gb-amd`
(provisioned the same way as the first - `docs/deploy-vultr.md` §§1-3, same
`.env`) and put a Vultr Load Balancer in front of both boxes instead of
Caddy doing the balancing locally, health check on `GET /health`. Extend
`deploy-api-vultr.yml` to roll one box at a time (`max_unavailable`-style: SSH
to box 1, `pqp-deploy.sh`, wait healthy, SSH to box 2), and assert
post-deploy that both boxes serve the new image, the same dual-version check
`deploy-api-fly.yml` already does for two Fly machines. Cost: **+$48/mo**
(second box) **+$10/mo** (load balancer) - matches the postmortem's own table
in section E.

**A0.4 - Whatever the A0.1 rehearsal finds.** The rehearsal is the thing most
likely to surface a real bug (the 2026-09-07 two-machine window on Fly found
exactly one: the mesh guard hanging up cross-instance calls, fixed the same
night - see `MULTI_INSTANCE_VOICE.md`'s "2026-09-08" notes). Budget a day for
whatever equivalent shows up before trusting A0.3 in production.

**One dependency worth stating now, resolved by A3.1 below:** a load
balancer or Caddy routing on `/health` only helps if `/health` can go
unhealthy *per box* without every box going unhealthy *at once* on a shared
DB hiccup. Today `/health` runs `SELECT 1`, so a Postgres blip fails
**every** box's check simultaneously and Layer 0 buys nothing during exactly
the incident that started this plan. A3.1 has to land before A0.3 is
trusted, not after.

Acceptance: redeploy or kill one process - no WebSocket is dropped for
longer than the reconnect-jitter window (~0.5-4s, `feat/reconnect-jitter`
below), only that process's sockets reconnect, and the roster/rings/watch-party
state on the surviving process shows no gap (already pinned by the "mesh
across instances" and "moderator mutes across instances" groups of
`voice-cluster.test.ts`).

## 3. Layer 1: the party keeps playing without the API

`feat/hls-edge-playlists` (#559) is built and describes itself accurately in
`docs/plans/RELOAD_STORM.md`: a Cloudflare Worker at `hls.pqp.gg` validates
the viewer token itself (a faithful, stateless port of
`hls-viewer-token.ts`'s HMAC scheme - no DB dependency, already true today)
and shares **one origin fetch per rung per 2s across every viewer**, instead
of one per viewer. That collapses the reload-storm cost, but the origin fetch
still lands on `pqp-api`'s `hls-playlist-proxy.ts` - so as shipped, the party
survives *load*, not an *API outage*. Closing that last gap is Layer 1's real
work:

**A1.1 - Merge #559 as shipped.** Needed either way: it is the fix for the
reload-storm problem regardless of what follows, and every later step here
builds on the Worker existing.

**A1.2 - Give the Worker its own R2 credentials.** A read-only R2 API token
scoped to the live-HLS bucket only (same pattern as the backup role in
`docs/DB_RUNBOOK.md` §1), stored as a Worker secret. Port `signRequest`
(`server/src/lib/s3.ts`) into the Worker in plain Web Crypto - the same
porting pattern `hls-viewer-token.ts`'s HMAC already used, which is what
makes token verification independent of the API today.

**A1.3 - Port `LiveWindowHistory` into the Worker, one Durable Object per
session.** `server/src/voice/hls-live-window.ts`'s `merge`/`window`/`render`
logic, keyed by channel+session+rung, so the 30 s live window survives across
the Worker's stateless invocations and across whichever colo the audience
lands on. This is what the task's brief means by "its own 30 s window
(Durable Object per session)" - today the window lives in the API process's
memory (`windowHistory` map in `hls-playlist-proxy.ts`) and dies with it.

**A1.4 - Switch the Worker's origin fetch from the API route to a direct R2
read.** List the session's segment objects under `hlsObjectPrefix` (the
bucket layout `hls-egress.ts` already writes) and build the playlist body in
the Worker using A1.2 and A1.3, instead of proxying to
`GET /api/voice/hls-playlist/...`. This is the step that actually removes the
API from the hot path - everything before it just made the API cheaper to
call.

**A1.5 - Party-lifetime tokens (the known remaining gap).**
`HLS_VIEWER_TOKEN_TTL_MS` is 60 minutes, and a token is only minted by the
API (`GET /api/channels/:id/live`, or the `channel-live`/`voice-stream` WS
frame). Even after A1.4, a viewer whose token expires mid-outage, or a new
joiner, still needs the API. Two options to spec out, not build blind: a
longer-lived "party pass" minted once at party start that the Worker can
verify without the API (same HMAC shape, coarser revocation), or accepting
the 60-minute ceiling and documenting it as the known bound on "how long a
party survives an API outage" until this ships.

**A1.6 - Confirm the client never couples the player to the socket.**
`hls-watch-player.tsx`'s stall watchdog already polls the playlist URL
independently of `realtime.ts`'s connection state (confirmed by
`feat/reconnect-jitter`'s own description of jittering that watchdog
separately from the WS backoff). Verify nothing swaps in a "reconectando"
overlay that unmounts the `<video>` element on `status !== "online"` - chat
should show reconnecting, the stage should not.

Acceptance, as specified: kill the API for 2 minutes mid-party - zero player
stalls for 500 viewers already holding a token; A1.5 is what closes the gap
for anyone joining or expiring during that window.

## 4. Layer 2: the app opens when the API is down

`docs/PWA.md` is explicit about the current, deliberate posture: only the
shell is precached; "a chat app serving yesterday's messages out of a cache
is worse than one that admits it is offline"; and "Offline message
composition / outbox" was listed under **Not built** until #481 shipped the
compose half. Layer 2 asks to walk back part of that stance - cache enough
to open something, not nothing - which is a product call as much as an
engineering one, flagged here rather than assumed.

**A2.1 - IndexedDB read-only cache: last ~50 messages per open channel, the
channel/server list, own profile.** Written on every successful WS message or
fetch; read on boot before the API answers. New module (e.g.
`client/src/lib/offline-cache.ts`). Must ship with a persistent "offline ·
synced Xm ago" indicator so cached content never reads as live - the exact
failure mode `docs/PWA.md` was written to avoid.

**A2.2 - Boot from cache on a failed or timed-out initial fetch.** Tie into
`App.tsx`'s existing reconnect bootstrap (already jittered by
`feat/reconnect-jitter`): render from A2.1's cache immediately instead of a
spinner, then swap to live data once the socket reaches `"online"`.

**A2.3 - Extend the outbox (#481) past "reload during a blip."** Today it
replays "on the first ready socket after a reconnect or a reload." Confirm it
also replays correctly after a real multi-hour outage, and extend it to a
draft composed while the app opened entirely from A2.2's cache with no socket
ever established yet - a case #481 did not need to handle because the app
could not previously open offline at all.

**A2.4 - An "offline mode" banner distinct from "reconectando."**
`realtime.ts`'s `RealtimeStatus` already has `"reconnecting"`; add a
longer-threshold state (reconnecting past ~30s, or `navigator.onLine ===
false`) that swaps the copy to "modo offline" and stops implying a send is
about to go through, while still queuing it locally via A2.3.

**A2.5 - What must never be cached.** Clerk JWTs, the HLS `?t=` viewer token
(`hls-viewer-token.ts`), any presigned URL, and DM message content/previews -
none of A2.1-A2.4 should touch anything more sensitive than message bodies
and names already visible in the open channel. Audit that nothing new writes
a token into `localStorage`/IndexedDB beyond what Clerk's own SDK already
manages, which this plan does not touch.

Acceptance: airplane mode, open the app - server list and the last-open
channel's recent messages render within ~1s from cache, a visible offline
banner, composing a message queues it silently, reconnecting flushes it in
order. Client-only; no infra cost. Effort ~3-4 agent-days, and A2.1 is the
one item here that should get a product sign-off before it starts, since it
reverses a documented decision.

## 5. The database

### Why Friday happened

`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` item A2: roughly 330 tx/s
against a **shared-CPU** Fly Postgres node with 276 clients and 60 seated
voice participants churning state writes, at 23:23 the node died under it,
the pool (70) queued 79 requests, `/ready` (or its precursor) went 503,
routing stopped, and every dropped client's reconnect made the write rate
worse on the way back up - a reconnect storm compounding a write-rate
collapse.

**Already done:** a dedicated (not shared-CPU) node - production is now
Vultr Managed PostgreSQL, 2 dedicated vCPU / 4 GB, single node, daily backups
(the interim Fly move to `pqp-db-4` Launch was the bridge, per the
postmortem's §F). A2's write-budget work (batching seat writes/heartbeats,
caching roster membership checks, coalescing presence broadcasts) - partially
landed via the roster-access cache in `ws/voice.ts` (#534) that
`perf/read-cache`'s own header comment cites as its template. And
`perf/read-cache` itself: an uncommitted worktree (`server/src/lib/
read-cache.ts`, not yet a PR) implementing exactly RELOAD_STORM.md's step 3 -
a short-TTL (2s), stale-while-revalidate, in-flight-coalescing cache in front
of the specific queries a reconnect burst repeats identically across many
callers (latest message page, channel list, watch-party state), rollback via
`READ_CACHE=off`. **Not yet done:** everything below.

**A3.1 - Decouple routing health from DB health.** Today `server/src/index.ts`'s
`/health` handler runs `healthVerdict(() => getPool().query("SELECT 1"))` -
`fly.toml`'s own comment says the quiet part out loud: "a 200 here means
process up AND database reachable. That is what gates a deploy." With one
process that coupling is merely wasteful; with Layer 0's two processes
sharing one DB, it is actively harmful - a Postgres blip fails **every**
box's check at once, and a load balancer with nowhere healthy to route to is
no better than one machine. The fix: make `/health` check only that the
process is alive and its event loop is responsive, nothing that touches
Postgres - the DB check already lives at `/ready` (`services/ready.ts`) and
does not need duplicating. Point `fly.toml`'s check, the Vultr LB's check and
Caddy's (A0.2/A0.3) all at this shallow `/health`. Separately, each
DB-touching HTTP route (or a shared error-handling layer in
`server/src/api/index.ts`) must catch a pool-exhaustion or query-timeout
error and answer `503` with `Retry-After` rather than hanging or 500ing,
while: the WS transport itself stays open (a chat send can 503/queue via
#481's outbox without the socket closing), the HLS playlist proxy keeps
answering from its 1s `playlistCache`/`LiveWindowHistory` until its own
session-liveness query fails, and `perf/read-cache`'s stale-while-revalidate
naturally rides out a blip shorter than its TTL. **The tension to resolve,
not skip:** a shallow `/health` also stops gating *deploy safety* - a broken
release that can never reach Postgres at all would now report healthy
instantly. Keep that guarantee by having the deploy workflow's own
post-deploy verification additionally curl `/ready` (which is unaffected by
this change) before declaring the release done, so routing health and deploy
safety are checked by two different endpoints instead of one overloaded one.

**A3.2 - PgBouncer in transaction mode on the API box(es).** Raises the
effective connection ceiling by multiplexing many short queries onto fewer
real Postgres backends, so a burst queues inside PgBouncer instead of hitting
`FATAL: too many connections` (the failure mode `docs/DB_RUNBOOK.md` §3
describes). The one documented trap: `CLUSTER_BUS`'s `LISTEN`/`NOTIFY`
connection needs **session mode**, and a transaction-mode pooler silently
never delivers to it - already flagged as a named risk in
`MULTI_INSTANCE_VOICE.md` §9, mitigated there by the boot self-echo check
(`voice.hello`). So: the app's query pool goes through PgBouncer
(`DATABASE_URL`), the bus's dedicated client gets a second, direct connection
string that bypasses the pooler entirely, and the self-echo check stays on to
catch a misconfiguration loudly rather than silently. Re-derive
`PG_POOL_MAX` from `docs/DB_RUNBOOK.md` §3 once PgBouncer is in place - the
variable now sizes the app's pool against PgBouncer, not against Postgres
directly, which changes what number is safe.

**A3.3 - The A3 load test on staging, with the real shape.** Run
`tools/watch-party-load` (the seat-churn rig `docs/HANDOVER.md`'s new event
runbook references) against staging pointed at a Postgres tier matching
production's actual plan: 60-100 seated churning state, 300 watchers, 5
joins/min, sustained 30 minutes. Gate on pool-queue depth and p99 query time,
not pass/fail - the point is finding the ceiling of the 2 vCPU plan and the
concrete trigger (a specific queued-connections or p99 number) for upgrading,
not proving today's tier is fine in the abstract.

**A3.4 - Alerts: pool queued > 20 for 30s, `select 1` > 50ms, readiness
false.** `services/ready.ts`'s pool check already has *a* threshold (`queued
> 0` for 10s, or `inUse == max` for 30s) but not this one, and nothing today
logs a periodic pool/latency sample the way `voice.seats` is logged hourly
(`docs/MONITORING.md`). Add a `db.poolSample` log line every ~10s (piggyback
on the existing `refreshSlowProbes` cadence) carrying `queued`, `inUse`,
`max` and the last `SELECT 1` latency, then two new Grafana alert rules in
the existing `pqp-api-logs` group, same shape as its "Connection terminated >
5 in 5m" rule. "Readiness false" is already covered at the 10-minute
GitHub Actions cadence (`monitor-uptime.yml`'s `api-health` check, and
`/ready` is what an external monitor should point at per `docs/MONITORING.md`)
- the gap these two new rules close is the faster, minute-level warning
*before* readiness actually flips.

**A3.5 - Vultr HA with a standby replica.** Pricing: could not be fetched
live (Vultr's pricing page returned 403 to an automated fetch) - quote it
from the Vultr dashboard at decision time rather than trusting a number typed
into this doc. **Restore-from-backup RTO today is roughly 10 minutes** per
the current nightly-backup recipe (`docs/DB_RUNBOOK.md` §1's dump is
seconds - the postmortem's §F notes an 8 MB, 3s dump - and a restore onto a
fresh instance is the slow part). One caveat: `docs/DB_RUNBOOK.md`'s detailed
step-by-step in §2 still describes the **Fly MPG** PITR procedure
(`fly mpg restore`, `fly mpg attach`), written before the Vultr move: it
needs a Vultr-native rewrite before that 10-minute figure is a rehearsed
number rather than an estimate - itself already flagged as postmortem item
A5 ("update docs/DB_RUNBOOK.md with the ... new-cluster-copy recipes").

## 6. Order of work

Dependencies first, then rough effort:

1. **A0.1** (staging rehearsal) - already running; nothing here blocks on
   waiting for it idle, but A0.3 should not be trusted until it reports back.
2. **A3.1** (decouple `/health` from DB) - do this *before* A0.3, not after:
   a load balancer over a DB-coupled health check buys nothing in exactly the
   incident this plan exists to prevent. 1 day.
3. **A1.1** (merge #559 as shipped) - no dependencies, cuts real load today.
   Already built; ship it.
4. **feat/reconnect-jitter** (#558) - no dependencies, and both Layer 0's
   acceptance test and Layer 2's boot path lean on it already existing.
   Already built; ship it.
5. **perf/read-cache** - no dependencies, finish and open the PR. ~0.5 day
   to commit and test what is already written.
6. **A0.2** (two containers, one box) - depends on A3.1 for the health-check
   split to matter, though it can be built in parallel. 1 day.
7. **A0.3** (second box + LB) - depends on A0.1 passing and A0.2 being
   stable. 1-1.5 days + the $58/mo.
8. **A1.2-A1.4** (Worker reads R2 directly) - depends on A1.1 merged.
   ~2-3 days; A1.2 and A1.3 can run in parallel, A1.4 depends on both.
9. **A1.5** (party-lifetime tokens) - depends on A1.4; spec it before
   building. ~1 day to spec, 1-2 to build.
10. **A2.1-A2.5** (offline app shell) - independent of everything else here;
    needs a product decision on A2.1 before starting. ~3-4 days.
11. **A3.2** (PgBouncer) - independent, but sequence after A3.1 so the two
    health/connection changes are not debugged at once. 1-1.5 days.
12. **A3.3** (load test) - depends on A3.2 landing, to test the tier the
    product will actually run on. 1 day + a rehearsal window.
13. **A3.4** (alerts) - independent, small, do any time. 0.5 day.
14. **A3.5** (HA pricing + DB_RUNBOOK rewrite) - independent, mostly a
    pricing lookup and a documentation pass once A3.3 has established the
    right tier to price HA against. 0.5-1 day.

Total: roughly 15-19 agent-days across everything in this document, not
counting soak time between steps (the same "calendar, not typing" caveat
`MULTI_INSTANCE_VOICE.md` makes about its own milestones).

**Deliberately not done:** multi-region (the userbase is Brazilian and
`docs/deploy-fly.md`/`docs/deploy-vultr.md` both keep everything in `gru` on
purpose - cross-region Postgres would undo the latency win voice and chat
depend on) and a second Postgres provider (one managed Postgres, backed up
nightly to R2, is the whole database story; running two live providers is a
sync problem this project has no need to take on for a downtime budget
measured in minutes, not nines).
