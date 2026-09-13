#!/usr/bin/env bash
# The ENTIRE surface a leaked VULTR_API_SSH_KEY can reach.
#
# The HMAC key that guards the config-signature check below (search for
# "deploy-hmac.key") is read from its file with a plain `open(...).read()`
# in a python3 one-liner, never passed as a command-line argument to
# anything -- it does not appear in this process's argv or in `ps`/
# /proc/<pid>/cmdline for any other local user (including pqp-deploy
# itself) to read. There is no `openssl dgst -hmac` in this file.
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
  # No .strip()/whitespace-trimming here: provision.sh writes this file
  # with `printf '%s'` (no trailing newline added), the same exact bytes
  # GitHub hands the runner as the secret, so trimming would silently
  # accept a key that does not match what was actually provisioned instead
  # of failing closed on the mismatch.
  expected="$(python3 -c '
import hashlib, hmac, sys
with open("/etc/pqp/deploy-hmac.key", "rb") as f:
    key = f.read()
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

# API_REPLICAS lives in .env (NOT passed as an argument -- this script's
# only argument is the image tag, see the header comment on why that
# surface stays that small) so flipping it is the same "edit .env, redeploy"
# motion docs/deploy-vultr.md already documents for rotating a secret. Unset
# or anything other than exactly "1" means two replicas (api-a AND api-b) --
# that is the normal, shipped state (docs/plans/ALWAYS_ON.md A0.2).
# API_REPLICAS=1 is the one-line rollback to a single container, kept until
# the multi-instance registry (CLUSTER_BUS=postgres / VOICE_REGISTRY=postgres,
# both already set in this box's .env) has soaked through its own staging
# rehearsal (A0.1/M6 in docs/plans/MULTI_INSTANCE_VOICE.md).
API_REPLICAS="$(grep -m1 '^API_REPLICAS=' "$DEST/.env" 2>/dev/null | cut -d'=' -f2- || true)"
if [[ "$API_REPLICAS" == "1" ]]; then
  echo "API_REPLICAS=1: running api-a only"
  export COMPOSE_PROFILES=""
  API_SERVICES=(api-a)
else
  export COMPOSE_PROFILES="replicas"
  API_SERVICES=(api-a api-b)
fi

# Pull every image this run will touch before touching any running
# container. A pull failure here (bad tag, registry hiccup) exits non-zero
# with nothing touched, instead of leaving some containers on the new tag
# and others on the old one.
docker compose pull "${API_SERVICES[@]}" worker

# Rolling update, one replica at a time (docs/plans/ALWAYS_ON.md A0.2's
# whole point): recreate api-a, confirm it is healthy AND actually serving
# this tag, only THEN touch api-b. A container crash fails over to its
# sibling; this makes a bad *deploy* fail over the same way -- if api-a
# never comes up clean, api-b (and worker) are never touched and keep
# serving the previous release. If api-b is the one that fails, api-a is
# already confirmed healthy on the new tag and keeps serving -- either
# order, one replica is always up. `worker` runs last and alone: it is
# not behind Caddy and nothing fails over to it, so there is no ordering
# constraint it needs to protect.
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

# Belt and braces beyond the Docker healthcheck: confirm a given api
# container is actually reporting the tag this run asked for, not just
# "reachable" -- same check the old single-`api` version of this script
# did, now run per replica.
verify_version() {
  local svc="$1" served
  served="$(docker compose exec -T "$svc" node -e "fetch('http://localhost:3001/health').then(r=>r.json()).then(j=>console.log(j.version||'')).catch(()=>console.log(''))" 2>/dev/null || true)"
  if [[ "$served" != "$TAG" ]]; then
    echo "$svc is healthy but /health reports version '$served', expected '$TAG'" >&2
    return 1
  fi
  return 0
}

# --remove-orphans here (and only here -- once per run is enough, orphan
# detection compares the WHOLE project's containers against the WHOLE
# current file, not just the services named on this line) is what retires
# a container from a service that no longer exists in this compose.yaml at
# all. The one case that matters today: the very first deploy after this
# PR lands still has a lone `api` container running (the pre-split
# service name) on a box that has never seen api-a/api-b -- without this
# flag it would keep running forever under `restart: unless-stopped`,
# unmanaged, still holding a database connection and a cluster-bus
# identity, invisible to Caddy (which only ever pointed at `api`, not
# `api-a`) and to every check in this script. `docker compose` gives it
# the same stop treatment as a normal `down` (SIGTERM, honouring the
# 60s stop_grace_period baked into that old container at creation time,
# then remove) -- expect a one-time full drain of whatever was still
# connected to it, same shape as any other `restarts-api` deploy.
docker compose up -d --remove-orphans api-a
if ! wait_healthy api-a || ! verify_version api-a; then
  echo "api-a failed to come up on $TAG; leaving api-b/worker on the previous release" >&2
  exit 1
fi

if [[ " ${API_SERVICES[*]} " == *" api-b "* ]]; then
  docker compose up -d api-b
  if ! wait_healthy api-b || ! verify_version api-b; then
    echo "api-b failed to come up on $TAG; api-a is already healthy on $TAG and keeps serving" >&2
    exit 1
  fi
else
  # API_REPLICAS=1: api-a is confirmed healthy above, so it's now safe to
  # retire an api-b left over from a box that was previously running with
  # two replicas. Compose does not do this on its own -- disabling a
  # profile only stops FUTURE `up`/`pull` from touching that service, it
  # does not stop or remove a container the profile already created, so
  # without this an old api-b would keep running, keep taking a share of
  # Caddy's round-robin (Caddyfile's upstream list is static, not
  # profile-aware), and keep failing this script's own version check on
  # the NEXT deploy once it drifts onto a stale tag. `--profile replicas`
  # on this one invocation is what lets `stop`/`rm` address a service this
  # run's own COMPOSE_PROFILES has deliberately left deactivated.
  existing_api_b="$(docker compose --profile replicas ps -q api-b 2>/dev/null || true)"
  if [[ -n "$existing_api_b" ]]; then
    echo "API_REPLICAS=1: stopping and removing existing api-b"
    docker compose --profile replicas stop api-b
    docker compose --profile replicas rm -f api-b
  fi
fi

docker compose up -d worker
if ! wait_healthy worker; then
  echo "worker failed to come up on $TAG" >&2
  exit 1
fi

# Bring Caddy up if this is the very first run on this box (no container
# yet), then reload it unconditionally so a Caddyfile that was copied but
# never applied doesn't sit inert -- `caddy reload` validates first and
# only swaps in the new config if that passes. Caddy's own active health
# checking (Caddyfile's `upstreams` snippet) is what actually decides
# whether api-a/api-b are usable at request time; this reload only ever
# needs to happen once the replica(s) we just brought up are confirmed
# healthy above, which they are by this point.
docker compose up -d caddy
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force

# Only now, with every service healthy and every api replica confirmed on
# this tag, is this the box's new known-good release.
echo "$TAG" >"$DEST/.deployed-tag"
chmod 0644 "$DEST/.deployed-tag"

docker compose ps
