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
#   ssh root@<ip> 'SSH_ALLOWLIST_CIDRS="1.2.3.4/32 5.6.7.8/32" \
#     PQP_DEPLOY_PUBLIC_KEY="ssh-ed25519 AAAA... pqp-api-deploy" \
#     GHCR_USER=<gh-username> GHCR_TOKEN=<PAT with read:packages> \
#     bash /opt/pqp-provision/provision.sh'
#
# Existing box (verify drift, change nothing that is already correct):
#   ssh pqp@<box> 'sudo bash /opt/pqp/provision.sh'
#
# Two accounts, two threat models: `pqp` is for a human with their own SSH
# key (docker group, broad-ish sudo, for troubleshooting); `pqp-deploy` is
# what the CI secret VULTR_API_SSH_KEY authenticates to, and it can do
# exactly one thing — see "the pqp-deploy user" below and
# tools/api-host/pqp-deploy.sh.
#
# Secrets (.env, certs/origin.{pem,key}) are NEVER written by this script
# beyond an empty template on first run. See docs/deploy-vultr.md "Secrets"
# for how they actually get onto the box (scp'd by hand once, not by CI, not
# by cloud-init user data). The nightly backup (below) reads its secrets
# from .env too, DATABASE_URL and LIVE_HLS_S3_*, rather than a file of its
# own; see docs/DB_RUNBOOK.md.
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

echo "== the pqp user (human admin: docker + scoped sudo, own SSH keys via Vultr)"
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
# No deploy key goes here anymore (see "the pqp-deploy user" below) — this
# account's authorized_keys only ever gets a human's own key, via Vultr's
# account-level "SSH Keys" attachment at instance creation.

echo "== the pqp-deploy user (CI only: no docker group, one sudo rule)"
# This is the account VULTR_API_SSH_KEY actually authenticates to. It holds
# NO docker group membership and NO broad sudo — the Docker daemon socket
# is root-equivalent (start a container that bind-mounts /, read any file,
# replace any running service), so an account a CI secret can reach must
# never have it. Its one privilege is passwordless sudo for exactly one
# root-owned, fixed script (installed below), which only ever pulls fixed
# images and reloads Caddy from fixed files under /opt/pqp — never an
# arbitrary docker/compose invocation. See tools/api-host/pqp-deploy.sh.
if ! id pqp-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash pqp-deploy
  passwd -l pqp-deploy
fi
mkdir -p /home/pqp-deploy/.ssh /home/pqp-deploy/incoming
chmod 0700 /home/pqp-deploy/.ssh
touch /home/pqp-deploy/.ssh/authorized_keys
chmod 0600 /home/pqp-deploy/.ssh/authorized_keys
chmod 0700 /home/pqp-deploy/incoming
chown -R pqp-deploy:pqp-deploy /home/pqp-deploy/.ssh /home/pqp-deploy/incoming
if [[ -n "${PQP_DEPLOY_PUBLIC_KEY:-}" ]] && ! grep -qF "$PQP_DEPLOY_PUBLIC_KEY" /home/pqp-deploy/.ssh/authorized_keys; then
  echo "$PQP_DEPLOY_PUBLIC_KEY" >>/home/pqp-deploy/.ssh/authorized_keys
fi

install -m 0755 -o root -g root "$HERE/pqp-deploy.sh" /usr/local/bin/pqp-deploy
cat >/etc/sudoers.d/91-pqp-deploy <<'SUDOERS'
Defaults!/usr/local/bin/pqp-deploy !requiretty
pqp-deploy ALL=(root) NOPASSWD: /usr/local/bin/pqp-deploy
SUDOERS
chmod 0440 /etc/sudoers.d/91-pqp-deploy
visudo -cf /etc/sudoers.d/91-pqp-deploy

echo "== deploy config signing key"
# The one thing pqp-deploy (the unprivileged CI account) is never allowed
# to hold. VULTR_API_SSH_KEY authenticates the SSH connection -- if it
# leaks, whoever holds it can still stage any compose.yaml/Caddyfile they
# want in pqp-deploy's own home. What stops the root-owned pqp-deploy
# script from installing THAT file is this key: the GitHub Actions runner
# signs a manifest of the two files' checksums with it (secret
# VULTR_CONFIG_HMAC_KEY, never exposed to pqp-deploy), and the script
# refuses to install anything whose signature does not verify against this
# copy. Root-only (0600); an attacker with just the SSH key cannot forge a
# valid signature without this file too.
mkdir -p /etc/pqp
if [[ -n "${VULTR_CONFIG_HMAC_KEY:-}" ]]; then
  umask 077
  printf '%s' "$VULTR_CONFIG_HMAC_KEY" >/etc/pqp/deploy-hmac.key
  chmod 0600 /etc/pqp/deploy-hmac.key
fi
if [[ ! -s /etc/pqp/deploy-hmac.key ]]; then
  echo "   !! /etc/pqp/deploy-hmac.key is missing or empty; the deploy workflow"
  echo "   !! CANNOT ship a compose.yaml/Caddyfile change until this is set."
  echo "   !! Re-run with VULTR_CONFIG_HMAC_KEY=<the same value as the GitHub"
  echo "   !! secret> set (generate one with 'openssl rand -hex 32')."
fi

echo "== GHCR credentials (only needed while the image is private)"
mkdir -p /etc/pqp
if [[ -n "${GHCR_USER:-}${GHCR_TOKEN:-}" ]]; then
  umask 077
  cat >/etc/pqp/ghcr.env <<GHCR
GHCR_USER=${GHCR_USER:-}
GHCR_TOKEN=${GHCR_TOKEN:-}
GHCR
  chmod 0600 /etc/pqp/ghcr.env
fi
if [[ ! -s /etc/pqp/ghcr.env ]]; then
  touch /etc/pqp/ghcr.env
  chmod 0600 /etc/pqp/ghcr.env
  echo "   !! /etc/pqp/ghcr.env is empty; pqp-deploy will skip 'docker login ghcr.io'."
  echo "   !! Fine if ghcr.io/rafaelcg/pqp-api is public. Otherwise re-run with"
  echo "   !! GHCR_USER/GHCR_TOKEN set (a PAT scoped to read:packages only)."
fi

echo "== firewall"
# 22 from an allowlist ONLY (unlike the disposable SFU box, this one holds
# DATABASE_URL and CLERK_SECRET_KEY — see the README on why the two boxes'
# threat models differ). 80/443 are NOT opened to the world: api.pqp.gg is
# proxied (orange-cloud) behind Cloudflare (docs/deploy-vultr.md "cutover"),
# so the origin only needs to hear from Cloudflare's edge — anyone else
# connecting directly would bypass Cloudflare's WAF and rate limits
# entirely. Restricted to Cloudflare's own published ranges instead,
# refreshed on every re-run since they do occasionally change.
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

cf_ranges=""
for url in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
  ranges=$(curl -fsS --max-time 10 "$url") && cf_ranges="$cf_ranges $ranges"
done
if [[ -n "$(echo "$cf_ranges" | tr -d '[:space:]')" ]]; then
  echo "$cf_ranges" >/etc/pqp-cloudflare-ips
  for cidr in $cf_ranges; do
    ufw allow from "$cidr" to any port 80 proto tcp
    ufw allow from "$cidr" to any port 443 proto tcp
  done
else
  echo "   !! could not fetch Cloudflare's IP ranges; falling back to any"
  echo "   !! ranges cached from a previous run at /etc/pqp-cloudflare-ips"
  if [[ -s /etc/pqp-cloudflare-ips ]]; then
    while read -r cidr; do
      [[ -n "$cidr" ]] || continue
      ufw allow from "$cidr" to any port 80 proto tcp
      ufw allow from "$cidr" to any port 443 proto tcp
    done </etc/pqp-cloudflare-ips
  else
    echo "   !! no cache either — 80/443 stay closed until this succeeds. Re-run."
  fi
fi
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
# S3_*, LIVE_HLS_S3_*; the last of these is also what the nightly backup
# below uploads to, see docs/DB_RUNBOOK.md).
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

echo "== rclone (nightly backup upload to R2)"
if ! command -v rclone >/dev/null; then
  apt-get install -y -qq rclone >/dev/null
fi

echo "== nightly db backup"
# Runs directly on this box as a root cron job (see tools/api-host/
# db-backup.sh and docs/DB_RUNBOOK.md) rather than as a separate Fly app;
# `pqp-db-backup` (the old scheduled machine) was destroyed 2026-09-24. The
# script reads DATABASE_URL and LIVE_HLS_S3_* out of /opt/pqp/.env, the
# same values the API containers already use, so there is no backup-only
# secret to create or keep in sync here.
install -d -o root -g root -m 0755 "$DEST/backup"
install -m 0755 -o root -g root "$HERE/db-backup.sh" "$DEST/backup/run.sh"
cat >/etc/cron.d/pqp-db-backup <<CRON
# 04:23 UTC = 01:23 America/Sao_Paulo, an off-peak window. See docs/DB_RUNBOOK.md.
23 4 * * * root $DEST/backup/run.sh >>/var/log/pqp-db-backup.log 2>&1
CRON
chmod 0644 /etc/cron.d/pqp-db-backup
touch /var/log/pqp-db-backup.log
chown root:root /var/log/pqp-db-backup.log

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
