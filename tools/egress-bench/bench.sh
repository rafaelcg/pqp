#!/usr/bin/env bash
# Encoder benchmark rig for the pqp watch-party egress box.
#
# Answers one question in about ten minutes: at the box's current CPU cap,
# does each ladder profile in server/src/voice/hls-ladder.ts sustain enough
# encode headroom to be safe, or is it time for the B3.1 upgrade
# (docs/plans/BROADCAST_PIPELINE.md section 5)? Read README.md in this
# directory before running this on the real egress box.
#
# WHICH PIPELINE THIS RUNS, AND WHY.
# The real thing is `livekit/egress:v1.14.1`'s GStreamer pipeline: decode ->
# videorate -> scale -> x264enc(veryfast) -> AAC -> segments
# (docs/WATCH_PARTY_HLS_PERFORMANCE.md:65-66). That pipeline only starts
# against a live LiveKit room with a real publisher; there is no file-input
# mode for TrackCompositeEgress. Standing up a throwaway LiveKit server plus
# a synthetic publisher just to benchmark an encoder is a lot of extra moving
# parts for a ten-minute rig, and this task explicitly keeps us off anything
# resembling the production boxes. Instead this script runs host `ffmpeg`
# with `-c:v libx264`, configured to match the egress's own encoding
# options as closely as the code exposes them:
#
#   preset       veryfast   (docs/WATCH_PARTY_HLS_PERFORMANCE.md:66)
#   profile      Main       (server/src/voice/hls-ladder.ts rungEncodingOptions:
#                            VideoCodec.H264_MAIN; hls-egress.ts's H264_MAIN_L*
#                            CODECS strings are all profile 4d = Main)
#   keyint       2 s of frames, fixed GOP, no scene-cut insertion
#                            (rungEncodingOptions: keyFrameInterval: 2)
#   segment      4 s          (LIVE_HLS_SEGMENT_SECONDS in production; the
#                              code default is 2 s -- see hls-egress.ts
#                              hlsSegmentSeconds(). --segment-seconds
#                              overrides.)
#   bitrate      per rung, from server/src/voice/hls-ladder.ts LADDER_RUNGS
#                and CAMERA_RUNG, read directly below.
#
# GStreamer's x264enc and ffmpeg's libx264 output both wrap the same libx264
# library, so matching preset/profile/bitrate/keyint reproduces the CPU cost
# with high fidelity even though the surrounding pipeline (GStreamer vs.
# ffmpeg) differs. What this rig cannot measure: LiveKit's own RTP
# jitter-buffer and decode overhead ahead of the encoder, and the playlist
# upload path costed in hls-egress.ts's hlsSegmentSeconds() comment. Both are
# small next to the encoder itself per docs/CAPACITY.md's own measurement
# ("LiveKit's own container sat at 1.4 to 2.2% throughout, so the egress is
# essentially the whole cost").
#
# SOURCE CONTENT.
# testsrc2 plus moving text is mostly flat colour and barely taxes the
# encoder. This script instead composites two infinite generators
# (`life`, a cellular automaton, and `mandelbrot`, a zooming fractal) with
# temporal noise, so every pixel of every frame changes and very little of
# the frame compresses away -- the same "close to worst case" shape
# docs/CAPACITY.md already uses and names as an upper bound, not a real
# screen-share average. A real, downloaded game capture would sit somewhere
# below this and above flat testsrc2; use --source-file to substitute one
# (any file ffmpeg can read) if you have one on hand.
#
# CPU CAPPING.
# The box in question already runs the egress under Docker, and this task
# asks for `docker --cpus 3.5` by name, so `--limiter docker` (the default
# when a docker daemon is reachable) runs the whole profile -- every
# concurrent leg -- inside ONE container with `--cpus <n>`, matching how
# `tools/sfu/hls/docker-compose.yaml`'s single `egress:` service caps ALL of
# that box's concurrent rungs together (today `cpus: 2.5` on staging; the
# production dedicated box's compose is not in this repo -- see
# docs/plans/BROADCAST_PIPELINE.md's B0.1 finding -- so 3.5 here is this
# rig's own default guess for a 4 vCPU box with headroom left for the OS,
# not a value read from a committed file. Pass --cpus to match whatever the
# box's real compose file says.) `--limiter taskset` pins to the first
# ceil(cpus) whole cores instead (a coarser approximation, no Docker
# required). `--limiter none` applies no cap at all, which is what this
# script falls back to automatically outside Linux (i.e. on a Mac): numbers
# from an uncapped run are a smoke test only, never a box result.
#
# MEASUREMENT.
# Wall-clock realtime factor = source seconds / encode wall seconds, the
# minimum across a profile's concurrent legs (the bottleneck leg is what
# decides whether the whole profile keeps up). CPU% is sampled once a
# second, `docker stats --no-stream` under the docker limiter (the same tool
# docs/CAPACITY.md's own measurement used) or summed /proc/<pid>/stat deltas
# otherwise, reported as mean and p95. Steal% is read from the host's
# aggregate /proc/stat line (Linux only; not applicable elsewhere).
#
# PASS/FAIL.
# A profile PASSes when its slowest leg sustains >= 1.15x realtime under an
# actually-applied CPU cap -- the margin this rig treats as "leaves
# headroom," in the spirit of B3.1's own "headroom" language, not a number
# quoted from the plan. A run with no CPU cap applied is always reported
# INDETERMINATE, never PASS or FAIL, because it did not test the box's
# actual ceiling.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- defaults

CPUS="3.5"
DURATION=60
SEGMENT_SECONDS=4
PROFILE="all"
LIMITER="auto"
OUT_DIR=""
SOURCE_FILE=""
DOCKER_IMAGE="jrottenberg/ffmpeg:6.1-ubuntu2204"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: bench.sh [options]

  --profile NAME       720p30 | 1080p30 | 1080p60 | compound | all (default: all)
                        "compound" is 720p30 + camera rung 360p30 + a
                        voice-only leg, run concurrently (a watch party
                        whose presenter also has their camera up).
  --cpus N              CPU cap for the whole profile (default: 3.5)
  --limiter MODE        docker | taskset | none | auto (default: auto)
  --docker-image IMAGE  image used by --limiter docker (default:
                         jrottenberg/ffmpeg:6.1-ubuntu2204)
  --duration SECONDS    source length per leg (default: 60)
  --quick                shorthand for --duration 15
  --segment-seconds N    HLS segment length (default: 4, matches production
                         LIVE_HLS_SEGMENT_SECONDS; code default is 2)
  --source-file PATH     use a real clip instead of the synthetic generator
  --out DIR              output directory (default: ./results/<timestamp>)
  --dry-run              validate the environment and print commands only
  -h, --help              this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --limiter) LIMITER="$2"; shift 2 ;;
    --docker-image) DOCKER_IMAGE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --quick) DURATION=15; shift ;;
    --segment-seconds) SEGMENT_SECONDS="$2"; shift 2 ;;
    --source-file) SOURCE_FILE="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
[ -n "$OUT_DIR" ] || OUT_DIR="$SCRIPT_DIR/results/$STAMP"

log() { printf '[bench] %s\n' "$*" >&2; }
die() { printf '[bench] ERROR: %s\n' "$*" >&2; exit 1; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# -------------------------------------------------------------- environment

cpu_count() {
  if have_cmd nproc; then nproc
  elif have_cmd sysctl; then sysctl -n hw.ncpu 2>/dev/null || echo 1
  else getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1
  fi
}

is_linux() { [ "$(uname -s)" = "Linux" ]; }

detect_limiter() {
  if [ "$LIMITER" != "auto" ]; then
    printf '%s' "$LIMITER"
    return
  fi
  if have_cmd docker && docker info >/dev/null 2>&1; then
    printf 'docker'
    return
  fi
  if is_linux && have_cmd taskset; then
    printf 'taskset'
    return
  fi
  printf 'none'
}

validate_env() {
  local resolved_limiter="$1"
  local ok=1

  if ! have_cmd ffmpeg; then
    log "ffmpeg not found on PATH. Ubuntu: apt-get install -y ffmpeg. Mac: brew install ffmpeg."
    ok=0
  elif ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q "libx264"; then
    log "ffmpeg has no libx264 encoder. Ubuntu's ffmpeg package usually has it; if this is a stripped build, install a build with --enable-libx264 or apt-get install -y ffmpeg from universe."
    ok=0
  else
    log "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1)"
    log "libx264: present"
  fi

  case "$resolved_limiter" in
    docker)
      if ! have_cmd docker; then
        log "limiter=docker but docker is not on PATH."
        ok=0
      elif ! docker info >/dev/null 2>&1; then
        log "limiter=docker but the docker daemon is not reachable (docker info failed)."
        ok=0
      else
        log "docker: reachable, will use image $DOCKER_IMAGE (pulled on first run if not cached)"
      fi
      ;;
    taskset)
      if ! is_linux; then
        log "limiter=taskset requires Linux."
        ok=0
      elif ! have_cmd taskset; then
        log "limiter=taskset but taskset is not on PATH (util-linux)."
        ok=0
      else
        log "taskset: present"
      fi
      ;;
    none)
      log "limiter=none: no CPU cap will be applied. Results are a smoke test only, never a box result."
      ;;
  esac

  log "host CPUs visible: $(cpu_count)"
  log "requested cap: ${CPUS} cores, limiter=${resolved_limiter}"

  if [ "$ok" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    die "environment check failed (see above). Re-run with --dry-run to inspect commands without encoding."
  fi
}

# ------------------------------------------------------------------ profiles
#
# Bitrates and framerates below are copied from server/src/voice/hls-ladder.ts
# (LADDER_RUNGS and CAMERA_RUNG) as of the commit this script ships in. If
# that file changes the ladder, update these to match -- that is the whole
# point of "encodes the SAME way."

# leg_spec NAME -> "width height fps video_kbps audio_kbps has_audio"
leg_spec() {
  case "$1" in
    720p30)   echo "1280 720 30 3200 128 1" ;;   # LADDER_RUNGS["720p30"], the production default rung
    1080p30)  echo "1920 1080 30 6500 128 1" ;;  # LADDER_RUNGS["1080p30"]
    1080p60)  echo "1920 1080 60 8000 128 1" ;;  # LADDER_RUNGS["1080p60"]
    camera)   echo "640 360 30 400 0 0" ;;       # CAMERA_RUNG (video-only, audioKbps 0)
    voice)    echo "0 0 0 0 64 1" ;;             # not a real ladder rung -- see NOTE below
    *) die "unknown leg: $1" ;;
  esac
}

# profile_legs NAME -> space-separated leg names
profile_legs() {
  case "$1" in
    720p30) echo "720p30" ;;
    1080p30) echo "1080p30" ;;
    1080p60) echo "1080p60" ;;
    compound|720p30+camera+voice) echo "720p30 camera voice" ;;
    *) die "unknown profile: $1 (720p30 | 1080p30 | 1080p60 | compound)" ;;
  esac
}

all_profiles() { echo "720p30 1080p30 1080p60 compound"; }

# NOTE on the "voice" leg: production's mic-archive is a LiveKit Track Egress
# (not Track Composite) recording the presenter's Opus audio; per
# docs/CAPACITY.md, a Track Egress "consumes minimal resources because it
# doesn't need to transcode." This rig still runs a real, small AAC encode
# for that leg (64 kbit/s, mono-ish noise source) rather than pretending it
# is free, which makes the "compound" profile's number a conservative
# (slightly pessimistic) estimate of the real box, never an optimistic one.

# ---------------------------------------------------------- source building

video_filter() {
  local w="$1" h="$2" fps="$3"
  # Two infinite generators (a cellular automaton and a zooming fractal)
  # blended and grained with temporal noise, so every pixel of every frame
  # differs from the last -- a stress source, not an average one. See the
  # file header for why this replaces testsrc2+text.
  printf '[0:v]format=yuv420p[a0];[1:v]format=yuv420p[a1];[a0][a1]blend=all_mode=addition:all_opacity=0.5,noise=alls=12:allf=t+u,scale=%d:%d,setsar=1,format=yuv420p[vout]' "$w" "$h"
}

# Builds the ffmpeg argv for one leg into the array named by $2 (bash 3.2
# has no namerefs, so this writes to a fixed global array instead).
LEG_ARGS=()
build_leg_cmd() {
  local leg="$1" outdir="$2"
  local w h fps vkbps akbps has_audio
  read -r w h fps vkbps akbps has_audio <<< "$(leg_spec "$leg")"
  local legdir="$outdir/$leg"
  # NOTE: caller is responsible for creating $legdir on the HOST before
  # calling this. When outdir is the in-container "/out" (docker limiter),
  # the real mkdir happens on the host at the mounted path -- see
  # run_profile_docker / run_profile_hostcap.

  LEG_ARGS=(ffmpeg -hide_banner -loglevel warning -y -nostdin)

  if [ "$leg" = "voice" ]; then
    if [ -n "$SOURCE_FILE" ]; then
      LEG_ARGS+=(-i "$SOURCE_FILE" -vn)
    else
      LEG_ARGS+=(-f lavfi -i "anoisesrc=color=pink:amplitude=0.3:sample_rate=48000")
    fi
    LEG_ARGS+=(-c:a aac -b:a "${akbps}k" -t "$DURATION" -f null -)
    return
  fi

  if [ -n "$SOURCE_FILE" ]; then
    LEG_ARGS+=(-stream_loop -1 -i "$SOURCE_FILE")
    LEG_ARGS+=(-vf "scale=${w}:${h},fps=${fps},format=yuv420p")
  else
    LEG_ARGS+=(-f lavfi -i "life=size=${w}x${h}:rate=${fps}:mold=2:ratio=0.4:death_color=#0b0f14:life_color=#39ff88")
    LEG_ARGS+=(-f lavfi -i "mandelbrot=size=${w}x${h}:rate=${fps}:end_scale=0.0004")
    LEG_ARGS+=(-filter_complex "$(video_filter "$w" "$h" "$fps")" -map "[vout]")
  fi

  if [ "$has_audio" = "1" ]; then
    if [ -z "$SOURCE_FILE" ]; then
      # Inputs so far: 0=life, 1=mandelbrot, so the audio generator lands at 2.
      LEG_ARGS+=(-f lavfi -i "anoisesrc=color=pink:amplitude=0.2:sample_rate=48000")
      LEG_ARGS+=(-map "2:a")
    fi
    # --source-file case: no explicit -map was set above, so ffmpeg's
    # default stream selection picks the file's own best audio track.
    LEG_ARGS+=(-c:a aac -b:a "${akbps}k")
  else
    LEG_ARGS+=(-an)
  fi

  local gop=$((fps * 2))
  LEG_ARGS+=(
    -c:v libx264 -profile:v main -preset veryfast -pix_fmt yuv420p
    -b:v "${vkbps}k" -maxrate "${vkbps}k" -bufsize "$((vkbps * 2))k"
    -g "$gop" -keyint_min "$gop" -sc_threshold 0
    -t "$DURATION"
    -f hls -hls_time "$SEGMENT_SECONDS" -hls_segment_type mpegts
    -hls_list_size 0 -hls_flags temp_file
    "$legdir/index.m3u8"
  )
}

# ------------------------------------------------------------------ limiting

CONTAINER_NAME=""

run_profile_docker() {
  local profile="$1" outdir="$2"; shift 2
  local legs=("$@")
  CONTAINER_NAME="egress-bench-$$-$RANDOM"
  local script="$outdir/run-inside-container.sh"
  for leg in "${legs[@]}"; do
    mkdir -p "$outdir/$leg"
  done
  {
    echo "#!/usr/bin/env bash"
    echo "set -e"
    for leg in "${legs[@]}"; do
      build_leg_cmd "$leg" "/out"
      printf '( '
      printf '%q ' "${LEG_ARGS[@]}"
      printf '; echo LEG_DONE:%s:$? ) > /out/%s.log 2>&1 &\n' "$leg" "$leg"
    done
    echo 'wait'
  } > "$script"
  chmod +x "$script"

  log "docker run --name $CONTAINER_NAME --cpus=$CPUS $DOCKER_IMAGE ..."
  docker run --rm -d --name "$CONTAINER_NAME" --cpus="$CPUS" \
    -v "$outdir:/out" -w /out --entrypoint /bin/bash \
    "$DOCKER_IMAGE" "/out/run-inside-container.sh" >/dev/null

  sample_docker_and_wait "$CONTAINER_NAME" "$outdir"
}

sample_docker_and_wait() {
  local name="$1" outdir="$2"
  local samples="$outdir/cpu-samples.txt"
  : > "$samples"
  while docker ps --format '{{.Names}}' | grep -qx "$name"; do
    docker stats --no-stream --format '{{.CPUPerc}}' "$name" 2>/dev/null \
      | tr -d '%' >> "$samples" || true
    sleep 1
  done
}

run_profile_hostcap() {
  # taskset or no cap: run each leg as a background host process.
  local mode="$1" profile="$2" outdir="$3"; shift 3
  local legs=("$@")
  local pids=()
  local prefix=()

  if [ "$mode" = "taskset" ]; then
    local n_cores
    n_cores=$(awk -v c="$CPUS" 'BEGIN{v=(c==int(c))?c:int(c)+1; if(v<1) v=1; print v}')
    local core_list
    core_list="0-$((n_cores - 1))"
    [ "$n_cores" -eq 1 ] && core_list="0"
    prefix=(taskset -c "$core_list")
    log "taskset -c $core_list (approximating ${CPUS} cores as $n_cores whole cores)"
  fi

  for leg in "${legs[@]}"; do
    mkdir -p "$outdir/$leg"
    build_leg_cmd "$leg" "$outdir"
    ( "${prefix[@]+"${prefix[@]}"}" "${LEG_ARGS[@]}" > "$outdir/$leg.log" 2>&1; echo "LEG_DONE:$leg:$?" >> "$outdir/$leg.log" ) &
    pids+=("$!")
  done

  sample_host_and_wait "$outdir" "${pids[@]}"
}

sample_host_and_wait() {
  local outdir="$1"; shift
  local pids=("$@")
  local samples="$outdir/cpu-samples.txt"
  : > "$samples"
  local any_alive=1
  while [ "$any_alive" -eq 1 ]; do
    any_alive=0
    local total="0"
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        any_alive=1
        local pct
        pct=$(ps -o %cpu= -p "$pid" 2>/dev/null | tr -d ' ')
        [ -n "$pct" ] || pct=0
        total=$(awk -v a="$total" -v b="$pct" 'BEGIN{printf "%.2f", a+b}')
      fi
    done
    [ "$any_alive" -eq 1 ] && echo "$total" >> "$samples"
    sleep 1
  done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}

# -------------------------------------------------------------------- steal

read_steal_total() {
  # Prints "steal total" from the host aggregate cpu line, or "0 0" where
  # /proc/stat does not exist (non-Linux).
  if [ -r /proc/stat ]; then
    awk '/^cpu /{ total=0; for(i=2;i<=NF;i++) total+=$i; print $9, total }' /proc/stat
  else
    echo "0 0"
  fi
}

# ---------------------------------------------------------------- reporting

stats_from_samples() {
  local file="$1"
  if [ ! -s "$file" ]; then
    echo "0 0"
    return
  fi
  awk '
    { a[NR]=$1; sum+=$1 }
    END {
      n=NR; if (n==0) { print "0 0"; exit }
      for (i=1;i<=n;i++) for (j=i+1;j<=n;j++) if (a[j]<a[i]) { t=a[i]; a[i]=a[j]; a[j]=t }
      idx = int(0.95*n); if (idx < 1) idx = 1; if (idx > n) idx = n
      printf "%.2f %.2f\n", sum/n, a[idx]
    }
  ' "$file"
}

leg_realtime_factor() {
  local outdir="$1" leg="$2" start_epoch="$3" end_epoch="$4"
  local wall=$((end_epoch - start_epoch))
  [ "$wall" -le 0 ] && wall=1
  awk -v d="$DURATION" -v w="$wall" 'BEGIN{printf "%.3f", d/w}'
}

# --------------------------------------------------------------------- main

mkdir -p "$OUT_DIR"

RESOLVED_LIMITER="$(detect_limiter)"
validate_env "$RESOLVED_LIMITER"

if [ "$PROFILE" = "all" ]; then
  PROFILES_TO_RUN="$(all_profiles)"
else
  PROFILES_TO_RUN="$PROFILE"
fi

log "output directory: $OUT_DIR"
log "profiles: $PROFILES_TO_RUN"
log "duration: ${DURATION}s  segment: ${SEGMENT_SECONDS}s  cpus: ${CPUS}  limiter: ${RESOLVED_LIMITER}"
[ -n "$SOURCE_FILE" ] && log "source file: $SOURCE_FILE" || log "source: synthetic life+mandelbrot+noise generator"

JSON_ENTRIES=()
MD_ROWS=()

for profile in $PROFILES_TO_RUN; do
  legs_str="$(profile_legs "$profile")"
  # shellcheck disable=SC2206
  legs=($legs_str)
  pdir="$OUT_DIR/$profile"
  mkdir -p "$pdir"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "=== profile: $profile (dry run) ==="
    for leg in "${legs[@]}"; do
      build_leg_cmd "$leg" "$pdir"
      printf '[bench]   leg=%s: ' "$leg" >&2
      printf '%q ' "${LEG_ARGS[@]}" >&2
      printf '\n' >&2
    done
    if [ "$RESOLVED_LIMITER" = "docker" ]; then
      log "  would run inside: docker run --rm --cpus=$CPUS $DOCKER_IMAGE (all legs backgrounded together)"
    elif [ "$RESOLVED_LIMITER" = "taskset" ]; then
      log "  would run under: taskset -c <cores for $CPUS> (all legs backgrounded together)"
    else
      log "  would run uncapped on host"
    fi
    continue
  fi

  log "=== profile: $profile: legs=${legs[*]} ==="
  start_steal="$(read_steal_total)"
  start_epoch=$(date +%s)

  case "$RESOLVED_LIMITER" in
    docker) run_profile_docker "$profile" "$pdir" "${legs[@]}" ;;
    taskset) run_profile_hostcap taskset "$profile" "$pdir" "${legs[@]}" ;;
    none) run_profile_hostcap none "$profile" "$pdir" "${legs[@]}" ;;
  esac

  end_epoch=$(date +%s)
  end_steal="$(read_steal_total)"

  read -r s1 t1 <<< "$start_steal"
  read -r s2 t2 <<< "$end_steal"
  steal_pct="n/a"
  if [ "$t2" -gt "$t1" ] 2>/dev/null; then
    steal_pct=$(awk -v s1="$s1" -v s2="$s2" -v t1="$t1" -v t2="$t2" 'BEGIN{printf "%.2f", (s2-s1)/(t2-t1)*100}')
  fi

  read -r cpu_avg cpu_p95 <<< "$(stats_from_samples "$pdir/cpu-samples.txt")"

  min_rt="999999"
  leg_summ=""
  for leg in "${legs[@]}"; do
    rt="$(leg_realtime_factor "$pdir" "$leg" "$start_epoch" "$end_epoch")"
    leg_summ="${leg_summ}${leg}:${rt}x "
    is_min=$(awk -v a="$rt" -v b="$min_rt" 'BEGIN{print (a<b)?1:0}')
    [ "$is_min" -eq 1 ] && min_rt="$rt"
  done

  capped="yes"
  [ "$RESOLVED_LIMITER" = "none" ] && capped="no"

  verdict="INDETERMINATE (no CPU cap applied)"
  if [ "$capped" = "yes" ]; then
    pass=$(awk -v a="$min_rt" 'BEGIN{print (a>=1.15)?1:0}')
    if [ "$pass" -eq 1 ]; then verdict="PASS"; else verdict="FAIL"; fi
  fi

  log "  legs realtime factor: $leg_summ"
  log "  min realtime factor:  ${min_rt}x   cpu avg/p95: ${cpu_avg}%/${cpu_p95}%   steal: ${steal_pct}%"
  log "  verdict: $verdict"

  JSON_ENTRIES+=("{\"profile\":\"$profile\",\"legs\":\"${legs[*]}\",\"cpus\":$CPUS,\"limiter\":\"$RESOLVED_LIMITER\",\"duration_s\":$DURATION,\"segment_s\":$SEGMENT_SECONDS,\"min_realtime_factor\":$min_rt,\"cpu_avg_pct\":$cpu_avg,\"cpu_p95_pct\":$cpu_p95,\"steal_pct\":\"$steal_pct\",\"capped\":$( [ "$capped" = "yes" ] && echo true || echo false ),\"verdict\":\"$verdict\",\"leg_detail\":\"$leg_summ\"}")
  MD_ROWS+=("| $profile | ${legs[*]} | ${min_rt}x | ${cpu_avg}% | ${cpu_p95}% | ${steal_pct}% | $verdict |")
done

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run complete, nothing encoded."
  exit 0
fi

{
  printf '{\n  "generated_at": "%s",\n  "cpus": %s,\n  "limiter": "%s",\n  "duration_s": %s,\n  "segment_s": %s,\n  "profiles": [\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CPUS" "$RESOLVED_LIMITER" "$DURATION" "$SEGMENT_SECONDS"
  n=${#JSON_ENTRIES[@]}
  if [ "$n" -gt 0 ]; then
    for i in "${!JSON_ENTRIES[@]}"; do
      printf '    %s' "${JSON_ENTRIES[$i]}"
      [ "$i" -lt $((n - 1)) ] && printf ','
      printf '\n'
    done
  fi
  printf '  ]\n}\n'
} > "$OUT_DIR/results.json"

{
  echo "# Encoder benchmark results"
  echo
  echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ), limiter=$RESOLVED_LIMITER, cap=${CPUS} cores, duration=${DURATION}s, segment=${SEGMENT_SECONDS}s."
  echo
  echo "| profile | legs | min realtime | cpu avg | cpu p95 | steal | verdict |"
  echo "|---|---|---|---|---|---|---|"
  for row in "${MD_ROWS[@]+"${MD_ROWS[@]}"}"; do echo "$row"; done
  echo
  echo "PASS needs min realtime factor >= 1.15x under an applied CPU cap. INDETERMINATE means no cap was applied (limiter=none) -- re-run with --limiter docker or --limiter taskset on Linux for a real reading."
} > "$OUT_DIR/results.md"

log "wrote $OUT_DIR/results.json"
log "wrote $OUT_DIR/results.md"
cat "$OUT_DIR/results.md" >&2
