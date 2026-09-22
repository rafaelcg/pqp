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
# Installed at /usr/local/bin/pqp-deploy (0755, root:root) by provision.sh,
# and kept in sync on every deploy from here on by THIS SCRIPT'S OWN
# staged-install block below (docs/plans/ALWAYS_ON.md A0.2 needs the
# rolling-update logic in this file to track compose.yaml's service names,
# which the old provision.sh-only install path could not guarantee). The
# `pqp-deploy` account the deploy workflow SSHes into (cloud-init.yaml /
# provision.sh) is not in the docker group and has no other sudo rule, so
# the *only* thing that key can do -- even fully compromised -- is invoke
# this one fixed script against these fixed files, still true now that one
# of those files is this script's own successor: it is never installed
# without first checking out against the same HMAC signature compose.yaml
# and Caddyfile always have, verified below with a key pqp-deploy itself
# never has access to. It never receives a path, a compose override, an
# image name, or a shell fragment from the caller, only a tag; there is no
# `docker run`, so nothing here can mount `/`, read arbitrary host files,
# or start an unrelated container the way unrestricted docker-group / sudo
# access could.
#
# Usage: sudo /usr/local/bin/pqp-deploy <image-tag>
set -euo pipefail

TAG="${1:?usage: pqp-deploy <image-tag>}"
DEST=/opt/pqp
STAGING=/home/pqp-deploy/incoming
VERIFIED=""
tmp_bin=""
env_tmp=""

# Unconditional, on every exit path (success, a rejected/tampered config,
# a failed pull, a healthcheck timeout -- anything). pqp-deploy owns
# STAGING and can re-stage into it at any time, so a run that dies before
# reaching the end must never leave files behind for the NEXT invocation
# (e.g. the rollback call the workflow makes right after a failure) to
# find still sitting there -- a half-copied scp or a deliberately-broken
# upload from a previous attempt could otherwise block that rollback at
# the same manifest check, or get installed a second time by accident.
# VERIFIED and tmp_bin are ours (root-owned, created below), not
# pqp-deploy's, but the same "never leave residue for the next run" logic
# applies -- quoted with defaults so this fires safely even before either
# variable is ever assigned (a run that exits before reaching that point).
trap 'rm -f "$STAGING"/compose.yaml "$STAGING"/Caddyfile "$STAGING"/pqp-deploy.sh "$STAGING"/manifest.sha256 "$STAGING"/manifest.sig; rm -rf "${VERIFIED:-}"; rm -f "${tmp_bin:-}" "${env_tmp:-}"' EXIT

cd "$DEST"

# The deploy workflow scp's a fresh compose.yaml/Caddyfile/pqp-deploy.sh as
# pqp-deploy (unprivileged, cannot write into /opt/pqp or
# /usr/local/bin) into its own home directory. pqp-deploy is exactly the
# account VULTR_API_SSH_KEY authenticates to, so a leaked key lets an
# attacker stage ANY of these three files they want there -- a
# compose.yaml with a host-root bind mount, a command that reads
# /opt/pqp/.env, or (now that this script keeps itself in sync too) an
# entirely different pqp-deploy.sh that does whatever it likes AS ROOT the
# next time it runs. We are about to run/install that content as root; a
# bare `install` here would hand a leaked SSH key root on the box,
# defeating the entire point of pqp-deploy not being in the docker group.
#
# So: only ever install staged files that come with a manifest of their
# checksums, itself signed with an HMAC key pqp-deploy never has access to
# (/etc/pqp/deploy-hmac.key, root-only, set by provision.sh from GitHub
# secret VULTR_CONFIG_HMAC_KEY). The signature is verified against OUR
# copy of the key, not anything the caller supplied, and the manifest is
# checked against the files' actual bytes -- a valid signature over the
# wrong manifest, or a manifest that does not match what is actually
# staged, both fail closed. Adding pqp-deploy.sh to this same manifest
# (rather than trusting it separately, or not at all) is what makes
# self-updating safe: the exact same signature that has always gated
# compose.yaml/Caddyfile now gates root code, not just root config.
#
# CRITICAL: verify-then-use must not mean "check bytes at path P, then
# separately re-read path P to install it" -- STAGING stays writable by
# pqp-deploy for the ENTIRE time this script runs, so if verification and
# installation are two separate reads of the same attacker-writable path,
# a compromised pqp-deploy key can swap the content (or repoint a symlink)
# in between, install its OWN payload as root, and never once fail a
# check. So every staged file this run will trust is copied ONCE, up
# front, into VERIFIED -- a fresh `mktemp -d` owned by root, mode 0700,
# which pqp-deploy has no permission to read or write into. Everything
# from here on (the HMAC check, the sha256sum check, and the installs
# themselves) reads ONLY from VERIFIED, never from STAGING again, so
# "what got hashed" and "what got installed" are provably the same bytes
# regardless of what pqp-deploy does to STAGING afterward. Symlinks are
# refused outright rather than followed: a symlink is itself something
# pqp-deploy can repoint at any moment, including between this copy and
# whatever it points at being read, which is exactly the class of race
# this whole block exists to close.
if [[ -f "$STAGING/compose.yaml" || -f "$STAGING/Caddyfile" || -f "$STAGING/pqp-deploy.sh" ]]; then
  if [[ ! -s /etc/pqp/deploy-hmac.key ]]; then
    echo "refusing staged config: /etc/pqp/deploy-hmac.key is not provisioned" >&2
    exit 1
  fi
  # A bare `mktemp -d` honours $TMPDIR when set, and this process's
  # environment is not something to trust: sudoers' default env_reset
  # should already strip it before this script ever starts, but that is a
  # sudo CONFIGURATION fact this file cannot see or enforce, and the whole
  # point of the design above is to not depend on facts this file cannot
  # verify for itself. A caller-controlled TMPDIR pointed at a directory
  # pqp-deploy owns would let it repoint or replace VERIFIED's path after
  # creation, reopening exactly the race the copy-into-VERIFIED step
  # exists to close. So: fixed, hardcoded, root-only parent (/root is
  # 0700 by definition on any normal install) with an explicit mktemp
  # template under it, never the environment-dependent default location.
  mkdir -p /root/.pqp-deploy-verify
  chmod 0700 /root/.pqp-deploy-verify
  VERIFIED="$(mktemp -d /root/.pqp-deploy-verify/XXXXXX)"
  for f in compose.yaml Caddyfile pqp-deploy.sh manifest.sha256 manifest.sig; do
    p="$STAGING/$f"
    if [[ -e "$p" || -L "$p" ]]; then
      if [[ -L "$p" || ! -f "$p" ]]; then
        echo "refusing staged config: $f is not a regular file" >&2
        exit 1
      fi
      cp --no-preserve=mode,ownership,timestamps -- "$p" "$VERIFIED/$f"
    fi
  done
  if [[ ! -f "$VERIFIED/manifest.sha256" || ! -f "$VERIFIED/manifest.sig" ]]; then
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
' "$VERIFIED/manifest.sha256")"
  got="$(tr -d '[:space:]' <"$VERIFIED/manifest.sig")"
  if [[ -z "$expected" || "$expected" != "$got" ]]; then
    echo "refusing staged config: manifest signature does not verify" >&2
    exit 1
  fi
  if ! (cd "$VERIFIED" && sha256sum -c manifest.sha256 --quiet); then
    echo "refusing staged config: staged files do not match the signed manifest" >&2
    exit 1
  fi
  install -m 0644 -o pqp -g pqp "$VERIFIED/compose.yaml" "$DEST/compose.yaml"
  install -m 0644 -o pqp -g pqp "$VERIFIED/Caddyfile" "$DEST/Caddyfile"
  # Same permissions/ownership provision.sh uses for the initial install.
  # Explicit temp-file-then-rename rather than trusting `install`'s own
  # internals to do the equivalent: GNU coreutils' `install` DOES already
  # write to a fresh inode and rename it into place for a plain file copy
  # like this (verified directly against Ubuntu 24.04's coreutils 9.4, the
  # exact box/version this runs on, root-owned destination, matching
  # flags -- the currently-executing interpreter kept running its OLD,
  # unlinked-but-still-open inode to completion across the replacement
  # every time), but doing the rename ourselves removes any doubt for
  # whoever reads this next without re-deriving that from coreutils
  # internals. `mktemp` in the SAME directory as the destination is what
  # makes the final `mv` a same-filesystem rename (atomic, not a
  # cross-filesystem copy) -- mode and ownership are set on the temp file
  # BEFORE it is moved into place, so there is no window where the final
  # path exists with the wrong permissions. The shell currently executing
  # this script keeps reading whatever inode it already opened; only the
  # NEXT invocation of `pqp-deploy` sees the newly renamed-in file.
  if [[ -f "$VERIFIED/pqp-deploy.sh" ]]; then
    tmp_bin="$(mktemp /usr/local/bin/.pqp-deploy.XXXXXX)"
    cp --no-preserve=mode,ownership,timestamps -- "$VERIFIED/pqp-deploy.sh" "$tmp_bin"
    chmod 0755 "$tmp_bin"
    chown root:root "$tmp_bin"
    mv -f -- "$tmp_bin" /usr/local/bin/pqp-deploy
    tmp_bin=""
  fi
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
REPLICA_COUNT=${#API_SERVICES[@]}
# Printed for the workflow's own "Deploy over SSH" step, which greps this
# line out of our stdout and threads it through as a step output so the
# LATER "Verify the deployed commit" step -- a different SSH identity, no
# access to this box's .env -- knows whether api-b being unreachable right
# now is the expected API_REPLICAS=1 shape or a real failure. Emitted
# before any container is touched, on purpose: it states this run's
# TARGET topology, which is what a caller needs even if something below
# fails partway through.
echo "api-replicas=${REPLICA_COUNT}"

# DATABASE CONNECTION BUDGET: PG_POOL_MAX in .env is read here as the
# TOTAL budget for the API side (api-a + api-b combined), not a
# per-container value -- the same number that was previously handed
# straight to the single `api` container now gets split evenly across
# however many replicas are actually running, so turning on a second
# replica does not silently double the box's worst-case Postgres
# connection count the way just reusing .env's value unmodified in both
# containers would. Re-computed every deploy so flipping API_REPLICAS
# always re-derives the right split without a second variable to keep in
# sync. `server/src/db.ts`'s own hard-coded default (10) is the fallback
# if .env does not set PG_POOL_MAX at all, matching docs/DB_RUNBOOK.md §3.
# Check the resulting total against whatever max_connections the box's
# actual Postgres plan reports (Vultr's dashboard, not a number hard-coded
# here -- docs/plans/ALWAYS_ON.md's A3.5 hit the same "could not fetch
# this live" wall) before relying on two replicas in production; see
# docs/deploy-vultr.md "Two replicas on one box" -> "Database connection
# budget".
TOTAL_API_PG_POOL_MAX="$(grep -m1 '^PG_POOL_MAX=' "$DEST/.env" 2>/dev/null | cut -d'=' -f2- || true)"
# Compose accepts a quoted value (PG_POOL_MAX='45' or "45") and so must
# this arithmetic: the 2026-09-17 cutover env was written quoted and the
# deploy died on `(( '45' < 2 ))` before touching a container.
TOTAL_API_PG_POOL_MAX="${TOTAL_API_PG_POOL_MAX%[\"\']}"
TOTAL_API_PG_POOL_MAX="${TOTAL_API_PG_POOL_MAX#[\"\']}"
if [[ -n "$TOTAL_API_PG_POOL_MAX" && ! "$TOTAL_API_PG_POOL_MAX" =~ ^[0-9]+$ ]]; then
  echo "PG_POOL_MAX in .env is not a number: ${TOTAL_API_PG_POOL_MAX}" >&2
  exit 1
fi
TOTAL_API_PG_POOL_MAX="${TOTAL_API_PG_POOL_MAX:-10}"
# Fail closed rather than silently breaking the budget: flooring a
# too-small division up to 1-per-replica would make the AGGREGATE exceed
# TOTAL_API_PG_POOL_MAX (e.g. total=1, 2 replicas, floor-to-1 each = 2
# connections against a budget of 1) -- exactly the kind of silent
# violation this split exists to prevent. A total below the replica count
# means there is no way to split it without either giving some replica 0
# connections (broken) or exceeding the configured budget (the thing being
# guarded against); either way that is a real misconfiguration the
# operator needs to see and fix, not something to paper over.
if (( TOTAL_API_PG_POOL_MAX < REPLICA_COUNT )); then
  echo "PG_POOL_MAX=${TOTAL_API_PG_POOL_MAX} in .env cannot be split across ${REPLICA_COUNT} api replicas -- raise PG_POOL_MAX or set API_REPLICAS=1" >&2
  exit 1
fi
API_PG_POOL_MAX_PER_REPLICA=$(( TOTAL_API_PG_POOL_MAX / REPLICA_COUNT ))
export API_PG_POOL_MAX_PER_REPLICA
echo "PG_POOL_MAX budget: ${TOTAL_API_PG_POOL_MAX} total / ${REPLICA_COUNT} replica(s) = ${API_PG_POOL_MAX_PER_REPLICA} each"

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

# Also keep .env's own APP_IMAGE_TAG/APP_VERSION (see the export above --
# always the same value) equal to this now-verified release. The
# 2026-09-21 incident (PR #762, compose.yaml's header comment) pinned a
# fallback tag into .env by hand so a bare manual `docker compose up` with
# no tag in scope can no longer float to a stale local `:latest`, but this
# script never wrote that pin itself, so it drifted behind every
# pipeline-driven deploy and a later manual recreate could still resurrect
# whatever sha was last hand-written there. Attempted only here, after
# every replica and the worker have already passed
# wait_healthy/verify_version above -- a failed or rolled-back run exits
# before this line and never touches the fallback pin.
#
# $TAG is ALREADY this box's known-good release by this point
# (.deployed-tag is written above), so nothing in this block may fail the
# deploy: persist_fallback_pin warns on stderr and returns non-zero
# instead, which the call below deliberately ignores. A stale fallback
# only matters to a FUTURE bare manual recreate, not to what is running
# right now.
persist_fallback_pin() {
  if [[ ! -f "$DEST/.env" ]]; then
    echo "warning: $DEST/.env not found; skipping the APP_IMAGE_TAG/APP_VERSION fallback pin" >&2
    return 0
  fi
  env_tmp="$(mktemp "$DEST/.env.pin.XXXXXX")" || {
    echo "warning: could not create a temp file to persist the APP_IMAGE_TAG/APP_VERSION fallback pin; $TAG is already live, only the fallback used by a bare manual recreate is stale" >&2
    return 1
  }
  # Keep every line except the two we're about to replace. `grep -v` exits
  # 1 (no match, not an error) the first time this runs against a .env
  # that predates this script ever writing the pin -- e.g. right after PR
  # #762's by-hand write, before either key exists yet -- so only a status
  # above 1 is a genuine read failure. Swallowing that too (a bare
  # `|| true`) would let a half-read .env collapse the temp file down to
  # just the two appended lines below, and the rename that follows would
  # then replace the real .env -- DB credentials and everything else in it
  # -- with that.
  local grep_rc=0
  grep -v -E '^(APP_IMAGE_TAG|APP_VERSION)=' "$DEST/.env" >"$env_tmp" || grep_rc=$?
  if (( grep_rc > 1 )); then
    echo "warning: reading $DEST/.env failed (grep exit $grep_rc); leaving the fallback pin untouched -- $TAG is already live, only the fallback used by a bare manual recreate is stale" >&2
    rm -f "$env_tmp"
    env_tmp=""
    return 1
  fi
  {
    echo "APP_IMAGE_TAG=${TAG}"
    echo "APP_VERSION=${TAG}"
  } >>"$env_tmp"
  # `mktemp` in the SAME directory as .env is what makes the `mv` below a
  # same-filesystem rename(2) -- every reader sees either the complete old
  # file or the complete new one, never neither and never a partial one.
  # Deliberately NOT `install` the way compose.yaml/Caddyfile above use
  # it: GNU coreutils' `install` unlinks the destination and only THEN
  # opens a fresh file at that same name (cp_option_init's
  # unlink_dest_before_opening), so there is a window where $DEST/.env
  # does not exist at all, and a disk-full error or a killed process
  # mid-copy leaves a partial file sitting at the final path instead of
  # the untouched original -- exactly the corruption this pin exists to
  # avoid, on the one file here that holds secrets. Mode and ownership are
  # set on the temp file BEFORE the rename, so there is no window where
  # the final path exists with the wrong permissions.
  if chown pqp:pqp "$env_tmp" && chmod 0600 "$env_tmp" && mv -f -- "$env_tmp" "$DEST/.env"; then
    env_tmp=""
    return 0
  fi
  echo "warning: could not persist APP_IMAGE_TAG/APP_VERSION to $DEST/.env; $TAG is already live, only the fallback used by a bare manual recreate is stale" >&2
  rm -f "$env_tmp"
  env_tmp=""
  return 1
}
persist_fallback_pin || true

docker compose ps
