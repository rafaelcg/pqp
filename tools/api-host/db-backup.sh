#!/usr/bin/env bash
# Nightly logical backup of production Postgres, run directly on the API box
# by root's crontab (installed to /opt/pqp/backup/run.sh by provision.sh,
# which also wires the cron line — see "nightly db backup" there).
#
# Replaces tools/db-backup/, the Fly-scheduled machine app `pqp-db-backup`,
# destroyed 2026-09-24: that app had been failing silently since the
# 09-14 DB password rotation because its secrets were only ever staged on
# the app and never actually applied, and nobody was watching `fly logs`
# for it. Running the dump on the box that already holds DATABASE_URL
# removes that whole class of "a second place holds a second, stale
# credential" failure — this script reads exactly the secrets already on
# the box, nothing new to rotate or forget.
#
# Reads DATABASE_URL and LIVE_HLS_S3_* out of /opt/pqp/.env — the same
# connection string the API containers use, and the same R2 bucket
# (pqp-live-enam) the watch party recording feature already writes to —
# and never prints either. No `set -x` in this file, ever: a value would
# land in /var/log/pqp-db-backup.log.
set -euo pipefail

ENV_FILE="${PQP_ENV_FILE:-/opt/pqp/.env}"
LOCAL_DIR="${PQP_BACKUP_LOCAL_DIR:-/var/backups/pqp}"
KEY_PREFIX="backups/pqp-db"
MIN_BYTES="${MIN_BYTES:-102400}"              # 100 KB; smaller means the wrong or an empty database
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-7}"
REMOTE_RETENTION_DAYS="${REMOTE_RETENTION_DAYS:-30}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"

# Pull just the names this script needs out of .env rather than sourcing the
# whole file, which also holds CLERK_SECRET_KEY and everything else the API
# containers read and has no business being in this script's environment.
# Last match wins, same as a shell sourcing the file top to bottom.
read_env_var() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1
}

DATABASE_URL="$(read_env_var DATABASE_URL)"
LIVE_HLS_S3_ENDPOINT="$(read_env_var LIVE_HLS_S3_ENDPOINT)"
LIVE_HLS_S3_BUCKET="$(read_env_var LIVE_HLS_S3_BUCKET)"
LIVE_HLS_S3_REGION="$(read_env_var LIVE_HLS_S3_REGION)"
LIVE_HLS_S3_ACCESS_KEY_ID="$(read_env_var LIVE_HLS_S3_ACCESS_KEY_ID)"
LIVE_HLS_S3_SECRET_ACCESS_KEY="$(read_env_var LIVE_HLS_S3_SECRET_ACCESS_KEY)"
LIVE_HLS_S3_REGION="${LIVE_HLS_S3_REGION:-auto}"

for name in DATABASE_URL LIVE_HLS_S3_ENDPOINT LIVE_HLS_S3_BUCKET \
            LIVE_HLS_S3_ACCESS_KEY_ID LIVE_HLS_S3_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || die "missing $name in $ENV_FILE"
done

# Cheap guard, not a security boundary: the secret is the boundary.
case "$DATABASE_URL" in
  *localhost*|*127.0.0.1*|*staging*|*pqp_test*)
    die "DATABASE_URL points at a local, test or staging database" ;;
esac

case "$DATABASE_URL" in
  *\?*) dump_url="${DATABASE_URL}&sslmode=require" ;;
  *) dump_url="${DATABASE_URL}?sslmode=require" ;;
esac

mkdir -p "$LOCAL_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="pqp-db-${stamp}.dump"
path="${LOCAL_DIR}/${file}"

log "dumping"
# --network host: the Vultr managed cluster's trusted_ips only admits this
# box's address, not the Docker bridge network's NAT address — see
# docs/DB_RUNBOOK.md "trusted_ips". -Fc is custom format, its own zlib
# compression built in, so there is no separate gzip step.
docker run --rm --network host \
  -e PGCONNECT_TIMEOUT=15 \
  -v "$LOCAL_DIR:/backup" \
  postgres:17-alpine \
  pg_dump --dbname="$dump_url" -Fc --no-owner --no-privileges \
  --file="/backup/${file}"

bytes="$(stat -c %s "$path")"
log "dump ${file} is ${bytes} bytes"
if [ "$bytes" -lt "$MIN_BYTES" ]; then
  rm -f "$path"
  die "dump is ${bytes} bytes, under the ${MIN_BYTES} byte floor. Wrong database, empty database or truncated dump. Nothing uploaded."
fi

log "uploading to r2:${LIVE_HLS_S3_BUCKET}/${KEY_PREFIX}/${file}"
export RCLONE_CONFIG_PQPBACKUP_TYPE=s3
export RCLONE_CONFIG_PQPBACKUP_PROVIDER=Cloudflare
export RCLONE_CONFIG_PQPBACKUP_ACCESS_KEY_ID="$LIVE_HLS_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_PQPBACKUP_SECRET_ACCESS_KEY="$LIVE_HLS_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_PQPBACKUP_ENDPOINT="$LIVE_HLS_S3_ENDPOINT"
export RCLONE_CONFIG_PQPBACKUP_REGION="$LIVE_HLS_S3_REGION"
rclone copyto "$path" "pqpbackup:${LIVE_HLS_S3_BUCKET}/${KEY_PREFIX}/${file}" --checksum
log "upload OK"

log "pruning local copies older than ${LOCAL_RETENTION_DAYS} days"
find "$LOCAL_DIR" -maxdepth 1 -name 'pqp-db-*.dump' -mtime "+${LOCAL_RETENTION_DAYS}" -print -delete |
  while IFS= read -r old; do log "pruned local ${old}"; done

log "pruning remote copies older than ${REMOTE_RETENTION_DAYS} days"
rclone delete "pqpbackup:${LIVE_HLS_S3_BUCKET}/${KEY_PREFIX}" --min-age "${REMOTE_RETENTION_DAYS}d"

log "OK"
