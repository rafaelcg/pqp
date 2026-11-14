#!/usr/bin/env bash
# Captures one round of design council screenshots into a directory.
#
#   tools/design-council/capture.sh /tmp/pqp-council/r1
#   REDESIGN=1 tools/design-council/capture.sh /tmp/pqp-council/r1-after
#
# REDESIGN=1 photographs the same build with the redesign toggle on
# (client/src/lib/redesign.ts). Unset, the toggle is off: the "before".
#
# Rebuilds the scene from an empty database every time, so two rounds always
# photograph the same people, servers and lines. See docs/DESIGN_COUNCIL.md.
#
# COUNCIL_PG is a Postgres URL WITHOUT a database name. The script drops and
# recreates the database "pqp_council" there, and nothing else.
set -euo pipefail

OUT="${1:?usage: capture.sh <output-dir>}"
PG="${COUNCIL_PG:-postgresql://pqp:pqp@localhost:5432}"
DB="pqp_council"
SERVER_PORT="${COUNCIL_SERVER_PORT:-3141}"
CLIENT_PORT="${COUNCIL_CLIENT_PORT:-5341}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

for port in "$SERVER_PORT" "$CLIENT_PORT"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is busy. Playwright would reuse whatever is there." >&2
    echo "Stop it, or set COUNCIL_SERVER_PORT / COUNCIL_CLIENT_PORT." >&2
    exit 1
  fi
done

psql "$PG/postgres" -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"

# The server imports the built shared package.
pnpm --dir "$ROOT" --filter @pqp/shared build >/dev/null

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$ROOT/client"
DESIGN_COUNCIL_DIR="$OUT" \
DESIGN_COUNCIL_REDESIGN="${REDESIGN:-0}" \
E2E_DATABASE_URL="$PG/$DB" \
E2E_SERVER_PORT="$SERVER_PORT" \
E2E_CLIENT_PORT="$CLIENT_PORT" \
E2E_API_URL="http://localhost:$SERVER_PORT" \
  npx playwright test e2e/design-council-shots.spec.ts --project=chromium --reporter=list

ls "$OUT"
