#!/usr/bin/env bash
# Regenerates .data/ramp.h264: a synthetic H.264 Annex-B elementary stream
# that starts at 640x360 and, partway through, jumps to 1280x720 -- a new
# SPS/PPS mid-stream, on purpose. This reproduces the SPS-change shape
# behind PR #656 ("Fix LL watch-party decode death when screen-share
# resolution ramps") and the parameter-set handling in PR #657/#658:
# Chrome's getDisplayMedia encoder does exactly this whenever a shared
# window or the capture surface itself resizes, and it is the case
# production packet loss made fatal (a lost NAL carrying the new SPS/PPS,
# or the first post-ramp IDR, leaves the decoder wanting parameters it
# never received).
#
# `-x264-params keyint=60:min-keyint=60:scenecut=0` forces an IDR every 2s
# at 30fps regardless of content, so the elastic 4s segment boundary
# (tools/pqp-remux's SEGMENT_MS) always has one to close on -- a stand-in
# for a real presenter's encoder, which does this far less predictably
# (docs/plans/LL_HLS.md section 3).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p .data

if [ -f .data/ramp.h264 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "gen-ramp: .data/ramp.h264 already exists, skipping (FORCE=1 to rebuild)"
  exit 0
fi

command -v ffmpeg >/dev/null || { echo "gen-ramp: ffmpeg not found on PATH" >&2; exit 1; }

X264_PARAMS="keyint=60:min-keyint=60:scenecut=0"

echo "gen-ramp: encoding 20s @ 640x360 (baseline L3.0)"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=30" -t 20 \
  -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.0 \
  -x264-params "$X264_PARAMS" -f h264 .data/ramp-360.h264

echo "gen-ramp: encoding 40s @ 1280x720 (baseline L3.1)"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30" -t 40 \
  -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 \
  -x264-params "$X264_PARAMS" -f h264 .data/ramp-720.h264

cat .data/ramp-360.h264 .data/ramp-720.h264 > .data/ramp.h264
rm -f .data/ramp-360.h264 .data/ramp-720.h264

bytes=$(wc -c < .data/ramp.h264 | tr -d ' ')
echo "gen-ramp: wrote .data/ramp.h264 (${bytes} bytes, ~60s, 360p -> 720p ramp at 20s)"
