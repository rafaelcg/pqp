#!/usr/bin/env bash
# Prints the deployment URL from a `wrangler pages deploy` log, or fails.
#
#   client/scripts/deploy-url.sh <log>
#
# Never falls back to pqp.gg: the alias may still be the previous deploy, and a
# check against it would test the wrong build.
set -euo pipefail
url="$(grep -oE 'https://[a-z0-9-]+\.pqp-3yr\.pages\.dev' "$1" | head -1 || true)"
if [ -z "$url" ]; then
  echo "::error::No deployment URL in $1, so the precache could not be checked" >&2
  exit 1
fi
echo "$url"
