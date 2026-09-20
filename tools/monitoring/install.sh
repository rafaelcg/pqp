#!/usr/bin/env bash
# Install or update the GET /api/admin/metrics -> Prometheus textfile exporter.
# Idempotent: safe to re-run. Meant to run on the same box as
# tools/sfu-monitoring (it already runs Grafana Alloy with a textfile
# collector), but needs no code from that directory and does not touch it.
#
# From a laptop, after tools/sfu-monitoring is already installed there:
#   scp -r tools/monitoring root@216.238.114.79:/opt/
#   ssh root@216.238.114.79 'bash /opt/monitoring/install.sh'
#   (then paste ADMIN_METRICS_TOKEN at the hidden prompt below)
#
# ADMIN_METRICS_TOKEN never belongs on a command line: a token passed as
# `ADMIN_METRICS_TOKEN=... bash ...` sits in both the local shell's history
# and, remotely, in that process's argv for as long as it runs (readable by
# anyone else on the box via `ps`). This script instead reads it from a
# hidden TTY prompt when run interactively, or from stdin when it is not
# (piped over an already-open ssh session, e.g.
# `printf '%s\n' "$ADMIN_METRICS_TOKEN" | ssh root@216.238.114.79 'bash
# /opt/monitoring/install.sh'`, which keeps the token out of that ssh
# process's own argv too) -- see tools/monitoring/README.md. A pre-created
# 0600 /etc/pqp-api-metrics.env (see below) works too and skips the prompt
# entirely.
#
# ADMIN_METRICS_TOKEN is only needed the first time (or to rotate); leaving
# the prompt blank (empty line) keeps an existing /etc/pqp-api-metrics.env
# untouched. Never the same secret as the Grafana Cloud credential in
# /etc/alloy/credentials.env -- this one only ever calls api.pqp.gg.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector
PQP_API_URL="${PQP_API_URL:-https://api.pqp.gg}"
# Replica-split metrics (see tools/monitoring/README.md "Replica-split
# metrics") need NO extra config here: the exporter scrapes PQP_API_URL
# repeatedly and dedups by the payload's own instanceId on its own, whether
# this box is behind one API replica or several. PQP_API_METRICS_ENDPOINTS
# below is an OPTIONAL override for the rare case of genuinely distinct,
# directly reachable per-replica URLs -- leave it unset unless you actually
# have that.
PQP_API_METRICS_ENDPOINTS="${PQP_API_METRICS_ENDPOINTS:-}"

echo "== textfile collector"
mkdir -p "$TEXTFILE_DIR"
install -m 0755 "$HERE/pqp-api-metrics-exporter.py" /usr/local/bin/pqp-api-metrics-exporter

# Never accept the token as an env var already set on this same command line
# (see the header comment) -- only pick it up if something upstream exported
# it another way (a pre-created file, a secrets-manager wrapper), otherwise
# prompt for it: hidden input on a real TTY, one line of stdin when piped.
if [[ -z "${ADMIN_METRICS_TOKEN:-}" ]]; then
  if [[ -t 0 ]]; then
    read -rsp "ADMIN_METRICS_TOKEN (blank to keep the existing /etc/pqp-api-metrics.env): " ADMIN_METRICS_TOKEN
    echo
  else
    IFS= read -r ADMIN_METRICS_TOKEN || true
  fi
fi

if [[ -n "${ADMIN_METRICS_TOKEN:-}" ]]; then
  umask 077
  cat >/etc/pqp-api-metrics.env <<ENV
PQP_API_URL=${PQP_API_URL}
ADMIN_METRICS_TOKEN=${ADMIN_METRICS_TOKEN}
ENV
  # Only written when set -- this is the rare per-replica-URL override (see
  # the comment above), not something a normal install needs. Leaving the
  # line out entirely keeps the file matching what a plain install has
  # always looked like, so the instanceId-dedup path is what runs.
  if [[ -n "$PQP_API_METRICS_ENDPOINTS" ]]; then
    echo "PQP_API_METRICS_ENDPOINTS=${PQP_API_METRICS_ENDPOINTS}" >>/etc/pqp-api-metrics.env
  fi
  chmod 0600 /etc/pqp-api-metrics.env
fi
test -s /etc/pqp-api-metrics.env || { echo "missing /etc/pqp-api-metrics.env; re-run with ADMIN_METRICS_TOKEN=..." >&2; exit 1; }

install -m 0644 "$HERE/pqp-api-metrics.service" /etc/systemd/system/pqp-api-metrics.service
install -m 0644 "$HERE/pqp-api-metrics.timer" /etc/systemd/system/pqp-api-metrics.timer
systemctl daemon-reload
systemctl enable --now pqp-api-metrics.timer
systemctl start pqp-api-metrics.service

echo "== state"
systemctl is-active pqp-api-metrics.timer
sleep 1
cat "$TEXTFILE_DIR/pqp_api.prom"
