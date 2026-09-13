#!/usr/bin/env bash
# Build the pqp API box from nothing, or bring an existing one back in line.
# Idempotent, same contract as tools/sfu/install.sh: re-running against the
# live box re-writes identical bytes for anything that has not changed, never
# touches a secret that already exists, and never restarts the api/worker/
# caddy containers itself (that is the deploy workflow's job, over
# `docker compose pull && up -d`, so that "provision drifted" and "a new
# image shipped" stay two different, separately auditable events).
#
# Fresh box (Ubuntu 24.04, root or sudo, public IP, DNS not required yet):
#   scp -r tools/api-host root@<ip>:/opt/pqp-provision
#   ssh root@<ip> 'SSH_ALLOWLIST_CIDRS="1.2.3.4/32 5.6.7.8/32" bash /opt/pqp-provision/provision.sh'
#
# Existing box (verify drift, change nothing that is already correct):
#   ssh pqp@<box> 'sudo bash /opt/pqp/provision.sh'
#
# Secrets (.env, backup.env, certs/origin.{pem,key}) are NEVER written by
# this script beyond an empty template on first run. See docs/deploy-vultr.md
# "Secrets" for how they actually get onto the box (scp'd by hand once, not
# by CI, not by cloud-init user data).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run as root (or with sudo)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/pqp
SSH_ALLOWLIST_CIDRS="${SSH_ALLOWLIST_CIDRS:-}"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl ufw unattended-upgrades fail2ban >/dev/null

if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker

echo "== unattended security upgrades, no automatic reboot"
systemctl enable --now unattended-upgrades
# Same call as tools/sfu/install.sh: Ubuntu's shipped config leaves
# Automatic-Reboot commented out (false); left that way on purpose. Reboot
# by hand in a quiet window, see docs/deploy-vultr.md.

echo "== the pqp user"
if ! id pqp >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups docker,sudo pqp
  passwd -l pqp
  echo "pqp ALL=(ALL) NOPASSWD:/usr/bin/docker, /usr/bin/systemctl" >/etc/sudoers.d/90-pqp
  chmod 0440 /etc/sudoers.d/90-pqp
fi
mkdir -p /home/pqp/.ssh
chmod 0700 /home/pqp/.ssh
touch /home/pqp/.ssh/authorized_keys
chmod 0600 /home/pqp/.ssh/authorized_keys
chown -R pqp:pqp /home/pqp/.ssh
if [[ -n "${PQP_DEPLOY_PUBLIC_KEY:-}" ]] && ! grep -qF "$PQP_DEPLOY_PUBLIC_KEY" /home/pqp/.ssh/authorized_keys; then
  echo "$PQP_DEPLOY_PUBLIC_KEY" >>/home/pqp/.ssh/authorized_keys
fi

echo "== firewall"
# 22 from an allowlist ONLY (unlike the disposable SFU box, this one holds
# DATABASE_URL and CLERK_SECRET_KEY — see the README on why the two boxes'
# threat models differ), 80/443 open for Caddy and Cloudflare's proxy IPs.
ufw default deny incoming
ufw default allow outgoing
if [[ -n "$SSH_ALLOWLIST_CIDRS" ]]; then
  for cidr in $SSH_ALLOWLIST_CIDRS; do
    ufw allow from "$cidr" to any port 22 proto tcp
  done
else
  echo "   !! SSH_ALLOWLIST_CIDRS is empty; leaving any existing 22/tcp rules"
  echo "   !! alone rather than either opening 22 to the world or locking"
  echo "   !! out an admin who is mid-session. Re-run with it set."
fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw status | grep -q '^Status: active' || ufw --force enable

echo "== /opt/pqp layout"
mkdir -p "$DEST/certs"
chown pqp:pqp "$DEST" "$DEST/certs"
chmod 0750 "$DEST"

install -m 0644 -o pqp -g pqp "$HERE/compose.yaml" "$DEST/compose.yaml"
install -m 0644 -o pqp -g pqp "$HERE/Caddyfile" "$DEST/Caddyfile"

if [[ ! -f "$DEST/.env" ]]; then
  cat >"$DEST/.env" <<'ENVEOF'
# pqp API secrets. NEVER commit this file. Names only, values copied from
# `fly secrets list -a pqp-api` / your own records — see
# docs/deploy-vultr.md "Secrets to copy from Fly" for the full list this
# box needs (DATABASE_URL, CLERK_SECRET_KEY, CORS_ALLOWED_ORIGINS,
# CLERK_AUTHORIZED_PARTIES, TRUST_PROXY, PG_POOL_MAX, TURN_*, LIVEKIT_*,
# S3_*, ...).
DATABASE_URL=
CLERK_SECRET_KEY=
CORS_ALLOWED_ORIGINS=https://pqp.gg,https://pqp-3yr.pages.dev
CLERK_AUTHORIZED_PARTIES=
TRUST_PROXY=true
PG_POOL_MAX=10
ENVEOF
  chmod 0600 "$DEST/.env"
  chown pqp:pqp "$DEST/.env"
  echo "   !! wrote an empty $DEST/.env template — fill it in before the first deploy"
fi

if [[ ! -f "$DEST/backup.env" ]]; then
  cat >"$DEST/backup.env" <<'ENVEOF'
# Nightly backup secrets, deliberately separate from .env: a leaked backup
# credential should not also be the API's database role. See
# tools/db-backup/backup.sh and docs/DB_RUNBOOK.md.
BACKUP_DATABASE_URL=
R2_BACKUP_BUCKET=
R2_ACCOUNT_ID=
R2_BACKUP_ACCESS_KEY_ID=
R2_BACKUP_SECRET_ACCESS_KEY=
ENVEOF
  chmod 0600 "$DEST/backup.env"
  chown pqp:pqp "$DEST/backup.env"
  echo "   !! wrote an empty $DEST/backup.env template — fill it in before backups can run"
fi

echo "== nightly db backup"
# Reuses tools/db-backup verbatim (same image the Fly backup machine runs;
# see tools/db-backup/backup.sh and docs/DB_RUNBOOK.md), built locally on
# this box rather than pulled, so the backup path has no GHCR dependency.
if [[ -d "$HERE/db-backup" ]]; then
  cp -r "$HERE/db-backup" "$DEST/db-backup"
  chown -R pqp:pqp "$DEST/db-backup"
  docker build -t pqp-db-backup:local "$DEST/db-backup" >/dev/null
  cat >/etc/cron.d/pqp-db-backup <<CRON
# Mirrors the Fly scheduled machine (docs/DB_RUNBOOK.md), same script, same
# retention. 05:00 UTC = 02:00 America/Sao_Paulo, same off-peak window.
0 5 * * * pqp docker run --rm --env-file $DEST/backup.env pqp-db-backup:local >>/var/log/pqp-db-backup.log 2>&1
CRON
  chmod 0644 /etc/cron.d/pqp-db-backup
  touch /var/log/pqp-db-backup.log
  chown pqp:pqp /var/log/pqp-db-backup.log
else
  echo "   tools/db-backup not copied alongside this script (expected $HERE/db-backup);"
  echo "   copy it over (scp -r tools/db-backup tools/api-host root@<box>:/opt/pqp-provision/)"
  echo "   and re-run to wire up the nightly backup."
fi

echo "== monitoring (Alloy: box metrics + container logs to Grafana Cloud)"
if ! command -v alloy >/dev/null; then
  mkdir -p /etc/apt/keyrings
  wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor >/etc/apt/keyrings/grafana.gpg
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" >/etc/apt/sources.list.d/grafana.list
  apt-get update -qq
  apt-get install -y -qq alloy >/dev/null
fi
install -m 0644 "$HERE/config.alloy" /etc/alloy/config.alloy
usermod -aG docker alloy 2>/dev/null || true

if [[ -n "${GC_PROM_TOKEN:-}${LOKI_PASSWORD:-}" ]]; then
  umask 077
  cat >/etc/alloy/credentials.env <<CREDS
GC_PROM_USER=${GC_PROM_USER:-}
GC_PROM_TOKEN=${GC_PROM_TOKEN:-}
LOKI_URL=${LOKI_URL:-}
LOKI_USERNAME=${LOKI_USERNAME:-}
LOKI_PASSWORD=${LOKI_PASSWORD:-}
CREDS
  chmod 0600 /etc/alloy/credentials.env
fi
if [[ ! -s /etc/alloy/credentials.env ]]; then
  echo "   !! /etc/alloy/credentials.env missing or empty; Alloy will start but ship nothing."
  echo "   !! re-run with GC_PROM_USER/GC_PROM_TOKEN/LOKI_URL/LOKI_USERNAME/LOKI_PASSWORD set"
  echo "   !! (same Grafana Cloud stack tools/sfu-monitoring and tools/log-shipper already use)."
fi

mkdir -p /etc/systemd/system/alloy.service.d
cat >/etc/systemd/system/alloy.service.d/10-pqp.conf <<'DROPIN'
[Service]
EnvironmentFile=-/etc/alloy/credentials.env
SupplementaryGroups=docker
DROPIN

systemctl daemon-reload
systemctl enable --now alloy
systemctl restart alloy

echo "== state"
systemctl is-active docker alloy unattended-upgrades
ufw status verbose
ls -l "$DEST"
docker compose --project-directory "$DEST" config --quiet && echo "   compose.yaml parses OK" || echo "   !! compose.yaml has a problem"
