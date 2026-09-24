#!/usr/bin/env bash
# tools/ll-loss-harness/run.sh <LOSS_PCT>
#
# Runs one full local, offline LL-HLS repro: brings up a single-node
# LiveKit + the real pqp-remuxd in Docker, publishes a synthetic ramp
# (360p -> 720p, a genuine mid-stream SPS/PPS change) through a publisher
# container whose OWN egress interface has netem packet loss applied,
# points stock hls.js in real headless Chrome at the resulting LL
# playlist for ~60s, and prints a PASS/FAIL verdict.
#
# Usage:
#   ./run.sh            LOSS_PCT=0 (clean path)
#   ./run.sh 15         15% loss
#   ./run.sh 30         30% loss (the measured production ceiling, per
#                       docs/plans/LL_HLS.md)
#
# Since pqp-remux#700 (merged 2026-09-17), a lossy run at LOSS_PCT>0 is
# expected to PASS, not FAIL: the remux's RTP sequence check
# (h264.Depacketizer.PushRTP) now discards a damaged access unit and asks
# the publisher for a keyframe at once, instead of forwarding the hole to
# every viewer's decoder. This script therefore no longer accepts a bare
# hls.js PASS as proof the fix is doing anything -- a run where netem
# happened not to drop a packet this time would ALSO pass, silently. When
# LOSS_PCT>0 it additionally requires the remuxd log to show the defense
# actually firing (a "video damage:" line, and nonzero lost=+/damage=+ on
# the periodic stats line) before calling the run green -- see "What this
# now asserts" in README.md. That is the regression signal: remove or
# break the sequence check and this goes red again, either because the
# decode-death symptom comes back (hls.js FAILs) or because loss stops
# being defended against (no "video damage:" line even though netem is
# dropping packets). To prove the loop actually goes red, build remuxd at
# the parent of #700 (README.md "Forcing a red run").
#
# Env overrides (all optional): WATCH_SECONDS (default 60), KEEP_UP=1
# (skip teardown, for debugging), CFG=default|client (page.html's hls.js
# config presets).
#
# SOURCE=idle swaps the ramp for a PACED source (README.md "Idle and bursty
# sources"): frames on a wall-clock schedule that goes quiet and bursts the
# way a Chrome tab share of a mostly static page does, with production's
# CLOCK_CUT_PARTS=true, and measures when each part is published
# (harness/lateness.mjs) beside the viewer's stalls. PART_DEADLINE_GRACE_MS
# passes through to pqp-remuxd (1000 is the pre-deadline timing).
#
# Nothing here can reach production -- see README.md "What this cannot
# reach" and env.mjs's assertLocalHost/assertLocalUrl, which every Node
# script in this harness runs its own LiveKit/origin URLs through.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
HARNESS_DIR="$(pwd)"

LOSS_PCT="${1:-0}"
WATCH_SECONDS="${WATCH_SECONDS:-60}"
SOURCE="${SOURCE:-ramp}"
case "$SOURCE" in
  ramp) export SOURCE_FILE=ramp.h264 PACE="" CLOCK_CUT_PARTS="${CLOCK_CUT_PARTS:-}" ;;
  idle|static|mixed)
    PACE=idle-bursty
    [ "$SOURCE" != "idle" ] && PACE="$SOURCE"
    export SOURCE_FILE=idle.h264 PACE CLOCK_CUT_PARTS=true POLL_MODE="${POLL_MODE:-edge}" ;;
  *) echo "run.sh: SOURCE must be ramp, idle, static or mixed, got '$SOURCE'" >&2; exit 1 ;;
esac
export PART_DEADLINE_GRACE_MS="${PART_DEADLINE_GRACE_MS:-150}"

# SCENARIO=republish replaces the presenter's screen track REPUBLISH_AFTER
# seconds into the show (the same participant, a new track: what the web
# client does on every resume after an API deploy), and SCENARIO=reconnect
# does it under a NEW identity (a reconnect that could not resume), with this
# script playing pqp-api's part: POST /sessions/:id/rebind naming the new
# identity. Either way the file starts over on the new track, so the new
# source's parameter sets differ (an init change inside the session). The run
# is green only if the viewer passes AND the box kept the one session: it
# logged the rebind, never restarted or demoted, and GET /sessions still
# lists the same session with videoRebinds >= 1. See README.md "A mid-show
# republish".
SCENARIO="${SCENARIO:-}"
case "$SCENARIO" in
  "") ;;
  republish) export REPUBLISH=track REPUBLISH_AFTER="${REPUBLISH_AFTER:-25}" ;;
  reconnect) export REPUBLISH=identity REPUBLISH_AFTER="${REPUBLISH_AFTER:-25}" REPUBLISH_IDENTITY="${REPUBLISH_IDENTITY:-ramp-presenter-2}" ;;
  *) echo "run.sh: SCENARIO must be republish or reconnect, got '$SCENARIO'" >&2; exit 1 ;;
esac

# Host ports, overridable so two runs (two worktrees, two agents) can share
# one Docker host: give each its own COMPOSE_PROJECT_NAME and ports, or the
# second run's opening `down` tears the first one's containers away.
export LL_HARNESS_LIVEKIT_PORT="${LL_HARNESS_LIVEKIT_PORT:-7880}"
export LL_HARNESS_REMUXD_PORT="${LL_HARNESS_REMUXD_PORT:-8090}"
export LL_HARNESS_PORT="${LL_HARNESS_PORT:-18080}"
export PORT="${PORT:-18081}"
export LL_HARNESS_ORIGIN="http://127.0.0.1:${LL_HARNESS_REMUXD_PORT}"
export LL_HARNESS_CONTROL_URL="http://127.0.0.1:${LL_HARNESS_REMUXD_PORT}"
# The paced publisher stops on its own schedule, so it has to outlast the
# viewer's window.
export PACE_SECONDS="$((WATCH_SECONDS + 40))"
CFG="${CFG:-default}"
KEEP_UP="${KEEP_UP:-0}"
RUN_ID="$(date +%s)-$$"
ROOM="ll-loss-harness-${LOSS_PCT}-${RUN_ID}"

# --- second lock: refuse anything that isn't plainly local -----------
# Mirrors tools/watch-party-load's PROD_HOSTS guard (src/index.ts): the
# LiveKit URL both remuxd and the publisher will use is allowlisted
# BEFORE docker compose ever sees it, not just left to the compose file's
# own hardcoded default -- an operator setting LL_HARNESS_LIVEKIT_URL
# "just to check something quickly" is exactly the case that guard's own
# comment warns against, and this is the second, independent check on it
# (env.mjs's assertLocalHost/assertLocalUrl is the first, inside every
# Node script that touches a URL of its own).
assert_local_host() {
  local host="$1" label="$2"
  case "$host" in
    127.0.0.1|localhost|::1|livekit) return 0 ;;
    *.pqp.gg|pqp.gg) echo "run.sh: refusing $label=$host -- production host" >&2; exit 1 ;;
    *) echo "run.sh: refusing $label=$host -- not in the local allowlist" >&2; exit 1 ;;
  esac
}
LIVEKIT_URL="${LL_HARNESS_LIVEKIT_URL:-ws://livekit:7880}"
lk_host="${LIVEKIT_URL#*://}"; lk_host="${lk_host%%:*}"; lk_host="${lk_host%%/*}"
assert_local_host "$lk_host" "LL_HARNESS_LIVEKIT_URL"
export LIVEKIT_URL

if ! [[ "$LOSS_PCT" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "run.sh: LOSS_PCT must be a non-negative number, got '$LOSS_PCT'" >&2
  exit 1
fi

for bin in docker ffmpeg openssl node; do
  command -v "$bin" >/dev/null || { echo "run.sh: missing prerequisite '$bin' on PATH -- see README.md Prerequisites" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "run.sh: 'docker compose' (v2 plugin) not found" >&2; exit 1; }

LOG_DIR="$HARNESS_DIR/.data/runs/${RUN_ID}"
mkdir -p "$LOG_DIR"
echo "run.sh: loss=${LOSS_PCT}% room=${ROOM} logs=${LOG_DIR}"

cleanup() {
  local status=$?
  # The lateness poller is this script's own child, not part of the rig
  # KEEP_UP preserves: stop it on every exit, cancelled or not.
  [ -n "${LATENESS_PID:-}" ] && { kill "$LATENESS_PID" 2>/dev/null; wait "$LATENESS_PID" 2>/dev/null; } || true
  if [ "$KEEP_UP" != "1" ]; then
    echo "run.sh: tearing down (KEEP_UP=1 to skip this)"
    [ -n "${SID:-}" ] && node harness/remux-ctl.mjs stop "$SID" >/dev/null 2>&1 || true
    # Twice: the publisher runs with --rm and can finish removing itself
    # while the first pass is removing it, which makes compose abort before
    # LiveKit and leaves it running with its port held.
    docker compose --profile publish down --timeout 5 >"$LOG_DIR/compose-down.log" 2>&1 || true
    docker compose --profile publish down --timeout 5 >>"$LOG_DIR/compose-down.log" 2>&1 || true
  fi
  exit $status
}
trap cleanup EXIT INT TERM

# Always start from nothing: a container left running from a prior
# invocation (crashed mid-run, or KEEP_UP=1) would otherwise keep the
# PREVIOUS run's baked-in LiveKit keys (livekit.yaml is a plain volume
# mount, so `up -d` alone does not notice its contents changed and does
# not recreate the container) while remuxd -- whose env_file IS part of
# compose's own change detection -- picks up the freshly generated ones,
# and the two disagree ("unauthorized: invalid API key") the moment a
# session tries to subscribe. `down` first makes every run deterministic
# regardless of what an earlier run left behind.
echo "run.sh: clearing any containers left by a previous run"
docker compose --profile publish down --timeout 5 >/dev/null 2>&1 || true

echo "run.sh: generating ephemeral keys and ramp.h264"
bash scripts/gen-keys.sh
bash scripts/gen-ramp.sh
[ "$SOURCE" != "ramp" ] && bash scripts/gen-idle.sh

echo "run.sh: building images"
docker compose build remuxd publisher >"$LOG_DIR/build.log" 2>&1 || { echo "run.sh: build failed, see $LOG_DIR/build.log" >&2; tail -60 "$LOG_DIR/build.log" >&2; exit 1; }

echo "run.sh: starting livekit + remuxd"
docker compose up -d livekit remuxd >"$LOG_DIR/up.log" 2>&1

echo "run.sh: waiting for livekit :${LL_HARNESS_LIVEKIT_PORT}"
for i in $(seq 1 30); do
  # LiveKit answers a non-2xx on "/" (no route) -- any HTTP response at
  # all means the port is up, which is all this loop needs to know.
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${LL_HARNESS_LIVEKIT_PORT}/" || true)"
  [ -n "$code" ] && [ "$code" != "000" ] && break
  if [ "$i" = 30 ]; then echo "run.sh: livekit never answered on :${LL_HARNESS_LIVEKIT_PORT}, see 'docker compose logs livekit'" >&2; exit 1; fi
  sleep 1
done

echo "run.sh: waiting for remuxd control API :${LL_HARNESS_REMUXD_PORT}"
for i in $(seq 1 30); do
  if node harness/remux-ctl.mjs list >/dev/null 2>"$LOG_DIR/remuxd-wait.log"; then break; fi
  if [ "$i" = 30 ]; then echo "run.sh: remuxd never answered, see $LOG_DIR/remuxd-wait.log and 'docker compose logs remuxd'" >&2; exit 1; fi
  sleep 1
done

echo "run.sh: starting remux session (room=${ROOM})"
ROOM="$ROOM" node harness/remux-ctl.mjs start > "$LOG_DIR/session-start.log" 2>&1
SID="$(grep -oE '^SESSION [^ ]+' "$LOG_DIR/session-start.log" | awk '{print $2}')"
if [ -z "$SID" ]; then echo "run.sh: could not parse session id, see $LOG_DIR/session-start.log" >&2; exit 1; fi
echo "run.sh: session=${SID}"

echo "run.sh: starting playlist server on :${LL_HARNESS_PORT}"
SID="$SID" node harness/server.mjs > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
sleep 1

echo "run.sh: starting publisher (LOSS_PCT=${LOSS_PCT}%)"
ROOM="$ROOM" LOSS_PCT="$LOSS_PCT" docker compose --profile publish run --rm -d --name "ll-loss-publisher-${RUN_ID}" publisher > "$LOG_DIR/publisher-start.log" 2>&1

REBIND_PID=""
if [ "$SCENARIO" = "reconnect" ]; then
  # pqp-api's half of a reconnect: it sees the presenter's new peer id on the
  # voice socket and tells the box who to follow. Timed from the publisher's
  # own start (not after any warm-up below), for the moment the publisher
  # leaves: the rejoin and the new publish take it another 1.5 s or more, so
  # the rebind lands first, as the socket join does in production. The box
  # answers `waiting` and binds the new identity's track when it appears.
  ( sleep "$REPUBLISH_AFTER"; node harness/remux-ctl.mjs rebind "$SID" "$REPUBLISH_IDENTITY" > "$LOG_DIR/rebind.log" 2>&1 ) &
  REBIND_PID=$!
fi

if [ "$SOURCE" != "ramp" ]; then
  # Start the viewer on a stream that already has a few segments, the way a
  # real audience joins a party in progress. Started cold, hls.js retries a
  # 503 master until the first part exists and then lands wherever the
  # retry happened to catch the playlist, anywhere from the live edge to
  # tens of seconds behind it, and a viewer that far back never stalls on
  # part timing: two runs of the same build are then not comparable.
  echo "run.sh: waiting for 12s of published media before the viewer joins"
  for i in $(seq 1 60); do
    parts="$(SID="$SID" node --input-type=module -e '
      const { loadHarnessEnv } = await import("./harness/env.mjs");
      const key = process.env.MEDIA_ORIGIN_KEY || loadHarnessEnv().MEDIA_ORIGIN_KEY;
      const r = await fetch(`${process.env.LL_HARNESS_ORIGIN}/s/${process.env.SID}/state.json`, { headers: { "X-Pqp-Origin-Key": key } });
      const st = r.ok ? await r.json() : { video: { segments: [] } };
      console.log(st.video.segments.reduce((n, s) => n + s.parts.length, 0));
    ' 2>/dev/null || echo 0)"
    [ "${parts:-0}" -ge 24 ] && break
    sleep 1
  done
fi

echo "run.sh: watching for ${WATCH_SECONDS}s (cfg=${CFG} source=${SOURCE} grace=${PART_DEADLINE_GRACE_MS}ms scenario=${SCENARIO:-none})"
SID="$SID" PARTS_DIR="$LOG_DIR/parts" node harness/lateness.mjs "$WATCH_SECONDS" > "$LOG_DIR/lateness.log" 2>&1 &
LATENESS_PID=$!
set +e
node harness/run.mjs "$CFG" "$WATCH_SECONDS" | tee "$LOG_DIR/hlsjs.log"
VERDICT_STATUS=${PIPESTATUS[0]}
wait "$LATENESS_PID"
set -e

kill "$SERVER_PID" >/dev/null 2>&1 || true

echo "run.sh: capturing remuxd log (parameter-set changes, discards, demotes, loss)"
docker compose logs --no-color remuxd > "$LOG_DIR/remuxd-full.log" 2>&1 || true
grep -iE "discard|demote|parameter|sps|pps|idr|restart|stall|stuck|damage|loss" "$LOG_DIR/remuxd-full.log" > "$LOG_DIR/remuxd-relevant.log" 2>/dev/null || true
DISCARD_COUNT="$(grep -ci "discard" "$LOG_DIR/remuxd-full.log" 2>/dev/null || echo 0)"

# --- pqp-remux#700 regression signal ----------------------------------
# See run.sh's header comment. DAMAGE_LINES counts "video damage:" log
# lines (markDamaged in session.go) -- one per loss episode the sequence
# check caught. LOST_NONZERO/DAMAGE_NONZERO count periodic stats lines
# (formatStatsLine) whose window actually saw lost=+N / damage=+N with
# N>0, i.e. the depacketizer's PushRTP genuinely observed a sequence gap
# and the session genuinely armed drop-until-next-IDR for it, not just
# that a log line matched a grep.
DAMAGE_LINES="$(grep -c "video damage:" "$LOG_DIR/remuxd-full.log" 2>/dev/null || echo 0)"
LOST_NONZERO="$(grep -oE 'lost=\+[0-9]+' "$LOG_DIR/remuxd-full.log" 2>/dev/null | awk -F+ '$2>0{c++} END{print c+0}')"
DAMAGE_NONZERO="$(grep -oE 'damage=\+[0-9]+' "$LOG_DIR/remuxd-full.log" 2>/dev/null | awk -F+ '$2>0{c++} END{print c+0}')"

VERDICT_LINE="$(grep -E '^VERDICT: ' "$LOG_DIR/hlsjs.log" || echo 'VERDICT: FAIL (no verdict line emitted)')"

# --- the republish scenarios: one session, rebound, never restarted -----
REBIND_NOTE="n/a (no SCENARIO)"
REBIND_OK=1
if [ -n "$SCENARIO" ]; then
  [ -n "$REBIND_PID" ] && { wait "$REBIND_PID" 2>/dev/null || true; }
  node harness/remux-ctl.mjs list > "$LOG_DIR/sessions-after.json" 2>&1 || true
  # grep -c prints 0 AND exits 1 on no match: `|| true`, not `|| echo 0`.
  REBOUND_LINES="$(grep -c "video source rebound: first keyframe" "$LOG_DIR/remuxd-full.log" 2>/dev/null || true)"
  RESTARTS="$(grep -cE "restarting \(|demoting \(" "$LOG_DIR/remuxd-full.log" 2>/dev/null || true)"
  REBOUND_LINES="${REBOUND_LINES:-0}" RESTARTS="${RESTARTS:-0}"
  SAME_SESSION="$(SID="$SID" node -e '
    // `remux-ctl.mjs list` prints the unwrapped array; accept the raw
    // `{ sessions }` body too, so a change to the CLI cannot fail this
    // silently.
    const raw = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const s = Array.isArray(raw) ? raw : raw.sessions || [];
    const x = s.find((e) => e.sessionId === process.env.SID);
    console.log(x && !x.demoted && x.videoRebinds >= 1 ? "yes" : "no");
  ' "$LOG_DIR/sessions-after.json" 2>/dev/null || echo no)"
  if [ "$REBOUND_LINES" != "0" ] && [ "$RESTARTS" = "0" ] && [ "$SAME_SESSION" = "yes" ]; then
    REBIND_NOTE="kept the session (rebound x${REBOUND_LINES}, no restart or demotion, videoRebinds>=1)"
  else
    REBIND_NOTE="NOT kept (rebound x${REBOUND_LINES}, restarts/demotions=${RESTARTS}, same session=${SAME_SESSION})"
    REBIND_OK=0
  fi
fi

LOSS_EXPECTED=0
awk "BEGIN{exit !($LOSS_PCT>0)}" && LOSS_EXPECTED=1

FINAL_STATUS="$VERDICT_STATUS"
LOSS_DEFENSE_NOTE="n/a (LOSS_PCT=0, nothing to defend against)"
if [ "$LOSS_EXPECTED" = "1" ]; then
  if [ "$DAMAGE_LINES" != "0" ] && [ "$LOST_NONZERO" != "0" ] && [ "$DAMAGE_NONZERO" != "0" ]; then
    LOSS_DEFENSE_NOTE="observed (video damage: x${DAMAGE_LINES}, lost/damage stats nonzero) -- PushRTP's sequence check is doing its job"
  else
    LOSS_DEFENSE_NOTE="NOT observed (video damage: x${DAMAGE_LINES}, lost-nonzero-windows=${LOST_NONZERO}, damage-nonzero-windows=${DAMAGE_NONZERO})"
    if [ "$VERDICT_STATUS" = "0" ]; then
      echo "run.sh: WARNING loss=${LOSS_PCT}% but the remux never logged defending against it -- either netem dropped nothing this run, or the #700 sequence check has regressed silently. A PASS with no evidence of loss is not proof of anything; treating this run as FAIL." >&2
      FINAL_STATUS=1
    fi
  fi
fi

echo
echo "================================================================"
echo " tools/ll-loss-harness result"
echo "   loss:              ${LOSS_PCT}%"
echo "   room:               ${ROOM}"
echo "   ${VERDICT_LINE}"
echo "   remux loss defense:     ${LOSS_DEFENSE_NOTE}"
echo "   republish (${SCENARIO:-none}):  ${REBIND_NOTE}"
echo "   remux discard mentions: ${DISCARD_COUNT} (full log: ${LOG_DIR}/remuxd-full.log)"
echo "   remux relevant lines:   ${LOG_DIR}/remuxd-relevant.log"
echo "   hls.js error summary:   see ${LOG_DIR}/hlsjs.log (ERROR SUMMARY line)"
echo "   viewer:                 $(grep -E '^WAITING: ' "$LOG_DIR/hlsjs.log" || echo 'WAITING: n/a')"
echo "   viewer:                 $(grep -E '^LIVE LATENCY: ' "$LOG_DIR/hlsjs.log" || echo 'LIVE LATENCY: n/a')"
grep -E '^LATENESS (video|audio) ' "$LOG_DIR/lateness.log" | sed 's/^/   part publication:       /' || true
grep -E '^PDT SKEW ' "$LOG_DIR/lateness.log" | sed 's/^/   playlists:              /' || true
# The remux's own view of the same thing, summed over the run.
awk '/stats session/ {
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^deadline=\+/) { split($i, a, "+"); d += a[2] }
      if ($i ~ /^late250=\+/) { split($i, a, "+"); l2 += a[2] }
      if ($i ~ /^late500=\+/) { split($i, a, "+"); l5 += a[2] }
      if ($i ~ /^lateMaxMs=/) { split($i, a, "="); if (a[2] + 0 > m) m = a[2] + 0 }
      if ($i ~ /^ptsShiftMs=/) { split($i, a, "="); s = a[2] }
      if ($i ~ /^timelineRatio=/ && !seen) { split($i, a, "="); r = a[2]; seen = 1 }
    }
    seen = 0
  } END { printf "   remux counters:         deadline=%d late250=%d late500=%d lateMaxMs=%d ptsShiftMs=%s videoTimelineRatio=%s\n", d, l2, l5, m, s, r }' "$LOG_DIR/remuxd-full.log" || true
if [ "$REBIND_OK" = "0" ]; then
  FINAL_STATUS=1
  echo "   overall:                 FAIL (the republish did not keep the session -- see above)"
fi
if [ "$FINAL_STATUS" != "$VERDICT_STATUS" ] && [ "$REBIND_OK" = "1" ]; then
  echo "   overall:                 FAIL (hls.js passed but the loss defense did not fire -- see WARNING above)"
fi
echo "================================================================"

exit "$FINAL_STATUS"
