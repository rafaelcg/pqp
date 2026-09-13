# Event guardrails monitoring

Everything added for `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` items
A4 and D2: the alert rules and dashboard for running a watch party, and the
small exporter that gives three of those alerts a metric to evaluate. The
always-on monitoring this repo already runs (uptime, error rate, the SFU box)
is documented in [`docs/MONITORING.md`](../../docs/MONITORING.md) and is
**not** duplicated here. Everything in this directory is scoped to an event
window: install and enable it before a party per
[`docs/EVENT_RUNBOOK.md`](../../docs/EVENT_RUNBOOK.md), and it is fine to
leave the exporter running quietly between events (it costs one `GET
/api/admin/metrics` every 20s) even though the alert rules are meant to be
imported/removed per event rather than left firing forever — see the `_comment`
block at the top of `grafana-alert-rules-event.json` for why.

| File | Role |
|---|---|
| `pqp-api-metrics-exporter.py` | Reads `GET /api/admin/metrics` (the `ready`, `runtime`, `voice` and `liveHls` blocks) every 20s and writes a node_exporter textfile, so readiness, Postgres latency, pool queue depth, seated count, sockets and HLS rung/session counts become Prometheus series Grafana can alert and graph on over time, not just read as an instantaneous pull. |
| `pqp-api-metrics.service` / `.timer` | The systemd timer that runs it. |
| `install.sh` | Idempotent installer for the box above. |
| `grafana-alert-rules-event.json` | Grafana Alerting file-provisioning format: the 5 event-window alert rules (readiness false 60s, `/ready` postgres ms > 200 for 2m, pool queued > 20 for 60s, HLS rung deaths > 3 in 5m, API process restarted). Contact point `rafael-email`, same as every other alert in this repo's Grafana stack. |
| `grafana-dashboard-event.json` | One "pqp Event" dashboard: sockets, seated, watching (see below), pool in-use/queued, DB latency, egress box CPU, HLS rungs/sessions, restarts, rung deaths. |

## Install

Runs on the self-hosted SFU box (`216.238.114.79`) alongside
`tools/sfu-monitoring/`, which already has Grafana Alloy and a textfile
collector — no Alloy config change is needed, it just picks up the new
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
CLAUDE.md's env var table and `tools/admin-dashboard/README.md`) — this
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
it). Replace the two placeholder datasource UIDs first — the import dialog
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
Import. It pulls from three places at once — the new exporter above, the
existing `tools/sfu-monitoring` Prometheus series (egress box CPU), and Loki
log lines (restarts, HLS rung deaths) — which is the point of an event
dashboard: the four postmortem panels that needed a genuinely new number
(sockets, seated, pool, DB latency, rungs) sit next to the ones that already
existed.

**"Watching" is a text panel, not a graph.** pqp does not count concurrent
HLS viewers anywhere server-side — the playlist proxy is a stateless,
unauthenticated-per-request pull with no access log — and inventing one would
mean touching `server/src/voice/hls-playlist-proxy.ts`, which is runtime
code and out of scope for a monitoring-only change. During a real event, read
the audience size off the stream itself (Twitch/YouTube), the way the
2026-09-12 postmortem's own ~200-watching figure was read. During a rehearsal,
`tools/watch-party-load/src/hls-audience.ts`'s own progress output and final
report are the closest thing pqp has to this number.

## What still needs a human, every time

- Datasource UIDs in both JSON files are placeholders (`<PROMETHEUS_DATASOURCE_UID>`,
  `<LOKI_DATASOURCE_UID>`) — nothing here is provisioned from the repo, matching
  every other dashboard and alert group in `docs/MONITORING.md`: the Grafana UI
  is the source of truth once imported, and this file is the starting point.
- The exporter has to actually be running before the three Prometheus-backed
  alert rules mean anything; `noDataState: Alerting` on those three is
  deliberate (treat "the exporter died" the same as "the API is unhealthy"),
  which is also why it is worth glancing at `pqp_api_metrics_scrape_ok` once
  at T-1h per the runbook.
