#!/usr/bin/env bash
# Build flatpak/gg.pqp.pqp.yml and export it as a single-file bundle.
#
#   flatpak/build-bundle.sh <out.flatpak>
#
# Needs Linux with `flatpak` and `flatpak-builder`. Builds whatever release the
# manifest is pinned to (`node flatpak/bump.mjs --pinned`), so point it at the
# right release with bump.mjs first. `.github/workflows/flatpak-manifest.yml`
# runs this on every published desktop release and attaches the result.
#
# The bundle names Flathub as its runtime repo, so
# `flatpak install pqp-<version>-x86_64.flatpak` on a machine without Flathub
# offers to add it and pulls org.freedesktop.Platform from there.
#
# Then, unless SKIP_SMOKE=1, it installs the bundle into a throwaway Flatpak
# installation that has no remotes at all, which is the stranger's machine:
# the install only works if the runtime repo in the bundle does its job.
set -euo pipefail

FLATHUB_REPO=https://dl.flathub.org/repo/flathub.flatpakrepo
APP_ID=gg.pqp.pqp
BRANCH=stable

if [ $# -ne 1 ]; then
  echo "usage: $0 <out.flatpak>" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
out=$(realpath -m "$1")
work=${FLATPAK_WORK_DIR:-${TMPDIR:-/tmp}/pqp-flatpak}
mkdir -p "$work" "$(dirname "$out")"

flatpak remote-add --user --if-not-exists flathub "$FLATHUB_REPO"

# --disable-rofiles-fuse: CI runners and containers often have no usable FUSE,
# and the build does not need the hardlink protection it gives.
flatpak-builder --user --install-deps-from=flathub --force-clean \
  --disable-rofiles-fuse --default-branch="$BRANCH" \
  --state-dir="$work/state" --repo="$work/repo" \
  "$work/build" "$here/$APP_ID.yml"

flatpak build-bundle --runtime-repo="$FLATHUB_REPO" \
  "$work/repo" "$out" "$APP_ID" "$BRANCH"
echo "bundle: $out ($(du -h "$out" | cut -f1))"

if [ "${SKIP_SMOKE:-0}" = 1 ]; then
  exit 0
fi

# A fresh per-user installation: no flathub remote, no runtime.
fresh="$work/fresh-install"
rm -rf "$fresh"
trap 'rm -rf "$fresh"' EXIT
export FLATPAK_USER_DIR="$fresh"
flatpak install --user --noninteractive -y --bundle "$out"
flatpak info --user "$APP_ID"
# What the manifest promises the .deb turned into.
flatpak run --user --command=sh "$APP_ID" -c '
  set -e
  test -x /app/bin/pqp
  test -x /app/pqp/pqp
  test ! -e /app/pqp/chrome-sandbox
  test ! -e /app/pqp/resources/app-update.yml
  test -f /app/share/metainfo/gg.pqp.pqp.metainfo.xml
  test -f /app/share/licenses/gg.pqp.pqp/LICENSE
  echo "smoke: bundle installs from scratch and has the expected layout"
'
