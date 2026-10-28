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
# Every runner must open the shell's own picker and capture real frames
# (PQP_SHARE_SMOKE_REQUIRE_PICKER). What each needs for that is set up HERE,
# out loud, rather than discovered by a flaky test:
#
# - Linux has no display: xvfb-run gives it one. One X screen and no window
#   manager is ONE source (Chromium lists only windows a manager has mapped),
#   which the shell auto-picks without its picker. So a window manager runs
#   too, the smallest there is (Ubuntu's `twm` and the X fonts it draws
#   with, installed here when the image lacks them), and the app's own window
#   becomes the second source. Splitting
#   the screen with `xrandr --setmonitor` was tried first: Xvfb ignores it.
#   Ubuntu 24.04 also refuses unprivileged user namespaces to binaries with no
#   AppArmor profile, which is how an AppImage's Chromium sandbox starts; that
#   is lifted for the runner rather than starting the app with --no-sandbox, so
#   the binary runs as shipped.
# - macOS gates capture behind Screen Recording, which a fresh runner has not
#   granted to this bundle. The grant is written into the TCC database (hosted
#   runners allow it; measured 2026-10-28: the picker then lists the display
#   with previews and frames arrive). If it ever stops taking, the test fails
#   rather than passing on less.
# - Windows needs nothing: hosted runners have a desktop session to capture
#   and an audio endpoint for loopback.
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
    if ! command -v twm >/dev/null || ! [ -d /usr/share/fonts/X11/misc ]; then
      sudo apt-get install -y --no-install-recommends twm xfonts-base >/dev/null 2>&1 || {
        sudo apt-get update -qq >/dev/null && sudo apt-get install -y --no-install-recommends twm xfonts-base >/dev/null
      }
    fi
    command -v twm >/dev/null || { echo "::error::twm is not installed, so the shell will auto-pick and never open its picker"; exit 1; }
    # twm's default asks a person to click where each new window goes and
    # leaves it unmapped until then; these place it where it asked to be.
    printf 'RandomPlacement\nUsePPosition "on"\nNoTitle\n' > "$out/twmrc"
    cat > "$out/xvfb-session.sh" <<SESSION
#!/usr/bin/env bash
set -e
twm -f "$out/twmrc" >"$out/twm.log" 2>&1 &
sleep 1
pgrep -a twm || { echo "::error::twm did not start: \$(cat "$out/twm.log")"; exit 1; }
exec "\$@"
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
    ;;
esac

status=0
(cd "$electron_dir" && "${runner[@]}") || status=$?
node "$here/summary.mjs" "$out" || true
exit "$status"
