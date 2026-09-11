#!/usr/bin/env bash
# Install or update the SFU box monitoring. Idempotent: safe to re-run.
#
# From a laptop (production sfu-pqp):
#   scp -r tools/sfu-monitoring root@216.238.114.79:/opt/
#   ssh root@216.238.114.79 'GC_PROM_USER=... GC_PROM_TOKEN=... bash /opt/sfu-monitoring/install.sh'
#
# Dedicated HLS box (distinct scrape labels; does not replace prod):
#   scp -r tools/sfu-monitoring root@216.238.108.42:/opt/
#   ssh root@216.238.108.42 'GC_PROM_USER=... GC_PROM_TOKEN=... \
#     PQP_SFU_INSTANCE=sfu-hls \
#     PQP_METRICS_CONTAINERS=livekit-livekit-1,livekit-caddy-1,livekit-egress-1,livekit-redis-1 \
#     bash /opt/sfu-monitoring/install.sh'
#
# GC_PROM_USER / GC_PROM_TOKEN are only needed the first time (or to rotate);
# without them an existing /etc/alloy/credentials.env is left alone.
# PQP_SFU_INSTANCE defaults to sfu-pqp so a prod reinstall keeps its labels.
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

echo "== alloy"
# Labels are the instance name. Prod ships as sfu-pqp; a second box must
# pass PQP_SFU_INSTANCE so it does not collide with (or replace) prod series.
INSTANCE="${PQP_SFU_INSTANCE:-sfu-pqp}"
if [[ "$INSTANCE" != "sfu-pqp" ]]; then
  sed "s/sfu-pqp/${INSTANCE}/g" "$HERE/config.alloy" >/etc/alloy/config.alloy
else
  install -m 0644 "$HERE/config.alloy" /etc/alloy/config.alloy
fi
chmod 0644 /etc/alloy/config.alloy

if [[ -n "${GC_PROM_TOKEN:-}" ]]; then
  umask 077
  cat >/etc/alloy/credentials.env <<CREDS
GC_PROM_USER=${GC_PROM_USER:?set GC_PROM_USER}
GC_PROM_TOKEN=${GC_PROM_TOKEN}
CREDS
  chmod 0600 /etc/alloy/credentials.env
fi
test -s /etc/alloy/credentials.env || { echo "missing /etc/alloy/credentials.env; re-run with GC_PROM_USER and GC_PROM_TOKEN" >&2; exit 1; }

if [[ -n "${PQP_METRICS_CONTAINERS:-}" || -n "${PQP_EGRESS_ALLOWANCE_BYTES:-}" ]]; then
  mkdir -p /etc/systemd/system/pqp-box-metrics.service.d
  {
    echo "[Service]"
    [[ -n "${PQP_METRICS_CONTAINERS:-}" ]] && echo "Environment=PQP_METRICS_CONTAINERS=${PQP_METRICS_CONTAINERS}"
    [[ -n "${PQP_EGRESS_ALLOWANCE_BYTES:-}" ]] && echo "Environment=PQP_EGRESS_ALLOWANCE_BYTES=${PQP_EGRESS_ALLOWANCE_BYTES}"
  } >/etc/systemd/system/pqp-box-metrics.service.d/10-pqp.conf
fi

mkdir -p /etc/systemd/system/alloy.service.d
cat >/etc/systemd/system/alloy.service.d/10-pqp.conf <<'DROPIN'
[Service]
EnvironmentFile=/etc/alloy/credentials.env
# The built-in node exporter needs to read host state; the packaged unit is
# already hardened, this only adds what the filesystem collector needs.
ProtectHome=read-only
DROPIN

systemctl daemon-reload
systemctl start pqp-box-metrics.service
systemctl enable --now alloy
systemctl restart alloy

echo "== state"
systemctl is-active alloy pqp-box-metrics.timer
ls -l "$TEXTFILE_DIR"
