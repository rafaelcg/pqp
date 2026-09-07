#!/usr/bin/env bash
# Build the pqp SFU box from nothing, or bring an existing one back in line.
# Idempotent: against the live box it re-writes identical bytes and starts
# nothing, so it cannot interrupt a call.
#
# Fresh box (Ubuntu 24.04, root, public IP, DNS already pointing at it):
#   scp -r tools/sfu root@<ip>:/opt/
#   ssh root@<ip> 'LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... bash /opt/sfu/install.sh'
#
# Existing box (verify drift, change nothing):
#   ssh root@216.238.114.79 'bash /opt/sfu/install.sh'
#
# The key and secret are only needed the first time (or to rotate). Without
# them an existing /opt/livekit/livekit.yaml keeps the keys: block it already
# has, so a re-run never needs the secret on the command line. They are the
# same pair that is set on Fly as LIVEKIT_API_KEY / LIVEKIT_API_SECRET; see
# docs/plans/SELF_HOSTED_LIVEKIT.md, "Rebuilding the box from scratch".
#
# Nothing in this repo contains the secret.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/livekit

SFU_DOMAIN="${SFU_DOMAIN:-sfu.pqp.gg}"
TURN_DOMAIN="${TURN_DOMAIN:-turn.pqp.gg}"
ACME_EMAIL="${ACME_EMAIL:-rafaelcg@gmail.com}"

render() { # render <template> <destination> <mode>
  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|__SFU_DOMAIN__|${SFU_DOMAIN}|g" \
    -e "s|__TURN_DOMAIN__|${TURN_DOMAIN}|g" \
    -e "s|__ACME_EMAIL__|${ACME_EMAIL}|g" \
    "$1" >"$tmp"
  install -m "$3" "$tmp" "$2"
  rm -f "$tmp"
}

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y ca-certificates curl ufw >/dev/null

if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker

echo "== swap (8G; LiveKit sits in the low hundreds of MB, this is only a cushion)"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 8G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
fi
grep -qE '^/swapfile\s' /etc/fstab || echo '/swapfile swap swap defaults 0 0' >>/etc/fstab

echo "== journald cap (containers log through the journald driver)"
if ! grep -qE '^SystemMaxUse=500M' /etc/systemd/journald.conf; then
  sed -i 's|^#\?SystemMaxUse=.*|SystemMaxUse=500M|' /etc/systemd/journald.conf
  grep -qE '^SystemMaxUse=' /etc/systemd/journald.conf || echo 'SystemMaxUse=500M' >>/etc/systemd/journald.conf
  systemctl restart systemd-journald
fi

echo "== unattended security upgrades, no automatic reboot"
apt-get install -y unattended-upgrades >/dev/null
systemctl enable --now unattended-upgrades
# Ubuntu's shipped 50unattended-upgrades leaves Automatic-Reboot commented out,
# which means false. We do not override it: a reboot mid-party is worse than a
# kernel patch landing a day late. Reboot by hand, see the README.

echo "== firewall"
# Exactly the rules the production box carries. See the README for why 22 is
# open to the world.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw allow 3478/udp
ufw allow 5349/tcp
# NOT stale, despite rtc.udp_port being pinned to 7882. This is LiveKit's TURN
# *relay* allocation range, turn.relay_range_start/end, which default to
# 30000/40000 and which livekit.yaml does not override. Every cross-NAT client
# that falls back to turn.pqp.gg gets its relayed candidate on a port in here:
#   docker logs livekit-livekit-1 | grep -o 'udp relay [0-9.]*:[0-9]*'
# A relay socket only exists while an allocation is live, so `ss -lnup` shows
# an empty range most of the time. That emptiness is not evidence. Deleting
# this rule is a way to break relayed calls for exactly the users who have no
# other path. Confirm against the startup line before you touch it:
#   docker logs livekit-livekit-1 | grep 'Starting TURN server'
ufw allow 30000:40000/udp
# Only enable when it is off. `ufw enable` on a live box reloads every rule,
# and there is no reason to shake the firewall under a call in progress.
ufw status | grep -q '^Status: active' || ufw --force enable

echo "== ssh: keys only"
# Ubuntu ships /etc/ssh/sshd_config.d/50-cloud-init.conf with
# "PasswordAuthentication yes", which silently overrides the "no" in the main
# sshd_config: sshd takes the first value it sees for a keyword, and the
# Include of the drop-in directory comes first. Our file sorts ahead of the
# cloud-init one and wins the same way. Do not renumber it above 50-.
#
# The guard below is the whole reason this section is safe to run unattended
# during a 23:00 rebuild: no key on disk means no way back in, so we leave
# password auth alone and say so loudly rather than sealing the box.
if [[ -s /root/.ssh/authorized_keys ]]; then
  install -m 0600 "$HERE/sshd-hardening.conf" /etc/ssh/sshd_config.d/01-pqp-hardening.conf
  # Validate before touching the running daemon, then reload rather than
  # restart, so sessions in flight (including the one running this script)
  # survive. `systemctl reload ssh` runs `sshd -t` itself and refuses a bad
  # config, but check here too so the failure names this script.
  if sshd -t; then
    systemctl reload ssh
    sshd -T | grep -qx 'passwordauthentication no' \
      && echo "   password auth off, pubkey on" \
      || echo "   !! sshd -T still reports password auth on, investigate"
  else
    rm -f /etc/ssh/sshd_config.d/01-pqp-hardening.conf
    echo "   !! sshd -t rejected the config, drop-in removed, nothing reloaded" >&2
    exit 1
  fi
else
  echo "   !! /root/.ssh/authorized_keys is empty or missing."
  echo "   !! Leaving password authentication ON so this does not lock you out."
  echo "   !! Add your key, then re-run this script."
fi

echo "== fail2ban"
# Not what keeps the box safe (password auth is off above). This is here to
# stop the several thousand daily knocks from filling the journal and burning
# CPU on key exchanges that can never succeed.
#
# python3-systemd is not optional: the jail below reads the journal, and
# without the bindings fail2ban fails to initialise the backend and the jail
# runs watching nothing.
apt-get install -y fail2ban python3-systemd >/dev/null
F2B_JAIL=/etc/fail2ban/jail.d/pqp-sshd.local
# Only restart when the jail actually changed. A restart resets the in-memory
# counters and re-reads the journal from findtime back, so doing it on every
# drift check would keep the jail permanently forgetful.
if ! cmp -s "$HERE/fail2ban-jail-sshd.conf" "$F2B_JAIL"; then
  install -m 0644 "$HERE/fail2ban-jail-sshd.conf" "$F2B_JAIL"
  if fail2ban-client -t >/dev/null 2>&1; then
    systemctl enable fail2ban >/dev/null
    systemctl restart fail2ban
  else
    echo "   !! fail2ban config test failed, not restarting it" >&2
    fail2ban-client -t || true
  fi
else
  systemctl enable fail2ban >/dev/null
  systemctl is-active --quiet fail2ban || systemctl start fail2ban
  echo "   jail unchanged, left running"
fi

echo "== /opt/livekit"
mkdir -p "$DEST/certs"
chmod 0700 "$DEST"
render "$HERE/Caddyfile.tmpl" "$DEST/Caddyfile" 0644
render "$HERE/sync-turn-cert.sh.tmpl" "$DEST/sync-turn-cert.sh" 0700
install -m 0644 "$HERE/docker-compose.yaml" "$DEST/docker-compose.yaml"

echo "== livekit.yaml"
# The keys: block is the only secret on this box. Priority:
#   1. LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the environment
#   2. the keys: line already in /opt/livekit/livekit.yaml
#   3. a fresh pair generated here (then set it on Fly, see the README)
KEY="${LIVEKIT_API_KEY:-}"
SECRET="${LIVEKIT_API_SECRET:-}"
if [[ -z "$KEY" || -z "$SECRET" ]]; then
  if [[ -f "$DEST/livekit.yaml" ]]; then
    existing=$(awk '/^keys:/{getline; gsub(/^[[:space:]]+|[[:space:]]+$/,""); print; exit}' "$DEST/livekit.yaml")
    KEY="${existing%%:*}"
    SECRET="${existing#*: }"
  fi
fi
if [[ -z "$KEY" || -z "$SECRET" ]]; then
  echo "   no key pair given and none on disk; generating one"
  ( umask 077; docker run --rm livekit/livekit-server generate-keys >"$DEST/keys.txt" )
  cat "$DEST/keys.txt"
  KEY=$(awk -F': *' '/API Key/{print $2}' "$DEST/keys.txt" | tr -d '[:space:]')
  SECRET=$(awk -F': *' '/API Secret/{print $2}' "$DEST/keys.txt" | tr -d '[:space:]')
  echo "   !! set these three on Fly before this box can serve production:"
  echo "   !!   fly secrets set -a pqp-api LIVEKIT_URL=wss://${SFU_DOMAIN} LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=..."
fi
[[ -n "$KEY" && -n "$SECRET" ]] || { echo "could not resolve a LiveKit key pair" >&2; exit 1; }

LK_TMP="$(umask 077 && mktemp)"
sed \
  -e "s|__TURN_DOMAIN__|${TURN_DOMAIN}|g" \
  -e "s|__LIVEKIT_API_KEY__|${KEY}|" \
  -e "s|__LIVEKIT_API_SECRET__|${SECRET}|" \
  "$HERE/livekit.yaml.tmpl" >"$LK_TMP"
# Never install a config whose keys: block did not come out right. This is the
# one file where a bad render would take voice down at the next restart, hours
# after this script exited.
if grep -q '__LIVEKIT_API' "$LK_TMP" || ! grep -qE '^  [A-Za-z0-9]+: .+' "$LK_TMP"; then
  rm -f "$LK_TMP"
  echo "rendered livekit.yaml has no usable keys: block, refusing to install" >&2
  exit 1
fi
install -m 0600 "$LK_TMP" "$DEST/livekit.yaml"
rm -f "$LK_TMP"

echo "== systemd units"
install -m 0644 "$HERE/livekit-docker.service" /etc/systemd/system/livekit-docker.service
render "$HERE/turn-cert-sync.service.tmpl" /etc/systemd/system/turn-cert-sync.service 0644
install -m 0644 "$HERE/turn-cert-sync.timer" /etc/systemd/system/turn-cert-sync.timer
systemctl daemon-reload
systemctl enable turn-cert-sync.timer
systemctl start turn-cert-sync.timer
systemctl enable livekit-docker

echo "== stack"
if docker compose --project-directory "$DEST" ps --status running --quiet 2>/dev/null | grep -q .; then
  # Already serving, possibly a live call. Starting livekit-docker here would
  # run `docker compose up -d` under systemd, and any spec drift would recreate
  # the containers mid-call. Leave it alone; the README says how to hand the
  # running stack over to systemd during a quiet hour.
  echo "   containers already running, not touching them"
  docker compose --project-directory "$DEST" ps
else
  systemctl start livekit-docker
  echo "   waiting for Caddy to obtain certificates (ACME, up to ~2 min)"
  for _ in $(seq 1 24); do
    curl -fsS -o /dev/null "https://${SFU_DOMAIN}/" && break || sleep 5
  done
  /opt/livekit/sync-turn-cert.sh || true
fi

echo "== monitoring"
if [[ -f "$HERE/../sfu-monitoring/install.sh" ]]; then
  bash "$HERE/../sfu-monitoring/install.sh"
elif [[ -f /opt/sfu-monitoring/install.sh ]]; then
  bash /opt/sfu-monitoring/install.sh
else
  echo "   tools/sfu-monitoring not next to this script; copy it over and run its install.sh"
fi

echo "== state"
docker compose --project-directory "$DEST" ps
systemctl is-enabled livekit-docker turn-cert-sync.timer
systemctl is-active turn-cert-sync.timer
sshd -T | grep -E '^(passwordauthentication|pubkeyauthentication|permitrootlogin) '
# "Journal matches" must name ssh.service and the counters must be non-zero
# within a minute or two on a box that is being knocked on. A jail reporting
# "Total failed: 0" forever is watching the wrong log, not enjoying the quiet.
fail2ban-client status sshd || true
ufw status verbose
curl -sS -o /dev/null -w "https://${SFU_DOMAIN}/ -> %{http_code}\n" "https://${SFU_DOMAIN}/" || true
curl -sS -o /dev/null -w "https://${TURN_DOMAIN}/ -> %{http_code}\n" "https://${TURN_DOMAIN}/" || true
