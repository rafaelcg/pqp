# Cold paths: what runs inside the API process, and what moved to the worker

`pqp-api` is one `shared-cpu-1x` machine in `gru`. Its job is voice signalling
and chat fan-out, both latency-sensitive, both in-process. Everything periodic
or batch that also ran there competed for the same CPU. This is the inventory
of those jobs as of 2026-09-06, where each one runs now, and why.

The mechanism is `WORKER_MODE` (`server/src/lib/process-role.ts`) and the
`jobs.ts` module. Deploy wiring: `fly.worker.toml`, `deploy-api-fly.yml`,
`docs/deploy-fly.md` ("Worker").

## The rule

A job moves to the worker when it needs nothing this process owns: no
WebSocket, no in-process Map, no request that started it. A job stays when it
reads or writes state that exists only where the sockets are, or when it is
not a job at all but a request path that merely looks expensive.

## Inventory

| Job | Cadence | Work per tick | Needs in-process state? | Where it runs now | Decision |
|---|---|---|---|---|---|
| Attachment orphan sweep (`sweepOrphanedAttachments`) | hourly + boot | SELECT with LIMIT, then one S3 `DeleteObject` per orphan | No (DB + bucket) | `jobs.ts` | **Moved** |
| Quarantine expiry (`sweepQuarantinedAttachments`) | hourly + boot, same timer | one DELETE | No | `jobs.ts` | **Moved** |
| Audit log prune | daily | one DELETE | No | `jobs.ts` | **Moved** |
| Resolved-report prune (privacy sweep) | daily | one DELETE | No | `jobs.ts` | **Moved** |
| Expired-timeout prune | daily | one DELETE; nothing depends on it (reads filter on `expires_at`) | No | `jobs.ts` | **Moved** |
| Message retention sweep | daily | DELETE per server with a retention window; can be the largest single query the process runs | No; deliberately no broadcast | `jobs.ts` | **Moved** |
| Connection OAuth state sweep | daily | one DELETE | No | `jobs.ts` | **Moved** |
| Interrupted account deletions (`sweepPendingAccountDeletions`) | 5 min | Clerk API call + local DELETE per pending row (normally zero rows) | No, but needs `CLERK_SECRET_KEY` | `jobs.ts` | **Moved** |
| Community Home media orphan sweep | 30 s | SELECT with LIMIT, S3 delete per orphan | No | `jobs.ts` | **Moved** (split off the schedule publish below) |
| Outgoing webhook outbox tick (`deliverDueOutgoingWebhooks`) | 2 s | `FOR UPDATE SKIP LOCKED` claim, then outbound HTTP POSTs with signing | No; the in-memory token bucket is per process and fine to be per worker | `jobs.ts` | **Moved**. The API still fires the first attempt from enqueue, which is a direct call on the request path, not a timer; the worker owns retries and reclaim |
| Delivered-webhook receipt prune | hourly | one DELETE | No | `jobs.ts` | **Moved** |
| Voice occupancy sampler (`recordVoiceOccupancySample`) + daily rollup/prune | 1 min / daily | one SELECT over `voice_rooms`+`voice_peers`, two upserts | **Only with `VOICE_REGISTRY` off**: it then falls back to the in-process peer map, which is exact in the single process that both holds sockets and runs these jobs. With the registry on it reads the cluster and needs nothing local | `jobs.ts` | **Here from the start**. A dedicated worker with the registry off records nothing rather than zeros, because an empty local map there means "cannot see", not "nobody is talking" |
| Community Home schedule publish (`publishDueCommunityHomePosts`) | 30 s + boot | one UPDATE, then a WS nudge per affected server | **Yes**: `notifyCommunityHomeUpdate` is a socket push | `index.ts` | **Stays**. Moves when the cluster bus (`CLUSTER_BUS=postgres`) is on by default, so the nudge can travel over the bus |
| Status sampler (`recordStatusSamples`) + 30-day prune | 1 min / daily | `SELECT 1`, one S3 `HEAD`, two config reads, one INSERT | **Semantically yes**: the `api` probe is "this process answered" | `index.ts` | **Stays**. Negligible CPU, and a worker sampling it would record the API as up while the API is down. If it ever moves, the `api` probe must become a real `GET /health` against the API's URL |
| WS heartbeat (ping/pong, reap dead sockets) | 30 s | walks `wss.clients` | **Yes** | `index.ts` | **Stays**, obviously |
| Rate-limit / auth-cache / channel-audience sweeps | 1 min | shrink three in-process Maps | **Yes** | `index.ts` | **Stays** |
| LiveKit eviction re-sweeps (`voice/admin.ts`) | 5 s for one token TTL after each eviction | `listParticipants` + `removeParticipant` per stale token | **Yes**: keyed timers created by the eviction request, using the pre-eviction roster | `voice/admin.ts` | **Stays** until `docs/plans/MULTI_INSTANCE_VOICE.md` (not yet written) moves evictions to a claims table the worker can poll |
| Cluster presence / status re-announce (`CLUSTER_BUS=postgres` only) | periodic | bus writes | **Yes** | `ws/index.ts` | **Stays** |
| Bus spill-table sweep (`lib/bus-postgres.ts`) | periodic, bus on only | one DELETE | Tied to the bus lifecycle | `lib/bus-postgres.ts` | **Stays** with the bus |

### Not jobs, listed because the brief asked

| Path | What it is | Where | Decision |
|---|---|---|---|
| Content scanning of uploads (`content-scan.ts`) | Runs **inline** in the attachment claim (`scanImage` before the claim transaction) and in Discord import. Request path, not a timer | API | **Stays** for now. Moving it means a `scan_pending` state, a worker poll and a client that tolerates "attached, not yet visible". Worth doing if scanning shows up in request latency; it is one outbound HTTP call today |
| LGPD account export / server export (`export.ts`) | Built **on request** (`buildServerExport`, `exportAttachments`), streamed back in the same response | API | **Stays** for now. The proper move is an export table plus a worker that writes the archive to the bucket and the API hands out a presigned URL. Do it when an export is measured to hurt; a solo-hobby instance exports a handful a year |
| Admin metrics aggregation (`metrics.ts`) | ~32 count queries behind a 30 s cache, computed **on request** by the dashboard poll, plus a live `runtime` block that must come from the API process (pool saturation, socket count) | API | **Stays**. The `runtime` half cannot move. If the count half ever hurts, the worker can write the cached payload to a table every 30 s and the API can read it, but at ~1 request per 30 s it is not a CPU story |
| Dev seed (`seedDevHall`) | Boot-time, `DEV_AUTH_BYPASS` only | API | Stays; never in production |
| Schema migration (`initDb`) | Boot-time `schema.sql` | API only | Stays on the API. The worker does **not** run it, and deploys after the API in CI, so it never sees a schema older than its code |

### Already elsewhere

| Process | Where it runs | Notes |
|---|---|---|
| Ambient runner (`tools/ambient`) | Its own Fly app, `pqp-ambient` (`shared-cpu-1x`, 512 MB, `gru`, 1 GB volume) | Talks to the API over HTTP + WS like a client. Runbook: `docs/ambient-deploy.md`. Nothing to move |
| Support bot (`tools/support-bot`) | Not deployed anywhere yet (its README says so). Designed to run as a client process like the ambient runner | Nothing to move; when it ships it gets its own machine or shares `pqp-ambient`, never the API |
| Operator dashboard (`tools/admin-dashboard`) | Cloudflare Worker `pqp-admin` | Polls `GET /api/admin/metrics`; see above |

## Mode switch design

One image, one variable, three answers:

| `WORKER_MODE` | Listeners | Cold jobs (`jobs.ts`) | Who sets it |
|---|---|---|---|
| unset / `all` | `/api`, `/ws`, static, `/health`, `/up`, `/status.json` | yes | nobody: local dev, self-hosters, today's production |
| `api` | same as above | **no** | `pqp-api`, once `pqp-worker` exists |
| `worker` (`1` accepted) | `/health` only, 404 for everything else | yes | `pqp-worker` (also implied by its `node server/dist/worker.js` process command) |

An unknown value logs a warning and behaves as `all`: a typo must cost extra
work, never silence.

The API never learns whether a worker exists; the operator tells it with
`WORKER_MODE=api`. That is the "exactly one place" guard, and it is only a
guard if the flip happens after the worker is up. The order is written in
`fly.worker.toml` and in `docs/deploy-fly.md`. If it is done backwards the
sweeps stop everywhere, which the status page will not show, so the runbook
makes the flip the last step.

An overlap (both running the jobs, between steps 2 and 3 of the runbook) is
safe: every job claims its rows in SQL (grace windows, `SKIP LOCKED`,
`expires_at` filters), so two runners do duplicate work, not wrong work.

## What the worker needs

Secrets shared with `pqp-api`, by name (values never in git):
`DATABASE_URL` (the same Fly Postgres, over 6PN), `CLERK_SECRET_KEY` (the
pending-deletion sweep deletes the Clerk user first), `S3_*` (attachment and
Community Home media sweeps; skipped when unset), `VOICE_REGISTRY` **whenever
`pqp-api` has it**, and `DATABASE_SSL` if the API has it. It does not need
TURN, LiveKit, Clerk authorized parties, CORS, provider keys or
`ADMIN_METRICS_TOKEN`.

`VOICE_REGISTRY` is the one that does not announce itself. The occupancy
sampler is the only job here that reads live state, and the worker holds no
sockets, so `voice_peers` is the only place it can read from. Without the flag
it records nothing at all rather than a row of zeros, and says so once an hour
as `voice.occupancy.blind`. Nothing else on the worker changes: `worker.ts`
never calls `startVoiceRegistry`, so the flag buys the sampler its read and no
heartbeat, no reconcile and no writes.

**The worker does not redeploy with the API.** CI skips it when
`FLY_API_TOKEN_WORKER` is unset, and a merged cold job then sits on `main`
looking shipped while `pqp-worker` runs whatever image it was last given.
Check before believing a job is live:

```bash
fly status --app pqp-worker | grep Image     # against api.pqp.gg/health
sha=$(curl -fsS https://api.pqp.gg/health | jq -r .version)
fly deploy --config fly.worker.toml --app pqp-worker \
  --image "registry.fly.io/pqp-api:$sha" --ha=false --yes
```

Sized `shared-cpu-1x`, 512 MB, `PG_POOL_MAX=4`, no public service, one
machine. Its `/health` is reachable over the private network for the Fly
check and reports `"role":"worker"` plus the deployed commit.

## Later

1. `docs/plans/MULTI_INSTANCE_VOICE.md`: an eviction claims table so the
   LiveKit re-sweeps can leave the request that created them.
2. Community Home publish over the bus once `CLUSTER_BUS` is the default.
3. Exports to a table + bucket + presigned URL, then to the worker.
4. Content scanning as a queued state, if it ever shows in p95.
