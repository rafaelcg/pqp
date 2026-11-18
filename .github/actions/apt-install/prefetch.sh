#!/usr/bin/env bash
# Downloads the .deb files an `apt-get install <packages>` would fetch, several
# at once, into apt's archive directory, so the install that follows finds them
# there. apt fetches one package at a time over one connection, and on a
# throttled mirror (59 to 106 kB/s per connection on 2026-11-18) 80 packages
# take longer than a job. apt still verifies every file against the index
# hashes before using it, so this only changes how the bytes arrive. Runs as
# root. Best effort: any failure here leaves the install to fetch the rest.
#
# usage: prefetch.sh <archive-dir> <package>...
set -uo pipefail

archive="$1"
shift
jobs="${PREFETCH_JOBS:-8}"

mkdir -p "$archive/partial"
list="$(mktemp)"
trap 'rm -f "$list"' EXIT

# One line per file: 'http://...deb' name.deb size hash
apt-get install -y --print-uris "$@" 2>/dev/null | grep "^'" > "$list" || exit 0

todo="$(mktemp)"
trap 'rm -f "$list" "$todo"' EXIT
while read -r url name _; do
  url="${url//\'/}"
  [ -s "$archive/$name" ] && continue
  echo "$url $name"
done < "$list" > "$todo"

count="$(wc -l < "$todo" | tr -d ' ')"
echo "prefetch: $count of $(wc -l < "$list" | tr -d ' ') packages to download, $jobs at a time"
[ "$count" -gt 0 ] || exit 0

export ARCHIVE="$archive"
xargs -P "$jobs" -L 1 sh -c '
  curl -fsSL --retry 3 --connect-timeout 10 --speed-limit 5000 --speed-time 20 \
    -C - -o "$ARCHIVE/partial/$1" "$0" \
    && mv "$ARCHIVE/partial/$1" "$ARCHIVE/$1" \
    || echo "prefetch: $1 not finished"
' < "$todo"
exit 0
