#!/usr/bin/env bash
# Install monitoring on a REGIONAL SFU box (pqp-sfu-mia, pqp-sfu-lhr). Wraps
# install.sh, which is what sfu-pqp already runs, and adds the three things a
# second box needs that the Sao Paulo one gets from defaults:
#
#   * its own box name, so its series do not land on top of sfu-pqp's
#     (install.sh would accept the default silently, which is the mistake);
#   * its own monthly transfer allowance, because pqp-box-metrics.py defaults
#     to the 4c plan's 6 TB and these are smaller plans;
#   * its own public network interface and container names, found rather than
#     assumed (the Sao Paulo box is `enp1s0`; a box built later may not be).
#
# WHAT IT INSTALLS (all of it the same as on sfu-pqp, nothing new):
#   node_exporter   Alloy's built-in one: CPU, memory, disk, load, network,
#                   six systemd units, plus the textfile collector
#   Alloy           remote-writes to the pqp Grafana Cloud stack and scrapes
#                   LiveKit's own 127.0.0.1:6789
#   pqp-box-metrics the textfile exporter: monthly transfer from vnstat and
#                   docker container state, every minute
#
# WHAT IT DELIBERATELY DOES NOT INSTALL: tools/monitoring's
# pqp-api-metrics-exporter. That one reads GET /api/admin/metrics, which is
# one cluster-wide answer, and it already runs on sfu-pqp. A second copy on a
# regional box would write every pqp_api_* series twice (under another `box`
# label), and every sum() in the capacity alerts would double.
#
# Nothing here touches the livekit or caddy containers, so it never interrupts
# a call. Idempotent: safe to re-run, and a re-run is how the allowance is
# changed.
#
# USAGE, from a laptop:
#   scp -r tools/sfu-monitoring root@<box>:/opt/
#   ssh root@<box> 'SFU_BOX_NAME=sfu-mia PQP_EGRESS_ALLOWANCE_BYTES=<bytes> \
#       GC_PROM_USER=... GC_PROM_TOKEN=... bash /opt/sfu-monitoring/install-regional.sh'
#
# GC_PROM_USER / GC_PROM_TOKEN are only needed the first time (or to rotate);
# without them an existing /etc/alloy/credentials.env is left alone. Prefer
# the hidden-prompt or stdin forms in tools/monitoring/README.md over putting
# the token on a command line. See docs/MONITORING.md "Regional SFU boxes".
#
# SET PQP_REGIONAL_DRY_RUN=1 TO CHECK WITHOUT CHANGING ANYTHING: it validates
# the inputs, detects the interface and containers, prints what it would write
# and exits before touching the box.
#
# REQUIRED
#   SFU_BOX_NAME               sfu-mia, sfu-lhr, ... never sfu-pqp
#   PQP_EGRESS_ALLOWANCE_BYTES the plan's monthly transfer in bytes. Read it
#                              from the Vultr API (`bandwidth` on the plan, in
#                              GB), not from a pricing page, and use 10^9 bytes
#                              per GB so the percentage stays conservative.
# OPTIONAL
#   PQP_METRICS_INTERFACE      the public interface; default is the one the
#                              default route uses
#   PQP_METRICS_CONTAINERS     comma-separated; default is the livekit and
#                              caddy containers `docker ps` shows
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY="${PQP_REGIONAL_DRY_RUN:-}"
ENV_FILE="${PQP_BOX_METRICS_ENV_FILE:-/etc/pqp-box-metrics.env}"

die() {
  echo "install-regional.sh: $*" >&2
  exit 1
}

SFU_BOX_NAME="${SFU_BOX_NAME:-}"
[[ -n "$SFU_BOX_NAME" ]] || die "set SFU_BOX_NAME (sfu-mia, sfu-lhr, ...): without it install.sh would label this box sfu-pqp and its series would land on top of Sao Paulo's"
[[ "$SFU_BOX_NAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "SFU_BOX_NAME must match ^[a-z][a-z0-9-]{0,31}\$, got: $SFU_BOX_NAME"
[[ "$SFU_BOX_NAME" != "sfu-pqp" ]] || die "SFU_BOX_NAME=sfu-pqp is the Sao Paulo box; a regional box needs its own name"

ALLOWANCE="${PQP_EGRESS_ALLOWANCE_BYTES:-}"
[[ -n "$ALLOWANCE" ]] || die "set PQP_EGRESS_ALLOWANCE_BYTES to this plan's monthly transfer in bytes; the default is the 4c plan's 6 TB and would make every egress percentage wrong here"
[[ "$ALLOWANCE" =~ ^[0-9]{10,16}$ ]] || die "PQP_EGRESS_ALLOWANCE_BYTES must be a whole number of bytes (10 to 16 digits), got: $ALLOWANCE"

# The public interface: the one the default route leaves by.
IFACE="${PQP_METRICS_INTERFACE:-}"
if [[ -z "$IFACE" ]]; then
  IFACE="$(ip -o -4 route show to default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}' || true)"
fi
[[ -n "$IFACE" ]] || die "could not find the default-route interface; set PQP_METRICS_INTERFACE"
[[ "$IFACE" =~ ^[A-Za-z0-9_.:-]{1,32}$ ]] || die "odd interface name: $IFACE"

# The containers worth watching: the livekit and caddy ones tools/sfu starts.
CONTAINERS="${PQP_METRICS_CONTAINERS:-}"
if [[ -z "$CONTAINERS" ]]; then
  CONTAINERS="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^livekit-(livekit|caddy)-[0-9]+$' | sort | paste -sd, - || true)"
fi
[[ -n "$CONTAINERS" ]] || die "no livekit/caddy container found in 'docker ps -a'; set PQP_METRICS_CONTAINERS (default on sfu-pqp is livekit-livekit-1,livekit-caddy-1)"
[[ "$CONTAINERS" =~ ^[A-Za-z0-9_.,-]{1,200}$ ]] || die "odd container list: $CONTAINERS"

echo "== plan"
echo "box name        $SFU_BOX_NAME"
echo "interface       $IFACE"
echo "allowance bytes $ALLOWANCE"
echo "containers      $CONTAINERS"
echo "env file        $ENV_FILE"

if [[ -n "$DRY" ]]; then
  echo "== dry run: nothing was changed"
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || die "run as root"
[[ -f "$HERE/install.sh" ]] || die "install.sh is not next to this script ($HERE)"

echo "== box metrics environment"
# Not a secret: a plan size, an interface and two container names. Written
# beside the unit rather than into it, so a re-run changes a number and
# nothing else, and so the unit file is identical on every box.
umask 022
tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
cat >"$tmp" <<ENV
# Written by tools/sfu-monitoring/install-regional.sh. Re-run it to change.
PQP_EGRESS_ALLOWANCE_BYTES=${ALLOWANCE}
PQP_METRICS_INTERFACE=${IFACE}
PQP_METRICS_CONTAINERS=${CONTAINERS}
ENV
chmod 0644 "$tmp"
mv "$tmp" "$ENV_FILE"

# vnstat tracks an interface only once it has a database for it. The package
# creates one for the interface it sees at install time; add this one when it
# is missing (idempotent, and a no-op when it already exists).
if command -v vnstat >/dev/null && ! vnstat -i "$IFACE" --json m >/dev/null 2>&1; then
  vnstat --add -i "$IFACE" 2>/dev/null || true
fi

echo "== install.sh"
SFU_BOX_NAME="$SFU_BOX_NAME" bash "$HERE/install.sh"

echo "== check"
sleep 3
systemctl is-active alloy pqp-box-metrics.timer
if ! grep -q "^pqp_sfu_egress_allowance_bytes ${ALLOWANCE}\$" /var/lib/node_exporter/textfile_collector/pqp_sfu_egress.prom 2>/dev/null; then
  echo "   !! the textfile does not show the allowance yet; wait a minute and read it (vnstat needs one sample before it answers)" >&2
fi
echo "Series carry box=\"${SFU_BOX_NAME}\". In Grafana: up{box=\"${SFU_BOX_NAME}\"} and node_cpu_seconds_total{box=\"${SFU_BOX_NAME}\"}."
