#!/usr/bin/env bash
# Run the share smoke test against one packaged app on a CI runner.
#
#   electron/test/share-smoke/run-ci.sh <app>
#
# <app> is the macOS .app bundle, the Windows pqp.exe, or the Linux pqp
# executable. The page must already be built (client/e2e/desktop-share/build.mjs).
# Results land in electron/test-results/share-smoke/ (report files, the app's
# own log) and a table goes to the job summary.
#
# What each runner can and cannot do is decided HERE, out loud, rather than
# discovered by a flaky test:
#
# - Linux has no display: xvfb-run gives it one, an X11 screen the shell's
#   picker lists as "screen:...". Ubuntu 24.04 also refuses unprivileged user
#   namespaces to binaries with no AppArmor profile, which is how an AppImage's
#   Chromium sandbox starts; this lifts that for the runner rather than
#   starting the app with --no-sandbox, so the binary runs as shipped.
# - macOS gates capture behind Screen Recording, which a fresh runner has not
#   granted to this bundle. The grant is written into the TCC database (the
#   runners allow that); whether it took is then read off the picker itself,
#   and a run without it checks everything short of frames
#   (PQP_SHARE_SMOKE_MAC_WITHOUT_GRANT=accept, see share.smoke.mjs).
# - Windows needs nothing: hosted runners have a desktop session to capture.
set -euo pipefail

app="${1:?usage: run-ci.sh <app>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
electron_dir="$(cd "$here/../.." && pwd)"
out="$electron_dir/test-results/share-smoke"
rm -rf "$out"
mkdir -p "$out"

export PQP_SHARE_SMOKE_APP="$app"
export PQP_SHARE_SMOKE_REQUIRE_PACKAGED=1
export PQP_SHARE_SMOKE_REQUIRE_PICKER=1
export PQP_SHARE_SMOKE_OUT="$out"
export CI="${CI:-true}"

runner=(pnpm exec playwright test --config=playwright.share-smoke.config.mjs)

case "$(uname -s)" in
  Linux)
    if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
      sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null
    fi
    # Two monitors on one X screen (RandR 1.5 `--setmonitor`), so the shell
    # lists two screens and opens its picker. With one screen and no window
    # manager (so no windows either) it auto-picks the only source, and the
    # picker, the path every desktop user takes, would never run here.
    cat > "$out/xvfb-session.sh" <<'SESSION'
#!/usr/bin/env bash
set -e
if command -v xrandr >/dev/null; then
  xrandr --setmonitor pqp-left 640/169x800/211+0+0 none
  xrandr --setmonitor pqp-right 640/169x800/211+640+0 none
  xrandr --listmonitors
else
  echo "::warning::xrandr is not installed: one monitor, so no picker on this runner"
fi
exec "$@"
SESSION
    chmod +x "$out/xvfb-session.sh"
    runner=(xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" "$out/xvfb-session.sh" "${runner[@]}")
    ;;
  Darwin)
    plist="$app/Contents/Info.plist"
    bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
    now="$(date +%s)"
    for db in "/Library/Application Support/com.apple.TCC/TCC.db" "$HOME/Library/Application Support/com.apple.TCC/TCC.db"; do
      if sudo sqlite3 "$db" "INSERT OR REPLACE INTO access VALUES('kTCCServiceScreenCapture','$bundle_id',0,2,4,1,NULL,NULL,0,'UNUSED',NULL,0,$now,NULL,NULL,'UNUSED',0);" 2>"$out/tcc-error.txt"; then
        echo "Screen Recording written for $bundle_id in $db"
      else
        echo "::warning::could not write Screen Recording for $bundle_id in $db: $(cat "$out/tcc-error.txt")"
      fi
    done
    export PQP_SHARE_SMOKE_MAC_WITHOUT_GRANT=accept
    ;;
esac

status=0
(cd "$electron_dir" && "${runner[@]}") || status=$?
node "$here/summary.mjs" "$out" || true
exit "$status"
