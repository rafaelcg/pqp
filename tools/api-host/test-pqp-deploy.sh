#!/usr/bin/env bash
# Offline checks for the Caddyfile logic in pqp-deploy.sh. No Docker, no root,
# no box: `docker` is a stub and the functions under test are cut out of the
# real script (so this cannot drift from what ships), then run against a temp
# directory.
#
#   bash tools/api-host/test-pqp-deploy.sh
#
# Covers: the post-reload integrity check (in sync / recreate fixes it /
# recreate does not fix it / the container does not answer), the layout
# seeding from the old /opt/pqp/{Caddyfile,certs}, and the marker the deploy
# workflow greps for. The real bind-mount behaviour (rename seen by a
# directory mount, not by a file mount) needs a Docker daemon and is shown in
# the PR that introduced this file; it is not something a stub can prove.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/pqp-deploy.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fails=0

ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }
check() { # check <description> <command...>
  local d="$1"
  shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}

# The functions, exactly as shipped.
sed -n '/^# >>> caddy-integrity/,/^# <<< caddy-integrity/p' "$SCRIPT" >"$WORK/integrity.sh"
sed -n '/^ensure_caddy_layout() {/,/^}/p' "$SCRIPT" >"$WORK/layout.sh"
[[ -s "$WORK/integrity.sh" && -s "$WORK/layout.sh" ]] || {
  echo "could not extract the functions from $SCRIPT"
  exit 1
}

check "the installed-script marker the workflow greps for is present" \
  grep -q 'pqp-deploy-capability: caddy-dir-v1' "$SCRIPT"
check "the workflow greps for that same marker" \
  grep -q 'pqp-deploy-capability: caddy-dir-v1' "$HERE/../../.github/workflows/deploy-api-vultr.yml"
check "compose.yaml mounts the caddy DIRECTORY" \
  grep -qE '^\s+- \./caddy:/etc/caddy:ro' "$HERE/compose.yaml"
check "compose.yaml has no single-file Caddyfile mount" \
  bash -c "! grep -qE '^\s+- \./Caddyfile:' '$HERE/compose.yaml'"

# --- integrity check ---------------------------------------------------------
# Stub state: CONTAINER_FILE is what the stubbed container reads; RECREATE_MODE
# says what `up --force-recreate caddy` does to it.
run_integrity() { # run_integrity <recreate-mode: fixes|noop|dead>
  (
    export CADDY_DIR="$WORK/caddy"
    export CADDY_SYNC_TRIES=3 CADDY_SYNC_SLEEP=0 CADDY_PROBE_TRIES=3
    export RECREATE_MODE="$1"
    export CALLS="$WORK/calls"
    : >"$CALLS"
    docker() {
      echo "docker $*" >>"$CALLS"
      if [[ "$1 $2" == "compose exec" ]]; then
        # compose exec -T caddy sha256sum /etc/caddy/Caddyfile
        # TRANSIENT_FAILS=N: the first N exec calls fail (a Docker blip).
        if [[ -f "$WORK/transient" ]]; then
          local left
          left="$(<"$WORK/transient")"
          if ((left > 0)); then
            echo $((left - 1)) >"$WORK/transient"
            return 1
          fi
        fi
        [[ -f "$WORK/container" ]] || return 1
        echo "$(sha256sum <"$WORK/container" | awk '{print $1}')  /etc/caddy/Caddyfile"
        return 0
      fi
      if [[ "$*" == "compose up -d --no-deps --force-recreate caddy" ]]; then
        case "$RECREATE_MODE" in
          fixes) cp "$CADDY_DIR/Caddyfile" "$WORK/container" ;;
          dead) rm -f "$WORK/container" ;;
          noop) : ;;
        esac
        return 0
      fi
      echo "unexpected docker call: $*" >&2
      return 99
    }
    # shellcheck disable=SC1091
    source "$WORK/integrity.sh"
    verify_caddyfile_in_sync
  ) >"$WORK/out" 2>"$WORK/err"
}

mkdir -p "$WORK/caddy"
echo 'api.pqp.gg { respond "new" }' >"$WORK/caddy/Caddyfile"

# 1. in sync: passes, and does NOT recreate (the graceful reload path stays untouched)
cp "$WORK/caddy/Caddyfile" "$WORK/container"
run_integrity fixes
rc=$?
check "in sync: returns 0" test "$rc" -eq 0
check "in sync: never recreates caddy" bash -c "! grep -q 'force-recreate' '$WORK/calls'"
check "in sync: says so" grep -q 'caddyfile-sync=ok' "$WORK/out"

# 2. stale container (the 2026-10 shape): recreates ONLY caddy, then passes
echo 'api.pqp.gg { respond "old" }' >"$WORK/container"
run_integrity fixes
rc=$?
check "stale: returns 0 after the recreate" test "$rc" -eq 0
check "stale: recreates exactly once, caddy only, --no-deps" \
  test "$(grep -c 'compose up -d --no-deps --force-recreate caddy$' "$WORK/calls")" -eq 1
check "stale: touches no other service" bash -c "! grep -E 'api-a|api-b|worker' '$WORK/calls'"
check "stale: warns on stderr first" grep -q 'differs from' "$WORK/err"
check "stale: reports the recreate" grep -q 'caddyfile-sync=recreated' "$WORK/out"

# 3. recreate does not help: fails loudly
echo 'api.pqp.gg { respond "old" }' >"$WORK/container"
run_integrity noop
rc=$?
check "still stale after a recreate: returns non-zero" test "$rc" -ne 0
check "still stale: says the config on disk is not what is live" grep -q 'NOT what is live' "$WORK/err"

# 4. the checksum read never works (sha256sum missing, exec broken): the deploy
# fails loudly, but nothing was shown to be stale, so caddy is NOT recreated
rm -f "$WORK/container"
run_integrity dead
rc=$?
check "unreadable container checksum: returns non-zero, does not pass silently" test "$rc" -ne 0
check "unreadable container checksum: does not recreate caddy" bash -c "! grep -q 'force-recreate' '$WORK/calls'"
check "unreadable container checksum: says why" grep -q 'is unknown' "$WORK/err"

# 5. host file missing must never read as "in sync" with an empty container sum,
# and a recreate would not fix it, so none is attempted
mv "$WORK/caddy/Caddyfile" "$WORK/caddy/Caddyfile.gone"
rm -f "$WORK/container"
run_integrity dead
rc=$?
check "no host file: not treated as in sync" test "$rc" -ne 0
check "no host file: does not recreate caddy" bash -c "! grep -q 'force-recreate' '$WORK/calls'"
mv "$WORK/caddy/Caddyfile.gone" "$WORK/caddy/Caddyfile"

# 5b. garbage on stdout is not a checksum: it must not read as a mismatch
cp "$WORK/caddy/Caddyfile" "$WORK/container"
run_integrity_garbage() {
  (
    export CADDY_DIR="$WORK/caddy" CADDY_SYNC_TRIES=3 CADDY_SYNC_SLEEP=0 CADDY_PROBE_TRIES=2
    CALLS="$WORK/calls"
    : >"$CALLS"
    docker() {
      echo "docker $*" >>"$CALLS"
      echo "Error response from daemon: container is restarting"
      return 0
    }
    # shellcheck disable=SC1091
    source "$WORK/integrity.sh"
    verify_caddyfile_in_sync
  ) >"$WORK/out" 2>"$WORK/err"
}
run_integrity_garbage
rc=$?
check "non-hash output from exec: fails, does not read as a mismatch" test "$rc" -ne 0
check "non-hash output from exec: does not recreate caddy" bash -c "! grep -q 'force-recreate' '$WORK/calls'"

# 6. a transient exec failure on a container that IS in sync must not recreate
# caddy (that would cut every open socket over a Docker blip)
cp "$WORK/caddy/Caddyfile" "$WORK/container"
echo 2 >"$WORK/transient"
run_integrity fixes
rc=$?
check "transient exec failures, file in sync: returns 0" test "$rc" -eq 0
check "transient exec failures: never recreates caddy" bash -c "! grep -q 'force-recreate' '$WORK/calls'"
check "transient exec failures: reports ok, not recreated" grep -q 'caddyfile-sync=ok' "$WORK/out"
rm -f "$WORK/transient"

# --- layout seeding ----------------------------------------------------------
run_layout() {
  (
    export DEST="$WORK/opt" CADDY_DIR="$WORK/opt/caddy"
    # The real call passes -o pqp -g pqp, which needs root and that user.
    install() {
      local a=()
      while (($#)); do
        case "$1" in -o | -g) shift 2 ;; *)
          a+=("$1")
          shift
          ;;
        esac
      done
      command install "${a[@]}"
    }
    # shellcheck disable=SC1091
    source "$WORK/layout.sh"
    ensure_caddy_layout
  ) >"$WORK/out" 2>&1
}

# Old layout only: seeded from the old Caddyfile and certs, old ones left alone.
rm -rf "$WORK/opt"
mkdir -p "$WORK/opt/certs"
echo legacy-caddyfile >"$WORK/opt/Caddyfile"
echo cert >"$WORK/opt/certs/origin.pem"
run_layout
check "old layout: Caddyfile seeded into caddy/" grep -q legacy-caddyfile "$WORK/opt/caddy/Caddyfile"
check "old layout: certs copied into caddy/certs" test -f "$WORK/opt/caddy/certs/origin.pem"
check "old layout: old certs left in place" test -f "$WORK/opt/certs/origin.pem"

# Already migrated: nothing under caddy/ is overwritten.
echo already-new >"$WORK/opt/caddy/Caddyfile"
echo newcert >"$WORK/opt/caddy/certs/origin.pem"
run_layout
check "migrated: existing caddy/Caddyfile not overwritten" grep -q already-new "$WORK/opt/caddy/Caddyfile"
check "migrated: existing caddy/certs not overwritten" grep -q newcert "$WORK/opt/caddy/certs/origin.pem"

# A certs copy that died halfway leaves only the temp directory; the next run
# must redo it rather than take a half-filled certs/ for a finished migration.
rm -rf "$WORK/opt"
mkdir -p "$WORK/opt/certs" "$WORK/opt/caddy/.certs.migrating"
echo cert >"$WORK/opt/certs/origin.pem"
echo cert >"$WORK/opt/certs/origin.key"
echo partial >"$WORK/opt/caddy/.certs.migrating/origin.pem"
run_layout
check "interrupted copy: certs/ is complete after the retry" test -f "$WORK/opt/caddy/certs/origin.key"
check "interrupted copy: no temp directory left behind" test ! -e "$WORK/opt/caddy/.certs.migrating"

# Fresh box, nothing at all: directory and an empty certs/ exist (Mode B).
rm -rf "$WORK/opt"
mkdir -p "$WORK/opt"
run_layout
check "fresh box: caddy/ and caddy/certs/ exist" test -d "$WORK/opt/caddy/certs"

echo
if ((fails)); then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
