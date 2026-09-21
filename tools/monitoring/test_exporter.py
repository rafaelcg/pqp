"""Unit tests for pqp-api-metrics-exporter.py's render() -- payload dict in,
Prometheus text out, no network. render() was already a pure function (it
takes the parsed JSON payload and returns a string), so no refactor was
needed to make it testable; this file just exercises it directly.

The module's filename has dashes, so it is not import-able as a normal
package -- loaded by path with importlib instead, same trick the file itself
would need if it ever wanted to import a sibling script.

Run with: python3 -m unittest tools/monitoring/test_exporter.py
       or (from this directory): python3 -m unittest test_exporter
"""

from __future__ import annotations

import importlib.util
import os
import unittest

MODULE_PATH = os.path.join(os.path.dirname(__file__), "pqp-api-metrics-exporter.py")

_spec = importlib.util.spec_from_file_location("pqp_api_metrics_exporter", MODULE_PATH)
assert _spec is not None and _spec.loader is not None
exporter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(exporter)


def _base_payload(**overrides) -> dict:
    payload = {
        "ready": {
            "ok": True,
            "checks": {
                "postgres": {"ok": True, "ms": 5},
                "pool": {"queued": 0, "inUse": 1, "max": 10},
            },
        },
        "runtime": {
            "sockets": 3,
            "db": {"breaker": {"state": "closed", "opened": 0, "rejected": 0}},
        },
        "cluster": {"sockets": 3},
        "voice": {
            "activeRooms": 0,
            "participants": 0,
            "largestRoomNow": 0,
            "peakRoomSizeToday": 4,
            "rooms": [],
        },
        "liveHls": {"sessions": 0, "rungs": 0, "orphansStopped": 0},
    }
    payload.update(overrides)
    return payload


class RenderNewGaugesTests(unittest.TestCase):
    def test_empty_voice_rooms_emits_both_backends_at_zero(self):
        body = exporter.render(_base_payload())
        self.assertIn('pqp_api_voice_participants_by_backend{backend="mesh"} 0', body)
        self.assertIn('pqp_api_voice_participants_by_backend{backend="livekit"} 0', body)
        self.assertIn('pqp_api_voice_rooms_by_backend{backend="mesh"} 0', body)
        self.assertIn('pqp_api_voice_rooms_by_backend{backend="livekit"} 0', body)

    def test_missing_rooms_key_also_defaults_to_zero(self):
        payload = _base_payload()
        del payload["voice"]["rooms"]
        body = exporter.render(payload)
        self.assertIn('pqp_api_voice_participants_by_backend{backend="mesh"} 0', body)
        self.assertIn('pqp_api_voice_rooms_by_backend{backend="livekit"} 0', body)

    def test_mixed_backend_rooms_sum_and_count_per_backend(self):
        payload = _base_payload(
            voice={
                "activeRooms": 3,
                "participants": 9,
                "largestRoomNow": 5,
                "peakRoomSizeToday": 12,
                "rooms": [
                    {"transport": "mesh", "participants": 2},
                    {"transport": "mesh", "participants": 3},
                    {"transport": "livekit", "participants": 4},
                ],
            }
        )
        body = exporter.render(payload)
        self.assertIn('pqp_api_voice_participants_by_backend{backend="mesh"} 5', body)
        self.assertIn('pqp_api_voice_participants_by_backend{backend="livekit"} 4', body)
        self.assertIn('pqp_api_voice_rooms_by_backend{backend="mesh"} 2', body)
        self.assertIn('pqp_api_voice_rooms_by_backend{backend="livekit"} 1', body)
        self.assertIn("pqp_api_voice_largest_room_now 5", body)
        self.assertIn("pqp_api_voice_peak_room_size_today 12", body)

    def test_room_with_unrecognised_transport_is_skipped_not_guessed(self):
        payload = _base_payload(
            voice={
                "activeRooms": 1,
                "participants": 2,
                "largestRoomNow": 2,
                "peakRoomSizeToday": 2,
                "rooms": [{"transport": "cloudflare-sfu", "participants": 2}],
            }
        )
        body = exporter.render(payload)
        self.assertIn('pqp_api_voice_participants_by_backend{backend="mesh"} 0', body)
        self.assertIn('pqp_api_voice_participants_by_backend{backend="livekit"} 0', body)
        self.assertIn('pqp_api_voice_rooms_by_backend{backend="mesh"} 0', body)
        self.assertIn('pqp_api_voice_rooms_by_backend{backend="livekit"} 0', body)

    def test_users_online_reads_cluster_sockets(self):
        payload = _base_payload(cluster={"sockets": 42})
        body = exporter.render(payload)
        self.assertIn("pqp_api_users_online 42", body)

    def test_db_breaker_open_reports_zero_when_closed(self):
        body = exporter.render(_base_payload())
        self.assertIn("pqp_api_db_breaker_open 0", body)

    def test_db_breaker_open_reports_one_when_open_or_half_open(self):
        for state in ("open", "half-open"):
            payload = _base_payload(
                runtime={"sockets": 1, "db": {"breaker": {"state": state, "opened": 1, "rejected": 3}}}
            )
            body = exporter.render(payload)
            self.assertIn("pqp_api_db_breaker_open 1", body, msg=f"state={state}")

    def test_db_breaker_missing_defaults_to_closed(self):
        payload = _base_payload(runtime={"sockets": 1})
        body = exporter.render(payload)
        self.assertIn("pqp_api_db_breaker_open 0", body)

    def test_no_hls_viewers_gauge_is_emitted(self):
        # pqp has no server-side concurrent-viewer count; the exporter must
        # not invent one. See the comment above the liveHls gauges in
        # pqp-api-metrics-exporter.py and grafana-dashboard-event.json's
        # "Watching" panel.
        body = exporter.render(_base_payload())
        self.assertNotIn("pqp_api_hls_viewers", body)

    def test_no_hls_active_sessions_gauge_is_emitted(self):
        # Would be identical to the existing pqp_api_hls_sessions.
        body = exporter.render(_base_payload())
        self.assertNotIn("pqp_api_hls_active_sessions", body)

    def test_existing_gauges_still_present(self):
        # Regression guard: the new gauges must not have displaced the old
        # ones existing dashboards and alerts already depend on.
        body = exporter.render(_base_payload())
        for name in (
            "pqp_api_sockets",
            "pqp_api_voice_participants",
            "pqp_api_voice_active_rooms",
            "pqp_api_hls_sessions",
            "pqp_api_hls_rungs",
            "pqp_api_hls_orphans_stopped_total",
            "pqp_api_ready_ok",
            "pqp_api_ready_postgres_ok",
            "pqp_api_ready_postgres_ms",
            "pqp_api_ready_pool_queued",
            "pqp_api_ready_pool_in_use",
            "pqp_api_ready_pool_max",
        ):
            self.assertIn(name, body, msg=f"missing existing gauge {name}")


class RenderGrowthMetricsTests(unittest.TestCase):
    def _payload(self):
        return _base_payload(
            users={"total": 400, "last24h": 12},
            servers={"total": 30, "last24h": 2},
            messages={
                "last24h": 100,
                "byScope24h": {"dm": 40, "group": 10, "server": 50},
            },
            activation={
                "window7d": {
                    "signup": 12,
                    "ageGate": 10,
                    "handle": 4,
                    "firstJoin": 8,
                    "firstMessage": 6,
                    "firstVoice": 3,
                    "firstWatchParty": 1,
                },
                "window30d": {
                    "signup": 400,
                    "ageGate": 360,
                    "handle": 120,
                    "firstJoin": 300,
                    "firstMessage": 220,
                    "firstVoice": 90,
                    "firstWatchParty": 20,
                },
                "conversion30d": {
                    "signupToAgeGate": 0.9,
                    "ageGateToHandle": 0.333,
                    "handleToFirstJoin": 2.5,
                    "firstJoinToFirstMessage": 0.733,
                    "firstMessageToFirstVoice": 0.409,
                    "firstVoiceToFirstWatchParty": 0.222,
                    "signupToFirstMessage": 0.55,
                },
            },
            calls={
                "joinAttempts": 20,
                "joinConnected": 17,
                "joinConnectedByTransport": {"mesh": 12, "livekit": 5},
                "joinConnectedByScope": {"dm": 8, "group": 2, "server": 7},
                "joinRefusedByReason": {"room-full": 3},
                "rings": 6,
                "ringsAnswered": 4,
                "ringsDeclined": 1,
                "ringsEndedByReason": {"timeout": 1, "cancelled": 0},
            },
            liveHls={
                "sessions": 1,
                "rungs": 3,
                "orphansStopped": 0,
                "startsTotal": 2,
                "stopsTotal": 1,
                "restartsScheduled": 4,
                "restartsExhausted": 1,
                "playlistRejectedByReason": {"expired": 9, "missing": 2},
            },
            product={
                "pushDelivery": {
                    "web": {"sent": 30, "failed": 2, "pruned": 1},
                    "apns": {"sent": 5, "failed": 0, "pruned": 0},
                    "fcm": {"sent": 7, "failed": 1, "pruned": 0},
                }
            },
            streamQuality={
                "samplesAccepted": 12,
                "batchesAccepted": 4,
                "batchesRejectedSchema": 1,
                "batchesRejectedRateLimit": 0,
                "fpsBuckets": {
                    "presenter": {
                        "mesh": {"5-9": 3, "30-plus": 1},
                        "livekit": {},
                    },
                    "viewer": {"mesh": {}, "livekit": {"30-plus": 2}},
                },
                "bitrateBuckets": {
                    "presenter": {"mesh": {"200-499": 3}, "livekit": {}},
                    "viewer": {"mesh": {}, "livekit": {}},
                },
                "resolutionBuckets": {
                    "presenter": {"mesh": {"360p": 3}, "livekit": {}},
                    "viewer": {"mesh": {}, "livekit": {}},
                },
                "limitationReasons": {
                    "mesh": {"none": 0, "cpu": 0, "bandwidth": 3, "other": 0},
                    "livekit": {"none": 1, "cpu": 0, "bandwidth": 0, "other": 0},
                },
            },
        )

    def test_signups_and_messages(self):
        body = exporter.render(self._payload())
        self.assertIn("pqp_api_signups_24h 12", body)
        self.assertIn("pqp_api_messages_24h 100", body)
        self.assertIn('pqp_api_messages_24h_by_scope{scope="dm"} 40', body)
        self.assertIn('pqp_api_messages_24h_by_scope{scope="server"} 50', body)

    def test_call_outcomes(self):
        body = exporter.render(self._payload())
        self.assertIn("pqp_api_call_join_attempts_total 20", body)
        self.assertIn("pqp_api_call_join_connected_total 17", body)
        self.assertIn('pqp_api_call_join_connected_by_transport_total{transport="mesh"} 12', body)
        self.assertIn('pqp_api_call_join_connected_by_scope_total{scope="dm"} 8', body)
        self.assertIn('pqp_api_call_join_refused_total{reason="room-full"} 3', body)
        # A refusal reason never seen still gets a zero series.
        self.assertIn('pqp_api_call_join_refused_total{reason="no-access"} 0', body)
        self.assertIn("pqp_api_call_rings_total 6", body)
        self.assertIn('pqp_api_call_rings_ended_total{reason="timeout"} 1', body)

    def test_watch_party_lifecycle_and_rejections(self):
        body = exporter.render(self._payload())
        self.assertIn("pqp_api_hls_starts_total 2", body)
        self.assertIn("pqp_api_hls_restarts_scheduled_total 4", body)
        self.assertIn("pqp_api_hls_restarts_exhausted_total 1", body)
        self.assertIn('pqp_api_hls_playlist_rejected_total{reason="expired"} 9', body)

    def test_push_delivery(self):
        body = exporter.render(self._payload())
        self.assertIn('pqp_api_push_delivery_total{platform="web",outcome="sent"} 30', body)
        self.assertIn('pqp_api_push_delivery_total{platform="fcm",outcome="failed"} 1', body)

    def test_stream_quality_fps_bitrate_resolution_and_limitation_reason(self):
        body = exporter.render(self._payload())
        self.assertIn(
            'pqp_api_stream_quality_fps_total{role="presenter",transport="mesh",bucket="5-9"} 3',
            body,
        )
        # A bucket never hit still gets a zero series.
        self.assertIn(
            'pqp_api_stream_quality_fps_total{role="presenter",transport="mesh",bucket="0-4"} 0',
            body,
        )
        self.assertIn(
            'pqp_api_stream_quality_fps_total{role="viewer",transport="livekit",bucket="30-plus"} 2',
            body,
        )
        self.assertIn(
            'pqp_api_stream_quality_bitrate_kbps_total{role="presenter",transport="mesh",bucket="200-499"} 3',
            body,
        )
        self.assertIn(
            'pqp_api_stream_quality_resolution_total{role="presenter",transport="mesh",bucket="360p"} 3',
            body,
        )
        self.assertIn(
            'pqp_api_stream_quality_limitation_reason_total{transport="mesh",reason="bandwidth"} 3',
            body,
        )
        self.assertIn(
            'pqp_api_stream_quality_limitation_reason_total{transport="livekit",reason="none"} 1',
            body,
        )

    def test_stream_quality_absent_emits_nothing_but_does_not_crash(self):
        payload = self._payload()
        del payload["streamQuality"]
        body = exporter.render(payload)
        self.assertNotIn("pqp_api_stream_quality_fps_total", body)

    def test_activation_funnel_cohort_and_conversion(self):
        body = exporter.render(self._payload())
        # Both windows, every step, are emitted.
        self.assertIn('pqp_api_activation_cohort{window="7d",step="signup"} 12', body)
        self.assertIn('pqp_api_activation_cohort{window="7d",step="first_message"} 6', body)
        self.assertIn('pqp_api_activation_cohort{window="7d",step="first_watch_party"} 1', body)
        self.assertIn('pqp_api_activation_cohort{window="30d",step="signup"} 400', body)
        self.assertIn('pqp_api_activation_cohort{window="30d",step="first_voice"} 90', body)
        # The headline conversion the alert watches.
        self.assertIn(
            'pqp_api_activation_conversion_30d{step="signup_to_first_message"} 0.55',
            body,
        )
        self.assertIn(
            'pqp_api_activation_conversion_30d{step="signup_to_age_gate"} 0.9', body
        )

    def test_activation_missing_steps_default_to_zero(self):
        # A window present but a step key absent still emits a zero series, so
        # the funnel panel is never a hole while a step has no data yet.
        payload = _base_payload(
            activation={"window7d": {"signup": 5}, "window30d": {}}
        )
        body = exporter.render(payload)
        self.assertIn('pqp_api_activation_cohort{window="7d",step="signup"} 5', body)
        self.assertIn('pqp_api_activation_cohort{window="7d",step="first_voice"} 0', body)
        self.assertIn('pqp_api_activation_cohort{window="30d",step="signup"} 0', body)

    def test_absent_blocks_do_not_crash_render(self):
        # An older payload with none of the growth blocks still renders (the
        # optional blocks are skipped, the always-present ones default).
        body = exporter.render(_base_payload())
        self.assertIn("pqp_api_metrics_scrape_ok 1", body)
        self.assertIn("pqp_api_hls_starts_total 0", body)
        # No activation block at all -> no funnel series, and no crash.
        self.assertNotIn("pqp_api_activation_cohort", body)


class RenderFailureTests(unittest.TestCase):
    def test_render_failure_marks_scrape_not_ok(self):
        body = exporter.render_failure()
        self.assertIn("pqp_api_metrics_scrape_ok 0", body)
        # A failed scrape must not carry over any of the new gauges either.
        self.assertNotIn("pqp_api_users_online", body)
        self.assertNotIn("pqp_api_voice_participants_by_backend", body)
        self.assertNotIn("pqp_api_db_breaker_open", body)
        self.assertNotIn("pqp_api_call_join_attempts_total", body)


class ReplicasScrapedGaugeTests(unittest.TestCase):
    def test_defaults_to_one(self):
        body = exporter.render(_base_payload())
        self.assertIn("pqp_api_metrics_replicas_scraped 1", body)
        self.assertIn("pqp_api_metrics_instances_expected 1", body)

    def test_reflects_the_counts_passed_in(self):
        body = exporter.render(_base_payload(), replicas_scraped=1, instances_expected=2)
        self.assertIn("pqp_api_metrics_replicas_scraped 1", body)
        self.assertIn("pqp_api_metrics_instances_expected 2", body)


class AdminMetricsEndpointsOverrideTests(unittest.TestCase):
    """`PQP_API_METRICS_ENDPOINTS` parsing -- an OPTIONAL override, not the
    primary mechanism (that is `collect_admin_metrics_snapshots()`'s
    instanceId dedup, tested below). Unset/blank must return `None` so
    `main()` falls through to the dedup path -- a self-host / single-replica
    box needs no config change either way."""

    def setUp(self):
        self._saved = os.environ.get("PQP_API_METRICS_ENDPOINTS")

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("PQP_API_METRICS_ENDPOINTS", None)
        else:
            os.environ["PQP_API_METRICS_ENDPOINTS"] = self._saved

    def test_unset_returns_none(self):
        os.environ.pop("PQP_API_METRICS_ENDPOINTS", None)
        self.assertIsNone(exporter.admin_metrics_endpoints_override())

    def test_comma_separated_list_is_split_and_trimmed(self):
        os.environ["PQP_API_METRICS_ENDPOINTS"] = (
            " https://api-a.internal/api/admin/metrics , https://api-b.internal/api/admin/metrics "
        )
        self.assertEqual(
            exporter.admin_metrics_endpoints_override(),
            ["https://api-a.internal/api/admin/metrics", "https://api-b.internal/api/admin/metrics"],
        )

    def test_blank_value_returns_none(self):
        os.environ["PQP_API_METRICS_ENDPOINTS"] = "   "
        self.assertIsNone(exporter.admin_metrics_endpoints_override())


class FetchAdminMetricsAllTests(unittest.TestCase):
    """`fetch_admin_metrics_all()` against a stubbed `fetch_admin_metrics()` --
    no network. Covers the partial-failure case the task asked for: one
    replica down must not blank the whole textfile."""

    def setUp(self):
        self._orig = exporter.fetch_admin_metrics

    def tearDown(self):
        exporter.fetch_admin_metrics = self._orig

    def test_both_endpoints_succeed(self):
        exporter.fetch_admin_metrics = lambda url: {"url": url}
        payloads, scraped = exporter.fetch_admin_metrics_all(["a", "b"])
        self.assertEqual(scraped, 2)
        self.assertEqual([p["url"] for p in payloads], ["a", "b"])

    def test_one_endpoint_down_still_produces_output(self):
        def flaky(url):
            if url == "b":
                raise RuntimeError("connection refused")
            return {"url": url}

        exporter.fetch_admin_metrics = flaky
        payloads, scraped = exporter.fetch_admin_metrics_all(["a", "b"])
        self.assertEqual(scraped, 1)
        self.assertEqual([p["url"] for p in payloads], ["a"])

    def test_all_endpoints_down_raises(self):
        def always_fails(url):
            raise RuntimeError("connection refused")

        exporter.fetch_admin_metrics = always_fails
        with self.assertRaises(RuntimeError):
            exporter.fetch_admin_metrics_all(["a", "b"])


class CollectAdminMetricsSnapshotsTests(unittest.TestCase):
    """`collect_admin_metrics_snapshots()` -- the ACTUAL replica-split fix.
    No Caddy route, no per-replica URL: scrape the ordinary load-balanced
    endpoint repeatedly and dedup by the payload's own `instanceId`, stopping
    once `instanceCount` distinct ids have been seen or the scrape budget
    (`PQP_API_METRICS_MAX_SCRAPES`) runs out. Mocks `fetch_admin_metrics`, no
    network."""

    def setUp(self):
        self._orig_fetch = exporter.fetch_admin_metrics
        self._saved_max_scrapes = os.environ.get("PQP_API_METRICS_MAX_SCRAPES")

    def tearDown(self):
        exporter.fetch_admin_metrics = self._orig_fetch
        if self._saved_max_scrapes is None:
            os.environ.pop("PQP_API_METRICS_MAX_SCRAPES", None)
        else:
            os.environ["PQP_API_METRICS_MAX_SCRAPES"] = self._saved_max_scrapes

    def test_alternating_instance_ids_collect_both_snapshots(self):
        # Simulates a round-robin load balancer: consecutive scrapes of the
        # SAME url land on alternating replicas, each with its own
        # instanceId, different calls counts, identical messages/activation.
        payload_a = {
            "instanceId": "instance-a",
            "instanceCount": 2,
            "calls": {"joinAttempts": 5},
            "messages": {"last24h": 100},
        }
        payload_b = {
            "instanceId": "instance-b",
            "instanceCount": 2,
            "calls": {"joinAttempts": 3},
            "messages": {"last24h": 100},
        }
        cycle = [payload_a, payload_b]
        calls = {"n": 0}

        def fake_fetch(url):
            payload = cycle[calls["n"] % len(cycle)]
            calls["n"] += 1
            return payload

        exporter.fetch_admin_metrics = fake_fetch
        snapshots, expected = exporter.collect_admin_metrics_snapshots()
        self.assertEqual(expected, 2)
        self.assertEqual(len(snapshots), 2)
        ids = {snap["instanceId"] for snap in snapshots}
        self.assertEqual(ids, {"instance-a", "instance-b"})
        # Stopped as soon as both distinct ids were seen -- exactly 2 scrapes,
        # not the full PQP_API_METRICS_MAX_SCRAPES budget.
        self.assertEqual(calls["n"], 2)

    def test_merged_result_sums_calls_and_does_not_double_messages(self):
        payload_a = {
            "instanceId": "instance-a",
            "instanceCount": 2,
            "calls": {"joinAttempts": 5, "joinConnected": 4},
            "messages": {"last24h": 100},
            "activation": {"window7d": {"signup": 12}},
        }
        payload_b = {
            "instanceId": "instance-b",
            "instanceCount": 2,
            "calls": {"joinAttempts": 3, "joinConnected": 2},
            "messages": {"last24h": 100},
            "activation": {"window7d": {"signup": 12}},
        }
        cycle = [payload_a, payload_b]
        calls = {"n": 0}

        def fake_fetch(url):
            payload = cycle[calls["n"] % len(cycle)]
            calls["n"] += 1
            return payload

        exporter.fetch_admin_metrics = fake_fetch
        snapshots, expected = exporter.collect_admin_metrics_snapshots()
        merged = exporter.merge_admin_metrics(snapshots)
        self.assertEqual(merged["calls"]["joinAttempts"], 8)
        self.assertEqual(merged["calls"]["joinConnected"], 6)
        self.assertEqual(merged["messages"]["last24h"], 100)
        self.assertEqual(merged["activation"]["window7d"]["signup"], 12)

    def test_merged_result_sums_stream_quality_nested_buckets(self):
        # Three levels deep (role -> transport -> bucket): confirms deep_sum
        # recurses past the two-level shape calls/pushDelivery already cover.
        payload_a = {
            "instanceId": "instance-a",
            "instanceCount": 2,
            "streamQuality": {
                "samplesAccepted": 5,
                "fpsBuckets": {"presenter": {"mesh": {"5-9": 2}}},
                "limitationReasons": {"mesh": {"bandwidth": 2}},
            },
        }
        payload_b = {
            "instanceId": "instance-b",
            "instanceCount": 2,
            "streamQuality": {
                "samplesAccepted": 3,
                "fpsBuckets": {"presenter": {"mesh": {"5-9": 1}, "livekit": {"30-plus": 4}}},
                "limitationReasons": {"mesh": {"bandwidth": 1}, "livekit": {"none": 6}},
            },
        }
        cycle = [payload_a, payload_b]
        calls = {"n": 0}

        def fake_fetch(url):
            payload = cycle[calls["n"] % len(cycle)]
            calls["n"] += 1
            return payload

        exporter.fetch_admin_metrics = fake_fetch
        snapshots, _ = exporter.collect_admin_metrics_snapshots()
        merged = exporter.merge_admin_metrics(snapshots)
        self.assertEqual(merged["streamQuality"]["samplesAccepted"], 8)
        self.assertEqual(merged["streamQuality"]["fpsBuckets"]["presenter"]["mesh"]["5-9"], 3)
        # A key seen by only one replica (livekit here) still carries its count.
        self.assertEqual(
            merged["streamQuality"]["fpsBuckets"]["presenter"]["livekit"]["30-plus"], 4
        )
        self.assertEqual(merged["streamQuality"]["limitationReasons"]["mesh"]["bandwidth"], 3)
        self.assertEqual(merged["streamQuality"]["limitationReasons"]["livekit"]["none"], 6)

    def test_never_exceeds_max_scrapes(self):
        # A sticky load balancer that always answers with the SAME instance,
        # while claiming a second one exists -- the collector must give up
        # after the configured budget rather than looping forever.
        os.environ["PQP_API_METRICS_MAX_SCRAPES"] = "5"
        sticky_payload = {
            "instanceId": "instance-a",
            "instanceCount": 2,
            "calls": {"joinAttempts": 1},
        }
        calls = {"n": 0}

        def fake_fetch(url):
            calls["n"] += 1
            return sticky_payload

        exporter.fetch_admin_metrics = fake_fetch
        snapshots, expected = exporter.collect_admin_metrics_snapshots()
        self.assertEqual(calls["n"], 5)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(expected, 2)

    def test_single_instance_deployment(self):
        # API_REPLICAS=1: instanceCount is 1, so the very first scrape
        # already satisfies it -- one snapshot, one fetch.
        payload = {
            "instanceId": "only-instance",
            "instanceCount": 1,
            "calls": {"joinAttempts": 9},
        }
        calls = {"n": 0}

        def fake_fetch(url):
            calls["n"] += 1
            return payload

        exporter.fetch_admin_metrics = fake_fetch
        snapshots, expected = exporter.collect_admin_metrics_snapshots()
        self.assertEqual(calls["n"], 1)
        self.assertEqual(expected, 1)
        merged = exporter.merge_admin_metrics(snapshots)
        # A single-element merge must equal that payload unchanged.
        self.assertIs(merged, payload)

    def test_missing_instance_id_falls_back_to_single_scrape(self):
        # An older API predating the instanceId field: nothing to dedup on,
        # so this must behave exactly like the original single-scrape
        # exporter -- one fetch, no repeats.
        payload = {"calls": {"joinAttempts": 4}}
        calls = {"n": 0}

        def fake_fetch(url):
            calls["n"] += 1
            return payload

        exporter.fetch_admin_metrics = fake_fetch
        snapshots, expected = exporter.collect_admin_metrics_snapshots()
        self.assertEqual(calls["n"], 1)
        self.assertEqual(snapshots, [payload])
        self.assertEqual(expected, 1)

    def test_partial_failures_still_collect_the_others(self):
        payload_a = {"instanceId": "instance-a", "instanceCount": 2, "calls": {"joinAttempts": 1}}
        payload_b = {"instanceId": "instance-b", "instanceCount": 2, "calls": {"joinAttempts": 2}}
        cycle = [RuntimeError("timeout"), payload_a, RuntimeError("timeout"), payload_b]
        calls = {"n": 0}

        def flaky(url):
            item = cycle[calls["n"] % len(cycle)]
            calls["n"] += 1
            if isinstance(item, Exception):
                raise item
            return item

        exporter.fetch_admin_metrics = flaky
        snapshots, expected = exporter.collect_admin_metrics_snapshots()
        ids = {snap["instanceId"] for snap in snapshots}
        self.assertEqual(ids, {"instance-a", "instance-b"})
        self.assertEqual(expected, 2)

    def test_all_scrapes_failing_raises(self):
        def always_fails(url):
            raise RuntimeError("connection refused")

        exporter.fetch_admin_metrics = always_fails
        with self.assertRaises(RuntimeError):
            exporter.collect_admin_metrics_snapshots()


class MergeAdminMetricsTests(unittest.TestCase):
    """The classification this fix is actually about: `calls` and
    `product.pushDelivery` (process-local, additive) must be SUMMED across
    replicas, while `messages`/`activation`/`users`/`cluster` (DB-derived,
    shared) must NOT be doubled -- summing them would be as wrong as the
    non-monotonic bounce this exporter used to produce, just in the other
    direction."""

    def _payload(self, calls_join_attempts, messages_last24h, activation_signup):
        return {
            "cluster": {"sockets": 7},
            "users": {"total": 500, "last24h": 20},
            "messages": {
                "last24h": messages_last24h,
                "byScope24h": {"dm": 10, "group": 5, "server": 15},
            },
            "activation": {
                "window7d": {"signup": activation_signup, "firstMessage": 3},
            },
            "calls": {
                "joinAttempts": calls_join_attempts,
                "joinConnected": calls_join_attempts - 1,
                "joinConnectedByTransport": {"mesh": calls_join_attempts, "livekit": 0},
                "joinRefusedByReason": {"room-full": 1},
                "rings": 2,
                "ringsAnswered": 1,
                "ringsDeclined": 0,
                "ringsEndedByReason": {"timeout": 1},
            },
            "product": {
                "friendships": 42,
                "pushDelivery": {
                    "web": {"sent": 10, "failed": 1, "pruned": 0},
                },
            },
        }

    def test_calls_are_summed_across_replicas(self):
        a = self._payload(calls_join_attempts=9, messages_last24h=100, activation_signup=12)
        b = self._payload(calls_join_attempts=9, messages_last24h=100, activation_signup=12)
        merged = exporter.merge_admin_metrics([a, b])
        self.assertEqual(merged["calls"]["joinAttempts"], 18)
        self.assertEqual(merged["calls"]["joinConnected"], 16)
        self.assertEqual(merged["calls"]["joinConnectedByTransport"]["mesh"], 18)
        self.assertEqual(merged["calls"]["joinRefusedByReason"]["room-full"], 2)
        self.assertEqual(merged["calls"]["rings"], 4)

    def test_push_delivery_is_summed_across_replicas(self):
        a = self._payload(calls_join_attempts=1, messages_last24h=1, activation_signup=1)
        b = self._payload(calls_join_attempts=1, messages_last24h=1, activation_signup=1)
        merged = exporter.merge_admin_metrics([a, b])
        self.assertEqual(merged["product"]["pushDelivery"]["web"]["sent"], 20)
        self.assertEqual(merged["product"]["pushDelivery"]["web"]["failed"], 2)

    def test_messages_and_activation_are_not_doubled(self):
        # Different replicas, same DB -- identical DB-derived numbers, which
        # is what production actually looks like.
        a = self._payload(calls_join_attempts=5, messages_last24h=100, activation_signup=12)
        b = self._payload(calls_join_attempts=3, messages_last24h=100, activation_signup=12)
        merged = exporter.merge_admin_metrics([a, b])
        self.assertEqual(merged["messages"]["last24h"], 100)
        self.assertEqual(merged["activation"]["window7d"]["signup"], 12)
        self.assertEqual(merged["users"]["total"], 500)
        self.assertEqual(merged["product"]["friendships"], 42)
        # calls DID sum, for contrast -- proves the two blocks are genuinely
        # on different policies, not that summing silently never happened.
        self.assertEqual(merged["calls"]["joinAttempts"], 8)

    def test_cluster_block_is_not_doubled(self):
        a = self._payload(calls_join_attempts=1, messages_last24h=1, activation_signup=1)
        b = self._payload(calls_join_attempts=1, messages_last24h=1, activation_signup=1)
        merged = exporter.merge_admin_metrics([a, b])
        self.assertEqual(merged["cluster"]["sockets"], 7)

    def test_single_payload_is_returned_unchanged(self):
        payload = self._payload(calls_join_attempts=9, messages_last24h=100, activation_signup=12)
        merged = exporter.merge_admin_metrics([payload])
        self.assertIs(merged, payload)

    def test_voice_rooms_are_shared_not_summed(self):
        # VOICE_REGISTRY=postgres in production: both replicas already read
        # the same cluster-wide voice_peers rows, so `rooms`/`participants`
        # must be taken from one, never summed (that would double every
        # seated participant).
        a = {"voice": {"activeRooms": 2, "participants": 5, "largestRoomNow": 3, "rooms": [{"transport": "mesh", "participants": 3}], "peakRoomSizeToday": 6}}
        b = {"voice": {"activeRooms": 2, "participants": 5, "largestRoomNow": 3, "rooms": [{"transport": "mesh", "participants": 3}], "peakRoomSizeToday": 4}}
        merged = exporter.merge_admin_metrics([a, b])
        self.assertEqual(merged["voice"]["participants"], 5)
        self.assertEqual(merged["voice"]["activeRooms"], 2)
        self.assertEqual(len(merged["voice"]["rooms"]), 1)
        # peakRoomSizeToday is the one voice.* field that is neither summed
        # nor taken from one: it is a per-process high-water mark, so the
        # cluster's peak is the larger of the two.
        self.assertEqual(merged["voice"]["peakRoomSizeToday"], 6)

    def test_voice_in_memory_counters_are_summed(self):
        a = {
            "voice": {
                "cluster": {"framesRelayed": 10, "framesReceived": 3},
                "roster": {"deltas": 5, "snapshots": 1, "sockets": 4},
                "seats": {
                    "idleOverAnHour": 1,
                    "oldestIdleMinutes": 30,
                    "staleRowWritesRefused": 2,
                    "ghostsSwept": 1,
                    "meshHoldsRefused": 0,
                    "idleAloneWarned": 0,
                    "idleAloneDisconnected": 0,
                    "meshResumeSockets": 3,
                    "sockets": 4,
                },
            }
        }
        b = {
            "voice": {
                "cluster": {"framesRelayed": 6, "framesReceived": 1},
                "roster": {"deltas": 2, "snapshots": 0, "sockets": 2},
                "seats": {
                    "idleOverAnHour": 1,
                    "oldestIdleMinutes": 45,
                    "staleRowWritesRefused": 1,
                    "ghostsSwept": 0,
                    "meshHoldsRefused": 1,
                    "idleAloneWarned": 0,
                    "idleAloneDisconnected": 0,
                    "meshResumeSockets": 1,
                    "sockets": 2,
                },
            }
        }
        merged = exporter.merge_admin_metrics([a, b])
        self.assertEqual(merged["voice"]["cluster"]["framesRelayed"], 16)
        self.assertEqual(merged["voice"]["roster"]["deltas"], 7)
        self.assertEqual(merged["voice"]["roster"]["sockets"], 6)
        self.assertEqual(merged["voice"]["seats"]["staleRowWritesRefused"], 3)
        self.assertEqual(merged["voice"]["seats"]["meshResumeSockets"], 4)
        self.assertEqual(merged["voice"]["seats"]["sockets"], 6)
        # idleOverAnHour is DB-derived (countIdleVoiceSeats over the shared
        # voice_peers table) -- take one, never sum.
        self.assertEqual(merged["voice"]["seats"]["idleOverAnHour"], 1)

    def test_live_hls_sessions_summed_uncleaned_shared(self):
        a = {
            "liveHls": {
                "enabled": True,
                "sessions": 1,
                "rungs": 3,
                "orphansStopped": 0,
                "startsTotal": 5,
                "stopsTotal": 4,
                "restartsScheduled": 1,
                "restartsExhausted": 0,
                "uncleaned": 2,
                "oldestSessionMinutes": 10,
                "playlistRejectedByReason": {"expired": 3},
            }
        }
        b = {
            "liveHls": {
                "enabled": True,
                "sessions": 1,
                "rungs": 2,
                "orphansStopped": 1,
                "startsTotal": 3,
                "stopsTotal": 3,
                "restartsScheduled": 0,
                "restartsExhausted": 0,
                "uncleaned": 2,
                "oldestSessionMinutes": 25,
                "playlistRejectedByReason": {"expired": 1, "missing": 2},
            }
        }
        merged = exporter.merge_admin_metrics([a, b])
        # A live session lives in exactly one process's memory -- additive.
        self.assertEqual(merged["liveHls"]["sessions"], 2)
        self.assertEqual(merged["liveHls"]["rungs"], 5)
        self.assertEqual(merged["liveHls"]["startsTotal"], 8)
        self.assertEqual(merged["liveHls"]["orphansStopped"], 1)
        self.assertEqual(merged["liveHls"]["playlistRejectedByReason"]["expired"], 4)
        self.assertEqual(merged["liveHls"]["playlistRejectedByReason"]["missing"], 2)
        # The oldest session across the cluster is the older of the two.
        self.assertEqual(merged["liveHls"]["oldestSessionMinutes"], 25)
        # uncleaned is countDueSessions() over the shared hls_sessions table --
        # summing would double the real count of leaked objects.
        self.assertEqual(merged["liveHls"]["uncleaned"], 2)

    def test_merged_payload_renders_correctly(self):
        # End-to-end: merge two replica payloads, then render() them, and
        # confirm the Prometheus series carries the true cluster total for an
        # additive counter and the undoubled total for a shared one -- this
        # is the actual bug (pitfall-9-shaped: a flag/config that changes the
        # code path, exercised end to end rather than only at the unit level).
        a = _base_payload(
            calls={"joinAttempts": 9, "joinConnected": 8, "joinConnectedByTransport": {"mesh": 8, "livekit": 0},
                   "joinConnectedByScope": {"dm": 8, "group": 0, "server": 0},
                   "joinRefusedByReason": {"room-full": 1}, "rings": 0, "ringsAnswered": 0,
                   "ringsDeclined": 0, "ringsEndedByReason": {}},
            messages={"last24h": 100, "byScope24h": {"dm": 100, "group": 0, "server": 0}},
        )
        b = _base_payload(
            calls={"joinAttempts": 9, "joinConnected": 8, "joinConnectedByTransport": {"mesh": 8, "livekit": 0},
                   "joinConnectedByScope": {"dm": 8, "group": 0, "server": 0},
                   "joinRefusedByReason": {"room-full": 0}, "rings": 0, "ringsAnswered": 0,
                   "ringsDeclined": 0, "ringsEndedByReason": {}},
            messages={"last24h": 100, "byScope24h": {"dm": 100, "group": 0, "server": 0}},
        )
        merged = exporter.merge_admin_metrics([a, b])
        body = exporter.render(merged, replicas_scraped=2)
        self.assertIn("pqp_api_call_join_attempts_total 18", body)
        self.assertIn("pqp_api_messages_24h 100", body)
        self.assertIn("pqp_api_metrics_replicas_scraped 2", body)


if __name__ == "__main__":
    unittest.main()
