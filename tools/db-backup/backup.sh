#!/usr/bin/env bash
# pg_dump production -> gzip -> R2, then prune > RETENTION_DAYS. Exits non-zero
# on any failure so `fly machine status` / `fly logs -a pqp-db-backup` show red.
#
# Reads exactly one connection string, BACKUP_DATABASE_URL, and never prints it.
# Secret names are documented in docs/DB_RUNBOOK.md. No `set -x` in this file,
# ever: the URL would land in the logs.
set -euo pipefail

MIN_BYTES="${MIN_BYTES:-1048576}"        # 1 MB; smaller means the wrong or an empty database
RETENTION_DAYS="${RETENTION_DAYS:-30}"
KEY_PREFIX="${KEY_PREFIX:-pqp-db}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

# --- 1. Preconditions ---------------------------------------------------------
for name in BACKUP_DATABASE_URL R2_BACKUP_BUCKET R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || die "missing secret $name"
done
[ -n "${R2_ACCOUNT_ID:-}" ] || [ -n "${R2_BACKUP_ENDPOINT:-}" ] || die "set R2_ACCOUNT_ID or R2_BACKUP_ENDPOINT"

# Cheap guard, not a security boundary: the secret is the boundary.
case "$BACKUP_DATABASE_URL" in
  *localhost*|*127.0.0.1*|*staging*|*pqp_test*)
    die "BACKUP_DATABASE_URL points at a local, test or staging database" ;;
esac

endpoint="${R2_BACKUP_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true
# R2 does not implement the checksum trailers newer aws-cli versions send.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
aws() { command aws --endpoint-url "$endpoint" "$@"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

# --- 2. Dump ------------------------------------------------------------------
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
day="$(date -u +%Y-%m-%d)"
file="fly-db-${stamp}.dump.gz"
key="${KEY_PREFIX}/${day}/${file}"

log "dumping"
# --no-owner / --no-privileges: the restore target is always a different cluster
# with different role names (local docker, a fresh MPG).
PGCONNECT_TIMEOUT=15 pg_dump --dbname="$BACKUP_DATABASE_URL" \
  --format=custom --compress=0 --no-owner --no-privileges \
  --file=dump.custom
gzip -9 -c dump.custom > "$file"
rm -f dump.custom
bytes="$(stat -c %s "$file")"
log "dump ${file} is ${bytes} bytes"
if [ "$bytes" -lt "$MIN_BYTES" ]; then
  die "dump is ${bytes} bytes, under the ${MIN_BYTES} byte floor. Wrong database, empty database or truncated dump. Nothing uploaded."
fi

# --- 3. Upload and verify -----------------------------------------------------
log "uploading to s3://${R2_BACKUP_BUCKET}/${key}"
aws s3api put-object --bucket "$R2_BACKUP_BUCKET" --key "$key" --body "$file" \
  --content-type application/gzip >/dev/null
remote="$(aws s3api head-object --bucket "$R2_BACKUP_BUCKET" --key "$key" \
  --query ContentLength --output text)"
[ "$remote" = "$bytes" ] || die "uploaded object is ${remote} bytes, local file is ${bytes}"
log "upload verified (${bytes} bytes)"

# --- 4. Prune -----------------------------------------------------------------
cutoff="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
listing="$(aws s3api list-objects-v2 --bucket "$R2_BACKUP_BUCKET" --prefix "${KEY_PREFIX}/" --output json)"
newer="$(printf '%s' "$listing" | jq --arg c "$cutoff" '[.Contents[]? | select(.LastModified >= $c)] | length')"
if [ "$newer" -lt 1 ]; then
  # Never delete when nothing newer is listed: a clock or listing bug must not
  # empty the bucket.
  log "WARNING: no dump newer than ${cutoff} listed; skipping prune"
  exit 0
fi
count=0
while IFS= read -r old; do
  [ -n "$old" ] || continue
  aws s3api delete-object --bucket "$R2_BACKUP_BUCKET" --key "$old"
  log "pruned ${old}"
  count=$((count + 1))
done < <(printf '%s' "$listing" | jq -r --arg c "$cutoff" '.Contents[]? | select(.LastModified < $c) | .Key')
log "pruned ${count} object(s) older than ${RETENTION_DAYS} days"
log "OK"
