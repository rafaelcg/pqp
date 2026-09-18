# Event guardrails + live product monitoring

Everything added for `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` items
A4 and D2 (the event-window alert rules and dashboard), plus a second,
standing dashboard added later for day-to-day product gauges (online users,
voice by backend, watch party, infra basics) -- both read the same exporter.
The always-on monitoring this repo already runs (uptime, error rate, the SFU
box) is documented in [`docs/MONITORING.md`](../../docs/MONITORING.md) and is
**not** duplicated here.

The alert rules and `grafana-dashboard-event.json` are scoped to an event
window: install and enable them before a party per
[`docs/EVENT_RUNBOOK.md`](../../docs/EVENT_RUNBOOK.md). `grafana-dashboard-live.json`
is meant to stay up permanently instead, same posture as the always-on
dashboards in `docs/MONITORING.md`. It is fine to leave the exporter running
quietly all the time either way (it costs one `GET /api/admin/metrics` every
20s), even though the alert rules are meant to be imported/removed per event
rather than left firing forever -- see the `_comment` block at the top of
`grafana-alert-rules-event.json` for why.

**The exporter is not installed anywhere today.** Every `pqp_api_*` series
below, on either dashboard, exists only once `pqp-api-metrics-exporter.py` is
actually running on a box with a Prometheus textfile collector -- see
"Install" below. Until then those panels correctly read "No data".

| File | Role |
|---|---|
| `pqp-api-metrics-exporter.py` | Reads `GET /api/admin/metrics` (the `ready`, `runtime`, `voice`, `liveHls` and `cluster` blocks) every 20s and writes a node_exporter textfile, so readiness, Postgres latency, pool queue depth, seated count, sockets, voice-by-backend, HLS rung/session counts and the DB breaker state become Prometheus series Grafana can alert and graph on over time, not just read as an instantaneous pull. |
| `pqp-api-metrics.service` / `.timer` | The systemd timer that runs it. |
| `install.sh` | Idempotent installer for the box above. |
| `grafana-alert-rules-event.json` | Grafana Alerting file-provisioning format: the 5 event-window alert rules (readiness false 60s, `/ready` postgres ms > 200 for 2m, pool queued > 20 for 60s, HLS rung deaths > 3 in 5m, API process restarted). Contact point `rafael-email`, same as every other alert in this repo's Grafana stack. |
| `grafana-dashboard-event.json` | Event-scoped "pqp Event" dashboard: sockets, seated, watching (see below), pool in-use/queued, DB latency, egress box CPU, HLS rungs/sessions, restarts, rung deaths. |
| `grafana-dashboard-live.json` | Standing "pqp Live" dashboard: online users, voice calls (mesh vs livekit), voice rooms by backend, largest/peak room size, watch party sessions/rungs (+ the same "no viewer count" note as the event dashboard), SFU box CPU, egress box CPU, DB pool + breaker, and the exporter's own scrape health. See "Live dashboard" below. |
| `test_exporter.py` | `unittest` coverage for the exporter's `render()` (payload dict in, Prometheus text out) -- the by-backend zero-default behaviour, the breaker gauge, and that no viewer gauge is invented. Run with `python3 -m unittest tools/monitoring/test_exporter.py`. |

## Install

Runs on the self-hosted SFU box (`216.238.114.79`) alongside
`tools/sfu-monitoring/`, which already has Grafana Alloy and a textfile
collector -- no Alloy config change is needed, it just picks up the new
`pqp_api.prom` file the same way it already reads `pqp_sfu_*.prom`. It could
run anywhere else with Python 3 and egress to `api.pqp.gg`; the box is the
obvious choice because it is already always-on and already monitored for its
own liveness.

```bash
scp -r tools/monitoring root@216.238.114.79:/opt/
ssh root@216.238.114.79 'bash /opt/monitoring/install.sh'
# paste the token at the hidden prompt -- it is never typed on a command line
```

Do **not** run `ADMIN_METRICS_TOKEN=<value> bash install.sh`, over SSH or
locally: an env var set inline on a command like that lands in the local
shell's history and, on the remote box, is visible to anyone else on it via
`ps` for as long as the process runs. `install.sh` instead prompts for the
token with echo off when it has a real TTY, so pasting it interactively is
the normal path. Scripting the install non-interactively (no TTY to prompt
on) pipes the token over stdin instead, which keeps it out of argv on both
ends:

```bash
printf '%s\n' "$ADMIN_METRICS_TOKEN" | ssh root@216.238.114.79 'bash /opt/monitoring/install.sh'
```

(`$ADMIN_METRICS_TOKEN` there is a local shell variable read once from a
secrets manager or an already-hidden prompt, not typed as part of this
command.) A pre-created `/etc/pqp-api-metrics.env` (mode `0600`, see below)
works too and skips the prompt entirely.

`ADMIN_METRICS_TOKEN` is the same value set as a Fly secret on `pqp-api` (see
CLAUDE.md's env var table and `tools/admin-dashboard/README.md`) -- this
script is a second, read-only consumer of that one token, not a new secret.
Needed only on first install or to rotate; leaving the prompt blank (or
piping an empty line) leaves the existing `/etc/pqp-api-metrics.env` alone.

Check it is working:

```bash
ssh root@216.238.114.79 'systemctl is-active pqp-api-metrics.timer'
ssh root@216.238.114.79 'cat /var/lib/node_exporter/textfile_collector/pqp_api.prom'
```

`pqp_api_metrics_scrape_ok` is `1` on a healthy scrape and `0` on the last
failure (bad token, API unreachable); when it fails, every other gauge in the
file is dropped rather than left stale, so a broken exporter reads as "no
data" in Grafana rather than a confident wrong number.

## Alert rules

Import `grafana-alert-rules-event.json`: Alerting > Alert rules > "Import"
(or `POST` it to `/api/v1/provisioning/alert-rules` if you'd rather script
it). Replace the two placeholder datasource UIDs first -- the import dialog
also offers to remap them. Full reasoning for each threshold is in the
file's own `annotations.description` and in the postmortem's A4 row.

These are **event-scoped**, not part of the standing `pqp-api-logs` /
`pqp-sfu-box` groups that run forever: "API process restarted" fires on every
ordinary deploy, which is exactly the point during a freeze (A6, see
`docs/EVENT_RUNBOOK.md`) and exactly the noise you don't want the rest of the
time. Import before an event, pause or delete the `pqp-event-guardrails`
group after.

## Dashboard

Import `grafana-dashboard-event.json` the same way: Dashboards > New >
Import. It pulls from three places at once -- the new exporter above, the
existing `tools/sfu-monitoring` Prometheus series (egress box CPU), and Loki
log lines (restarts, HLS rung deaths) -- which is the point of an event
dashboard: the four postmortem panels that needed a genuinely new number
(sockets, seated, pool, DB latency, rungs) sit next to the ones that already
existed.

**"Watching" is a text panel, not a graph.** pqp does not count concurrent
HLS viewers anywhere server-side -- the playlist proxy is a stateless,
unauthenticated-per-request pull with no access log -- and inventing one would
mean touching `server/src/voice/hls-playlist-proxy.ts`, which is runtime
code and out of scope for a monitoring-only change. During a real event, read
the audience size off the stream itself (Twitch/YouTube), the way the
2026-09-12 postmortem's own ~200-watching figure was read. During a rehearsal,
`tools/watch-party-load/src/hls-audience.ts`'s own progress output and final
report are the closest thing pqp has to this number.

## Live dashboard

Import `grafana-dashboard-live.json` the same way: Dashboards > New > Import
(or script it with `POST /api/dashboards/db`, body `{"dashboard": <the JSON>,
"overwrite": true}`, same auth as any other Grafana API call against this
stack). 7-day default range, 1 minute refresh -- meant to be glanced at, not
an event war room (that's `grafana-dashboard-event.json`'s 3h/30s).

Gauges added to the exporter for this dashboard, all on top of the existing
ones (`pqp_api_sockets`, `pqp_api_voice_participants`,
`pqp_api_voice_active_rooms`, `pqp_api_hls_sessions`, `pqp_api_hls_rungs`,
`pqp_api_hls_orphans_stopped_total`, `pqp_api_ready_*`,
`pqp_api_metrics_scrape_ok`, `pqp_api_metrics_collected_seconds`, all
unchanged):

| Gauge | Reads | Notes |
|---|---|---|
| `pqp_api_users_online` | `cluster.sockets` | Closest thing to "people online" this payload has -- pqp has no field deduped by user; see the gauge's own HELP text. |
| `pqp_api_voice_participants_by_backend{backend}` | `voice.rooms[].participants` summed by `voice.rooms[].transport` | `backend` is `mesh` or `livekit`, both always emitted (0 when nobody is on that backend) so the stacked panel never reads "no data" just because a call ended. |
| `pqp_api_voice_rooms_by_backend{backend}` | Count of `voice.rooms[]` by `transport` | Same zero-default behaviour as above. |
| `pqp_api_voice_largest_room_now` | `voice.largestRoomNow` | |
| `pqp_api_voice_peak_room_size_today` | `voice.peakRoomSizeToday` | Resets on deploy and at Sao Paulo midnight, same as the field it reads. |
| `pqp_api_db_breaker_open` | `runtime.db.breaker.state` | `1` when `open` or `half-open`, `0` when `closed` (pitfall 17 in `CLAUDE.md`). |

**No `pqp_api_hls_viewers` and no `pqp_api_hls_active_sessions`.** pqp has no
server-side count of concurrent watch-party viewers anywhere -- same finding
as the event dashboard's "Watching" panel, carried over rather than invented;
see the comment above the `liveHls` gauges in `pqp-api-metrics-exporter.py`.
`pqp_api_hls_sessions` (already exported) is the only session count there is,
so a distinct "active sessions" gauge would just be a second name for the
same number.

## What still needs a human, every time

- Datasource UIDs in all three JSON files are placeholders (`<PROMETHEUS_DATASOURCE_UID>`,
  `<LOKI_DATASOURCE_UID>`) -- nothing here is provisioned from the repo, matching
  every other dashboard and alert group in `docs/MONITORING.md`: the Grafana UI
  is the source of truth once imported, and these files are the starting point.
  On this stack today those resolve to the Grafana Cloud built-ins, uid
  `grafanacloud-prom` and `grafanacloud-logs` -- the import dialog's own
  "remap datasource" step is still the way to set them, this is just a
  shortcut for finding the right ones.
- The exporter has to actually be running before the three Prometheus-backed
  alert rules mean anything; `noDataState: Alerting` on those three is
  deliberate (treat "the exporter died" the same as "the API is unhealthy"),
  which is also why it is worth glancing at `pqp_api_metrics_scrape_ok` once
  at T-1h per the runbook. The same is true of every panel on the live
  dashboard, all the time, not just around an event -- it is only as good as
  whether the exporter's systemd timer is still active on whichever box runs
  it.
