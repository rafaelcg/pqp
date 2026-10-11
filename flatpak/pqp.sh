#!/bin/sh
# Flatpak launcher for pqp.
#
# zypak-wrapper (from org.electronjs.Electron2.BaseApp) stands in for
# Chromium's setuid sandbox, which cannot run inside Flatpak.
#
# TMPDIR: Flatpak gives every `flatpak run` its own /tmp, and Electron's
# single-instance lock lives there. Without a shared TMPDIR a pqp:// link
# opened while pqp is running starts a second copy instead of reaching the
# first one.
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"

# Flathub ships the updates; the in-app updater must never run.
export PQP_DISABLE_AUTO_UPDATE=1

exec zypak-wrapper /app/pqp/pqp "$@"
