# Event runbook: running a watch party

A checklist for the operator (today: Rafael, alone) running a watch party
that will draw a crowd. Written after the 2026-09-12 MoonKase party (~800
members, ~200 watching, 60 to 90 seated) took production down twice in one
night: a merge dropped 168 sockets mid-announcement, and the shared-CPU
database died at ~330 tx/s with 276 clients and 60 seated. Full account and
the fix list this runbook operationalizes:
[`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`](./plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md).

This is a checklist, not a tutorial. Every step links to the doc that
actually explains the thing.

---

## T-24h

- [ ] **DB plan.** Read `docs/DB_RUNBOOK.md` §3 (`PG_POOL_MAX`) and confirm
      the deployed value is the one measured for this event's expected seated
      count, not whatever was last set for a different occasion. Do **not**
      resize the managed cluster itself in the 24h before or during the
      event (`docs/DB_RUNBOOK.md` says this in as many words, and it is what
      triggered the 2026-09-05 incident that doc exists to describe).
- [ ] **Freeze on.**
      ```bash
      gh variable set DEPLOY_FREEZE --body true
      ```
      One variable gates both `deploy-api-fly.yml` and `deploy-api-vultr.yml`
      (whichever `DEPLOY_TARGET` is live). Confirms on the next CI run as
      that workflow's `deploy` job showing **skipped**, not a failure.
      Announce it (`#moderacao` or wherever the team reads) so nobody is
      surprised a merged PR did not deploy. See "Merge freeze" below for
      what it does and does not cover.
- [ ] **Disk.** `fly mpg status <production-cluster-id> --json` (id from
      `fly mpg list --org personal`; see `docs/DB_RUNBOOK.md`) for Postgres
      volume headroom, and glance at the SFU box's root filesystem panel on
      the **pqp SFU box** Grafana dashboard (`docs/MONITORING.md` §"The SFU
      box"; alerts at 85%). Both are also covered by the daily
      `postgres-disk` / `root filesystem` checks, but T-24h is when you have
      time to act on a bad number instead of discovering it mid-party.
- [ ] **Secrets.** Confirm on `pqp-api`: `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
      `LIVEKIT_API_SECRET` (SFU), `LIVE_HLS_*` (watch-party bucket; see
      `docs/WATCH_PARTY.md`), `ADMIN_METRICS_TOKEN` (dashboard and the
      exporter below). Confirm the SFU box has the same
      `ADMIN_METRICS_TOKEN` copied into `/etc/pqp-api-metrics.env` (see
      `tools/monitoring/README.md`) — a stale or missing copy there makes
      three of the four event alert rules read "no data" all night without
      anybody noticing until it matters.
- [ ] **Retention.** Check the deployed `LIVE_HLS_RETENTION_MINUTES` on
      `pqp-api` against the default in `server/src/voice/hls-egress.ts`
      (10 minutes when a session is not marked `keep_replay`). Ten minutes is
      not long enough to notice a good clip and mark it after the fact during
      a live event — see "After" below, `keep_replay` has no product surface
      at all, only a direct SQL update, and there is nobody watching for it
      to happen unless someone is deliberately looking within that window.
      Consider raising `LIVE_HLS_RETENTION_MINUTES` for the event window (a
      plain env var change, `restarts-api`) so "After" has time to act, and
      drop it back afterward — do not leave it raised, it grows the R2 bill
      for replay storage nobody asked for.
- [ ] **Monitoring imported.** Import (or confirm still imported from a
      previous event)
      `tools/monitoring/grafana-alert-rules-event.json` and
      `tools/monitoring/grafana-dashboard-event.json` — see
      `tools/monitoring/README.md`. Confirm the exporter is running:
      ```bash
      ssh root@216.238.114.79 'systemctl is-active pqp-api-metrics.timer'
      ssh root@216.238.114.79 'cat /var/lib/node_exporter/textfile_collector/pqp_api.prom | grep scrape_ok'
      ```
      `pqp_api_metrics_scrape_ok 1` is the pass. If it is `0` or the timer is
      not active, fix it now — these are the readings the four event alert
      rules key on, and `noDataState: Alerting` on three of them means a dead
      exporter pages you as if the API were down, which is at least honest,
      but only if you notice it before the party rather than during it.

## T-1h

- [ ] **Presenter test share, with OBS live.** The presenter shares their
      actual capture (OBS or the browser tab that will be shared for real),
      **voice off** (`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` B4:
      keep Voz off by default — a moderator herding the audience into the
      voice call for "lower delay" is exactly what turned 60 seated into
      pressure the database had never been measured against), **720p**
      (B3/B7: the default the client ladder holds a room above 20 people to;
      do not test at 1080p and assume it downgrades correctly under load).
      Confirm on the host panel: an outgoing audio level meter is moving (B2:
      three silent stretches happened because "da aba + mic" was checked
      while -91 dB went out), camera off, mic unmuted, film actually playing.
- [ ] **Watch the Event dashboard for 5 minutes** with the test share live:
      sockets, seated, pool, DB latency, egress box CPU should all be flat
      and unremarkable before a real audience shows up. See "During" below
      for what a bad reading on each one means.
- [ ] **If rehearsing size:** run the three-process load recipe in
      `tools/watch-party-load/README.md` §"The recommended event rehearsal"
      **on staging**, not production, days before — not at T-1h. It takes 30
      minutes and needs staging headroom (`docs/STAGING.md` §"Load testing
      staging"): `index.ts shard --presenter-only` (the share),
      `seat-churn.ts --seats 80 --churn-per-minute 5 --duration-seconds 1800`
      (60 to 100 seated, churning), `hls-audience.ts --viewers 300` (the
      watchers). Never load-test from the presenter's own machine (measured
      2026-09-12: it competes with the camera for the same uplink) and never
      against production hosts — both scripts refuse to.

## Roles

**Nobody edits channel permissions, roles, or server settings during a live
party. Only the designated host or co-host touches Ir ao vivo / Encerrar.**
This is the single highest-value rule on this page: the 2026-09-12 incident's
first outage was a permission save at 22:07 that dropped 168 sockets mid
announcement, and three more permission saves between 23:12 and 23:26
scheduled sweeps that evicted the transcoder every 5 seconds and kicked
seated users ("sai da call sozinho"). None of those saves were reckless —
each looked like an ordinary, safe action taken at the wrong moment. During
an event there is no such thing as an ordinary settings change.

- **Encerrar** (ending the party) is narrower than it looks: only the
  party's `host` and a promoted `cohost` may call it
  (`packages/shared/src/watch-party-session.ts`'s role table on the `end`
  action) — not a server owner, not an admin, not anyone else holding
  `MANAGE_CHANNELS` (`docs/WATCH_PARTY.md`'s role table says so explicitly:
  a "manager" cannot Encerrar a party they did not start or co-host). Before
  the event, say out loud (and in whatever channel the team reads) who the
  host and co-host actually are, because **there is no operator override**:
  nobody else, not even the person running this runbook, can force-end a
  party from outside it today. If the host's session breaks mid-show, the
  only way to end it is a promoted co-host, or waiting for the host-inactivity
  sweep the server also runs on its own.
- **The double-Encerrar gap is still open** (postmortem B8, unresolved as of
  this writing): a second end attempt on an already-ended or stale session id
  gets a conflict error from the API rather than a quiet "already ended, here
  is the current state." On the night this was written up, every one of those
  errors turned out to mean the first press had already succeeded — the tab
  was stale, not the party. If Encerrar appears to fail, **check whether the
  party actually ended before pressing it again**; do not assume the error is
  real.
- **The operator** (reading the Event dashboard, deciding whether to
  intervene) does not have to be the same person as the presenter's co-host,
  and on a one-person team it usually is the same person by necessity — say
  so and know that means dashboard-watching and Encerrar-pressing are
  competing for the same attention.
- **Nobody else touches Fly, the database, or the SFU box during the show.**
  If something needs a `fly secrets set` or a `fly mpg` command, that is
  already "During" below, not a routine change.

## During

Watch the **pqp Event** dashboard
(`tools/monitoring/grafana-dashboard-event.json`, imported at T-24h). What
each panel means and what to do about a bad reading:

| Panel | Healthy | Bad reading means |
|---|---|---|
| Sockets | tracks the audience roughly 1:1 | A cliff is a mass disconnect (a deploy despite the freeze, or a crash) — check "API restarts" next to it |
| Seated | near the number you planned for | Climbing well past plan with no matching drop elsewhere is more voice load than budgeted; consider asking the presenter to keep saying voice is optional |
| Watching | not tracked server-side — see the panel's own text | Read audience size off the stream platform itself (Twitch/YouTube), not pqp |
| Pool in-use / queued | queued near 0 | Queued sustained above 20 is the 2026-09-12 collapse shape starting. This is the earliest number that moves, before anything else looks wrong. Alert: "Pool queued > 20 for 60s" |
| DB latency (postgres ms) | low single-digit to double-digit ms | Sustained above 200ms for 2+ minutes is Postgres straining under write load (A2's write-budget concern). Alert: "/ready postgres ms > 200 for 2m" |
| Egress box CPU | well under 85% | High CPU here is what actually stalls a watch party's transcode, not API pool pressure — cross-check against HLS rungs/deaths |
| HLS rungs / sessions | matches how many watch-party shares are live, rungs = renditions per share | `orphansStopped` above 0 is pitfall 15 (a leaked transcode); rungs dropping without a matching `voice.hlsRungDied` log line is worse — a rendition vanished silently |
| API restarts | flat zero | Any bump means something restarted the API despite the freeze — a crash, an OOM, or someone running `fly deploy`/`fly machine restart` by hand. Every restart drops every `/ws` (CLAUDE.md pitfall 11) |
| HLS rung deaths | occasional single deaths, self-healing | More than 3 in 5 minutes is the media box or LiveKit egress struggling, not a one-off hiccup |

The five alert rules in `tools/monitoring/grafana-alert-rules-event.json`
page the same contact point (`rafael-email`, per `docs/MONITORING.md`) the
instant any of the above crosses its threshold, so watching the dashboard is
belt, the alerts are braces — do not rely on either alone if you can help it.

**If the pool queue or DB latency alert fires:** do not resize the database
live (`docs/DB_RUNBOOK.md` says this explicitly and it is how the 2026-09-05
incident started). If it is bad enough to be an outage, follow
`docs/DB_RUNBOOK.md` §2, "Production Postgres is degraded" — restore into a
fresh cluster, repoint the API, one restart — the same recipe exercised again
during 2026-09-12 (see that postmortem's §F, "Interim state to unwind," for
what an in-flight repoint actually looked like that night).

**If "API restarts" fires and you didn't do it:** check whether
`DEPLOY_FREEZE` actually landed (`gh variable list` — it is a repo variable,
not a secret, so this is instant) and check `fly machine list -a pqp-api`
for a crash-restart. A frozen repo does not stop a manual `fly deploy` or a
platform-initiated restart; the freeze only gates the automated workflow.

**If someone reaches for a permission change, a role edit, or a server
setting:** stop them. That is the whole lesson of this postmortem's A1 item.
If it truly cannot wait, it goes through the one person named in "Roles"
above, and everyone else keeps watching the dashboard through it, because a
permission save is exactly what triggers an SFU eviction sweep 15 minutes
later with no warning.

## After

- [ ] **`keep_replay`.** For any session worth keeping, before the retention
      window from the T-24h check passes:
      ```sql
      -- fly mpg connect <production-cluster-id> --database fly-db
      update hls_sessions set keep_replay = true
        where channel_id = '<channelId>' and ended_at > now() - interval '1 hour';
      ```
      There is no HTTP route for this (`server/src/voice/hls-cleanup.ts`'s
      sweep is the only consumer of the column) — it is a direct SQL update
      against production, the same pattern as the community-suspension flip
      CLAUDE.md documents elsewhere. `keep_replay = true` extends the window
      to `LIVE_HLS_REPLAY_HOURS` (default 24h); `false` (the default) is gone
      in `LIVE_HLS_RETENTION_MINUTES`, and once the sweep runs there is no
      undo.
- [ ] **Mirror / stitch a recording**, if the egress box kept one (see the
      postmortem's §F for the 2026-09-12 example path under
      `/srv/party-archive/live/`; `ffmpeg -f concat` joins the segments).
      Do this before the retention sweep above removes the source objects it
      was mirrored from.
- [ ] **Unfreeze.**
      ```bash
      gh variable set DEPLOY_FREEZE --body false
      ```
      Flipping the variable does **not**, by itself, deploy anything: a
      commit whose CI run already completed *while frozen* only becomes
      "needed" the next time the deploy workflow actually runs, and nothing
      reruns it automatically just because the variable changed. If nobody
      merges again soon, whatever piled up during the freeze sits undeployed
      indefinitely — contrary to what the old wording here implied. So kick
      a reconciliation run explicitly, right after unfreezing:
      ```bash
      gh workflow run "Deploy API (Fly)"       # or "Deploy API (Vultr)",
                                                # whichever vars.DEPLOY_TARGET
                                                # is live
      ```
      That dispatch diffs `main` against whatever commit `/health` says is
      actually deployed (not just the last merge), so it picks up every
      commit skipped during the freeze in one pass, however many piled up.
      Expect a short burst of `restarts-api` activity if several did. Pick a
      quiet moment to unfreeze and dispatch if you can, the same way any
      other API-restarting merge waits for a traffic trough rather than
      going out mid-event.
- [ ] **Retention back down.** If `LIVE_HLS_RETENTION_MINUTES` was raised at
      T-24h, drop it back — leaving it high forever quietly grows the R2 bill
      for storage nobody is going to watch again.
- [ ] **Decommission anything stood up only for this event** — a temporary
      Managed Postgres cluster for a rehearsal (`docs/STAGING.md`), a scaled
      SFU box, an ephemeral load-test machine. The 2026-09-12 postmortem's
      own unwind list left an old cluster running pending a backup-restore
      verification before destroying it (its §F, "Interim state to unwind")
      — plan the verification step in, don't let "decommission later" become
      "never."
- [ ] **Read back the dashboard's own numbers** one more time (sockets back
      to baseline, pool queue at 0, no lingering HLS sessions) before calling
      it done. Pause or delete the `pqp-event-guardrails` Grafana alert group
      if you are not running another event soon — see
      `tools/monitoring/README.md` for why it is meant to be event-scoped
      rather than left firing forever.

---

## Reference: merge freeze

`DEPLOY_FREEZE` is a single GitHub repo variable read by **both**
`.github/workflows/deploy-api-fly.yml` and
`.github/workflows/deploy-api-vultr.yml`, so it stops whichever one
`vars.DEPLOY_TARGET` currently points at without needing to know which that
is. While it is `true`, each workflow's `deploy` job's own top-level `if`
condition is false, so the job shows **skipped** rather than run — a frozen
deploy is a deliberate skip, not a malfunction, so it does not open a red X
anybody has to explain later. Because the check sits in the job's `if`
rather than inside a step, it applies to a manual `workflow_dispatch` the
same as it applies to the automatic post-CI trigger — there is no path
through either workflow that deploys while the variable is `true`.

```bash
gh variable set DEPLOY_FREEZE --body true    # freeze
gh variable set DEPLOY_FREEZE --body false   # unfreeze
gh variable list                              # confirm what is set right now
```

Labeling a pull request `freeze` makes the `announce-freeze` job in
`.github/workflows/ci.yml` comment "server deploys are frozen for an event"
on that PR, so a contributor who was not in the room when the freeze went on
still finds out before wondering why their merge did not deploy. The label
only announces; it does not itself do anything to either deploy workflow —
the repo variable is the actual gate, and it applies to every PR, labeled or
not.

The freeze covers the automated deploy workflows only. It does not stop a
manual `fly deploy` / SSH deploy, a platform-initiated machine restart, or a
crash — see "During" above for what to check if "API restarts" fires
anyway.

Unfreezing does not itself deploy anything skipped during the freeze; the
"Unfreeze" step above covers the explicit `gh workflow run` reconciliation
dispatch that does.

## Reference: what's in `tools/monitoring/`

See `tools/monitoring/README.md` for the full detail. Short version: a
Python exporter turns `GET /api/admin/metrics` into a Prometheus textfile on
the SFU box (piggybacking on the Alloy collector `tools/sfu-monitoring/`
already runs there), five Grafana alert rules key off it plus existing Loki
log lines, and one dashboard JSON puts the panels this runbook's "During"
section talks about in one place. All three are event-scoped: install and
import them per event rather than assuming a previous event left them
running and correctly configured.
