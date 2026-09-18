# Watch party 2026-09-12 (moonkase, ~800 members, ~200 watching + 60-90 seated): post-mortem plan

Status legend: P0 = before the next party, P1 = this month, P2 = backlog. Effort in engineer-days (agent-assisted).

## A. Platform (server / infra)

| # | Item | Why (evidence) | Effort | Prio |
|---|------|----------------|--------|------|
| A1 | Exempt egress identities (`EG_*`) from every SFU eviction sweep; cancel `voice_resweeps` rows when a channel goes public; log who triggered a sweep | 23:12–23:26: three permission saves scheduled 15-min sweeps that evicted our transcoder every 5 s and kicked seated users ("sai da call sozinho") | 0.5 | P0 |
| A2 | Database write budget: batch voice-registry seat writes and heartbeats, cache roster membership checks, coalesce presence broadcasts; add a counter for tx/s per seated user | ~330 tx/s with 276 clients and 60 seated; the shared-CPU node died at 23:23 | 2 | P0 — reads shipped (`READ_CACHE`, on); writes shipped behind `VOICE_REGISTRY_BATCH`, default off, see §G |
| A3 | Load test the **database** with the real shape: 60–100 seated churning, 300 watchers, 5 joins/min, 30 min sustained, against a clone of the prod plan; gate on pool queue depth and p99 query time | Every earlier test hit the playlist route or WS joins on staging's DB; the write path was never measured | 1 | P0 |
| A4 | Alerts: pool queued > 20 for 30 s, `select 1` > 50 ms, readiness false, HLS rung death rate; page to Rafael's phone | We learned about the collapse from viewers | 0.5 | P0 |
| A5 | Decommission `pqp-db-2`, verify nightly backup runs against `pqp-db-4`, update `docs/DB_RUNBOOK.md` with the stop-API-then-resize and the new-cluster-copy recipes (8 MB, 3 s dump) | Cluster still up; backup secret staged, not deployed | 0.5 | P0 |
| A6 | Merge freeze for events: a `freeze` label or a scheduled window in `deploy-api-fly.yml` that refuses server deploys; announce in `#moderacao` | 22:07 server merge dropped 168 sockets mid-announcement | 0.5 | P1 |
| A7 | Ghost egress records: clean the 9 stale ACTIVE egresses in LiveKit (Redis on sfu-pqp); make the box budget ignore records older than 1 h | 720p rung refused twice with `box-budget` while the box was idle | 0.5 | P1 |
| A8 | Operator changes outside the API (cancel session, flip private, delete sweep) must broadcast, or move them behind admin routes that do | Stale tabs: "Watch party not found", "already has a party", Encerrar "never closes" | 1 | P1 |
| A9 | Second API machine (needs `CLUSTER_BUS` + registry M3/M5 finished) so a deploy or crash is no longer a 40 s outage | Two restarts tonight, each ~40 s of refused connections | 3 | P2 |
| A10 | Egress worker on demand (snapshot + reserved IP), staging LiveKit off the party box | $48/mo idle, and staging sharing the party box | 1 | P2 |

## B. Presenter experience

| # | Item | Why | Effort | Prio |
|---|------|-----|--------|------|
| B1 | Desktop app screen-share parity: display-media handler, picker, Windows loopback excluding own audio, capability detection, unblocked Windows/Linux release | She lost 40 min to the app; Gio cannot share Pocket Bard; "no aplicativo buga para entrar" | in progress (agent) | P0 |
| B2 | Outgoing audio level meter + "stream is silent" warning in the host panel (after 10 s of digital silence) | Three silent stretches tonight; the panel said "da aba + mic" while -91 dB went out | 0.5 | P0 |
| B3 | Presenter checklist in the go-live flow: Chrome, tab share, tab audio ticked, film playing, 720p, camera off, mic unmuted; block "Ir ao vivo" from the desktop app until B1 ships | Every failure mode tonight was on this list | 0.5 | P0 |
| B4 | Voice default and copy: keep Voz off by default, explain in the modal what "on" costs (seats, echo, database load); moderators cannot herd the audience into the call | romulo910 told 90 people to join the call for lower delay | 0.25 | P0 |
| B5 | Mic-in-stream must not double: while the mix is live, unmuting the mic must keep the published mic track muted for the room; test on device | 00:31 "agora ta duplicado a voz dela"; romulo 20:42 "audio duplicado" | 0.5 | P1 |
| B6 | **Face in the stream**: a second Track Composite egress for the camera (360p, draft #492) rendered as a corner picture-in-picture on every viewer (click to swap, fullscreen hides it), plus the separate mic file (#518, dark) and a camera file for clips. Owner's framing: the transmission IS the product (screen + voice + face), nobody joins a call to get any of it | "UMA CAMERA" x2; "nao entrando na call n da pra ver a camera"; clip-making | 2 (PiP egress + viewer) | P0 |
| B7 | Quality selector remembers per user, not per browser; default 720p even if the last session was 1080p | She came back on 1080p three times | 0.25 | P1 |
| B8 | **Encerrar must always work**: idempotent end (an already-ended or stale session id refreshes state instead of erroring), a visible error when it fails, and never coupled to leaving the room silently | Host: "eu fico tentando fechar por aqui NUNCA FECHA"; every end had actually succeeded server-side, the tab was stale | 0.5 | P0 |

## C. Viewer experience

| # | Item | Why | Effort | Prio |
|---|------|-----|--------|------|
| C1 | Delay framing: "ao vivo · 25 s" badge visible by default, copy "atraso normal da transmissão", and a one-line explanation the first time; no "lag" wording | "delay do cão", "30 segundos atrasado pra todos?" x10; delay misread as breakage drove the call rush | 0.5 | P0 |
| C2 | Join/leave sounds auto-muted above 10 people in a room, with a visible toggle | "PILIM PILIM DE CONECTANDO TODA HORA", "como muta o som da galera" | 0.25 | P0 |
| C3 | Bubbles screen says what is happening: "reconectando" vs "a apresentadora ainda não compartilhou" vs "a transmissão reiniciou, volta em 10 s", with a small countdown | "bolhas" x30; nobody knew if it was them or us | 0.5 | P0 |
| C4 | Seated + watching on two devices: detect the same user seated and on HLS and warn about echo; audio de-dupe hint | "to fora da call e só na watch pq tava duplicado" | 0.5 | P1 |
| C5 | Mobile fullscreen discoverability (web-mobile hint, iOS rotate hint, Android) and stability under reconnect storms | "tem como deixar em tela cheia?", "PELO CELULAR TAVA PIOR", "celular vai explodir" | 1 | P1 |
| C6 | Mini-player on voice channels (#520) and ended-card fix (#521 shipped); post-party merges: #517 RNNoise, #518 mic archive, #520 | ready | 0 | P0 (merge) |
| C7 | Reconnect storm damping: jittered reconnect backoff on the client, and a server-side connect rate limiter that sheds gracefully instead of failing readiness | Each recovery re-triggered the collapse | 1 | P1 |
| C8 | Viewer playlist token refresh at 50 min without a stall (server pushes a fresh `hlsUrl` on `channel-live`, or the client re-fetches before expiry); native players need the same URL swapped in without re-buffering | 01:00 to 01:05: rolling `hlsPlaylistRejected reason=expired` waves, one 10 s bubble per viewer per hour | 0.5 | P0 |
| C10 | **No "join call" for the audience.** With Voz off (default) viewers see no call button, no seat count, no join sounds; the card reads "assistindo · N". The call is renamed **Palco**, reachable only from the host's controls for host and co-hosts. With Voz on it appears as "Pedir para falar" (a stage request), never as "entrar na call" | "q chamada?", "como entra na chamada?", and a moderator herding 90 people into the call; owner: "the 'join call' is so confusing, not sure we need it" | 0.5 | P0 |
| C9 | **Refresh mid-party must land clean**: after F5 during a live party the layout comes back wrong (stacked surfaces, stale party card, dock host in the wrong place). Reproduce with a live party and a reload on web, mobile web and the apps; fix each | Owner: "if you refresh screen gets extra buggy"; viewers were told to F5 all night | 1 | P0 |

## D. Process

| # | Item | Effort | Prio |
|---|------|--------|------|
| D1 | Event runbook: T-24h checks (DB plan, disk, secrets, freeze on), T-1h presenter test share with OBS running, T-0 roles (who touches what: nobody edits channels), during (dashboards to watch), after (archive, keep_replay, decommission) | 0.5 | P0 |
| D2 | One dashboard for events: sockets, seated, watching, pool queue, DB latency, egress CPU, rung state, restarts | 0.5 | P0 |
| D3 | Post-event survey link in the party chat at "Encerrar" (three questions) | 0.25 | P2 |


## E. Target infrastructure on Vultr São Paulo (decision 2026-09-13: move everything off Fly)

Order: database first, one party on it, API second. Keep Fly's `pqp-api` and the Fly cluster as rollback for ~30 days (one month of double cost, about $60 to 80 extra).

| service | today (Fly / Vultr) | target on Vultr | plan | est. cost/mo |
|---|---|---|---|---|
| API + worker + cron backup | Fly performance 2 vCPU / 4 GB + two shared machines, ~$66 | one box, Docker, Caddy or Cloudflare in front, GitHub Actions deploy over SSH | `vhp-4c-8gb-amd` (4 vCPU / 8 GB) | $48 (a `vhp-2c-4gb-amd` at $24 would carry today's load of 0.4; take 4 cores for headroom until the second instance exists) |
| Postgres | Fly Managed Postgres Launch, $282 (Starter $72 collapsed) | Vultr Managed PostgreSQL, single node, daily backups, same city | 4 vCPU / 8 GB tier | ~$120 (2 vCPU / 4 GB tier ~$60 once A2 lands and A3 proves it; HA replica roughly doubles either) |
| Postgres, self-hosted alternative | | own box, WAL archiving to R2, restore drill | `vhp-4c-8gb-amd` | $48, plus ~2 h/month of care |
| SFU (LiveKit) | Vultr 4 vCPU / 8 GB, $48 | downsize: peak tonight was 34% of one core and 400 MB at 58 participants | `vhp-2c-4gb-amd` | $24 (bump on party days above ~150 seated) |
| Egress / party box | Vultr 4 vCPU / 8 GB always on, $48 | on demand: snapshot + reserved IP, created ~15 min before a party, destroyed after | `vhp-4c-8gb-amd` while up | ~$4 idle + ~$0.07/h while up (a 4 h party ≈ $0.30); ~$10/mo at one party a week |
| Edge, TLS, DDoS | Cloudflare Pages + Cloudflare proxy | same, plus api.pqp.gg proxied | free | $0 |
| Object storage | R2 (attachments, live HLS, backups) | same | | ~$5 |
| Auth, monitoring, analytics | Clerk free tier, Grafana Cloud free, Umami | same | | $0 |
| **Total, managed Postgres 4 vCPU** | **~$450 today** | | | **~$207** |
| **Total, managed Postgres 2 vCPU** | | | | **~$147** |
| **Total, self-hosted Postgres** | | | | **~$135** |

Prices are Vultr list prices as of 2026-09-12 (`vhp-*` plans from the Vultr API; managed PostgreSQL tiers from memory of the current price sheet, confirm at checkout). Nothing in this table moves with viewer count: HLS viewers cost R2 reads (free egress). Seated voice moves the SFU box; database write rate moves the Postgres tier, which is what A2 attacks.

## F. Interim state to unwind (as of 2026-09-13 01:00Z)

- `pqp-api` runs on `pqp-db-4` (Launch, PG 17) via the **direct** host, `PG_POOL_MAX=70`. `pqp-worker` repointed. `pqp-db-backup`'s `BACKUP_DATABASE_URL` is staged, not applied.
- Old cluster `pqp-db-2` still exists: verify one nightly backup from the new cluster restores, then destroy it.
- Ephemeral machine `migrate-pg17b` in app `pqp-db-backup` to destroy.
- Nine ghost ACTIVE egress records in LiveKit (A7).
- Recording of tonight: mirror on the egress box under `/srv/party-archive/live/318a0954-.../`, stitch with `ffmpeg -f concat`; set `keep_replay` on tonight's sessions before the 3 h retention passes.
- PRs ready to merge in the post-party window: #517 (RNNoise, opt-in), #518 (mic archive, restarts-api, dark), #520 (mini-player on voice channels), #524 (desktop share parity, then tag 0.1.6).

## G. A2, the write half: the voice-registry write coalescer (2026-09-18, behind a flag)

A2 was two halves. The **read** half shipped as `server/src/lib/read-cache.ts` (`READ_CACHE`, on by
default): identical Postgres reads during a reload storm are coalesced, and 200 concurrent cold
bootstraps against staging are now unremarkable. The **write** half was still open, and a staging
run on 2026-09-18 said so in numbers:

| what | measured on staging, 2026-09-18 |
|---|---|
| 800 seated sockets rejoining at once | pool wait queue **4,604** on one API process (1,765 on each of two). `lib/db-breaker.ts` opens at a queue of 8 for 5 s, so the breaker opened and **every rejoin failed** |
| ~700 seats leaving at once | `checks.postgres.ms` **1,225**, 141 queries queued, for a minute |
| 200 concurrent cold bootstraps (reads) | fine — the read cache does its job |

The cause is one line of arithmetic: with `VOICE_REGISTRY=postgres`, a join, a state change and a
leave are each their own statement on their own pooled connection, so the pool sees the fan-in of
the event rather than the work of it.

**What shipped**: `VOICE_REGISTRY_BATCH` (`server/src/voice/registry-batch.ts`), **default off**.
On, peer upserts, peer deletes, orphan stamps, retired ids and the two empty-room tidies for this
instance are queued and flushed every `VOICE_REGISTRY_BATCH_MS` (default 50) or as soon as
`VOICE_REGISTRY_BATCH_MAX` (default 200) rows are waiting, as one multi-row statement per kind
inside **one transaction on one pooled connection**, with at most one flush in flight. The queue
absorbs the burst so the pool sees one checkout instead of hundreds. Measured in
`server/src/voice/registry-batch.test.ts` against a real Postgres: 500 joins then 500 leaves cost
**2,000 statements with the flag off and 20 with it on**, four flushes, 300 rows in the largest,
p95 flush 3 ms.

**Ordering is preserved, and that is a correctness rule, not a nicety** (CLAUDE.md pitfall 13).
`ws/voice.ts`'s `trackRowWrite` still chains a peer's writes, so a peer's second op is not enqueued
until the first op's flush has committed; inside a flush the queue holds at most one op per peer
and the later one wins, folded rather than appended (an orphan stamp lands *inside* a pending
upsert so its state change is not lost, and a delete an upsert replaced is remembered); and the
"is this seat still in the map" check is re-asked at **flush** time, because batching opens a new
window between a write being asked for and the statement going out. A `set-voice-state` behind a
leave therefore still cannot resurrect a seat.

**What is deliberately not batched**: the instance heartbeat (already one row per instance per
tick), `sweepOwnStaleVoicePeers` and `reconcileVoiceRegistry` (already one statement each however
many peers they touch), and the moderator mute / raised hand / watch-party / music writes, which
are one write per deliberate human action rather than seat churn.

**Turning it on**: set `VOICE_REGISTRY_BATCH=on` (restarts the API). Watch `voice.registry.batch`
on `GET /api/admin/metrics` — `rowsCoalesced / batchFlushes` is the compression ratio and a ratio
of about 1 means the flag is on and buying nothing; `flushFailures` (a flush that failed twice and
fell back to per-row writes) and `staleDropped` (the pitfall-13 guard firing) both belong at zero.
`voice.registry.writesPerMinute` deliberately keeps counting row writes *asked for* rather than
statements issued, so it stays comparable across the flip and a healthy batcher cannot make the
graph look like a voice outage. Rollback is unsetting it.

**Still open in A2**: the leave path's per-seat `listVoicePeersInRoom` (one roster read per leave,
to decide whether the person's hand should come down) and the presence broadcast coalescing. Both
are reads or fan-out rather than registry writes, and neither was what the numbers above pointed at.
