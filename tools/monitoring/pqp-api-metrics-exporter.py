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

REPLICA-SPLIT METRICS. Production runs two API replicas (`api-a`, `api-b`)
behind Caddy's round robin (`tools/api-host/Caddyfile`), and each replica
holds its own in-memory counters -- `calls.*`, `product.pushDelivery.*`, and
the in-memory counter fields under `voice.*` / `liveHls.*` all live in one
process's memory and reset to zero on that process's own boot. Scraping the
load-balanced `https://api.pqp.gg/api/admin/metrics` on a timer means
consecutive scrapes land on a random replica, so the single series this
script used to write bounced non-monotonically between each replica's own
count (e.g. 26, 13, 26, 14, 27...). Prometheus reads every drop as a counter
reset and `increase()`/`rate()` inflate wildly across the reset -- this
produced a false "call failure rate 20%" alert from a cluster that actually
answered ~18 calls. DB-derived blocks (`users`, `messages`, `activation`,
`servers`, `cluster`) were never affected: every replica queries the same
Postgres and reports the same numbers regardless of which one answers.

THE FIX IS NOT A DEDICATED ROUTE PER REPLICA. An earlier version of this
fix added `/_replica/a` / `/_replica/b` routes to `tools/api-host/Caddyfile`
that were meant to bypass the round robin and pin straight to one
container, but they did not work in production -- every request to them
returned the SPA's catch-all instead of the metrics JSON, and there was no
way to debug the live Caddy config from outside the box. Those routes are
gone; do not re-add them.

THE ACTUAL FIX: `collect_admin_metrics_snapshots()` scrapes the ordinary,
load-balanced `{PQP_API_URL}/api/admin/metrics` REPEATEDLY -- a fresh
request each time, exactly as unpredictably routed as before -- and keys
each response by its own top-level `instanceId`, a per-process UUID
regenerated every boot (`server/src/lib/bus.ts`'s `INSTANCE_ID`, carried on
the payload by `server/src/services/metrics.ts`'s `AdminMetrics.instanceId`).
Keeping only the latest snapshot per distinct `instanceId` and stopping once
as many distinct ids have been seen as the payload's own `instanceCount`
claims turns a sequence of scrapes against ONE unpredictable endpoint into
the same thing a per-replica route would have provided: one snapshot per
live replica, no Caddy change required at all. Bounded by
`PQP_API_METRICS_MAX_SCRAPES` (default 8) so a stuck load balancer or a
topology that never converges cannot spin this forever. A payload with no
`instanceId` at all (an older API) is returned as the single snapshot with
no repeated scrapes -- there is nothing to dedup on, so a self-host or a
deployment that has not yet picked up the `instanceId` field keeps working
exactly as before, at the old single-scrape cost.

The collected snapshots are combined with `merge_admin_metrics()` below into
a single, correct payload before `render()` ever sees it -- process-local
counters summed across replicas, DB-derived blocks taken from one (never
summed, or they would double-count). `PQP_API_METRICS_ENDPOINTS` still
exists as an OPTIONAL override, comma-separated, for the rare deployment
shape where each replica genuinely has its own directly reachable URL; it is
no longer the primary mechanism and most deployments should leave it unset.
See tools/monitoring/README.md and docs/MONITORING.md for the merge rules.

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


def admin_metrics_endpoints_override() -> list[str] | None:
    """`PQP_API_METRICS_ENDPOINTS`, parsed, or `None` when unset/blank.

    This is an OPTIONAL override, not the primary mechanism -- see the
    module docstring's "REPLICA-SPLIT METRICS" section. Most deployments
    should leave it unset and let `collect_admin_metrics_snapshots()` dedup
    the ordinary load-balanced endpoint by `instanceId` instead. Set it only
    for a deployment shape where each replica genuinely has its own
    directly reachable URL (comma-separated, one per replica).
    """
    raw = os.environ.get("PQP_API_METRICS_ENDPOINTS", "").strip()
    if not raw:
        return None
    endpoints = [entry.strip() for entry in raw.split(",") if entry.strip()]
    return endpoints or None


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


def fetch_admin_metrics(url: str) -> dict:
    if not TOKEN:
        raise RuntimeError("ADMIN_METRICS_TOKEN is not set")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "pqp-api-metrics-exporter/1 (+https://pqp.gg)", "Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"unexpected status {response.status}")
        return json.loads(response.read().decode("utf-8"))


def fetch_admin_metrics_all(urls: list[str]) -> tuple[list[dict], int]:
    """Scrape every endpoint in `urls`, tolerating partial failure.

    Returns the payloads that succeeded (in the same order as `urls`) and how
    many of `urls` that was. A single unreachable replica must not blank the
    whole textfile -- the surviving replica's numbers are still real numbers,
    just not the whole cluster's, so this proceeds with whatever it got and
    lets the caller record `pqp_api_metrics_replicas_scraped` so a partial
    scrape is visible rather than silently passed off as a full one. All
    failing is the caller's problem (same as today's single-endpoint case):
    an empty list here means "raise", not "render zeroes".
    """
    payloads: list[dict] = []
    for url in urls:
        try:
            payloads.append(fetch_admin_metrics(url))
        except Exception as exc:  # noqa: BLE001
            print(f"pqp-api-metrics-exporter: scrape of {url} failed: {exc}", file=sys.stderr)
    if not payloads:
        raise RuntimeError(f"all {len(urls)} admin-metrics endpoint(s) failed")
    return payloads, len(payloads)


def collect_admin_metrics_snapshots() -> tuple[list[dict], int]:
    """THE REPLICA-SPLIT FIX. Scrapes the single, load-balanced
    `{PQP_API_URL}/api/admin/metrics` repeatedly -- a fresh request each
    time, exactly as unpredictably routed across `api-a`/`api-b` as any other
    request to that host -- and dedups the responses by their own top-level
    `instanceId` (server/src/services/metrics.ts's `AdminMetrics.instanceId`,
    a per-process UUID regenerated every boot: `server/src/lib/bus.ts`'s
    `INSTANCE_ID`). Keeping only the LATEST snapshot per distinct
    `instanceId` and stopping once as many distinct ids have been seen as
    the payload's own `instanceCount` claims turns that unpredictable
    sequence into one snapshot per live replica, with no Caddy route and no
    per-replica URL required at all -- see the module docstring for why an
    earlier version of this fix tried a dedicated route per replica and why
    that did not work in production.

    Returns the distinct per-instance payloads (ready for
    `merge_admin_metrics()`) and the `instanceCount` the last payload with
    one reported, so the caller can publish both how many were actually
    collected and how many were expected -- a gap between the two is a real
    thing to notice (a replica not answering, or stuck sticky routing that
    never surfaces a second instance within the scrape budget), not
    something to paper over.

    BOUNDED by `PQP_API_METRICS_MAX_SCRAPES` (default 8, read fresh on every
    call so a test or an operator can override it without reloading the
    module): a stuck load balancer that always routes to the same replica,
    or a topology that genuinely never converges, must not spin this
    forever. Falling one instance short of `instanceCount` after the cap is
    visible as `pqp_api_metrics_replicas_scraped` <
    `pqp_api_metrics_instances_expected`, not a hang.

    NO `instanceId` AT ALL (an older API, predating this field) returns that
    single payload immediately with no repeated scrapes -- there is nothing
    to dedup on, so repeating the request would only add load for no
    benefit. This is also exactly what a self-host or single-replica
    deployment on an older build already did, so nothing regresses for it.
    """
    url = f"{API_URL}/api/admin/metrics"
    max_scrapes = max(1, int(os.environ.get("PQP_API_METRICS_MAX_SCRAPES", "8")))
    seen: dict[str, dict] = {}
    expected = 1
    last_error: BaseException | None = None
    for attempt in range(max_scrapes):
        try:
            payload = fetch_admin_metrics(url)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            print(
                f"pqp-api-metrics-exporter: scrape {attempt + 1}/{max_scrapes} failed: {exc}",
                file=sys.stderr,
            )
            continue
        instance_id = payload.get("instanceId")
        if instance_id is None:
            return [payload], 1
        expected = payload.get("instanceCount") or expected
        seen[instance_id] = payload
        if len(seen) >= expected:
            break
    if not seen:
        assert last_error is not None
        raise last_error
    return list(seen.values()), expected


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


# ------------------------------------------------------------- merge (M1/M2)
#
# THE CRITICAL PART. One `GET /api/admin/metrics` payload is one process's
# view. Some of what it carries is process-local, in-memory state that must
# be SUMMED across replicas to get the cluster total (a call counted on
# `api-a` never shows up on `api-b`'s side of the same counter). Some of it
# is already a DB-derived, cluster-wide number that is IDENTICAL on every
# replica (same query, same Postgres) and must be taken from exactly one --
# summing it would silently double-count. Getting this backwards in either
# direction produces a wrong number that looks plausible, which is worse
# than the non-monotonic bounce this whole module exists to fix. Every rule
# below cites the source file that justifies it; see this PR's description
# for the full classification with line numbers.
#
# The policy is per TOP-LEVEL BLOCK (`calls`, `voice`, `users`, ...), because
# that is what `AdminMetrics` (server/src/services/metrics.ts) is organised
# around and what a new counter gets added to. A few blocks mix process-local
# and DB-derived fields internally (`voice`, `liveHls`, `watchParty`,
# `product`) and get a hand-written merge function instead of a blanket rule.


def _is_number(value: object) -> bool:
    # bool is a subclass of int in Python -- True + True must never become 2.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def take_first(a: object, b: object) -> object:
    """SHARED / PER-INSTANCE-HEALTH policy: the first replica's value, never
    summed. Correct for anything DB-derived (every replica queries the same
    Postgres and gets the same answer) and for anything that only describes
    'whichever process answered' (runtime, ready, config flags, ladders)."""
    return a if a is not None else b


def max_nullable(a: object, b: object) -> object:
    """For a per-process HIGH-WATER MARK or peak (not cumulative, not shared):
    neither summing nor picking one replica is right -- the true cluster peak
    is the larger of what each process independently saw. `None` means 'that
    replica has nothing to report' (e.g. no live session), not zero."""
    if a is None:
        return b
    if b is None:
        return a
    return a if a >= b else b


def deep_sum(a: object, b: object) -> object:
    """ADDITIVE policy: recursively sum numeric leaves across two payloads,
    unioning dict keys so a reason/label seen by only one replica still
    carries its count (e.g. `joinRefusedByReason`, `playlistRejectedByReason`).
    A leaf that is not a number on at least one side (a string, a bool, a
    list) is not summable and falls back to the first replica's value --
    this is what keeps `deep_sum` safe to use even on a block that is mostly
    but not entirely numeric."""
    if isinstance(a, dict) or isinstance(b, dict):
        a_dict = a if isinstance(a, dict) else {}
        b_dict = b if isinstance(b, dict) else {}
        keys = dict.fromkeys(list(a_dict.keys()) + list(b_dict.keys()))
        return {k: deep_sum(a_dict.get(k), b_dict.get(k)) for k in keys}
    if _is_number(a) and _is_number(b):
        return a + b
    if a is None:
        return b
    if b is None:
        return a
    return a  # two non-numeric values (e.g. two strings): not summable.


# ----- blocks that mix process-local and DB-derived fields: hand-written ---


def _merge_voice(a: dict | None, b: dict | None) -> dict | None:
    """`payload.voice`, built by `getVoiceActivitySnapshot()`
    (server/src/ws/voice.ts).

    `activeRooms`/`participants`/`largestRoomNow`/`rooms`/`backend`: when
    `VOICE_REGISTRY=postgres` (production's own posture -- see
    docs/deploy-vultr.md "Two replicas on one box"), `rooms` already comes
    from `listVoiceRoomOccupancy()`, a query over the shared `voice_peers`
    table, so every replica reports the SAME cluster-wide rooms -- take one,
    never sum (voice.ts:1891-1906). Without the registry this is only that
    process's own peer map, but that is exactly today's (buggy) single-scrape
    behaviour for a self-host running one replica, not a regression.

    `peakRoomSizeToday`: a per-process high-water mark (`noteRoomSizeForPeak`,
    voice.ts:1567-1581) reset at boot / Sao Paulo midnight -- not shared, not
    cumulative, so the true cluster peak is the max of what each process saw.

    `cluster`/`roster`/`liveHls`: in-memory, since-boot, per-instance counters
    (`clusterFrames`, `musicCluster`, `hlsReconcileRelay`, `rosterFramesSent`,
    `hlsAudienceFramesSent`, `hlsTokenRemint` -- voice.ts:1600-1621,
    1701-1734, 1922-1957) -- additive.

    `registry`/`seats`: see the dedicated helpers below -- each mixes a
    DB-derived field with in-memory counters.
    """
    a = a or {}
    b = b or {}
    if not a and not b:
        return None
    out: dict = {}
    for key in ("activeRooms", "participants", "largestRoomNow", "rooms", "backend", "peakTrackedSince"):
        out[key] = take_first(a.get(key), b.get(key))
    out["peakRoomSizeToday"] = max_nullable(a.get("peakRoomSizeToday"), b.get("peakRoomSizeToday"))
    out["cluster"] = deep_sum(a.get("cluster"), b.get("cluster"))
    out["roster"] = deep_sum(a.get("roster"), b.get("roster"))
    out["liveHls"] = deep_sum(a.get("liveHls"), b.get("liveHls"))
    out["registry"] = _merge_voice_registry(a.get("registry"), b.get("registry"))
    out["seats"] = _merge_voice_seats(a.get("seats"), b.get("seats"))
    return out


def _merge_voice_registry(a: dict | None, b: dict | None) -> dict | None:
    """`voice.registry` (voice.ts:1631-1651). `writesPerMinute` is registry
    writes issued BY THIS PROCESS in the trailing 60s -- each process writes
    its own rows, so the cluster rate is the sum. `batch.*` (registry-batch.ts:
    206-226) is mostly the same (cumulative since-boot counters, additive),
    except `maxBatch`/`flushMsP95`/`maxPending`, which are a high-water mark
    and a latency percentile -- not cumulative totals, so the larger of the
    two is the closer answer (a true merged p95 would need the underlying
    samples, which this payload does not carry)."""
    a = a or {}
    b = b or {}
    if not a and not b:
        return None
    out = {"writesPerMinute": deep_sum(a.get("writesPerMinute"), b.get("writesPerMinute"))}
    batch_a, batch_b = a.get("batch"), b.get("batch")
    if batch_a is None and batch_b is None:
        out["batch"] = None
    else:
        batch_a = batch_a or {}
        batch_b = batch_b or {}
        out["batch"] = {
            "batchFlushes": deep_sum(batch_a.get("batchFlushes"), batch_b.get("batchFlushes")),
            "rowsCoalesced": deep_sum(batch_a.get("rowsCoalesced"), batch_b.get("rowsCoalesced")),
            "flushFailures": deep_sum(batch_a.get("flushFailures"), batch_b.get("flushFailures")),
            "staleDropped": deep_sum(batch_a.get("staleDropped"), batch_b.get("staleDropped")),
            "pending": deep_sum(batch_a.get("pending"), batch_b.get("pending")),
            "maxBatch": max_nullable(batch_a.get("maxBatch"), batch_b.get("maxBatch")),
            "flushMsP95": max_nullable(batch_a.get("flushMsP95"), batch_b.get("flushMsP95")),
            "maxPending": max_nullable(batch_a.get("maxPending"), batch_b.get("maxPending")),
        }
    return out


def _merge_voice_seats(a: dict | None, b: dict | None) -> dict | None:
    """`voice.seats` (voice.ts:1812-1842). `idleOverAnHour`/`oldestIdleMinutes`
    come from `countIdleVoiceSeats()`, a query over the shared `voice_peers`
    table -- explicitly "SHARED ON PURPOSE" in that function's own comment, so
    take one, never sum. Everything else is either an in-memory since-boot
    counter (`staleRowWritesRefused`, `ghostsSwept`, `meshHoldsRefused`,
    `idleAloneWarned`, `idleAloneDisconnected`) or a count of sockets held BY
    THIS PROCESS (`meshResumeSockets`, `sockets`) -- a socket lives on exactly
    one replica, so the cluster total is the sum. `None` on either side means
    the registry was off on that replica (should not happen in practice --
    both replicas share one `.env` -- but handled rather than assumed)."""
    if a is None and b is None:
        return None
    if a is None:
        return b
    if b is None:
        return a
    return {
        "idleOverAnHour": take_first(a.get("idleOverAnHour"), b.get("idleOverAnHour")),
        "oldestIdleMinutes": take_first(a.get("oldestIdleMinutes"), b.get("oldestIdleMinutes")),
        "staleRowWritesRefused": deep_sum(a.get("staleRowWritesRefused"), b.get("staleRowWritesRefused")),
        "ghostsSwept": deep_sum(a.get("ghostsSwept"), b.get("ghostsSwept")),
        "meshHoldsRefused": deep_sum(a.get("meshHoldsRefused"), b.get("meshHoldsRefused")),
        "idleAloneWarned": deep_sum(a.get("idleAloneWarned"), b.get("idleAloneWarned")),
        "idleAloneDisconnected": deep_sum(a.get("idleAloneDisconnected"), b.get("idleAloneDisconnected")),
        "meshResumeSockets": deep_sum(a.get("meshResumeSockets"), b.get("meshResumeSockets")),
        "sockets": deep_sum(a.get("sockets"), b.get("sockets")),
    }


def _merge_live_hls(a: dict | None, b: dict | None) -> dict | None:
    """`payload.liveHls` (server/src/services/metrics.ts:512-655, built from
    `liveHlsActivity()`/`llHlsActivity()` in hls-egress.ts / hls-remux.ts).

    `enabled`/`configured`/`allowlisted`/`ladder`/`maxSessions`/`sweepsHere`/
    `latency`: config flags or a percentile histogram -- take one, never sum.
    `sweepsHere` in particular is `WORKER_MODE`-derived and identical on
    `api-a`/`api-b` (both run `WORKER_MODE=api`) so which one is taken does
    not matter in practice.

    `sessions`/`rungs`/`silentSessions`/`micArchive`/`cameraSessions`/
    `deferredStops`: CURRENT counts on this process (hls-egress.ts:2435-2465,
    `rooms.values()` / `deferredStops.size`) -- an egress lives in exactly one
    process's memory, so the cluster total is the sum, same reasoning as
    `voice.seats.sockets` above.

    `startsTotal`/`stopsTotal`/`restartsScheduled`/`restartsExhausted`/
    `orphansStopped`/`skippedOwnedElsewhere`/`llStartFailures`/
    `llStopFailures`/`llDemoted`/`keepWarmLoops`/`keepWarmRenders`: cumulative
    since-boot counters, additive by the same reasoning as `calls.*`.

    `oldestSessionMinutes`: the longest-running LOCAL session's age -- not
    cumulative, not shared, so the cluster's oldest session is the max of
    what each process reports (mirrors `voice.peakRoomSizeToday`).

    `uncleaned`: `countDueSessions()`, a query over `hls_sessions` -- shared
    across the cluster (metrics.ts:1011, "only `uncleaned` costs a query...").
    Summing this would double the real count of leaked objects.

    `stateFrames`/`playlistRejectedByReason`: in-memory since-boot counters
    (watch-party-events.ts, hls-playlist-proxy.ts) -- additive.
    """
    a = a or {}
    b = b or {}
    if not a and not b:
        return None
    out: dict = {}
    for key in ("enabled", "configured", "allowlisted", "ladder", "maxSessions", "sweepsHere", "latency"):
        out[key] = take_first(a.get(key), b.get(key))
    out["stateFrames"] = deep_sum(a.get("stateFrames"), b.get("stateFrames"))
    out["playlistRejectedByReason"] = deep_sum(a.get("playlistRejectedByReason"), b.get("playlistRejectedByReason"))
    for key in (
        "sessions", "rungs", "silentSessions", "micArchive", "cameraSessions", "deferredStops",
        "skippedOwnedElsewhere", "orphansStopped", "startsTotal", "stopsTotal",
        "restartsScheduled", "restartsExhausted", "keepWarmLoops", "keepWarmRenders",
        "llSessions", "llStartFailures", "llStopFailures", "llDemoted",
    ):
        out[key] = deep_sum(a.get(key), b.get(key))
    out["oldestSessionMinutes"] = max_nullable(a.get("oldestSessionMinutes"), b.get("oldestSessionMinutes"))
    out["uncleaned"] = take_first(a.get("uncleaned"), b.get("uncleaned"))
    return out


def _merge_watch_party(a: dict | None, b: dict | None) -> dict | None:
    """`payload.watchParty` (services/watch-parties.ts:1385-1394,
    `sweepCounters`): in-memory since-boot counters -- additive.
    `draftTtlMinutes`/`hostGoneMinutes` are the two sweep knobs' live values
    (config, identical on both replicas) -- take one."""
    a = a or {}
    b = b or {}
    if not a and not b:
        return None
    out: dict = {}
    for key in ("sweptDrafts", "supersededDrafts", "sweptHostGone", "sweptNoShare", "heldByLiveStream", "streamCheckFailures"):
        out[key] = deep_sum(a.get(key), b.get(key))
    for key in ("draftTtlMinutes", "hostGoneMinutes"):
        out[key] = take_first(a.get(key), b.get(key))
    return out


def _merge_product(a: dict | None, b: dict | None) -> dict | None:
    """`payload.product` (services/metrics.ts). `friendships`/
    `pendingFriendRequests`/`attachments`/`invites`/`push` come from one SQL
    query (`productCounts` in `computeAdminMetrics`) -- DB-derived, shared,
    take one. `pushDelivery` is `product/push-metrics.ts`'s in-process,
    since-boot send-outcome counters -- additive, and the example the task
    that produced this file was built around."""
    a = a or {}
    b = b or {}
    if not a and not b:
        return None
    out: dict = {}
    for key in ("friendships", "pendingFriendRequests", "attachments", "invites", "push"):
        out[key] = take_first(a.get(key), b.get(key))
    out["pushDelivery"] = deep_sum(a.get("pushDelivery"), b.get("pushDelivery"))
    return out


# ----- top-level policy table ----------------------------------------------

# SHARED / PER-INSTANCE-HEALTH: DB-derived (every replica queries the same
# Postgres) or describes "whichever process answered" (runtime, ready, sfu,
# config). Never summed -- see services/metrics.ts's own field comments,
# which name each of these as either a SQL-backed block or explicitly
# per-instance ("Which machine answered this request", "cluster" itself is
# already the cross-instance sum via the `voice_instances` heartbeat table --
# metrics.ts:163-177 -- so summing it AGAIN here would double it).
_SHARED_TAKE_FIRST_KEYS = (
    "generatedAt", "cacheTtlSeconds", "version", "excludedAccounts",
    "runtime", "instanceId", "instanceCount", "cluster", "ready", "sfu",
    "statusHistory", "users", "servers", "messages", "distinctSenders24h",
    "activeTextChannels24h", "channels", "topServers24h", "acquisition",
    "activation", "retention", "callRatings", "connections",
    "channelDetail", "userDetail", "communities", "moderation",
)

# ADDITIVE: process-local in-memory counters, confirmed cumulative-since-boot
# in their own source file (db-tx-metrics.ts, read-cache.ts, chat.ts's
# `getPresenceFanoutStats`, call-metrics.ts). Recursively summed, including
# their nested label maps (`byPath`, `byRoute`, `joinRefusedByReason`, ...).
_ADDITIVE_SUM_KEYS = ("dbTx", "dbQueries", "readCache", "presence", "calls")

# Blocks that mix process-local and DB-derived fields: hand-written mergers.
_CUSTOM_MERGERS = {
    "voice": _merge_voice,
    "liveHls": _merge_live_hls,
    "watchParty": _merge_watch_party,
    "product": _merge_product,
}

_warned_unclassified_keys: set[str] = set()


def _merge_pair(a: dict, b: dict) -> dict:
    keys = dict.fromkeys(list(a.keys()) + list(b.keys()))
    out: dict = {}
    for key in keys:
        if key in _CUSTOM_MERGERS:
            out[key] = _CUSTOM_MERGERS[key](a.get(key), b.get(key))
        elif key in _ADDITIVE_SUM_KEYS:
            out[key] = deep_sum(a.get(key), b.get(key))
        elif key in _SHARED_TAKE_FIRST_KEYS:
            out[key] = take_first(a.get(key), b.get(key))
        else:
            # Not explicitly classified. Default to take-from-first, which is
            # safe against double-counting: the wrong call on an additive
            # counter merely undercounts it (same failure mode as scraping
            # one replica today), while the wrong call on a shared/DB-derived
            # number would silently double it. Logged once per process so a
            # new top-level block on the payload does not ride along
            # unclassified forever -- see this file's module docstring and
            # tools/monitoring/README.md.
            if key not in _warned_unclassified_keys:
                _warned_unclassified_keys.add(key)
                print(
                    f"pqp-api-metrics-exporter: unclassified admin-metrics block '{key}' -- "
                    "defaulting to take-from-first-replica; classify it in "
                    "_merge_pair()'s policy tables (pqp-api-metrics-exporter.py)",
                    file=sys.stderr,
                )
            out[key] = take_first(a.get(key), b.get(key))
    return out


def merge_admin_metrics(payloads: list[dict]) -> dict:
    """Combine 1+ admin-metrics payloads (one per scraped replica) into the
    single, correct payload `render()` expects. A single payload is returned
    unchanged -- the single-endpoint fallback path never touches any of the
    merge logic above, so a self-host / single-replica deployment's output is
    byte-for-byte what it always was."""
    if not payloads:
        raise ValueError("merge_admin_metrics requires at least one payload")
    merged = payloads[0]
    for extra in payloads[1:]:
        merged = _merge_pair(merged, extra)
    return merged


def render(
    payload: dict,
    ready_payload: dict | None = None,
    replicas_scraped: int = 1,
    instances_expected: int = 1,
) -> str:
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
        "pqp_api_metrics_replicas_scraped",
        "How many DISTINCT api-a/api-b instances (by instanceId) this run collected a snapshot "
        "for, via collect_admin_metrics_snapshots(). 1 for a single-replica deployment or an "
        "older API with no instanceId. Less than pqp_api_metrics_instances_expected means a "
        "partial collection -- the numbers below are still real, just not the whole cluster's.",
        replicas_scraped,
    )
    gauge(
        lines,
        "pqp_api_metrics_instances_expected",
        "instanceCount as reported by the admin-metrics payload: how many live instances this "
        "run should have collected a snapshot from. Compare against "
        "pqp_api_metrics_replicas_scraped to see a partial collection.",
        instances_expected,
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
        override = admin_metrics_endpoints_override()
        if override:
            payloads, _ = fetch_admin_metrics_all(override)
            expected = len(override)
        else:
            payloads, expected = collect_admin_metrics_snapshots()
        payload = merge_admin_metrics(payloads)
        scraped = len(payloads)
        try:
            ready_payload = fetch_ready()
        except Exception as exc:  # noqa: BLE001
            print(f"pqp-api-metrics-exporter: /ready fetch failed, using admin block: {exc}", file=sys.stderr)
            ready_payload = None
        body = render(payload, ready_payload, replicas_scraped=scraped, instances_expected=expected)
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
