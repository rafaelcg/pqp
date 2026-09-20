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


def counter(lines: list[str], name: str, help_text: str, value) -> None:
    """A cumulative-since-boot total. Emitted as a Prometheus `counter` so
    rate()/increase() handle the reset-to-zero on an API restart correctly.
    The API's own counters reset on deploy, which is a real reset, not a
    rollover -- exactly what the counter type is for."""
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} counter")
    lines.append(f"{name} {value}")


def labeled_counter(
    lines: list[str], name: str, help_text: str, samples: list[tuple[dict[str, str], object]]
) -> None:
    """labeled_gauge()'s counter sibling; one cumulative series per label set."""
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} counter")
    for labels, value in samples:
        label_str = ",".join(f'{key}="{val}"' for key, val in labels.items())
        lines.append(f"{name}{{{label_str}}} {value}")


def labeled_gauge(
    lines: list[str], name: str, help_text: str, samples: list[tuple[dict[str, str], object]]
) -> None:
    """Same as gauge(), but one series per label set. `samples` is a list of
    (labels, value) pairs, e.g. ({"backend": "mesh"}, 3). Caller decides which
    label combinations to emit -- see voice_room_backend_totals() below for
    why mesh and livekit are always both present."""
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} gauge")
    for labels, value in samples:
        label_str = ",".join(f'{key}="{val}"' for key, val in labels.items())
        lines.append(f"{name}{{{label_str}}} {value}")


def voice_room_backend_totals(rooms) -> dict[str, dict[str, int]]:
    """Sums voice.rooms[] participants and counts rooms by transport.

    mesh and livekit are always both present, zero when nobody holds either,
    so a stacked panel reads a real zero instead of "no data" the moment a
    room's last call ends -- rooms may be absent or empty on an older payload
    shape or a quiet process, and a room with a transport this exporter does
    not recognise is skipped rather than guessed at.
    """
    totals: dict[str, dict[str, int]] = {
        "mesh": {"participants": 0, "rooms": 0},
        "livekit": {"participants": 0, "rooms": 0},
    }
    for room in rooms or []:
        backend = room.get("transport")
        if backend not in totals:
            continue
        totals[backend]["participants"] += int(room.get("participants") or 0)
        totals[backend]["rooms"] += 1
    return totals


def fetch_admin_metrics() -> dict:
    if not TOKEN:
        raise RuntimeError("ADMIN_METRICS_TOKEN is not set")
    request = urllib.request.Request(
        f"{API_URL}/api/admin/metrics",
        headers={"User-Agent": "pqp-api-metrics-exporter/1 (+https://pqp.gg)", "Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected status {response.status}")
        return json.loads(response.read().decode("utf-8"))


def fetch_ready() -> dict:
    """GET /ready on its own, unauthenticated.

    The admin payload also carries a `ready` block, but it is sampled while
    that same request runs the dashboard's query burst on a cold cache, so
    its Postgres round trip read 40-65 ms every other scrape on a box whose
    real probe is 1 ms (2026-09-17, first day behind Cloudflare). /ready is
    the number an external monitor would see, so it is the one to graph and
    alert on. Falls back to the admin block if /ready itself fails, so a
    transient error here does not blank the gauges.
    """
    request = urllib.request.Request(
        f"{API_URL}/ready",
        headers={"User-Agent": "pqp-api-metrics-exporter/1 (+https://pqp.gg)"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def render(payload: dict, ready_payload: dict | None = None) -> str:
    ready = ready_payload if ready_payload else payload.get("ready", {})
    checks = ready.get("checks", {})
    postgres = checks.get("postgres", {})
    pool = checks.get("pool", {})
    runtime = payload.get("runtime", {})
    voice = payload.get("voice", {})
    live_hls = payload.get("liveHls", {})
    cluster = payload.get("cluster", {})
    users = payload.get("users", {})
    servers = payload.get("servers", {})
    activation = payload.get("activation", {})
    messages = payload.get("messages", {})
    calls = payload.get("calls", {})
    product = payload.get("product", {})
    breaker = runtime.get("db", {}).get("breaker", {})

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
        "pqp_api_users_online",
        "Open WebSocket connections across the whole cluster (cluster.sockets), used as the "
        "'people online' gauge. pqp has no field that dedupes by user: sockets are per-session "
        "(one person open in two tabs holds two), and connections.ofUsers on the same payload "
        "is all-time signups with a linked Steam/Battle.net/Twitch account, not presence -- "
        "cluster.sockets is the closest thing to online users this payload has. On a "
        "one-machine deployment (today) it equals runtime.sockets; VOICE_REGISTRY=off makes it "
        "exactly runtime.sockets by construction.",
        cluster.get("sockets", -1),
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
        "pqp_api_voice_largest_room_now",
        "Seats in the single largest voice room right now (voice.largestRoomNow).",
        voice.get("largestRoomNow", -1),
    )
    gauge(
        lines,
        "pqp_api_voice_peak_room_size_today",
        "Highest voice.largestRoomNow seen since voice.peakTrackedSince (process start or the last Sao Paulo midnight).",
        voice.get("peakRoomSizeToday", -1),
    )
    backend_totals = voice_room_backend_totals(voice.get("rooms"))
    labeled_gauge(
        lines,
        "pqp_api_voice_participants_by_backend",
        "voice.rooms[].participants summed by transport (voice.rooms[].transport). "
        "mesh and livekit are both always emitted, zero when nobody is on that backend, "
        "so this never reads no data just because a call ended.",
        [({"backend": backend}, counts["participants"]) for backend, counts in backend_totals.items()],
    )
    labeled_gauge(
        lines,
        "pqp_api_voice_rooms_by_backend",
        "Count of voice.rooms[] by transport (voice.rooms[].transport). "
        "mesh and livekit are both always emitted, zero when neither has a room open.",
        [({"backend": backend}, counts["rooms"]) for backend, counts in backend_totals.items()],
    )
    gauge(
        lines,
        "pqp_api_db_breaker_open",
        "1 when the A3.1 circuit breaker over the Postgres pool (runtime.db.breaker.state) "
        "is anything but closed (open or half-open), 0 when closed or the field is missing "
        "(same falsy-default convention as pqp_api_ready_ok).",
        0 if breaker.get("state", "closed") == "closed" else 1,
    )
    # No pqp_api_hls_viewers gauge, and no pqp_api_hls_active_sessions distinct
    # from pqp_api_hls_sessions below: pqp has no server-side count of
    # concurrent watch-party viewers anywhere in the codebase today -- the
    # playlist proxy (server/src/voice/hls-playlist-proxy.ts) is a stateless,
    # unauthenticated-per-request pull with no per-request log, same finding
    # already written up in grafana-dashboard-event.json's "Watching" panel
    # and this directory's README. liveHls.sessions / liveHls.rungs below are
    # transcode PROCESS counts (how many encodes are running), not audience
    # size, and are not a substitute for it. Adding a real viewer count would
    # mean touching runtime code, which is out of scope for a monitoring-only
    # change; if that ever lands, wire its field in here rather than guessing
    # from sessions/rungs.
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

    # ---------------------------------------------------------------- growth
    # Product and ops counters for the growth dashboard (grafana-dashboard-growth.json).
    # Everything below is either a 24h rolling window (a gauge) or a cumulative
    # since-boot total (a counter, so rate()/increase() survive a deploy reset).

    # Signups and message volume (24h rolling windows -> gauges).
    gauge(
        lines,
        "pqp_api_users_total",
        "All human accounts that exist (users.total).",
        users.get("total", -1),
    )
    gauge(
        lines,
        "pqp_api_signups_24h",
        "Human accounts created in the last 24 hours (users.last24h).",
        users.get("last24h", -1),
    )
    gauge(
        lines,
        "pqp_api_servers_24h",
        "Servers created in the last 24 hours (servers.last24h).",
        servers.get("last24h", -1),
    )
    gauge(
        lines,
        "pqp_api_messages_24h",
        "Human messages sent in the last 24 hours (messages.last24h).",
        messages.get("last24h", -1),
    )
    by_scope = messages.get("byScope24h") or {}
    if isinstance(by_scope, dict):
        labeled_gauge(
            lines,
            "pqp_api_messages_24h_by_scope",
            "Human messages in the last 24h split by where they were sent "
            "(messages.byScope24h): dm, group, server. Sums to pqp_api_messages_24h.",
            [({"scope": scope}, by_scope.get(scope, 0)) for scope in ("dm", "group", "server")],
        )

    # Activation funnel (payload.activation). A GAUGE, not a counter: each value
    # is how many of a signup COHORT have reached a step, and the cohort is a
    # sliding window (accounts whose signup_at is in the last 7 / 30 days), so
    # the number goes both up (as people progress) and down (as the window
    # slides past them) -- a counter's rate()/increase() would be nonsense on
    # it. Every window x step pair is emitted always, zero included, so the
    # funnel panel has a full series set before the first signup and never reads
    # "no data" for a step nobody has reached yet. `signup` is the cohort size
    # (the funnel's denominator). The JS keys are camelCase; the label values
    # are the snake_case step names services/activation.ts calls the events.
    if isinstance(activation, dict) and activation:
        step_keys = (
            ("signup", "signup"),
            ("age_gate", "ageGate"),
            ("handle", "handle"),
            ("first_join", "firstJoin"),
            ("first_message", "firstMessage"),
            ("first_voice", "firstVoice"),
            ("first_watch_party", "firstWatchParty"),
        )
        cohort_samples: list[tuple[dict[str, str], object]] = []
        for window_label, window_key in (("7d", "window7d"), ("30d", "window30d")):
            counts = activation.get(window_key) or {}
            for step_label, step_key in step_keys:
                cohort_samples.append(
                    (
                        {"window": window_label, "step": step_label},
                        counts.get(step_key, 0) if isinstance(counts, dict) else 0,
                    )
                )
        labeled_gauge(
            lines,
            "pqp_api_activation_cohort",
            "Activation funnel: accounts in a signup cohort (window=7d|30d) that have "
            "reached each step (activation.window7d / window30d). step=signup is the cohort "
            "size and the funnel denominator; every step is <= the one before it, so "
            "step/signup is a conversion. Gauge, because the cohort window slides.",
            cohort_samples,
        )
        conversion = activation.get("conversion30d") or {}
        if isinstance(conversion, dict):
            conversion_keys = (
                ("signup_to_age_gate", "signupToAgeGate"),
                ("age_gate_to_handle", "ageGateToHandle"),
                ("handle_to_first_join", "handleToFirstJoin"),
                ("first_join_to_first_message", "firstJoinToFirstMessage"),
                ("first_message_to_first_voice", "firstMessageToFirstVoice"),
                ("first_voice_to_first_watch_party", "firstVoiceToFirstWatchParty"),
                ("signup_to_first_message", "signupToFirstMessage"),
            )
            labeled_gauge(
                lines,
                "pqp_api_activation_conversion_30d",
                "Step-to-step conversion for the 30-day signup cohort (activation.conversion30d), "
                "each a share 0..1 of the PREVIOUS step. step=signup_to_first_message is the "
                "headline activation rate, and the one an alert watches.",
                [
                    ({"step": label}, conversion.get(key, 0))
                    for label, key in conversion_keys
                ],
            )

    # Calls: attempts, connected (by transport and scope), refusals by reason,
    # and the DM/group ring outcomes. Server-truth, cumulative -> counters.
    if isinstance(calls, dict) and calls:
        counter(
            lines,
            "pqp_api_call_join_attempts_total",
            "join-voice-room frames tried, past the per-user room limiter (calls.joinAttempts). "
            "Denominator for the connect/refuse rates.",
            calls.get("joinAttempts", 0),
        )
        counter(
            lines,
            "pqp_api_call_join_connected_total",
            "Joins that seated a peer (calls.joinConnected). attempts - connected is the refusal total.",
            calls.get("joinConnected", 0),
        )
        connected_transport = calls.get("joinConnectedByTransport") or {}
        labeled_counter(
            lines,
            "pqp_api_call_join_connected_by_transport_total",
            "Connected joins by media path (calls.joinConnectedByTransport). mesh and livekit both emitted.",
            [
                ({"transport": t}, connected_transport.get(t, 0))
                for t in ("mesh", "livekit")
            ],
        )
        connected_scope = calls.get("joinConnectedByScope") or {}
        labeled_counter(
            lines,
            "pqp_api_call_join_connected_by_scope_total",
            "Connected joins by room kind (calls.joinConnectedByScope): dm, group, server.",
            [({"scope": s}, connected_scope.get(s, 0)) for s in ("dm", "group", "server")],
        )
        refused = calls.get("joinRefusedByReason") or {}
        # Fixed reason set: emit all so a series exists before its first refusal.
        refused_reasons = (
            "no-access",
            "blocked",
            "timeout",
            "character",
            "invalid-channel",
            "transport-unsupported",
            "room-full",
            "watch-party-full",
        )
        labeled_counter(
            lines,
            "pqp_api_call_join_refused_total",
            "join-voice-room refusals by reason (calls.joinRefusedByReason). "
            "room-full is the mesh cap that refused the MoonKase spike.",
            [({"reason": r}, refused.get(r, 0)) for r in refused_reasons],
        )
        counter(
            lines,
            "pqp_api_call_rings_total",
            "DM/group rings committed (calls.rings).",
            calls.get("rings", 0),
        )
        counter(
            lines,
            "pqp_api_call_rings_answered_total",
            "Rings where at least one person answered (calls.ringsAnswered).",
            calls.get("ringsAnswered", 0),
        )
        counter(
            lines,
            "pqp_api_call_rings_declined_total",
            "Rings someone actively declined (calls.ringsDeclined).",
            calls.get("ringsDeclined", 0),
        )
        rings_ended = calls.get("ringsEndedByReason") or {}
        labeled_counter(
            lines,
            "pqp_api_call_rings_ended_total",
            "Unanswered rings that ended (calls.ringsEndedByReason): timeout rang out, cancelled emptied.",
            [({"reason": r}, rings_ended.get(r, 0)) for r in ("timeout", "cancelled")],
        )

    # Watch-party transcode lifecycle (cumulative -> counters) and playlist
    # rejections by reason.
    counter(
        lines,
        "pqp_api_hls_starts_total",
        "Watch-party transcode sessions started since boot (liveHls.startsTotal).",
        live_hls.get("startsTotal", 0),
    )
    counter(
        lines,
        "pqp_api_hls_stops_total",
        "Watch-party transcode sessions torn down since boot (liveHls.stopsTotal).",
        live_hls.get("stopsTotal", 0),
    )
    counter(
        lines,
        "pqp_api_hls_restarts_scheduled_total",
        "Rung deaths that scheduled a restart (liveHls.restartsScheduled). A rising slope during "
        "one party is a stream that will not stay up.",
        live_hls.get("restartsScheduled", 0),
    )
    counter(
        lines,
        "pqp_api_hls_restarts_exhausted_total",
        "scheduleRestart giving up after the window's budget (liveHls.restartsExhausted). "
        "Nonzero means an audience got a blank pane.",
        live_hls.get("restartsExhausted", 0),
    )
    rejected = live_hls.get("playlistRejectedByReason") or {}
    if isinstance(rejected, dict) and rejected:
        labeled_counter(
            lines,
            "pqp_api_hls_playlist_rejected_total",
            "Playlist requests refused by the viewer capability, by reason "
            "(liveHls.playlistRejectedByReason). A rolling `expired` wave is pitfall 16.",
            [({"reason": reason}, count) for reason, count in rejected.items()],
        )

    # Push delivery outcomes per platform (cumulative -> counters). NOT
    # subscription counts (product.push): this is what happened when the server
    # sent. `failed` is the one an alert watches; `pruned` is normal GC.
    push_delivery = product.get("pushDelivery") or {}
    if isinstance(push_delivery, dict) and push_delivery:
        samples: list[tuple[dict[str, str], object]] = []
        for platform in ("web", "apns", "fcm"):
            outcomes = push_delivery.get(platform) or {}
            for outcome in ("sent", "failed", "pruned"):
                samples.append(
                    ({"platform": platform, "outcome": outcome}, outcomes.get(outcome, 0))
                )
        labeled_counter(
            lines,
            "pqp_api_push_delivery_total",
            "Push sends by platform and outcome (product.pushDelivery): sent, failed, pruned.",
            samples,
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
    # fetch_admin_metrics() and render() are in the SAME try. A 200 response
    # is not proof of a well-formed one -- `null`, `{"ready": null}`, or any
    # other shape render() does not expect raises AttributeError/TypeError/
    # KeyError reaching into it, and that failure must replace the textfile
    # exactly like an unreachable API does. Getting a 200 with a body render()
    # cannot use is not meaningfully different from not getting a response at
    # all: either way the numbers on disk cannot be trusted, and leaving the
    # previous (possibly stale) success metrics in place would let Grafana
    # keep reading a confident, wrong, green number through an outage.
    try:
        payload = fetch_admin_metrics()
        try:
            ready_payload = fetch_ready()
        except Exception as exc:  # noqa: BLE001
            print(f"pqp-api-metrics-exporter: /ready fetch failed, using admin block: {exc}", file=sys.stderr)
            ready_payload = None
        body = render(payload, ready_payload)
    except (
        urllib.error.URLError,
        RuntimeError,
        ValueError,
        TimeoutError,
        AttributeError,
        KeyError,
        TypeError,
    ) as err:
        print(f"pqp-api-metrics-exporter: fetch/render failed: {err}", file=sys.stderr)
        try:
            write_atomic(FILENAME, render_failure())
        except OSError as write_err:
            print(f"pqp-api-metrics-exporter: write failed: {write_err}", file=sys.stderr)
        return 1
    try:
        write_atomic(FILENAME, body)
    except OSError as err:
        print(f"pqp-api-metrics-exporter: write failed: {err}", file=sys.stderr)
        # The rendered success body never made it to disk, so whatever
        # pqp_api.prom already holds is a previous run's numbers -- stale the
        # moment this run fails to replace them. Best-effort overwrite with
        # the failure marker rather than leaving that stale success in place;
        # if this also fails (the same OSError that just happened, most
        # likely) the exporter still exits non-zero and the log line above
        # already says why.
        try:
            write_atomic(FILENAME, render_failure())
        except OSError as fallback_err:
            print(
                f"pqp-api-metrics-exporter: fallback write also failed: {fallback_err}",
                file=sys.stderr,
            )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
