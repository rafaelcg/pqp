#!/usr/bin/env bash
# The stems `JamWebTakeAlignmentTests` plays: three takes shaped exactly the way
# the web recorder uploads them, encoded by the web's OWN FLAC encoder
# (`client/src/lib/jam/flac.ts`: 16-bit mono, fixed 4096-frame blocks, no
# SEEKTABLE, MD5 left zero), because that is the file every real song is made
# of and the file the phone has to open, seek and trim.
#
# Each stem is silence with one-sample clicks at known SONG times. Its numbers
# (offsetMs, trimStartMs, trimEndMs) are the recorder's: `offsetMs` is the song
# time of the buffer's FIRST sample (`client/src/lib/jam/timeline.ts`), so a click
# at song time s sits at buffer frame round((s - offsetMs) * rate / 1000). The test
# restates the same numbers; change them in both places.
#
#   guitar  48 kHz, one bar of count-in at 120 BPM plus a 23 ms round trip:
#           offset -2023, trimStart 2023. Clicks on every second, 0 .. 239 s,
#           and one in the count-in at -1000 ms that must never be heard.
#   bass    48 kHz, a camera take with no count-in (offset -137) that was then
#           trimmed by 500 ms in the editor: trimStart 637, trimEnd 1000.
#           Clicks at every second + 250 ms, 250 .. 239 250 ms; the first
#           (250) is under the head trim, the last (239 250) under the tail trim.
#   keys    44.1 kHz, the context ran at the interface's rate: offset -2050,
#           trimStart 2050. Clicks at every second + 500 ms, 500 .. 239 500.
#
# Run from anywhere; needs node 22.6+ (type stripping). The outputs are
# committed (about 120 KB each); this is how they were made.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
out="$repo/ios/pqp/Tests/Fixtures/jam"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

# node strips the types but resolves imports literally, so the one import gets
# its extension in a scratch copy; the encoder itself is byte for byte the web's.
sed 's#from "./pcm"#from "./pcm.ts"#' "$repo/client/src/lib/jam/flac.ts" > "$work/flac.ts"
cp "$repo/client/src/lib/jam/pcm.ts" "$work/pcm.ts"
cat > "$work/make.ts" <<'TS'
import { writeFileSync } from "node:fs";
import { encodeFlac } from "./flac.ts";

const out = process.argv[2];
type Take = { name: string; rate: number; offsetMs: number; endSongMs: number; clicks: number[]; amplitude: number };
const seconds = (from: number, to: number, plus: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => (from + i) * 1000 + plus);
const takes: Take[] = [
  { name: "web-guitar-48000", rate: 48000, offsetMs: -2023, endSongMs: 240_000, clicks: [-1000, ...seconds(0, 239, 0)], amplitude: 0.5 },
  { name: "web-bass-48000", rate: 48000, offsetMs: -137, endSongMs: 240_000, clicks: seconds(0, 239, 250), amplitude: 0.4 },
  { name: "web-keys-44100", rate: 44100, offsetMs: -2050, endSongMs: 240_000, clicks: seconds(0, 239, 500), amplitude: 0.3 },
];
for (const take of takes) {
  const frame = (songMs: number) => Math.round(((songMs - take.offsetMs) * take.rate) / 1000);
  const samples = new Float32Array(frame(take.endSongMs));
  for (const click of take.clicks) samples[frame(click)] = take.amplitude;
  writeFileSync(`${out}/${take.name}.flac`, encodeFlac([samples], take.rate));
  console.log(take.name, samples.length, "frames");
}
TS
node "$work/make.ts" "$out"
ls -l "$out"
