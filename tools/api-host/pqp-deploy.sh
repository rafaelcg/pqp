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

cd "$DEST"

# The deploy workflow scp's a fresh compose.yaml/Caddyfile as pqp-deploy
# (unprivileged, cannot write into /opt/pqp) into its own home directory.
# Adopt them here, as root, before touching any container -- this is the
# step that actually APPLIES a copied compose/Caddy change instead of
# leaving it on disk unread.
if [[ -f "$STAGING/compose.yaml" ]]; then
  install -m 0644 -o pqp -g pqp "$STAGING/compose.yaml" "$DEST/compose.yaml"
fi
if [[ -f "$STAGING/Caddyfile" ]]; then
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
