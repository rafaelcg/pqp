#!/usr/bin/env bash
# The codec fixtures for JamCodecAlignmentTest: one second of silence with a
# 10 ms windowed 3 kHz burst starting at exactly 0.5 s, encoded every way the
# server accepts a jam stem (docs/JAM.md) plus WAV, at 48 kHz and 44.1 kHz. The
# test decodes each with the platform's own decoder and finds where the burst
# landed, so the delay a codec adds (or the platform removes) is a number, not a
# belief. Run from this directory; needs ffmpeg and python3 with numpy.
# The outputs are committed (each is a few KB to 100 KB); this is how they were made.
set -euo pipefail
cd "$(dirname "$0")"

python3 - <<'PY'
import numpy as np, wave

def burst(rate):
    n = rate
    out = np.zeros(n)
    start = rate // 2
    length = int(rate * 0.010)
    t = np.arange(length) / rate
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(length) / (length - 1))
    out[start:start + length] = 20000 * np.sin(2 * np.pi * 3000 * t) * window
    return np.round(out).astype('<i2')

for rate in (48000, 44100):
    with wave.open(f'burst-{rate}.wav', 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(burst(rate).tobytes())
PY

for rate in 48000 44100; do
  ffmpeg -v error -y -i burst-$rate.wav -c:a flac burst-$rate.flac
  ffmpeg -v error -y -i burst-$rate.wav -c:a aac -b:a 192k burst-$rate.m4a
  ffmpeg -v error -y -i burst-$rate.wav -c:a libmp3lame -b:a 192k burst-$rate.mp3
done
# Opus always runs at 48 kHz inside the file; the webm and ogg are what a browser's MediaRecorder makes.
ffmpeg -v error -y -i burst-48000.wav -c:a libopus -b:a 128k burst-48000.ogg
ffmpeg -v error -y -i burst-48000.wav -c:a libopus -b:a 128k burst-48000.webm
# Safari's MediaRecorder writes fragmented MP4 with AAC.
ffmpeg -v error -y -i burst-48000.wav -c:a aac -b:a 192k -movflags +frag_keyframe+empty_moov burst-48000-fragmented.mp4
ls -l
