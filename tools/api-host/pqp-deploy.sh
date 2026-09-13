#!/usr/bin/env bash
# The ENTIRE surface a leaked VULTR_API_SSH_KEY can reach.
#
# Installed at /usr/local/bin/pqp-deploy (0755, root:root) by provision.sh.
# The `pqp-deploy` account the deploy workflow SSHes into (cloud-init.yaml /
# provision.sh) is not in the docker group and has no other sudo rule, so
# the *only* thing that key can do -- even fully compromised -- is invoke
# this one fixed script against these fixed files. It never receives a
# path, a compose override, an image name, or a shell fragment from the
# caller, only a tag; there is no `docker run`, so nothing here can mount
# `/`, read arbitrary host files, or start an unrelated container the way
# unrestricted docker-group / sudo access could.
#
# Usage: sudo /usr/local/bin/pqp-deploy <image-tag>
set -euo pipefail

TAG="${1:?usage: pqp-deploy <image-tag>}"
DEST=/opt/pqp
STAGING=/home/pqp-deploy/incoming

# Unconditional, on every exit path (success, a rejected/tampered config,
# a failed pull, a healthcheck timeout -- anything). pqp-deploy owns this
# directory and can re-stage into it at any time, so a run that dies
# before reaching the end must never leave files behind for the NEXT
# invocation (e.g. the rollback call the workflow makes right after a
# failure) to find still sitting there -- a half-copied scp or a
# deliberately-broken upload from a previous attempt could otherwise block
# that rollback at the same manifest check, or get installed a second time
# by accident.
trap 'rm -f "$STAGING"/compose.yaml "$STAGING"/Caddyfile "$STAGING"/manifest.sha256 "$STAGING"/manifest.sig' EXIT

cd "$DEST"

# The deploy workflow scp's a fresh compose.yaml/Caddyfile as pqp-deploy
# (unprivileged, cannot write into /opt/pqp) into its own home directory.
# pqp-deploy is exactly the account VULTR_API_SSH_KEY authenticates to, so
# a leaked key lets an attacker stage ANY compose.yaml they want there --
# one with a host-root bind mount or a command that reads /opt/pqp/.env.
# We are about to run that file as root; a bare `install` here would hand
# a leaked SSH key root on the box, defeating the entire point of
# pqp-deploy not being in the docker group.
#
# So: only ever install a staged compose.yaml/Caddyfile that is
# accompanied by a manifest of their checksums, itself signed with an
# HMAC key pqp-deploy never has access to (/etc/pqp/deploy-hmac.key,
# root-only, set by provision.sh from GitHub secret
# VULTR_CONFIG_HMAC_KEY). The signature is verified against OUR copy of
# the key, not anything the caller supplied, and the manifest is checked
# against the files' actual bytes -- a valid signature over the wrong
# manifest, or a manifest that does not match what is actually staged,
# both fail closed.
if [[ -f "$STAGING/compose.yaml" || -f "$STAGING/Caddyfile" ]]; then
  if [[ ! -s /etc/pqp/deploy-hmac.key ]]; then
    echo "refusing staged config: /etc/pqp/deploy-hmac.key is not provisioned" >&2
    exit 1
  fi
  if [[ ! -f "$STAGING/manifest.sha256" || ! -f "$STAGING/manifest.sig" ]]; then
    echo "refusing staged config: missing manifest.sha256/manifest.sig" >&2
    exit 1
  fi
  # Deliberately NOT `openssl dgst -hmac "$(cat ...)"` -- that would put
  # the key's bytes on this process's own command line, readable by any
  # local user (including pqp-deploy itself, the account a leaked
  # VULTR_API_SSH_KEY reaches) via `ps` or /proc/<pid>/cmdline for as long
  # as the command runs. python3 opens the key file itself, root-only
  # (0600), and the key never appears as an argument to anything.
  expected="$(python3 -c '
import hashlib, hmac, sys
with open("/etc/pqp/deploy-hmac.key", "rb") as f:
    key = f.read().strip()
with open(sys.argv[1], "rb") as f:
    data = f.read()
print(hmac.new(key, data, hashlib.sha256).hexdigest())
' "$STAGING/manifest.sha256")"
  got="$(tr -d '[:space:]' <"$STAGING/manifest.sig")"
  if [[ -z "$expected" || "$expected" != "$got" ]]; then
    echo "refusing staged config: manifest signature does not verify" >&2
    exit 1
  fi
  if ! (cd "$STAGING" && sha256sum -c manifest.sha256 --quiet); then
    echo "refusing staged config: staged files do not match the signed manifest" >&2
    exit 1
  fi
  install -m 0644 -o pqp -g pqp "$STAGING/compose.yaml" "$DEST/compose.yaml"
  install -m 0644 -o pqp -g pqp "$STAGING/Caddyfile" "$DEST/Caddyfile"
fi

# GHCR credentials, only needed while ghcr.io/rafaelcg/pqp-api is private.
# See docs/deploy-vultr.md "GHCR pull on the host" -- the alternative is
# making the package public, in which case this file stays empty and the
# login below is skipped. Harmless to repeat.
if [[ -s /etc/pqp/ghcr.env ]]; then
  # shellcheck disable=SC1091
  source /etc/pqp/ghcr.env
  if [[ -n "${GHCR_USER:-}" && -n "${GHCR_TOKEN:-}" ]]; then
    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
  fi
fi

# Captured for the workflow's own rollback step, which reads this line from
# our stdout rather than re-reading the file afterward -- once we write the
# new tag below, the file itself no longer tells "old" from "new" apart.
PREV_TAG="$(cat "$DEST/.deployed-tag" 2>/dev/null || true)"
echo "previous-tag=${PREV_TAG:-none}"

export APP_IMAGE_TAG="$TAG" APP_VERSION="$TAG"

# Pull BOTH images before touching either running container. A pull
# failure here (bad tag, registry hiccup) exits non-zero with neither
# service touched, instead of leaving one on the new tag and one on the
# old one.
docker compose pull api worker

docker compose up -d api worker

# Bring Caddy up if this is the very first run on this box (no container
# yet), then reload it unconditionally so a Caddyfile that was copied but
# never applied doesn't sit inert -- `caddy reload` validates first and
# only swaps in the new config if that passes.
docker compose up -d caddy
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force

# Wait for BOTH services' own Docker healthchecks (compose.yaml defines one
# for each) before calling this a success -- the deploy workflow's external
# check only ever reaches `api` through Caddy, so without this a worker
# that fails to boot on the new image would go unnoticed here and only
# surface later, off this pipeline entirely.
wait_healthy() {
  local svc="$1" tries=0 status="unknown"
  while (( tries < 24 )); do # 24 * 5s = 120s, generous over the 30s start_period
    cid=$(docker compose ps -q "$svc")
    if [[ -n "$cid" ]]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "unknown")
      [[ "$status" == "healthy" ]] && return 0
    fi
    tries=$((tries + 1))
    sleep 5
  done
  echo "$svc never reported healthy (last status: $status)" >&2
  return 1
}
wait_healthy api
wait_healthy worker

# Belt and braces beyond the Docker healthcheck: confirm the api container
# is actually reporting the tag this run asked for, not just "reachable".
served="$(docker compose exec -T api node -e "fetch('http://localhost:3001/health').then(r=>r.json()).then(j=>console.log(j.version||'')).catch(()=>console.log(''))" 2>/dev/null || true)"
if [[ "$served" != "$TAG" ]]; then
  echo "api is healthy but /health reports version '$served', expected '$TAG'" >&2
  exit 1
fi

# Only now, with both containers healthy and api confirmed on this tag, is
# this the box's new known-good release.
echo "$TAG" >"$DEST/.deployed-tag"
chmod 0644 "$DEST/.deployed-tag"

docker compose ps
