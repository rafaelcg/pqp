#!/usr/bin/env python3
"""Textfile metrics for the self-hosted SFU box (sfu.pqp.gg / turn.pqp.gg).

Two things Prometheus cannot see on its own, written as node_exporter
textfile metrics and picked up by Grafana Alloy every scrape:

1. **Monthly egress, across reboots.** The plan includes 5 TB of transfer a
   month. `/proc/net/dev` counters reset on every reboot, so anything derived
   from them undercounts after a restart -- exactly when a busy month is most
   likely to have had one. vnstat keeps its own SQLite database in
   /var/lib/vnstat and survives reboots, so it is the source here.

   Both a calendar month-to-date and a rolling 30 day total are exported. The
   alert uses the rolling one: Vultr's allowance resets on the instance's
   billing date, which is not necessarily the 1st, and a rolling 30 day window
   is always >= the true billing-period usage. It warns early rather than late,
   which is the right way round for a soft overage of about a cent per GB.

2. **Docker container state.** Nothing else notices when the livekit or caddy
   container exits or is restarted by its `unless-stopped` policy.
   `StartedAt` catches both a policy restart and a `docker compose up`
   recreation (which resets RestartCount to 0), so it is what the alert reads.

Writes are atomic (write to .tmp, rename), because the textfile collector will
happily read a half-written file otherwise.
"""

from __future__ import annotations

import calendar
import json
import os
import subprocess
import sys
import time
from datetime import date, timedelta

# The public interface. docker0 and lo are deliberately not counted.
INTERFACE = os.environ.get("PQP_METRICS_INTERFACE", "enp1s0")

# Vultr plan allowance. 5 TB read as 5 * 10^12 bytes, the smaller of the two
# readings of "TB", so the percentage is conservative. Change here and in
# docs/MONITORING.md if the plan changes.
ALLOWANCE_BYTES = int(os.environ.get("PQP_EGRESS_ALLOWANCE_BYTES", 5_000_000_000_000))

CONTAINERS = os.environ.get("PQP_METRICS_CONTAINERS", "livekit-livekit-1,livekit-caddy-1").split(",")

TEXTFILE_DIR = os.environ.get("PQP_TEXTFILE_DIR", "/var/lib/node_exporter/textfile_collector")


def write_atomic(name: str, body: str) -> None:
    path = os.path.join(TEXTFILE_DIR, name)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(body)
    os.replace(tmp, path)


def run(args: list[str]) -> str:
    return subprocess.run(args, capture_output=True, text=True, timeout=30, check=True).stdout


def vnstat_json(mode: str) -> dict:
    return json.loads(run(["vnstat", "-i", INTERFACE, "--json", mode]))


def interface_block(payload: dict) -> dict:
    for iface in payload.get("interfaces", []):
        if iface.get("name") == INTERFACE:
            return iface
    return {}


def egress_metrics() -> str:
    lines: list[str] = []

    def gauge(name: str, help_text: str, value: float) -> None:
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name} {value}")

    month = interface_block(vnstat_json("m"))
    day = interface_block(vnstat_json("d"))

    today = date.today()
    month_tx = month_rx = 0
    for entry in month.get("traffic", {}).get("month", []):
        stamp = entry.get("date", {})
        if stamp.get("year") == today.year and stamp.get("month") == today.month:
            month_tx = int(entry.get("tx", 0))
            month_rx = int(entry.get("rx", 0))

    cutoff = today - timedelta(days=30)
    rolling_tx = rolling_rx = 0
    for entry in day.get("traffic", {}).get("day", []):
        stamp = entry.get("date", {})
        try:
            when = date(stamp["year"], stamp["month"], stamp["day"])
        except (KeyError, ValueError):
            continue
        if when > cutoff:
            rolling_tx += int(entry.get("tx", 0))
            rolling_rx += int(entry.get("rx", 0))

    created = month.get("created", {}).get("timestamp", 0)

    gauge("pqp_sfu_egress_month_tx_bytes", "Outbound bytes this calendar month, from vnstat.", month_tx)
    gauge("pqp_sfu_egress_month_rx_bytes", "Inbound bytes this calendar month, from vnstat.", month_rx)
    gauge("pqp_sfu_egress_30d_tx_bytes", "Outbound bytes over the last 30 days, from vnstat.", rolling_tx)
    gauge("pqp_sfu_egress_30d_rx_bytes", "Inbound bytes over the last 30 days, from vnstat.", rolling_rx)
    gauge("pqp_sfu_egress_allowance_bytes", "Monthly transfer included in the plan.", ALLOWANCE_BYTES)
    gauge(
        "pqp_sfu_egress_history_start_seconds",
        "Unix time the vnstat database for this interface starts; totals before it are not counted.",
        created,
    )
    gauge("pqp_sfu_metrics_collected_seconds", "Unix time this textfile was last written.", int(time.time()))
    return "\n".join(lines) + "\n"


def docker_metrics() -> str:
    lines = [
        "# HELP pqp_sfu_container_running 1 when the container is running, 0 otherwise.",
        "# TYPE pqp_sfu_container_running gauge",
        "# HELP pqp_sfu_container_restart_count Docker restart-policy restarts since the container was created.",
        "# TYPE pqp_sfu_container_restart_count gauge",
        "# HELP pqp_sfu_container_started_seconds Unix time the current run of the container started.",
        "# TYPE pqp_sfu_container_started_seconds gauge",
    ]
    for name in CONTAINERS:
        name = name.strip()
        if not name:
            continue
        try:
            raw = run(
                [
                    "docker",
                    "inspect",
                    "-f",
                    "{{.State.Running}} {{.RestartCount}} {{.State.StartedAt}}",
                    name,
                ]
            ).strip()
            running_s, restarts_s, started_s = raw.split(" ", 2)
            running = 1 if running_s == "true" else 0
            restarts = int(restarts_s)
            # docker reports StartedAt in UTC ("2026-09-06T00:11:22.334Z").
            started = calendar.timegm(time.strptime(started_s[:19], "%Y-%m-%dT%H:%M:%S"))
        except Exception:
            # A container docker does not know about is reported as not
            # running, which is the truth the alert cares about.
            running, restarts, started = 0, 0, 0
        lines.append(f'pqp_sfu_container_running{{name="{name}"}} {running}')
        lines.append(f'pqp_sfu_container_restart_count{{name="{name}"}} {restarts}')
        lines.append(f'pqp_sfu_container_started_seconds{{name="{name}"}} {started}')
    return "\n".join(lines) + "\n"


def main() -> int:
    status = 0
    try:
        write_atomic("pqp_sfu_egress.prom", egress_metrics())
    except Exception as err:  # noqa: BLE001
        print(f"egress metrics failed: {err}", file=sys.stderr)
        status = 1
    try:
        write_atomic("pqp_sfu_docker.prom", docker_metrics())
    except Exception as err:  # noqa: BLE001
        print(f"docker metrics failed: {err}", file=sys.stderr)
        status = 1
    return status


if __name__ == "__main__":
    raise SystemExit(main())
