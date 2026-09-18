#!/bin/sh
# Applies netem packet loss to THIS container's own egress interface, then
# execs rampub. Runs inside the publisher container (needs NET_ADMIN,
# granted by docker-compose.yaml's cap_add) rather than as a separate
# sidecar, because `tc qdisc ... netem` is scoped to one network namespace
# and the publisher's own namespace is exactly the one we want: everything
# rampub sends (RTP to LiveKit over WebRTC) leaves through this interface,
# so loss applied here lands on the SEND side of the publish -- the same
# side of the connection a presenter's real uplink (Wi-Fi, tethered
# cellular, a saturated home upload) is lossy on. It says nothing about
# loss in the other direction (viewer download), which is a different
# problem this harness is not built to reproduce.
#
# LOSS_PCT is a percentage (0-100, may be fractional, e.g. "17.5"). 0 or
# unset means "no loss" -- the qdisc is left at its default (pfifo_fast),
# nothing is added.
set -eu

LOSS_PCT="${LOSS_PCT:-0}"

iface="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
iface="${iface:-eth0}"

is_zero() {
  # POSIX sh has no float compare; treat "0", "0.0", "" etc. as zero.
  case "$1" in
    ""|0|0.0|0.00|0.000) return 0 ;;
    *) return 1 ;;
  esac
}

if is_zero "$LOSS_PCT"; then
  echo "rampub-entrypoint: LOSS_PCT=$LOSS_PCT -- clean path, no netem qdisc added on $iface"
else
  echo "rampub-entrypoint: applying netem loss ${LOSS_PCT}% egress on $iface (models presenter uplink loss)"
  tc qdisc add dev "$iface" root netem loss "${LOSS_PCT}%"
  tc qdisc show dev "$iface"
fi

exec /usr/local/bin/rampub
