#!/usr/bin/env python3
"""Textfile metrics for the API's own `GET /api/admin/metrics`, so the four
event-window alert rules in `grafana-alert-rules-event.json` (readiness,
`/ready` Postgres latency, pool queue depth) have a Prometheus series to
evaluate `for` a duration against.

WHY THIS EXISTS. `GET /ready` and `GET /api/admin/metrics` are pulls: an
external HTTP monitor or the operator dashboard reads them on demand, and
nothing writes the numbers down anywhere Grafana can query over time. The
existing `pqp-api-events` Loki dashboard graphs *log lines*, which is exactly
right for something that happens (a join, a close, a rung death) and useless
for something that has a *level* (the pool is at 12, Postgres answered in
340ms). A "greater than X for N minutes" alert needs a level sampled on a
clock, not a line to grep. See docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md
item A4 and docs/MONITORING.md.

WHERE THIS RUNS. Installed alongside `tools/sfu-monitoring/` on the
self-hosted SFU box: it already runs Grafana Alloy with a textfile collector
and holds the `metrics:write` credential, it is always on, and it has open
egress to `api.pqp.gg`. Nothing here touches LiveKit or the box's own
metrics; it writes a second, independently-named textfile
(`pqp_api.prom`) next to `pqp_sfu_egress.prom` / `pqp_sfu_docker.prom` in the
same directory, which Alloy's existing `textfile` collector already globs.
No Alloy config change is needed to pick it up. It could equally run
anywhere else with a Python 3 interpreter, a copy of
`/etc/alloy/credentials.env` is not required by *this* script (it only reads
the API's admin-metrics token, never the Grafana one).

WHAT IT READS. One authenticated GET against
`{PQP_API_URL}/api/admin/metrics` with `Authorization: Bearer
$ADMIN_METRICS_TOKEN` (the same machine token the operator dashboard's
Cloudflare Worker presents; see tools/admin-dashboard/README.md and
CLAUDE.md's env var table). The `ready` block on that payload is NOT part of
the 30-second admin-metrics cache (services/metrics.ts says so explicitly),
so every run of this script costs the API one live `SELECT 1` through the
pool -- the same cost `GET /ready` itself has, and why this polls on a timer
rather than continuously.

Writes are atomic (write to .tmp, rename), same as pqp-box-metrics.py,
because the textfile collector will happily read a half-written file
otherwise. On a failed fetch (network, expired token, API down) the ready/
pool gauges are NOT rewritten with stale-but-plausible numbers -- the file is
replaced with just `pqp_api_metrics_scrape_ok 0` and a timestamp, so the
series for the removed gauges goes stale and Grafana shows "no data" rather
than a confident, wrong, green number. That is what `pqp_api_metrics_scrape_ok`
and `pqp_api_metrics_collected_seconds` are for: alert on staleness of THIS
exporter with `time() - pqp_api_metrics_collected_seconds > 120`, separately
from anything the exported numbers say.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("PQP_API_URL", "https://api.pqp.gg").rstrip("/")
TOKEN = os.environ.get("ADMIN_METRICS_TOKEN", "")
TIMEOUT_SECONDS = float(os.environ.get("PQP_API_METRICS_TIMEOUT_SECONDS", "10"))
TEXTFILE_DIR = os.environ.get(
    "PQP_TEXTFILE_DIR", "/var/lib/node_exporter/textfile_collector"
)
FILENAME = "pqp_api.prom"


def write_atomic(name: str, body: str) -> None:
    path = os.path.join(TEXTFILE_DIR, name)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(body)
    os.replace(tmp, path)


def gauge(lines: list[str], name: str, help_text: str, value) -> None:
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} gauge")
    lines.append(f"{name} {value}")


def fetch_admin_metrics() -> dict:
    if not TOKEN:
        raise RuntimeError("ADMIN_METRICS_TOKEN is not set")
    request = urllib.request.Request(
        f"{API_URL}/api/admin/metrics",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected status {response.status}")
        return json.loads(response.read().decode("utf-8"))


def render(payload: dict) -> str:
    ready = payload.get("ready", {})
    checks = ready.get("checks", {})
    postgres = checks.get("postgres", {})
    pool = checks.get("pool", {})
    runtime = payload.get("runtime", {})
    voice = payload.get("voice", {})
    live_hls = payload.get("liveHls", {})

    lines: list[str] = []
    gauge(
        lines,
        "pqp_api_ready_ok",
        "1 when GET /ready reports ok:true, 0 otherwise. Mirrors the boolean an external monitor pages on.",
        1 if ready.get("ok") else 0,
    )
    gauge(
        lines,
        "pqp_api_ready_postgres_ok",
        "1 when the ready check's own SELECT 1 succeeded.",
        1 if postgres.get("ok") else 0,
    )
    gauge(
        lines,
        "pqp_api_ready_postgres_ms",
        "Round-trip time of the SELECT 1 behind GET /ready, in milliseconds.",
        postgres.get("ms", -1),
    )
    gauge(
        lines,
        "pqp_api_ready_pool_queued",
        "Requests queued for a pool connection, sampled in-process (checks.pool.queued on GET /ready).",
        pool.get("queued", -1),
    )
    gauge(
        lines,
        "pqp_api_ready_pool_in_use",
        "Pool connections checked out right now.",
        pool.get("inUse", -1),
    )
    gauge(
        lines,
        "pqp_api_ready_pool_max",
        "PG_POOL_MAX for this process.",
        pool.get("max", -1),
    )
    gauge(
        lines,
        "pqp_api_sockets",
        "Open WebSocket connections on this process (runtime.sockets on GET /api/admin/metrics).",
        runtime.get("sockets", -1),
    )
    gauge(
        lines,
        "pqp_api_voice_participants",
        "People seated in a voice room on this process's view of the registry (voice.participants).",
        voice.get("participants", -1),
    )
    gauge(
        lines,
        "pqp_api_voice_active_rooms",
        "Voice rooms with at least one seat (voice.activeRooms).",
        voice.get("activeRooms", -1),
    )
    gauge(
        lines,
        "pqp_api_hls_sessions",
        "Watch-party transcodes this process is running right now (liveHls.sessions).",
        live_hls.get("sessions", -1),
    )
    gauge(
        lines,
        "pqp_api_hls_rungs",
        "Renditions across every live session on this process (liveHls.rungs).",
        live_hls.get("rungs", -1),
    )
    gauge(
        lines,
        "pqp_api_hls_orphans_stopped_total",
        "Leftover transcodes reapForeignEgresses has stopped since this process started. Belongs at zero.",
        live_hls.get("orphansStopped", -1),
    )
    gauge(
        lines,
        "pqp_api_metrics_scrape_ok",
        "1 when this script last reached GET /api/admin/metrics, 0 on the most recent failure.",
        1,
    )
    gauge(
        lines,
        "pqp_api_metrics_collected_seconds",
        "Unix time this textfile was last written.",
        int(time.time()),
    )
    return "\n".join(lines) + "\n"


def render_failure() -> str:
    lines: list[str] = []
    gauge(
        lines,
        "pqp_api_metrics_scrape_ok",
        "1 when this script last reached GET /api/admin/metrics, 0 on the most recent failure.",
        0,
    )
    gauge(
        lines,
        "pqp_api_metrics_collected_seconds",
        "Unix time this textfile was last written.",
        int(time.time()),
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    try:
        payload = fetch_admin_metrics()
    except (urllib.error.URLError, RuntimeError, ValueError, TimeoutError) as err:
        print(f"pqp-api-metrics-exporter: fetch failed: {err}", file=sys.stderr)
        try:
            write_atomic(FILENAME, render_failure())
        except OSError as write_err:
            print(f"pqp-api-metrics-exporter: write failed: {write_err}", file=sys.stderr)
        return 1
    try:
        write_atomic(FILENAME, render(payload))
    except OSError as err:
        print(f"pqp-api-metrics-exporter: write failed: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
