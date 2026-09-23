#!/usr/bin/env bash
# Regenerates .data/idle.h264: the source for SOURCE=idle runs (see
# README.md "Idle and bursty sources"). One resolution, a keyframe every 30
# frames, and ONE reference frame, because that is what a stream must look
# like for tools/pqp-remux's internal/skipframe to accept it: production
# runs CLOCK_CUT_PARTS=true, and a harness source the synthesizer refuses
# would test a code path production never takes (repo pitfall 12). x264's
# baseline profile gives CAVLC and, with no B-frames, pic_order_cnt_type 2;
# ref=1 is the one that has to be asked for.
#
# The frame RATE in this file does not matter: rampub's PACE mode sends
# its frames on a wall-clock schedule and stamps them to match.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p .data

if [ -f .data/idle.h264 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "gen-idle: .data/idle.h264 already exists, skipping (FORCE=1 to rebuild)"
  exit 0
fi

command -v ffmpeg >/dev/null || { echo "gen-idle: ffmpeg not found on PATH" >&2; exit 1; }

echo "gen-idle: encoding 60s @ 1280x720 (baseline L3.1, ref=1, keyint=30)"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30" -t 60 \
  -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 \
  -x264-params "keyint=30:min-keyint=30:scenecut=0:ref=1" -f h264 .data/idle.h264

bytes=$(wc -c < .data/idle.h264 | tr -d ' ')
echo "gen-idle: wrote .data/idle.h264 (${bytes} bytes)"
