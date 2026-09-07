#!/usr/bin/env bash
# Install or update the SFU box monitoring. Idempotent: safe to re-run.
#
# From a laptop:
#   scp -r tools/sfu-monitoring root@216.238.114.79:/opt/
#   ssh root@216.238.114.79 'GC_PROM_USER=... GC_PROM_TOKEN=... bash /opt/sfu-monitoring/install.sh'
#
# GC_PROM_USER / GC_PROM_TOKEN are only needed the first time (or to rotate);
# without them an existing /etc/alloy/credentials.env is left alone.
#
# Nothing here touches the livekit or caddy containers, so it never interrupts
# a call.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y vnstat gpg >/dev/null
systemctl enable --now vnstat

if ! command -v alloy >/dev/null; then
  mkdir -p /etc/apt/keyrings
  wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor >/etc/apt/keyrings/grafana.gpg
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" >/etc/apt/sources.list.d/grafana.list
  apt-get update -qq
  apt-get install -y alloy >/dev/null
fi

echo "== textfile collector"
mkdir -p "$TEXTFILE_DIR"
install -m 0755 "$HERE/pqp-box-metrics.py" /usr/local/bin/pqp-box-metrics
install -m 0644 "$HERE/pqp-box-metrics.service" /etc/systemd/system/pqp-box-metrics.service
install -m 0644 "$HERE/pqp-box-metrics.timer" /etc/systemd/system/pqp-box-metrics.timer
systemctl daemon-reload
systemctl enable --now pqp-box-metrics.timer
systemctl start pqp-box-metrics.service

echo "== alloy"
install -m 0644 "$HERE/config.alloy" /etc/alloy/config.alloy

if [[ -n "${GC_PROM_TOKEN:-}" ]]; then
  umask 077
  cat >/etc/alloy/credentials.env <<CREDS
GC_PROM_USER=${GC_PROM_USER:?set GC_PROM_USER}
GC_PROM_TOKEN=${GC_PROM_TOKEN}
CREDS
  chmod 0600 /etc/alloy/credentials.env
fi
test -s /etc/alloy/credentials.env || { echo "missing /etc/alloy/credentials.env; re-run with GC_PROM_USER and GC_PROM_TOKEN" >&2; exit 1; }

mkdir -p /etc/systemd/system/alloy.service.d
cat >/etc/systemd/system/alloy.service.d/10-pqp.conf <<'DROPIN'
[Service]
EnvironmentFile=/etc/alloy/credentials.env
# The built-in node exporter needs to read host state; the packaged unit is
# already hardened, this only adds what the filesystem collector needs.
ProtectHome=read-only
DROPIN

systemctl daemon-reload
systemctl enable --now alloy
systemctl restart alloy

echo "== state"
systemctl is-active alloy pqp-box-metrics.timer
ls -l "$TEXTFILE_DIR"
