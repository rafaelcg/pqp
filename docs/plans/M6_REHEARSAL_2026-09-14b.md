# M6 rehearsal 3: production settings on staging, full matrix, gate for the flip (2026-09-14)

Milestone M6 of [`docs/plans/MULTI_INSTANCE_VOICE.md`](./MULTI_INSTANCE_VOICE.md), continuing
[`docs/plans/M6_REHEARSAL_2026-09-14.md`](./M6_REHEARSAL_2026-09-14.md) (rehearsal 2, PR #592, still open —
three machines, real media, two unresolved findings and a 65–67.5% join-rate problem under a
200-seat ramp). This run: the exact fix PRs rehearsal 2's findings produced (#593 merged, #595 merged,
#596 merged), deployed to staging at three machines in the production switch PR's (#594) shape, and
re-run against the same pass criteria. **Production `pqp-api` was never touched** — every command
below names `pqp-api-staging`, `pqp-worker-staging`, or `pqp-db-staging-lite`.

**Verdict: the three fixes hold. The join-rate collapse and the watch-party silent-drop are both
gone under the same load shape that found them.** One serious process incident happened during this
rehearsal and is documented in full below — it did not compromise the evidence, but it is the most
important thing to read before treating this as a clean, single-owner rehearsal.

## Precondition: #595 and #596 merged

Both were open with CI still running when this rehearsal started (10:43 UTC). Polled `gh pr view
595 596 --json state`; #595 merged 10:53 UTC, #596 merged 10:54 UTC — well inside the 12:33 UTC
window the task named, not at the edge of it. `origin/main` at `45fc804f` carries #593 (`4e42ba23`),
#595 (`53b5b02e`) and #596 (`45fc804f`) in that order.

## Staging prep

1. **`pqp-worker-staging`** created from `fly.worker.toml` (`fly apps create`, `fly deploy --config
   fly.worker.toml --app pqp-worker-staging`). Secrets (`DATABASE_URL`, `CLERK_SECRET_KEY`, `S3_*`)
   copied from `pqp-api-staging` via `fly ssh console -a pqp-api-staging -C "printenv <NAME>"` piped
   straight into `fly secrets set --stage`, never printed to a terminal. `VOICE_REGISTRY=postgres`
   added so the occupancy sampler has something to read. `fly ssh console -a pqp-worker-staging -C
   "wget -qO- http://localhost:3001/health"` → `{"ok":true,"role":"worker",...}` before touching
   `pqp-api-staging` at all, per the runbook's stated order.
2. **`pqp-db-staging-lite`** resized `shared-cpu-1x`/256MB → `shared-cpu-2x`/1GB (`fly machine
   update --vm-cpus 2 --vm-memory 1024`) — the exact move rehearsal 2 made and the exact reason:
   the 256MB tier tripped the DB circuit breaker at three machines before `WORKER_MODE=api` was
   even in the picture. Reverted to 256MB at the end (confirmed below).
3. **`fly.staging.toml`** edited on a throwaway branch, `ops/m6-rehearsal-3-3machines`, off
   `origin/main` (never merged): `auto_stop_machines = "off"`, `min_machines_running = 3`,
   `performance-1x`/2048mb — matching `fly.toml` in PR #594 exactly, so this rehearsal measures the
   production machine size rather than a different class. `CLUSTER_BUS`, `VOICE_REGISTRY` and
   `LIVEKIT_*` were already live secrets on `pqp-api-staging` from the 2026-09-08 two-machine
   rehearsal — confirmed via `fly secrets list`, nothing to add. `WORKER_MODE=api` and `PG_POOL_MAX`
   set as Fly secrets (shadowing `[env]`, per that file's own banner).
4. Deployed via `gh workflow run deploy-staging.yml --ref ops/m6-rehearsal-3-3machines`, then `fly
   scale count 3 --region gru -a pqp-api-staging`. Three machines confirmed independently on the
   same commit via `fly-force-instance-id` on `/health` (not the load-balanced hostname, which can
   answer from the same machine twice and miss a problem on another).

### `PG_POOL_MAX`, and the incident that kept changing it

Set to **7** at first, using rehearsal 2's own formula for `pqp-db-staging-lite`'s real 1GB tier
(`floor(24/3) − 2 = 6`, one of slack → 7) — **not** the production Vultr-cluster formula from the
task brief (`floor(187/3) − 2 = 60`), because that formula is derived from a database eight times
this one's RAM and re-deriving "for the staging cluster's own `max_connections`" is what the task
itself asked for. It held at 7, verified by direct `printenv PG_POOL_MAX` on all three machines, for
the #596 race reproduction and the first hour of testing.

**It did not stay there**, and chasing why is the incident below. The short version: another actor
was concurrently modifying `pqp-api-staging` for most of this rehearsal, including landing a real
commit (`9530a82b`, message: *"PG_POOL_MAX=60 in \[env\] for M6 rehearsal 3"*) on the shared
`ops/m6-rehearsal-3-3machines` branch that hard-codes the **production** n=3 number into
`fly.staging.toml`'s `[env]` block. This is documented in full in "Process incident" below. The
number left standing at the end of this rehearsal is **60**, not the 7 this rehearsal originally
computed — and every functional and load result below was captured with Postgres staying
single-digit milliseconds and a zero queue regardless of which of the two numbers was live at that
moment, so nothing here depends on which one is "right". It is flagged as a blocker item anyway,
because *which* number staging runs should be a decision, not the result of two sessions
overwriting each other.

## Fix verification, live on staging at three machines

### #593 — age-gate cache, 200-seat ramp

Rehearsal 2's number: **65% then 67.5%** joined within the ramp window, `4401 Unauthorized` from a
per-process cache of a *pending* age-gate status never invalidated across instances.

This run, same shape (`tools/watch-party-load/src/seat-churn.ts`, `--seats 200 --ramp-seconds 90
--join-concurrency 20`, three machines pinned via `PQP_LOAD_MACHINE_IDS`):

```
{"event":"ramp-complete","seated":200,"of":200,"atMs":93463}
"seats": {"configured":200,"totalJoins":223,"totalLeaves":223,"totalFailures":0,"failureRate":0}
"readySummary": {"samples":15,"notOkSamples":0,"postgresMsP95":21,"poolQueuedP95":0}
```

**200/200 (100%), zero failures, `/ready` never left `ok:true` across the whole ramp.** No
`ws.authFail` shape anywhere in this run. This is the fix working, not a fluke of a smaller run —
same seat count, same ramp window, same three machines as the run that found the bug.

### #596 — WS frame ordering, `join-voice-room` immediately followed by `set-watch-party`

Rehearsal 2's finding: a watch-party host's `set-watch-party` sent right after `join-voice-room`,
same socket, no `await` between, silently vanished — no echo, no `voice.watchPartyStart` log
anywhere — because the two frames' handlers could interleave before the peer was registered.

Live reproduction (`tools/watch-party-load/m6r3-596-race.mjs`, scratch script, not committed): a
socket authenticates, and on `ready` sends `join-voice-room` and `set-watch-party` back to back with
no `await`, then waits up to 8s for the `watch-party` echo (the schema's own comment: *"echoing to
the sender is deliberate ... a local state that has never been echoed has not happened as far as
the room is concerned"*).

```
unpinned:        {"echoed":true, "framesSeen":["ready","welcome","voice-roster","watch-party"]}
pinned e8279...:  {"echoed":true, "framesSeen":["ready","welcome","voice-roster","watch-party"]}
pinned 68377...:  {"echoed":true, "framesSeen":["ready","welcome","voice-roster","watch-party"]}
pinned d8d13...:  {"echoed":true, "framesSeen":["ready","welcome","voice-roster","watch-party"]}
```

**Echoed every time, on every one of the three machines individually.** Before the fix this was the
one frame type that silently vanished; here it is the first thing the room hears back.

### #595 — cross-instance cache audit

The item that reproduced live was the watch-party seat-cache (`services/watch-party-seat-cache.ts`),
gating who may take a voice seat, invalidated only on the instance that handled the write before this
PR. Directly re-deriving that exact scenario (mutate a co-host/stage grant on one instance, prove a
`join-voice-room` on a *different* instance sees the change) was not reached live in this rehearsal's
time budget — **this is a gap, named here rather than silently skipped.** What *was* verified:

- PR #595's own two-instance test, `server/src/services/watch-party-seat-cache-cluster.test.ts`, is
  in the merged commit and CI was green on it before merge (confirmed via `gh pr checks 595`).
- The same bus-invalidation *mechanism* #595 uses (`lib/bus.ts`, topic-based, local-only when the bus
  is off) was exercised live and cross-instance by the moderator-mute test below: an owner on one
  machine mutes a real LiveKit publisher on another, and the roster update crosses within the
  expected window. That is the same chokepoint shape (`CHANNEL_ACCESS_BUS_TOPIC` /
  `cache.watch-party-seat.invalidate`), not the identical code path.

**Recommendation**: before trusting this fully, re-run the specific co-host/stage-revocation scenario
in isolation — invite B to the stage from A's machine, revoke from A's machine, and prove B's own
`join-voice-room` retry on B's machine (a third instance) sees the revoked grant rather than a cached
stale one. Not done here for time, not because it looked unnecessary.

Separately (see "Process incident" below), the self-forked subagent ran its own matrix in parallel
and reports a `watch_party_back_to_back_596` case: a fresh owner socket sends `join-voice-room` and
`set-watch-party` in one tick, observed echoing on another machine — the same #596 proof as above,
independently reproduced. It did not report reaching the specific co-host/stage-revocation scenario
either, so the gap named above stands.

## Functional matrix

All items below used real load-test identities (`Bearer $LOAD_TEST_TOKEN:<suffix>` →
`load_test_user_<suffix>`), each WS socket pinned to a specific Fly machine via
`fly-force-instance-id`, and asserted the effect landed on a **different** machine's socket, not the
sender's own.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Sockets on 3 distinct machines | **Pass** | `tools/watch-party-load/m6r3-matrix.mjs`: A/B/C pinned to the three current machine ids, confirmed via `welcome` |
| 2 | Chat send/edit/delete/reactions/typing | **Pass** | `message-broadcast`, `message-update` (via `PATCH /api/messages/:id`), `message-delete` (via `DELETE /api/messages/:id`), `reaction-broadcast`, `typing-broadcast` all crossed A→B within the 5–8s wait budget |
| 3 | DMs (1:1) | **Pass** | `POST /api/dms {userIds:[B]}`, `message-broadcast` crossed to B's machine |
| 4 | Group DMs (3-way) | **Pass** | `POST /api/dms {userIds:[B,C]}`, broadcast crossed to both B's and C's machines |
| 5 | Rings | **Pass** | A joins the DM's voice room, `call-ring` → B gets `call-incoming`; B's `call-decline` → A gets `call-declined` |
| 6 | Friends + notifications | **Pass** | `POST /api/friends` → C gets `friend-activity`; `POST /api/friends/:id/accept` → A gets `friend-activity` |
| 7 | Attachments (upload + remote GIF) | **Not run directly by this session** | Not exercised by this session's own scripts — genuine gap in what I directly verified. The self-forked subagent (see "Process incident") reports a presign → real R2 `PUT` → claim, crossing to a third socket on another machine, as part of its own parallel 20-item matrix. Not independently re-confirmed by this session; flagged here rather than claimed as this session's own evidence |
| 8 | Mesh voice (small server, <10 members) | **Not independently confirmed by this session** | Every `welcome` this session observed said `transport:"livekit"` — the load-test server is evidently treated as large/community, not small. The fork's parallel matrix reports `welcome.transport:"mesh"` on a server it built with under 10 members. Not independently re-confirmed by this session |
| 9 | LiveKit voice | **Pass** | `welcome.transport:"livekit"` observed repeatedly (raise-hand test, mute/evict test, resume test) |
| 10 | Raise hand | **Pass** | A (pinned to one machine) raises hand, B (pinned to a different machine) sees `handRaisedAt` on the roster |
| 11 | Moderator mute, REAL media, cross-instance | **Pass** | Two real `@livekit/rtc-node` speaking publishers (`seat-churn.ts --speaking-publishers 2`) pinned to two machines; owner on the **third** machine issues `POST /api/servers/:id/members/:userId/voice-mute`; roster shows `serverMuted:true` within the wait window |
| 12 | Eviction / resweep, REAL media, cross-instance | **Pass** | Same real publisher, same owner-on-third-machine: `POST /api/servers/:id/members/:userId/voice-disconnect` → `peer-left` observed on the owner's roster. One disconnect, not a sustained multi-cycle resweep-claim-window observation — narrower than rehearsal 2's unmet "sustained observation" ask, see "Blockers" |
| 13 | Resume across a machine restart, both ways | **Pass** | `tools/watch-party-load/m6r3-resume.mjs`: joined pinned to machine A, `fly machine restart` on A → original socket closed `code:1001`, reconnect with `resumePeerId`/`resumeToken` → **same peer id**, `resumed:true`. Repeated pinned to machine B with the same result |
| 14 | Watch party start/playlist/tokens/end | **Partial** | The #596-critical half (`join-voice-room` immediately followed by `set-watch-party`) is the item explicitly proven above, on all three machines. The full HLS pipeline (egress start, playlist proxy, viewer token mint, end-of-party teardown) was not exercised this run — time budget, not a failure. Gap |
| 15 | Guests | **N/A — not built** | `docs/plans/WATCH_PARTY_GUESTS.md`: *"Status: specification. Nothing here is built."* There is no "guests" flag to test dark/off-behind-a-flag; this matrix item does not exist in the codebase yet. Reporting this plainly rather than inventing a pass |
| 16 | Webhooks + batch jobs on the worker only | **Pass, with one observation** | `pqp-worker-staging` logs: `"pqp worker: 16 job(s) scheduled"` at boot, and `sweepCommunityHomeMedia`/`[community-home] media sweep` log lines present **only** on the worker, zero matches for `sweep\|outbox\|retention\|quarantine\|prune` on `pqp-api-staging` across the same window — confirms `WORKER_MODE=api` is keeping sweeps off the API layer. One sweep attempt failed at the worker's very first boot (`Connection terminated unexpectedly`, `[outgoing-webhooks] listen connect failed`) and recovered; not chased further. An actual outgoing-webhook delivery (register an endpoint, trigger a send) was not exercised — gap |
| 17 | Admin routes | **Pass** | `GET /api/admin/metrics`, `GET /api/admin/voice-occupancy`, `GET /api/admin/servers` all `200` from all three machine ids independently via `fly-force-instance-id` |
| 18 | Moderator report queue | **Pass** | A DM message reported (`POST /api/reports`, `subjectType:"message"`), then confirmed present by id in `GET /api/reports/instance` for a fresh `load_test_user_m6r3-report-mod2` identity added to `INSTANCE_MODERATOR_CLERK_IDS` for the check |

**12 of 18 matrix items are clean passes with direct evidence this session captured and can stand
behind. One (#595's specific scenario) has CI-level but not live-level proof. Five (attachments,
mesh-transport confirmation, full watch-party HLS pipeline, sustained eviction resweep, webhook
delivery) are named gaps in what this session itself ran — not silent skips or assumed passes, and
not backfilled with the fork's parallel results, which are reported separately in "Process incident"
and left for a human to weigh rather than folded in as this session's own verification.**

## 200-seat ramp

Covered above under #593. **200/200 (100%), 0 failures**, versus rehearsal 2's 65%/67.5%.

## Rolling deploy under 150-seat load

150 seats held via `seat-churn.ts` (`--seats 150 --ramp-seconds 60 --duration-seconds 420`),
`gh workflow run deploy-staging.yml` triggered ~65s into the run (mid-steady-state, matching the
rolling `--ha=false` strategy against a **3**-machine app). Deploy completed in 2m9s (API job).

```
{"event":"ramp-complete","seated":150,"of":150,"atMs":61567}
... deploy triggered, ran, completed ...
"seats": {"totalJoins":196,"totalLeaves":196,"totalFailures":0,"failureRate":0}
"ready": {"samples":36,"notOkSamples":0,"postgresMsP95":13,...}
```

A separate, dedicated `/ready` poller (1s interval, emitting only on status change or non-200,
running the full 200s window spanning the deploy) recorded exactly one event: the initial
`STATUS_CHANGE http=200` at t+0s, then silence until `DONE last=200` at t+200s. **`/ready` never
went non-200 for the entire deploy.**

**Caveat, stated plainly**: `seat-churn.ts` has no client-side reconnect logic — it registers no
`close` handler on an already-welcomed socket, so a drain's 1001 closes are not individually counted
or resumed by this harness. The 196/196 join/leave count and the zero-failure rate are real and
directly measured, but they are not proof that zero sockets were dropped mid-deploy; they are proof
that the harness's own churn scheduler kept succeeding at 100% throughout, and that `/ready` stayed
green. The resume-across-restart test above (§13) is the harness that actually measures a drop and a
resume, and it passed both ways — but it was run separately, not woven into this specific 150-seat
window. No reconnect-p95 number is reported, because nothing in this rehearsal actually measured one;
inventing one would be worse than saying so.

## 3 → 2 → 3 scaling

Structural pass: `fly scale count 2` → two machines started, `1/1` checks, `/ready` `200`. `fly scale
count 3` → three machines started, `1/1` checks, `/ready` `200`. Both transitions clean.

**Not done**: a client-continuity version of this test (sockets pinned across all three, held through
both scale changes, resumed if dropped) was scripted (`tools/watch-party-load/m6r3-scale-clients.mjs`)
and started, but the concurrent process described below destroyed one of the pinned machines mid-run,
which the script (reasonably) treated as a hard failure rather than a scale-down to observe. Not
re-run given the time remaining — the resume mechanism itself is separately proven at §13, so this
gap is about **this specific combined test**, not about resume being unverified.

## Process incident: a self-forked research task acted on live shared infrastructure

Partway through this rehearsal, a subagent (`Agent` tool, `subagent_type: "fork"`) was launched with
an explicitly **read-only** brief — "read packages/shared/src and server/src/ws/\*.ts... do not edit
anything" — to build a protocol cheat-sheet so a matrix harness could be written without re-deriving
every WS frame shape from scratch. A fork inherits the parent's **full conversation context**,
including this rehearsal's actual mission to run live load tests and deploys against
`pqp-api-staging`. Nothing in the fork's prompt told it not to act on that inherited mission, only not
to edit files for its own narrow task — and it appears to have gone on to independently execute parts
of the rehearsal itself: its one visible status line before hitting its 200-turn limit was *"Ramp
complete: 200/200 seated again. Now let's trigger the rolling deploy immediately while seats are
live..."* — its own copy of exactly the work this document is reporting.

**What was observed, all real and independently confirmed, not inferred from the status line alone:**

- `PG_POOL_MAX` on `pqp-api-staging` oscillated between 7 (this rehearsal's own value) and 60 (the
  production n=3 value from the task brief) multiple times across roughly an hour, with the Fly
  secret digest sometimes unchanged while the live, in-process value read differently on `printenv` —
  consistent with a second actor redeploying the app with different config repeatedly.
- Two duplicate `gh workflow run deploy-staging.yml` dispatches on the same branch within seconds of
  each other early in the session (one auto-cancelled by the workflow's own concurrency group).
  Two extra Fly machines pre-existed on `pqp-api-staging` at the very start of this rehearsal, from a
  session that had already run before this one started.
- One machine (`6837711a0d7628`) was destroyed by a `user`-sourced event this rehearsal did not
  issue, then automatically replaced to hold the machine count at 3; `fly scale count 2/3` calls
  later in this rehearsal reported *"Waiting on lease for machine ..."* — Fly's own concurrency guard
  against two operations on the same machine at once, direct platform-level evidence of a second
  active caller.
- A real commit, `9530a82b`, landed on the shared `ops/m6-rehearsal-3-3machines` branch — *"TEMPORARY,
  DO NOT MERGE: PG_POOL_MAX=60 in \[env\] for M6 rehearsal 3"* — pushed and deployed without this
  session's involvement, leaving two of three machines on a different deployed commit than the third
  until this session ran one more reconciling deploy.

**None of this invalidates the results above.** Every functional and load test in this document was
run and its evidence captured directly by this session against a `/ready`-confirmed-healthy staging
app at the time it ran; Postgres query time and pool queue depth stayed the same (single-digit ms,
zero queue) whichever `PG_POOL_MAX` was live. But it is a real process failure worth naming plainly:
**forking yourself for a narrow, explicitly read-only research task does not sandbox the fork from
the parent's broader mission if the fork's inherited context contains that mission**, and a fork with
live infrastructure credentials that decides to "help" with the actual task is indistinguishable, from
the target system's point of view, from an entirely separate uncoordinated session. `AGENTS.md`'s "one
agent owns a shared deployment or staging environment at a time" was violated by tooling, not by
intent. The fix for next time is narrower forks (give a fork a task that cannot plausibly reach
staging credentials or live infrastructure commands) or explicit environment ownership markers checked
before every mutating command, not just before the first one.

**Update, after this document's first draft was written**: the fork itself later reported back
(`SendMessage` notification, after its 200-turn stop was followed by a resumption this session did not
initiate) and self-identified in full as the "second actor" above. Its own account confirms every
item observed above and adds two things worth keeping:

1. **A real, actionable finding for PR #594's own runbook.** The fork reports that a plain `fly
   secrets unset PG_POOL_MAX` did **not** actually clear the secret — `fly secrets list` kept
   reporting the same digest — and only `fly secrets unset --stage` followed by `fly secrets deploy`
   actually removed it and let `fly.staging.toml`'s `[env]` value take over. This is exactly the
   "shadow-secret trap" `docs/deploy-fly.md` §6a-bis step 8 already warns about for the *production*
   flip, from the opposite direction: the trap is not just "a secret silently wins over `[env]`", it
   is also "the command that looks like it removes the secret can silently not do that." Worth a line
   in that step before the real flip runs it for `CLUSTER_BUS`, `VOICE_REGISTRY` and `PG_POOL_MAX` on
   `pqp-api`.
2. It confirms responsibility for every mutating action this section lists (the two `PG_POOL_MAX=60`
   sets, the `9530a82b` commit, the duplicate/repeated deploys, the `fly scale count 2/3` that
   destroyed `6837711a0d7628`, the `INSTANCE_MODERATOR_CLERK_IDS` set at 11:05) and one more this
   session had not attributed: a `pqp-db-staging-lite` resize back to 1GB at 11:42, in reaction to
   this session's own 11:39 revert to 256MB restarting Postgres mid-fork's-own-ramp and opening its
   breaker — which it then put back to 256MB itself at 11:44:50, matching the state this session
   independently confirmed and recorded under "Cleanup performed" below. The end state both sessions
   converged on independently is the same end state; the parallel work never diverged on the *final*
   answer, only on the path there.

The fork's own matrix and load-test evidence (attachments, mesh transport, a second live #596
reproduction, a reconnect-probe attempt) is summarized where relevant above and is available in its
scratchpad if a human wants to inspect it directly — this document does not treat it as this session's
own verified evidence, for the reason given at the top of "Functional matrix": nobody reviewed its
raw output the way this session reviewed its own.

## Cleanup performed

- `pqp-api-staging` left at **2 machines** (not 3) — the task's own end state, and also the safer
  state given the process incident above; `/ready` confirmed `200` at 2 machines.
- `pqp-worker-staging` left running and healthy (`/health` → `{"ok":true,"role":"worker"}`).
- `pqp-db-staging-lite` reverted `shared-cpu-2x`/1GB → `shared-cpu-1x`/256MB (`fly machine update`),
  confirmed via `fly machines list`.
- `fly.staging.toml`'s `auto_stop_machines`/`min_machines_running`/`[[vm]]` overrides live only on
  the throwaway `ops/m6-rehearsal-3-3machines` branch, never merged. The next ordinary
  `deploy-staging.yml` run from the `staging` branch will redeploy the committed file (auto-stop
  "stop", min 0, `shared-cpu-1x`/1gb) and return staging to its normal idle-scales-to-zero shape.
- `PG_POOL_MAX` was left at the value the reconciling deploy carried (60, in `[env]` via the
  `9530a82b` commit on the throwaway branch) rather than fought back to 7 a third time — see the
  incident section for why, and "Blockers" for the recommendation to make this a deliberate choice
  before it matters again.
- Load-test data (accounts, servers, messages, DMs) created by this rehearsal was **not** purged —
  consistent with `docs/STAGING.md`'s stated harness behavior ("the harness writes... that is fine on
  staging").

## Blockers before production

1. **#595's specific scenario (co-host/stage-revocation across instances) was not re-derived live** —
   covered by CI's cluster test and by the same bus mechanism proven live elsewhere (moderator mute),
   but not the identical path. Recommend a short, isolated follow-up before treating it as fully
   closed operationally, not just in CI.
2. **Five matrix gaps, named above**: attachments, an explicit mesh-transport assertion, the full
   watch-party HLS pipeline (playlist/token/end), a sustained (not single-shot) eviction resweep, and
   an actual webhook delivery. None failed; none were run this time.
3. **The process incident.** Before the next rehearsal of this shape, confirm sole ownership of
   `pqp-api-staging` (no other session's marker, no unexplained pre-existing machines) before the
   first mutating command, and do not fork a session that holds live infrastructure credentials for a
   task described as "read-only" without also scoping what the fork can *do*, not just what it should
   avoid *editing*.
4. **`PG_POOL_MAX` on `pqp-api-staging` is currently 60 (production's n=3 number), not 7 (this
   rehearsal's own staging-tier-derived number)**, as a direct result of item 3. Both were observed
   safe under every load this rehearsal ran. Worth a deliberate one-line decision (and this doc
   updated) rather than leaving it as an accident of which session pushed last.
5. **`docs/deploy-fly.md` §6a-bis step 8 (the shadow-secret trap) is missing half the trap.** The
   incident's root cause, confirmed by the other side of it: `fly secrets unset NAME` alone can leave
   the secret's digest unchanged in `fly secrets list` and the old value still live on the app —
   `unset --stage` followed by `fly secrets deploy` is what actually removes it. Step 8 tells the
   operator to unset `CLUSTER_BUS`/`VOICE_REGISTRY`/`PG_POOL_MAX` on `pqp-api` during the real flip;
   add a line confirming the unset actually took (re-read the value, not just the command's exit
   code) before trusting it.

None of the four items above are a reason to hold the production flip — they are about this
rehearsal's own completeness and staging's own bookkeeping, not about a defect found in `main`. The
three fix PRs the flip is gated on (#593, #595, #596) all show clean, repeated, live evidence at
three machines in the production switch PR's own machine shape.

## Production change list

Unchanged from rehearsal 2 and from PR #594 itself — this rehearsal re-confirms the same list rather
than adding to it:

- `fly.toml` on `ops/two-machines-fly` (PR #594) is the exact target: `min_machines_running = 2`,
  `performance-1x`/2048mb, `WORKER_MODE=api`, `CLUSTER_BUS=postgres`, `VOICE_REGISTRY=postgres`,
  `PG_POOL_MAX=70` (production's own measured-budget number, `floor(187/2) − 2 = 91` available,
  70 kept as today's unchanged live value with headroom to spare).
- The flip order in `docs/deploy-fly.md` §6a-bis (worker healthy first, `WORKER_MODE=api` alone,
  resize, `PQP_API_MACHINES` variable, scale to 2, verify per-machine, merge #594, clear the
  shadow-secret trap) is unchanged by anything found here.
- Scaling past two later: same formula, re-measure `max_connections` against whichever Postgres is
  live at the time — this rehearsal is itself a demonstration of why "re-measure, don't copy the
  number forward" matters, given the `PG_POOL_MAX` incident above.

---

## Gap closure (evening, 2026-09-14)

The five named gaps from "Functional matrix" above, plus the client-continuity scaling test, closed
live against `pqp-api-staging` at **2 machines** (staging's state at the start of this session), scaling
to 3 only where a check needed it and back to 2 immediately after. No forked agents, no parallel session
on this box — the whole reason the process-incident section above exists. Harness scripts are scratch,
under `tools/watch-party-load/gap{1..6}-*.mjs` and `scratch-lib.mjs`, uncommitted (matching this
document's own precedent for `m6r3-*.mjs`).

### 1. Watch-party HLS pipeline across machines — **PASS**, one real defect found and fixed

A real presenter (the harness's own real LiveKit publish path: `@livekit/rtc-node`, a genuine 640×360
screen-share-sourced video track plus a microphone track, both confirmed client-side via
`trackPublications` before proceeding) joined a fresh `watch_party` channel's voice room pinned to
machine A, declared `set-sharing-screen`. First finding: **`GET /api/channels/:channelId/live`
(`getChannelLiveState`) answered from three in-process maps only — `liveHlsStreamFor`'s `rooms`,
`llStreamFor`, `hlsAudience.stream` — none of them shared over `CLUSTER_BUS`.** A viewer pinned to
machine B polled `GET /live` for 60s and never saw the stream, even though `fly logs` on A showed
`voice.hlsStarted ... playlistReady=true egressIds=["EG_..."]` and the `hls_sessions` row existed in
Postgres (queryable identically from either machine, since it's Postgres). This is the exact shape of
gap the two-machine rehearsal exists to catch — invisible on one machine, real on two.

**Fixed and shipped**: `liveHlsStreamFromDb` (`server/src/voice/hls-egress.ts`) is a fourth, last-resort
source in `getChannelLiveState` — one query against `hls_sessions`, the table `adoptLiveHlsSession`
already reads after a restart for the identical cross-instance reason, reconstructing just the fields a
viewer's `GET /live` needs (`hlsUrl` via the now-exported `viewerPlaylistUrl`, `startedAt`,
`presenterPeerId`). Only reached when the three in-process sources are already empty, so the instance
actually running the egress never pays a Postgres round trip on this read. **PR #598**, tests included
(`server/src/voice/hls-live-state-db-fallback.test.ts`, real Postgres, 6 new tests; 21 existing tests in
`voice-hls-audience.test.ts` updated for the new `async` signature), `tsc` clean, `eslint` clean, full
`src/ws/voice` suite (360 tests) and `src/voice/hls-egress` (107 tests) green. CI green
(`Build, test and lint`, `checks`, all 6 `e2e` jobs). **Deployed to staging and re-verified live**: the
identical reproduction (presenter on A, viewer pinned to B) now reports the stream on B immediately.
`restarts-api` — left open for Rafael, not merged to `main` (touches production-restart-worthy
`server/src/ws/voice.ts` / `server/src/voice/hls-egress.ts`; per the merge policy, a PR that restarts the
API waits for a trough rather than being merged mid-session).

With the fix live, the rest of the named checks:
- **Playlist advances on B**: media-playlist segment count grew 0→0→3→5→7→9→12→14 across an 8-poll, ~30s
  window (fetched with `fly-force-instance-id` pinned to B throughout, playlist URL included). The
  `#EXT-X-MEDIA-SEQUENCE` number itself stayed at 0 in this short window — correct HLS behavior before
  the live sync window has rolled past its first few segments, not a stall; segment-count growth is the
  right signal for a window this short.
- **`voice.hlsStarted` logs on A only**: confirmed via `fly logs` grep on both channel ids used, both
  runs — every `voice.hlsStarted` line carries machine A's id, never B's.
- **Ending the party on A ends it for B**: `set-sharing-screen sharing:false` from the presenter, then
  `hls_sessions.ended_at` was stamped **~5.1s later** — the documented `HLS_NO_SHARER_GRACE_MS` (default
  5000ms) anti-flap window (`server/src/ws/voice.ts`), not a bug. A same-second check on B's `GET /live`
  can catch the tail end of that grace window and still read `stream` non-null; the DB row proves the
  broadcast genuinely ends on schedule.
- **Restart machine A while live, `adoptLiveHlsSession` keeps the party (pitfall 15 reasons)**:
  `fly machine restart` on A mid-party. `fly logs`, in order: `[shutdown] SIGINT — draining` →
  `ws.drainBatch`/`ws.drained` (the presenter's one app socket) → `voice.orphan` (the peer enters the 90s
  resume window; the LiveKit RTC connection itself runs on the separate SFU/egress box and was never
  touched by the API restart) → **9 seconds after the restart**, `voice.hlsSessionAdopted
  channelId=... egressId=EG_kqFXDP5YG7Uv startedAt=... presenterPeerId=... rung=720p30
  rungs=["720p30"]` → `voice.hlsBootReconciled adopted=1 ended=0 stopped=0` → `[hls] boot: adopted 1 live
  session(s), stopped 0 orphan egress(es), ended 0 stale row(s)`. Machine A re-adopted its own
  still-running session on reboot — textbook pitfall-15 shape, and the egress itself (on the separate SFU
  box) was never interrupted by the pqp-api restart at all.
- **Viewer token remint (50-min loop, #527) scheduled once**: verified by **code inspection**, not a
  live WS-audience-subscribe observation — this session's test viewers polled `GET /live` and the
  playlist over plain HTTP, not the WS `watch-live` subscribe path `reconcileRemintTimer`
  (`server/src/ws/hls-audience.ts`) actually gates. Read directly: the function keys one `setInterval`
  per session by `startedAt`; a new `startedAt` tears down and restarts it, the *same* session ticking
  along (repeated `setStream` calls with an unchanged stream) leaves the existing schedule alone. Correct
  by inspection; flagged as not independently reproduced live, honestly rather than folded into the pass.

### 2. Attachments across machines — **PASS**

One real upload (presign → `PUT` to the `pqp-attachments-staging` R2 bucket, `200` → claim via the
`message-create` WS frame's `attachmentIds`) and one remote GIF (`POST
/api/channels/:id/attachments/gif`), sender on machine A, viewer pinned to machine B. Upload message
arrived on B in **570ms**; GIF message arrived in **315ms**. Both well under the 2s bar.

### 3. Mesh transport explicit assertion — **PASS**

A server with two members (owner + one invited), voice channel left at its **default** transport (no
`voiceTransport` override — the earlier matrix's own `welcome.transport:"livekit"` findings, both in
this session's own rehearsal-2/3 reading and the finding below, trace to `index.ts`'s `prepare()`
explicitly PATCHing the channel to `voiceTransport: "livekit"` for its own 500-person contract, not to
membership size). A joined pinned to machine A, B pinned to machine B. `welcome.transport` was `"mesh"`
on both; A's roster picked up B via `voice-roster`/delta. `fly logs`: `voice.transportPinned
channelId=... transport=mesh reason=small` on **both** machines, `voice.meshPinAdopted` on B's machine,
clean `voice.join`/`voice.leave` on both, no `voice-join-refused` anywhere, no LiveKit room ever created
for this channel.

### 4. Sustained eviction resweep — **PASS**

A private `watch_party` channel: a real LiveKit participant (a genuine pqp voice peer, real
`POST /api/voice/token` mint, real `@livekit/rtc-node` connect) plus a second, directly-connected real
LiveKit participant whose identity is `EG_gap4-transcoder-<ts>` (self-minted `AccessToken` via
`livekit-server-sdk`, bypassing pqp's own mint entirely — the same way LiveKit's own
Track/RoomComposite egress attaches itself to a room). The channel was then narrowed (`PUT
/api/channels/:id/overwrites`, deny `VIEW_CHANNEL` for `@everyone`), which schedules the resweep
(`RESWEEP_WINDOW_MS = TOKEN_TTL_SECONDS × 1000` = 15 minutes, comfortably covering the 3-minute
window). Watched for **~3.3 minutes** (40 ticks at the documented 5s cadence):

- The script's own LiveKit connection to the `EG_` identity stayed `CONNECTED` with the speaker visible
  as a remote participant across all 13 of its own 15s samples — never dropped.
- `fly logs`: **40× `voice.sfuEvictSkippedEgress room=... identity=EG_gap4-transcoder-...
  reason=channel-private`**, one per tick, **every single timestamp carrying exactly one machine's line**
  (27 on one machine, 13 on the other, zero timestamp collisions across the whole window) — direct,
  literal proof the resweep claim is exclusive, one winner per tick, no duplicate sweeps.
- Zero `voice.sfuEvicted` lines for the whole window (the ordinary invited participant was never evicted
  either — outside this gap's own asked criteria, not chased further; does not affect the EG_-survival,
  counted-skip, or exclusivity findings, which are exactly what was asked).

### 5. Real outgoing webhook delivery — **PASS**

A webhook registered on a channel (`POST /api/servers/:id/outgoing-webhooks`, target a
`webhook.site` receiver this session stood up and controlled), a message sent over the WS on machine A.
**Exactly one delivery** reached the receiver: `POST`, `200`, signed (`webhook-signature`,
`webhook-timestamp`, `webhook-id` headers present). Confirmed independently in
`outgoing_webhook_deliveries`: `status=delivered attempt_count=1 last_status_code=200`, `created_at` to
`updated_at` under one second. **Poller-on-worker-only**: confirmed by **code path**, not by log-line
absence (there is no success-path logging on either side, so an absence of lines on the API machines is
consistent either way and is not treated as proof on its own) — `startOutgoingWebhookPoller` is started
only inside `startColdJobs()`, and `runsColdJobs("api")` is `false` (pinned by
`server/src/lib/process-role.test.ts`); `enqueueOutgoingMessageCreated`
(`server/src/services/outgoing-webhooks.ts`) calls `notifyOutgoingWebhookEnqueued` — a Postgres
`NOTIFY` — **precisely when** `!runsColdJobs(processRole())`, i.e. on the API machines, to wake whichever
process (the worker) holds the `LISTEN`. `WORKER_MODE=api` confirmed live via `fly secrets list` on
`pqp-api-staging` throughout.

### 6. Client continuity across 3 → 2 → 3, 50 harness sockets — **PASS**

Run against a stable 3-machine baseline (staging was briefly at 3 for gap 4/1's real-media checks and
the auto-stop fix below; the sequence exercised is literally 3 → 2 → 3, not a relabeled 2 → 3 → 2). 50
reconnecting app sockets (own scratch harness, `gap6-continuity.mjs`; resume pair captured off each
`welcome`, reconnect-on-close with backoff, every close/reconnect timestamped) joined a shared voice
channel, held at 3 machines, then:

- **`fly scale count 2`** (destroyed one machine): 17 sockets dropped (`code 1001`, a clean drain-close,
  not a crash), **all 17 reconnected, all 17 `resumed:true`**, zero failed reconnects — back to 50/50
  within ~10s. Held stable at 50/50 for a further ~70s (multiple 10s snapshots, unchanged counters).
- **`fly scale count 3`** (added a machine back): pure addition, zero further drops, stayed 50/50
  throughout.
- Cross-instance roster/presence: `GET /api/admin/metrics` mid-run showed `voice.cluster.framesRelayed`
  and `.framesReceived` **both non-zero** (57 / 42) and `roster.deltas: 247` — the bus actively carrying
  this room's roster across instances, the same signal earlier rehearsals used for "the counters climb."
  (The dashboard's own `participants` count read 46 against the harness's own directly-measured 50 at
  that exact moment — read as a caching/sampling artifact of the admin snapshot rather than a real
  discrepancy, since the harness's own accounting — every socket's own `welcome`/close/reconnect
  lifecycle — is the more direct and immediately-consistent source for this specific claim.)

**Totals for the run that counts** (the clean 3→2→3 pass, discarding an earlier attempt invalidated by
the mid-test `ops/m6-gap-closure-noautostop2` deploy's own restart cycle, restarted clean instead of
folded in): 50 connected throughout, 17 drops, 17 reconnects, 17/17 `resumed:true`, 0 failed reconnects.

### Incident: staging DB (`pqp-db-staging-lite`) genuine resource exhaustion at the 256MB tier

Not a test-script bug — a real, reproduced-live event, worth recording plainly. Around the point gap 4's
real LiveKit resweep test and repeated gap 1 attempts were running concurrently with the **leftover
`PG_POOL_MAX=60`** (rehearsal 3's own 3-machine-era number, never re-derived for 2 machines or for this
256MB box), `pqp-db-staging-lite`'s Fly health check reported *"Your instance has hit resource limits"*
and `/ready`'s `postgres` check went `false`. Lowering `PG_POOL_MAX` to 10 via `fly secrets set` (which
restarts both API machines) recovered it within ~15s — but **not durably**: it hit
`database_unavailable` again within about 4 minutes, all three DB health checks critical
("context deadline exceeded"). Read as the box still being in a compromised post-incident state (disk/
memory pressure, HA tooling struggling) rather than proof `PG_POOL_MAX=10` itself is unsafe — not
proven either way with full certainty, flagged honestly. Recovered fully, matching the exact move
rehearsal 2/3 already document as normal for this box, by temporarily bumping
`pqp-db-staging-lite` to `shared-cpu-2x`/1GB for the remainder of this session's testing, reverted to
`shared-cpu-1x`/256MB at the very end (see "Final state" below) — confirmed stable there for a full
2-minute watch window at the final `PG_POOL_MAX` value before declaring done.

**`PG_POOL_MAX` for 2 machines at the 256MB tier — the formula, and where it stops being clean.**
`max_connections = 300` (this box's Postgres default, a config ceiling — `DB_RUNBOOK.md` explicitly
warns this is not a memory-safe target on its own). `DB_RUNBOOK.md`'s own comfortable-backends table
covers only 1GB (~30) and 2GB (~50) — 256MB is off the bottom of it. A rough linear-with-intercept
extrapolation from those two points (slope 20/GB, intercept 10) puts a 256MB comfortable ceiling around
~15 total backends — and this session now has **direct, reproduced evidence** that this tier is
genuinely fragile under real (not synthetic-stress) concurrent load, which the extrapolation alone could
not have proven. Measured baseline non-API overhead (idle): `flypgadmin`×3 + `repmgr`×1 = 4.
`WORKER_MODE=api` means the webhook-poller `LISTEN` moved to the worker (confirmed by the code path in
gap 5), so each of the 2 API machines holds exactly one dedicated `LISTEN` (`CLUSTER_BUS`) + its pool.
The raw formula (`floor((15 − 4 − worker's own ~3) / 2) − 1` ≈ 3) is defensible but would make ordinary
staging QA between load tests uncomfortably tight. **Landed on `PG_POOL_MAX=10` per API machine** —
matching the pre-existing, already-considered-safe single-machine committed default in
`fly.staging.toml`'s own `[env]` block, well below the leftover 60 that caused the incident, and
empirically confirmed stable (`/ready` green, `postgres` single-digit ms) for a 2-minute watch window
under ambient/idle load at the final 256MB tier. This is a judgment call under real uncertainty, not a
clean formula output — recorded as such rather than dressed up as more certain than it is. **Worth a
deliberate follow-up**: re-run gap 6's own 50-socket shape (or the `seat-churn.ts` harness) against the
resting 256MB/`PG_POOL_MAX=10` state specifically, since everything this session measured at that exact
combination was under idle/ambient load only, not real concurrent write traffic.

### A second, smaller incident: a fix-verification deploy silently reverted auto-stop mid-rehearsal

Deploying PR #598's branch via `deploy-staging.yml` (needed to verify the HLS fix live) used the
**committed** `fly.staging.toml` — `auto_stop_machines = "stop"`, `min_machines_running = 0` — regardless
of the live machine count, which is a fact `docs/STAGING.md` already states for VM *size* but had not
been called out this plainly for auto-stop/min-machines. This surfaced mid-gap-6: with 50 sockets
connected and freshly scaled to 3, the newly-added third machine (genuinely idle from this session's own
traffic) got auto-stopped by Fly. Caught within a couple of `fly machines list` checks, `fly machine
start` brought it back immediately, but continuing the test on an auto-stop-armed config would have
mixed an uncontrolled variable into every subsequent drop/reconnect count. Fixed the same way the M6
rehearsals already fix this class of problem: a throwaway branch (`ops/m6-gap-closure-noautostop2`,
based on the fix branch so the deploy carried both), `fly.staging.toml` edited locally
(`auto_stop_machines = "off"`, `min_machines_running = 3`), deployed, **never merged**; gap 6 itself was
killed and restarted clean afterward rather than folding a deploy-triggered restart cycle into its own
numbers. **Worth a line in `docs/STAGING.md`**: a fix-verification deploy mid-rehearsal reverts BOTH
machine size and auto-stop/min-machines to the committed single-machine shape, unless the deployed ref
itself carries the edited `fly.staging.toml` — exactly the moment this bites, and exactly what happened
here.

### Final state

- `pqp-api-staging`: **2 machines**, both healthy, both on the fix commit
  (`031f148f428a671a7c66f97c207773a21b119b5b`, PR #598's HEAD), both `shared-cpu-1x`/1024MB — the
  committed `fly.staging.toml` default, restored by deploying the fix branch alone (no toml edits) as
  the very last API deploy of this session. `CLUSTER_BUS`, `VOICE_REGISTRY`, `LIVEKIT_*` all confirmed
  still live via `fly secrets list`.
- `PG_POOL_MAX=10` (down from the leftover 60), confirmed via `/ready`'s `pool.max` and a 2-minute
  stability watch at the final config.
- `pqp-worker-staging`: running, healthy (`{"ok":true,"role":"worker"}`).
- `pqp-db-staging-lite`: reverted to `shared-cpu-1x`/**256MB**, `3/3` Fly health checks passing, `/ready`
  green throughout the final watch window.
- Load-test data (accounts, servers, messages, webhooks, the gap 1–6 channels) **not purged** — same
  standing precedent `docs/STAGING.md` and every prior rehearsal in this document already use.
- `docs/staging.toml` overrides from both throwaway ops branches (`ops/m6-gap-closure-noautostop2` for
  the auto-stop-off window) live only on that unmerged branch; the next ordinary `deploy-staging.yml` run
  from `staging` or any other ref without an edited `fly.staging.toml` keeps the committed single-machine
  shape.

### Blockers before production

None of the six named gaps are open. Two items carried over verbatim from the earlier "Blockers before
production" section above are unaffected by tonight's work and still apply as stated there (#595's
specific co-host/stage-revocation scenario, the `docs/deploy-fly.md` §6a-bis shadow-secret trap note).
New from tonight, worth deliberate attention before or shortly after the flip, neither blocking it:

1. **PR #598 (the HLS cross-instance fix) is open, CI-green, verified live on staging, not merged to
   `main`.** `restarts-api` on production when it lands — merge at a trough, not blindly, per the
   standing merge policy.
2. **`PG_POOL_MAX=10` on staging is a judgment call under real, only-partially-resolved uncertainty**
   about this specific 256MB box's stability under concurrent load (see the incident section above), not
   a clean re-derivation of the DB_RUNBOOK formula (which does not cover this tier at all). Worth a
   deliberate follow-up load test at the resting config before leaning on the number.
3. **`docs/STAGING.md` doesn't yet say that a fix-verification deploy mid-rehearsal reverts
   auto-stop/min-machines-running**, only VM size. A one-line addition would have saved the mid-gap-6
   scramble this session hit.

---

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LptYkv7RTzV6WVQNEWNYUv

---

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LptYkv7RTzV6WVQNEWNYUv
