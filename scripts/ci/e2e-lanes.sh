#!/usr/bin/env bash
# Runs several Playwright shards side by side on ONE runner, each in a lane of
# its own: its own API port, its own client bundle, its own database.
#
#   scripts/ci/e2e-lanes.sh "<playwright project flags>" <total shards> <shard>...
#   scripts/ci/e2e-lanes.sh "--project=chromium --project=mobile-pixel" 6 1 2
#
# E2E_ALONGSIDE, if set, is one more command (run from client/) started as an
# extra lane next to the shards, for a suite that needs no API and no database
# of its own (the stale-bundle one). It must use its own --output directory:
# Playwright empties the output directory when a run starts.
#
# Why lanes rather than more jobs: the suite runs one Playwright worker per
# database (shared server state, computed-colour assertions), and a hosted
# runner sat mostly idle under one worker. Every extra job also pays ~1.5 min
# of setup (service container, checkout, install, browser deps, client build)
# and holds one of the account's 20 concurrent job slots, which is what PRs
# were queueing behind. Two lanes per runner use the idle CPU instead.
#
# A lane is exactly what `client/playwright.config.ts` already documents as an
# isolated run (a second checkout on one machine): E2E_SERVER_PORT,
# E2E_CLIENT_PORT and E2E_DATABASE_URL all moved together, plus
# E2E_API_URL for the specs' own fetches. The translation stub port follows the
# server port by itself. The client bundle bakes its API URL in, so each lane
# builds its own (`vite build`, ~15 s, in parallel).
#
# Needs: Postgres on localhost:5432 as pqp/pqp (the job's service container),
# `psql` (on the hosted image), Playwright's Chromium installed.
set -uo pipefail

projects="$1"
total="$2"
shift 2
shards=("$@")

cd "$(dirname "$0")/../../client"

admin_url="postgres://pqp:pqp@localhost:5432/pqp"


# 1. One database and one bundle per lane, all built at once.
pids=()
lane=0
for shard in "${shards[@]}"; do
  lane=$((lane + 1))
  port=$((3101 + (lane - 1) * 100))
  db="pqp_lane${lane}"
  psql "$admin_url" -q -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" -c "CREATE DATABASE ${db}" || exit 1
  (
    VITE_DEV_AUTH_BYPASS=true \
    VITE_API_URL="http://localhost:${port}" \
    VITE_WS_URL="ws://localhost:${port}/ws" \
    VITE_PQP_BUILD_ID=dev \
      pnpm exec vite build --outDir "dist-lane${lane}" --logLevel warn
  ) &
  pids+=($!)
done
for pid in "${pids[@]}"; do
  wait "$pid" || { echo "client build failed"; exit 1; }
done

# 2. The lanes. Output is prefixed per lane so an interleaved log stays legible.
pids=()
lane=0
for shard in "${shards[@]}"; do
  lane=$((lane + 1))
  offset=$(( (lane - 1) * 100 ))
  server_port=$((3101 + offset))
  (
    export E2E_SERVER_PORT="$server_port"
    export E2E_CLIENT_PORT=$((5273 + offset))
    export E2E_API_URL="http://localhost:${server_port}"
    export E2E_DATABASE_URL="postgres://pqp:pqp@localhost:5432/pqp_lane${lane}"
    export E2E_CLIENT_DIST="dist-lane${lane}"
    export E2E_RESULTS_FILE="e2e-results-lane${lane}.json"
    # shellcheck disable=SC2086 # $projects is a list of flags on purpose.
    pnpm exec playwright test $projects --shard="${shard}/${total}" \
      --output="test-results/lane${lane}" 2>&1 | sed -u "s/^/[lane ${lane} ${shard}\/${total}] /"
    exit "${PIPESTATUS[0]}"
  ) &
  pids+=($!)
done

alongside_pid=""
if [ -n "${E2E_ALONGSIDE:-}" ]; then
  (
    # shellcheck disable=SC2086 # a command line on purpose.
    ${E2E_ALONGSIDE} 2>&1 | sed -u "s/^/[alongside] /"
    exit "${PIPESTATUS[0]}"
  ) &
  alongside_pid=$!
fi

status=0
lane=0
for pid in "${pids[@]}"; do
  lane=$((lane + 1))
  if ! wait "$pid"; then
    echo "::error::e2e lane ${lane} (shard ${shards[$((lane - 1))]}/${total}) failed"
    status=1
  fi
done
if [ -n "$alongside_pid" ] && ! wait "$alongside_pid"; then
  echo "::error::e2e alongside (${E2E_ALONGSIDE}) failed"
  status=1
fi
exit "$status"
