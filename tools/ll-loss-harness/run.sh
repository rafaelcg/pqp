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
# Nothing here can reach production -- see README.md "What this cannot
# reach" and env.mjs's assertLocalHost/assertLocalUrl, which every Node
# script in this harness runs its own LiveKit/origin URLs through.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
HARNESS_DIR="$(pwd)"

LOSS_PCT="${1:-0}"
WATCH_SECONDS="${WATCH_SECONDS:-60}"
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
  if [ "$KEEP_UP" != "1" ]; then
    echo "run.sh: tearing down (KEEP_UP=1 to skip this)"
    [ -n "${SID:-}" ] && node harness/remux-ctl.mjs stop "$SID" >/dev/null 2>&1 || true
    docker compose --profile publish down --timeout 5 >"$LOG_DIR/compose-down.log" 2>&1 || true
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

echo "run.sh: building images"
docker compose build remuxd publisher >"$LOG_DIR/build.log" 2>&1 || { echo "run.sh: build failed, see $LOG_DIR/build.log" >&2; tail -60 "$LOG_DIR/build.log" >&2; exit 1; }

echo "run.sh: starting livekit + remuxd"
docker compose up -d livekit remuxd >"$LOG_DIR/up.log" 2>&1

echo "run.sh: waiting for livekit :7880"
for i in $(seq 1 30); do
  # LiveKit answers a non-2xx on "/" (no route) -- any HTTP response at
  # all means the port is up, which is all this loop needs to know.
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:7880/" || true)"
  [ -n "$code" ] && [ "$code" != "000" ] && break
  if [ "$i" = 30 ]; then echo "run.sh: livekit never answered on :7880, see 'docker compose logs livekit'" >&2; exit 1; fi
  sleep 1
done

echo "run.sh: waiting for remuxd control API :8090"
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

echo "run.sh: starting playlist server on :18080"
SID="$SID" node harness/server.mjs > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
sleep 1

echo "run.sh: starting publisher (LOSS_PCT=${LOSS_PCT}%)"
ROOM="$ROOM" LOSS_PCT="$LOSS_PCT" docker compose --profile publish run --rm -d --name "ll-loss-publisher-${RUN_ID}" publisher > "$LOG_DIR/publisher-start.log" 2>&1

echo "run.sh: watching for ${WATCH_SECONDS}s (cfg=${CFG})"
set +e
node harness/run.mjs "$CFG" "$WATCH_SECONDS" | tee "$LOG_DIR/hlsjs.log"
VERDICT_STATUS=${PIPESTATUS[0]}
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
echo "   remux discard mentions: ${DISCARD_COUNT} (full log: ${LOG_DIR}/remuxd-full.log)"
echo "   remux relevant lines:   ${LOG_DIR}/remuxd-relevant.log"
echo "   hls.js error summary:   see ${LOG_DIR}/hlsjs.log (ERROR SUMMARY line)"
if [ "$FINAL_STATUS" != "$VERDICT_STATUS" ]; then
  echo "   overall:                 FAIL (hls.js passed but the loss defense did not fire -- see WARNING above)"
fi
echo "================================================================"

exit "$FINAL_STATUS"
