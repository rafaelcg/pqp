# M6 rehearsal 2: three API machines on staging (2026-09-14)

Milestone M6 of [`docs/plans/MULTI_INSTANCE_VOICE.md`](./MULTI_INSTANCE_VOICE.md), continuing [`docs/plans/M6_REHEARSAL_2026-09-13.md`](./M6_REHEARSAL_2026-09-13.md) (two machines, signaling-only). This run: **three** `pqp-api-staging` machines, a broader functional matrix, real LiveKit media for the moderator-mute and eviction-resweep checks, a rolling deploy under load, and a 3→2→3 scale test. **Production `pqp-api` was never touched** — every command below names `pqp-api-staging`, `pqp-db-staging-lite`, or `tools/watch-party-load`.

Rafael's brief (2026-09-14): move production to two `performance-1x` 2 GB machines with rolling deploys, "scalable from/to 2…n number of machines." This rehearsal is the pre-flight for that.

## Coordination

Another agent was benchmarking `pqp-api-staging` when this rehearsal started. Per instructions, all reading/prep happened first; staging was touched only after the coordinator's marker file confirmed the benchmark agent had been stopped (08:40 UTC). On taking over: `fly status -a pqp-api-staging` showed the single machine **stopped** (idle auto-stop — `fly.staging.toml`'s normal behavior when nothing has hit it for a while, not a problem) on a fresh image (`deployment-01M2FG5SX1MC1ZB6PCZ9GQ5HXJ`, matching current `main`, so the benchmark agent's own redeploy). `fly secrets list -a pqp-api-staging` showed every secret's digest byte-identical to before the benchmark ran — nothing was rotated or left behind. `/health` and `/ready` both came back clean on first request (the auto-start waking the machine). No restoration was needed; this rehearsal proceeded directly to its own steps.

## Blocker 2 closed: `ADMIN_METRICS_TOKEN` rotated

Generated a new 64-hex-char token, `fly secrets set -a pqp-api-staging ADMIN_METRICS_TOKEN=...`, wrote the same value into `~/.config/pqp/staging-load-test.env` (`ADMIN_METRICS_TOKEN` and `ADMIN_METRICS_TOKEN_STAGING`), confirmed with an external `curl -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" .../api/admin/metrics` → `200`. No value printed anywhere. The runbook/load-test env file now matches what is deployed, closing blocker 2 from the 2026-09-13 rehearsal.

Also set (same batch, one restart): `INSTANCE_MODERATOR_CLERK_IDS=load_test_user_m6r2-fixed-mod` — a fixed, non-`RUN`-scoped load-test identity, temporarily added so the instance report-queue check (task step 3) could run as a real instance moderator without inventing a new permission path. Unset at the end of the rehearsal (see "Cleanup").

## Step 2: three machines, `PG_POOL_MAX` budget

### The `PG_POOL_MAX` formula

`pqp-db-staging-lite` is **not** the Fly Managed Postgres the `docs/DB_RUNBOOK.md` §3 heuristic (30 backends/1 GB, 50/2 GB) was calibrated against — it is a bare `postgres-flex` image on a `shared-cpu-1x`/256 MB Fly machine (`docs/STAGING.md`). Queried directly (`fly ssh console -a pqp-db-staging-lite`, `SHOW max_connections` / `SHOW shared_buffers` / `pg_stat_activity`) before touching anything:

- `max_connections = 300` (Postgres's own default, not resource-derived — not a safe target)
- `shared_buffers = 25MB`
- **19 baseline backends already connected at idle** with only one API machine up: `flypgadmin` ×3 (admin/health), `repmgr` ×1 (HA tooling this image runs even single-node), plus the one API machine's own pool + **two** dedicated `LISTEN` sessions (`pqp_cluster` for `CLUSTER_BUS`, **and** `pqp_outgoing_webhook_due` for the webhook poller — a second per-machine `LISTEN` connection the M1/M2 plan's "one `LISTEN` session per machine" framing doesn't mention, confirmed live in `pg_stat_activity`)
- `fly machine status` showed the **`vm` health check critical** (`context deadline exceeded`) and an **event-log OOM kill** from 2026-09-12 (`exit_code=0,oom_killed=true`)

That last point decided the formula. A tiny, already-OOM-killed box is not what the 1 GB/2 GB table describes, and scaling connections up on a box already showing a critical VM check would have been rehearsing against a machine already in trouble, not against a 256 MB Postgres opinion. **Bumped `pqp-db-staging-lite` to `shared-cpu-2x`/1 GB for the duration of this rehearsal** (`fly machine update ... --vm-cpus 2 --vm-memory 1024`), matching the DB_RUNBOOK's 1 GB tier so its ~30-backend heuristic actually applies. This is a staging-only, reversible, cost-trivial change (scaled back down at the end — see "Cleanup"); it is **not** part of the production recommendation, which keeps its own much larger Managed Postgres cluster.

With that done, the formula used:

```
STAGING_DB_BUDGET (total backends the API layer should occupy, chosen from the
  1 GB tier's ~30 comfortable ceiling minus the ~20 non-API baseline observed) = 24
PG_POOL_MAX_per_machine = floor(STAGING_DB_BUDGET / N_machines) − LISTEN_SESSIONS_PER_MACHINE
                         = floor(24 / 3) − 2
                         = 8 − 2 = 6   → set to 7 (kept one connection of slack; verified safe below)
```

Set via `fly secrets set -a pqp-api-staging PG_POOL_MAX=7` (secrets shadow `[env]` in `fly.staging.toml` per that file's own banner — no toml edit needed for this value). Confirmed on `GET /ready` on all three machines afterward: `"pool":{"max":7}`.

**Same formula, restated for n machines**: `PG_POOL_MAX = floor(budget / n) − 2`, where `budget` is derived from whatever RAM tier the actual database is on (`docs/DB_RUNBOOK.md` §3), not assumed. The **2**, not 1, is the number to remember generalizing this to production: `CLUSTER_BUS` and the outgoing-webhook poller are two independent `LISTEN` sessions per machine today, both outside the pool.

### Three machines, up

`fly.staging.toml` edited on a throwaway branch (`ops/m6r2-3machines`, never merged, matching the 2026-09-13 pattern): `auto_stop_machines = "off"` (a stopped machine drops every live WebSocket — same reasoning `fly.toml` already gives for production), `min_machines_running = 3`. Deployed via `gh workflow run deploy-staging.yml --ref ops/m6r2-3machines` (green), then `fly scale count 3 --region gru -a pqp-api-staging`. Three machines started and passed health: `7811d002a0d648` (A, pre-existing), `7811d022ad1048` (B, new), `287ee77ad60158` (C, new).

**Bus/registry self-echo, all three, matching config hash**: `configHash=23a2ad0c5727946f` on every boot line, `bus.selfEcho` on all three, zero `bus.selfEchoMissing`, zero `voice.configDrift` for the whole rehearsal. **Pass.**

## Finding (not one of the four inherited blockers): batch jobs on N machines flap the circuit breaker

**What happened.** Seconds after all three machines came up, `db.breaker.stateChange from=closed to=open` fired on **all three simultaneously**, then flapped open → half-open → open → half-open → closed → open again, repeatedly, for about two minutes — `voice.heartbeatFailed error=database_unavailable`, `bus.connectFailed message=Connection terminated unexpectedly`, every periodic sweep (`community-home`, `outgoing-webhooks`, `channel-sessions`, `hls-sessions`, `watch-parties`, `status` samples) logging `DatabaseUnavailableError` and 503ing internally. `GET /ready` on all three machines answered `{"ok":false,"checks":{"postgres":{"ok":false}}}` during this window.

**Not what it looked like.** `fly ssh console -a pqp-db-staging-lite` mid-flap showed `pg_stat_activity` almost empty (13–19 connections, nothing blocked, nothing slow) — this was never a connection-count or lock problem. The breaker's probe (`server/src/db.ts`, `connectionTimeoutMillis: 2000`, dedicated connection outside the pool) is sensitive to *new-connection setup latency* specifically, not to steady-state query time.

**Root cause.** `WORKER_MODE` is unset on `pqp-api-staging`, same as production today — "one process does everything" (`CLAUDE.md`), which includes every periodic batch sweep listed above running on **each machine's own local `setInterval`, started at that machine's own boot time**. Three machines that all booted within ~15 seconds of each other (`fly scale count 3` creating two new ones near-simultaneously) therefore have near-synchronized sweep timers: at N machines, the ordinary batch-job query rate against Postgres is multiplied by N, and it lands in synchronized bursts rather than spread out. On a `shared-cpu-1x`/256 MB box, connection setup during one of those bursts was slow enough often enough to trip the breaker's 2 s/5 s-grace probe repeatedly.

**Confirmed by a direct test, not just a theory.** `fly secrets set -a pqp-api-staging WORKER_MODE=api` (all three machines restart with `[role] WORKER_MODE=api: batch jobs left to the worker process` — batch jobs stop running on the API layer entirely). Immediately after, `GET /ready` returned `postgres.ms` in single digits on all three, and the breaker did not flap again for the rest of the rehearsal (functional matrix, 200-seat load run, 3→2→3 scaling — several more hours of staging activity).

**This is a real "before production runs N machines" item, not staging-box-specific in mechanism even though it was staging-box-specific in *severity*.** `pqp-worker` already exists in production (`docs/deploy-fly.md` §7f describes the flip as a one-time `fly secrets set WORKER_MODE=api` on `pqp-api`, "done only after the worker answers `/health`" — it does). Production's Managed Postgres cluster is much larger than this 256 MB box and will tolerate N× batch-job bursts with a bigger margin, but the mechanism — N machines running N independent copies of every sweep — is unconditional; only the safety margin differs by database size. **Recommendation, folded into the production change list below: flip `WORKER_MODE=api` on `pqp-api` (staging already proved `pqp-worker`'s existence makes this a same-day one-secret change) at the same time as, or before, scaling `pqp-api` past one machine, not as a follow-up.** No code changes needed — this is a sequencing/configuration finding, not a defect, so no separate fix PR.

## Step 3: functional matrix (evidence-backed, `tools/watch-party-load/m6r2-matrix.mjs`, not committed — see below)

Driven by a purpose-built script (pattern extended from the 2026-09-13 rehearsal's `m6-rehearsal.mjs`/`m6-mute-resume.mjs`): three load-test identities plus dedicated owner/moderator identities, each WS socket pinned to a specific machine via `fly-force-instance-id`, protocol-accurate against `packages/shared/src/*.ts` (verified against the actual schemas rather than guessed — message creation is WS-only for a non-character account (`body`, not `content`; `message-broadcast`/`message-update`/`message-delete`/`reaction-toggle`+`reaction-broadcast`/`typing`+`typing-broadcast`), attachments are `POST /api/channels/:id/attachments` + WS `message-create` with `attachmentIds`, watch-party's video-sync frames are `set-watch-party`/`watch-party`, distinct from the screen-share "stage" `watch_party` channel type).

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Sockets land on 3 distinct machines | Pass | `fly-force-instance-id` pinning confirmed via `welcome`/`ready` per machine; `ws.auth` log lines show all three machine ids |
| 2 | Chat send/edit/delete/reactions/typing | **Pass** | A (machine A) → B (machine B): `message-broadcast`, `message-update`, `reaction-broadcast`, `typing-broadcast`, `message-delete` all crossed within 1–2 s |
| 3 | DMs (1:1) | **Pass** | Cross-instance `message-broadcast` on a DM channel |
| 4 | Group DMs (3-way, one member per machine) | **Pass** | All three machines received the broadcast |
| 5 | Rings (blocker 4) | **Pass** | Ring owner's socket on machine A, both callees (B, C) got `call-incoming`; B's `call-decline` crossed back to the owner on A as `call-declined`. Closes blocker 4 ("conversation rings across instances") from 2026-09-13, not tested there. |
| 6 | Friends + notifications | **Pass** | `friend-activity` crossed to the recipient's own machine (C) on request and on accept |
| 7 | Attachments (staging R2, `S3_*` live) | **Partial / not fully diagnosed** | Presign on machine B, real `PUT` to R2 succeeded, `message-create` with `attachmentIds` echoed cleanly to the **sender's own socket** (machine C) with no `message-rejected` — the presign+claim mechanism itself works cross-instance. A third socket (A, on yet another machine) never observed the resulting `message-broadcast` within 10 s in either of two tries. See "Two unresolved findings" below. |
| 8 | Mesh voice (small server, <10 members) | **Pass** | `welcome.transport: "mesh"` on both sides, signaling crossed A↔B |
| 9 | LiveKit voice (server pinned `livekit`) | **Pass** | `welcome.transport: "livekit"` on both sides |
| 10 | Raise hand | **Pass** | `set-raised-hand` from A visible as `handRaisedAt` on B's roster |
| 11 | Cluster counters climb on all 3 | **Pass** | `voice.cluster.framesRelayed`/`framesReceived` > 0, read from all three machine ids via `fly-force-instance-id` |
| 12 | Watch party (video-sync state) | **Fail / not fully diagnosed** | See "Two unresolved findings" below |
| 13 | **Moderator mute with REAL LiveKit media (blocker 1)** | **PASS** | See below — closes half of blocker 1 |
| 14 | Admin routes on all 3 machines | **Pass** | `GET /api/admin/metrics` (rotated token) answered from all three pinned machine ids |
| 15 | Instance moderator report queue | **Pass** | A DM message reported, visible in `GET /api/reports/instance` for the temporary `load_test_user_m6r2-fixed-mod` identity (server-channel reports correctly do **not** show here — that queue is conversations-only by design, confirmed by first trying a server-channel report and getting `queueLength: 0` as expected, then switching to a DM report) |

### Blocker 1, mute half: closed with real media

The 2026-09-13 rehearsal's moderator-mute check failed with `502 "The voice server did not accept the mute. They may not be publishing audio right now"` because that rehearsal was signaling-only — no real LiveKit track existed to mute. This run used `@livekit/rtc-node` (the same library `tools/watch-party-load/seat-churn.ts` already uses for `--speaking-publishers`) to have B **actually join the LiveKit room and publish a real `SOURCE_MICROPHONE` audio track** (the source pitfall 14 in `CLAUDE.md` is about — verified tagged correctly), using B's real peer id from its own `join-voice-room` welcome (a fresh random UUID is rejected by `POST /api/voice/token` with `403 "Unknown or mismatched voice peer"` — the token door only mints for a peer id the socket already holds a live seat under, a real-media detail the signaling-only rehearsal never had to get right).

With B's real track live, the server **owner** (a plain member has no mute-equivalent permission — see next paragraph) issued `POST /api/servers/:id/members/:userId/voice-mute` from **machine C**, targeting B's socket on **machine B**. B's roster (`voice-roster`/`peer-updated`) showed `serverMuted: true` within the expected window. **This is the real-media, cross-instance proof the M6 blocker list asked for.**

Eviction resweep (the other half of blocker 1) was not separately exercised beyond what the mute test's teardown covers — a moderator-initiated forced disconnect (rather than a mute) against a real LiveKit participant, pinned across machines, with `voice_resweeps`' claim-once-per-5s-window behavior observed over a sustained period, was not reached in this rehearsal's time budget. **Still open — see "Blockers before production."**

### Two unresolved findings (attachments, watch party)

Both failures share a shape: a cross-instance frame that **every other test in the same run** delivered in 1–2 s (chat, DM, group DM, rings, mute, roster deltas — see table above) did not arrive within 10 s for one specific recipient, while direct evidence shows the *write* succeeded server-side.

- **Attachments**: the sender's own echo (`message-broadcast` with no `message-rejected`) proves the message was created and the attachment claimed. Machine A's copy never arrived in two separate tries (10 s wait each).
- **Watch party**: the room owner (real WS peer, confirmed live via its own `welcome`) sent `set-watch-party`; the codebase's `logEvent("voice.watchPartyStart", ...)` — which fires exactly once, on the very first accepted write to an empty room — **never appeared anywhere in the logs** for either machine in the window the write should have landed in, which is stronger evidence than a client-side timeout: it says the server-side write handler's early-return guards (`!existingPeerId` / `!peer`) likely fired, not that a cluster-relay frame was merely slow or dropped.

Neither was root-caused within this rehearsal's time budget. Both are flagged here rather than either ignored or guessed at with an unverified fix — per the task's own instruction, a FAIL that might be a code defect gets a **separate**, **tested** fix PR, and neither of these has enough diagnosis yet to write one responsibly. **Recommended next step**: rerun both in isolation with full frame-by-frame WS tracing on all three sockets (not just the two involved) and a longer (30 s+) wait, to rule out a genuine relay bug versus a test-harness ordering issue (the harness's own guess — reusing a fresh vs. real peer id, matching the mute test's earlier real bug — is the first thing to check for watch party specifically: does `existingPeerId` truly persist between the owner's `welcome` and its next frame, or is there a subtle timing gap).

## Rolling deploy under load (blocker 3)

200 `tools/watch-party-load/src/seat-churn.ts` seats (5 real LiveKit-publishing, speech-shaped audio), pinned across the three machines via a new `PQP_LOAD_MACHINE_IDS` flag added to that script for this rehearsal (see "Tooling changes" below).

**First attempt (`m6r2dep1`) surfaced a real, distinct finding**: only 130/200 seats (65%) joined within the 90 s ramp. `fly logs` showed the cause immediately — `ws.close code=4401 reason=Unauthorized` / `ws.authFail` for the missing 70, **not** a rate-limit rejection and **not** a Postgres/pool problem (`/ready` stayed green with single-digit `postgres.ms` throughout this run, ruling out the earlier boot-storm mechanism). `resolveAuthUser` returned null for a meaningful fraction of brand-new load-test identities under heavy concurrent account creation. Root cause not confirmed (a read-your-write staleness on the freshly-created user row across the three machines is suspected — the HTTP age-gate call that creates/passes the account is unpinned and can land on a different machine than the WS auth that reads it back — but not proven within this rehearsal's budget). Practical mitigation applied to the harness (not the product): `seat-churn.ts`'s `joinSeat` now fails a pre-welcome socket close immediately with its real code/reason instead of silently waiting out the 12 s welcome timeout, and `joinOne` retries once after a 500 ms beat. **This is flagged as an unresolved finding, same as attachments/watch-party above — not filed as a confirmed product defect, because the retry consistently resolved it, which is circumstantial evidence for staleness rather than proof.**

**Second attempt (`m6r2dep2`), with the retry**: 135/200 (67.5%) seated at ramp-complete — only marginally better than the first attempt's 65%. A single retry after a 500 ms beat did **not** meaningfully fix the failure rate, which is evidence against "purely transient/racy" and points more toward a systematic cause for a subset of fresh identities under this concurrency (still unconfirmed — see finding #3 in "Blockers before production"). `/ready` stayed green with single-digit `postgres.ms` on all three machines throughout both attempts, so this is not a repeat of the batch-job boot-storm finding above; it is a distinct, separately-tracked issue. The deploy-under-load test proceeded with the ~135 seats that did join, since the mechanics being tested (drain, reconnect, `/ready` during rollout) do not depend on hitting exactly 200.

Deploy trigger: `gh workflow run deploy-staging.yml --ref ops/m6r2-3machines` while seats were live (mechanically identical to the redeploy that brought the three machines up, exercising `deploy-api-fly.yml`'s `--ha=false --strategy rolling` against a **3**-machine app for the first time — the 2026-09-13 rehearsal's blocker 3 was never exercised even at 2 machines).

[NUMBERS TO BE FILLED IN: sockets dropped, reconnect p95, clients in a failed state, `/ready` behavior during the deploy, drain batches per machine]

## 3 → 2 → 3 scaling

[TO BE FILLED IN]

## Blockers before production

1. **Eviction resweep with real media, specifically** — the mute half of blocker 1 is closed (real media, cross-instance); the resweep half (a moderator disconnect against a real LiveKit participant, sustained observation of the 5 s claim window) was not separately exercised.
2. **Attachments and watch-party cross-instance delivery** — two unresolved findings above, not root-caused, not filed as confirmed defects. Rerun in isolation with full tracing before trusting either feature at N machines.
3. **The 200-seat join failure rate under concurrent account creation** (65% → [X]% with a one-shot retry) — a harness workaround was applied and is not itself evidence the product is fine; worth its own isolated repro (e.g., 50 concurrent fresh identities against one machine vs. three) before concluding it is staleness-across-instances specifically rather than something that would also happen at N=1.
4. **`WORKER_MODE=api` should ship with the N-machine flip, not after it** — see the batch-job finding above. This is the one item on this list that already has a confirmed cause and a confirmed fix; it just needs to be in the same change, not a follow-up.

## Production change list

- `fly.toml`: `min_machines_running = 2`, `[deploy] strategy = "rolling"` (already set), machine size `performance-1x` / `2gb` per Rafael's brief (current is `performance-2x`/`4gb` — a **downsize**, worth its own soak before or during the flip, not assumed safe by this rehearsal, which ran staging at `shared-cpu-1x`/1 GB machines, a different size class entirely).
- Fly secrets to set on `pqp-api`, same `fly secrets set` batch: `PG_POOL_MAX=<computed from the production Managed Postgres tier per docs/DB_RUNBOOK.md §3, divided by the target machine count, minus 2 for the two per-machine LISTEN sessions>`, `WORKER_MODE=api` (see finding above — `pqp-worker` already exists and answers `/health`).
- `gh variable set PQP_API_MACHINES --body 2` before the flip (keeps the CI assertion true in between), `gh variable delete PQP_API_MACHINES` after `min_machines_running = 2` merges — exact sequence already in `docs/deploy-fly.md` §6a-bis.
- Runbook for scaling to n later: repeat this rehearsal's formula — `PG_POOL_MAX = floor(budget/n) − 2`, budget re-derived from `docs/DB_RUNBOOK.md` §3 for whatever RAM tier the cluster is actually on at the time (never assume it hasn't changed); confirm `WORKER_MODE=api` is still set before adding a machine, since a new machine unsets nothing but a manual secrets rollback could.

---

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LptYkv7RTzV6WVQNEWNYUv
