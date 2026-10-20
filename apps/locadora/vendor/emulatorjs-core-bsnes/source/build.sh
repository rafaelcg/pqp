#!/bin/bash
# How bsnes-legacy-wasm.data in the folder above was built (2026-10-20, macOS arm64).
# Corresponding source: the two pinned commits below plus the two .patch files beside this script.
# Usage: build.sh <empty work dir>. Needs git, make, and 7z on the PATH; downloads emsdk 3.1.74
# (the version EmulatorJS/build pins in build_env.sh) into the work dir. Nothing is installed globally.
set -euo pipefail
work="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
cd "$work"

pin() { # dir url sha
  mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" remote add origin "$2"
  git -C "$1" fetch -q --depth 1 origin "$3"
  git -C "$1" checkout -q FETCH_HEAD
}

git clone -q https://github.com/emscripten-core/emsdk.git emsdk
emsdk/emsdk install 3.1.74
emsdk/emsdk activate 3.1.74
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh

pin RetroArch https://github.com/EmulatorJS/RetroArch.git d907a125ee76e02a21d89003c140fd0b72886e90
pin bsnes https://github.com/EmulatorJS/bsnes-libretro.git 4b344745e3878e7c0675a60c624582935524b8f7

# libco's emscripten backend has no co_derive and no co_serializable; without them a state
# save, a state load and a reset abort the runtime (the EmulatorJS nightly of 2026-07-25 does)
patch -d bsnes -p1 < "$here/libco-emscripten-fiber.patch"
# RetroArch's save_state_info returned a local array by address (a null pointer at -O3) and serialised inside the
# JavaScript call, where bsnes's fibers cannot switch: the main loop now makes the state on its next tick
patch -d RetroArch -p1 < "$here/retroarch-save-state-info.patch"

# the core, as EmulatorJS/build's buildLegacy does it
(cd bsnes && nice -n 15 emmake make -j2 -f Makefile platform=emscripten EMULATORJS_LEGACY=1)
cp bsnes/bsnes_libretro_emscripten.bc RetroArch/libretro_emscripten.a

# RetroArch linked around it: the command RetroArch/emulatorjs/build-emulatorjs.sh --legacy runs
# for bsnes (in its needsAsync and no7Zip lists), called directly because that script needs GNU sed
(cd RetroArch && nice -n 15 emmake make -f Makefile.emulatorjs HAVE_7ZIP=0 HAVE_CHD=1 HAVE_THREADS=0 \
  PTHREAD_POOL_SIZE=0 ASYNC=1 HAVE_OPENGLES3=0 STACK_SIZE=4194304 INITIAL_HEAP=134217728 HAVE_AL=0 \
  HAVE_RWEBAUDIO=1 LIGHT_DEBUG=0 TARGET=bsnes_libretro.js -j2)

# the archive EmulatorJS reads: the core's glue and wasm, its metadata, its license
mkdir pack
cp RetroArch/bsnes_libretro.js RetroArch/bsnes_libretro.wasm pack/
cp bsnes/LICENSE.txt pack/license.txt
printf '{"name":"bsnes","extensions":["smc","sfc","swc","fig","bs","st"],"makeoptions":{"buildpath":"./","makescript":"Makefile","arguments":[]},"options":{},"save":"srm","license":"LICENSE.txt","repo":"https://github.com/EmulatorJS/bsnes-libretro"}' > pack/core.json
printf '{\n    "minimumEJSVersion": "4.2.3",\n    "version": "2.0.3"\n}\n' > pack/build.json
touch -t 202610200000 pack/*
(cd pack && 7z a -t7z ../bsnes-legacy-wasm.data bsnes_libretro.js bsnes_libretro.wasm build.json core.json license.txt)
shasum -a 256 bsnes-legacy-wasm.data
