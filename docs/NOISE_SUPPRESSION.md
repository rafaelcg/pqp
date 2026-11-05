# Noise suppression

The microphone has three settings instead of a tick box: **Desligada**,
**Padrão (navegador)** and **Voz limpa** (`"advanced"` in code and in
`preferences`/`localStorage` — the row was RNNoise's technical name in the UI
until the one-time nudge shipped; see `docs/ONBOARDING.md`). Client-only, in
`client/src/lib/noise-suppression.ts`.

RNNoise itself is never named in the product outside the one Settings
description that carries it in parentheses (`settings.voice.processing.noise.advancedHint`)
— everywhere else, including the one-time nudge card above the user bar
(`components/voice/voice-clean-hint.tsx`, `lib/voice-clean.ts`), it is "Voz
limpa" / "Clean voice".

Since 2026-10-20 **Voz limpa is the default** on a capable device that never
chose a mode, behind a kill switch (see "The default" below); everywhere else
`Padrão` is. On a microphone running `Padrão` or `Desligada` nothing about this
feature runs: no wasm is fetched, no worklet is registered, and the audio
graph is the same graph it was before.

## Why

The browser's `noiseSuppression` constraint is a stationary-noise filter. It
takes a fan and leaves a keyboard, a dog, a chair and a room, and it is also
the thing people mean when they say a call "eats consonants". RNNoise is the
Xiph recurrent-network suppressor, trained on speech against real noise, so it
removes the transients the constraint cannot.

## The library

| | |
|---|---|
| Package | [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) `0.4.0` |
| Licence | **MIT** (the RNNoise model and C source it wraps are Xiph's, BSD-3-Clause). No GPL, which matters: this repo is AGPL and must stay able to ship a browser bundle. |
| Weight on the wire | `rnnoise_simd.wasm` 154 kB (`rnnoise.wasm` 149 kB on a CPU without SIMD), the worklet processor 63 kB, the loader 2.8 kB. **All of it lazy** — a `import()` inside `loadRnnoiseBinary`, plus `?url` imports so Vite hashes and copies the assets. A default install downloads none of it. |
| CPU | a few percent of one core at 48 kHz mono, on the render thread rather than the main one. Measurably more than the constraint, which is free because it happens inside the capture. |

Cloudflare Pages needs no configuration for it: the worklet is a `.js` asset
under `/assets` (served as JavaScript) and the wasm arrives through `fetch` as
an `ArrayBuffer` rather than through `instantiateStreaming`, so its media type
is not load-bearing. There is no CSP on the Pages deploy, so no
`wasm-unsafe-eval` to add; **if one is ever added it needs `wasm-unsafe-eval`
in `script-src`** or this feature dies silently.

## Where the node sits

```
getUserMedia  →  [RNNoise worklet]  →  [voice gate]  →  gain  →  analyser (level meter)
      │           only in advanced      only in advanced     →  destination  →  published track
      │                                  ▲ input 1                          →  watch-party mix
      └──────────────────────────────────┘ the raw microphone, as its sidechain
```

`createMicPipeline` in `client/src/hooks/use-voice.ts`. The suppressor goes in
**before the gain node**, which is before the mute gate, before the meter, and
before the `MediaStreamAudioDestinationNode` whose stream is both what gets
published *and* what `createScreenMix` carries to a watch party's audience. One
insertion covers the room and the stream; nothing beside the publish call
needed to change.

The voice gate (see "The voice gate" below) sits between the suppressor and the
gain and is wired by the same `connectMicChain`; the rest of this section is
true of it too: it is built by `createMicPipeline`, so a mode change or a device
change replaces it with the pipeline, and the mic test in Settings ("Ouvir meu
microfone") builds the same chain.

Switching modes goes through `swapPipeline`, the same path the device picker
uses: a new pipeline is built, and only once it exists is the old one stopped
and the track handed to `replaceTrack`. Nobody sees you leave.

What `replaceTrack` is depends on the room. On a mesh room it is
`RTCRtpSender.replaceTrack` on every peer: no renegotiation, no gap. On a
LiveKit room it is NOT an in-place swap: `livekit-session.ts` unpublishes the
current microphone clone and publishes a new one, so every listener sees one
publication go and another arrive. Two rules keep that inaudible, and both
were production bugs before they were rules (QG, 2026-10-20: "mexe nas configs
e para de ouvir, tem que sair da call"):

- **A listener files the new voice before it hears that the old one left.**
  LiveKit delivers the new publication's `TrackSubscribed` before the old
  one's `TrackUnsubscribed`, so an unsubscribe only removes the stream its own
  publication filed (`filedBy` / `releaseStream`). Clearing the person's slot
  instead made whoever changed a setting inaudible to the whole room until
  they rejoined.
- **Microphone publishes run one at a time, in order** (`micPublishing`).
  Several changes in a row are several `swapPipeline` calls, each stopping the
  pipeline before it; interleaved, an earlier publish could finish last and
  leave a clone of a stopped track on the wire, so the room got no packets.

Both are pinned by `client/src/lib/livekit-session-republish.test.ts`. The
same holds for a camera or screen share republished in place.

Advanced mode is the only thing that asks for a specific `AudioContext` sample
rate (48 kHz, which is what RNNoise is trained at).

## The two never stack

`browserNoiseSuppression` returns **false** for `advanced`, so
`buildAudioConstraints` turns the browser's suppressor off whenever RNNoise is
on. A model fed an already-suppressed signal is hearing nothing like its
training set, and the pair sounds worse than either alone. Pinned by
`client/src/lib/audio-devices.test.ts`.

## Fallbacks

Nothing here is allowed to break a microphone.

1. **No `AudioWorklet` or no `WebAssembly`** (old Safari, an insecure context):
   detected *before* the mic is opened, so the capture is made in `browser`
   mode and never has to be made twice.
2. **The wasm will not download**: same, detected before the capture. The
   cached promise is cleared so a flaky network does not pin the feature off
   for the session.
3. **`addModule` or the node itself fails after capture**: the chain is built
   without it and `applyConstraints({ noiseSuppression: true })` asks the
   browser to take over on the live track, best effort.

All three log `console.warn("[mic] advanced noise suppression unavailable", err)`.
The setting stays where the user put it: the failure may be this device, this
build or this minute. Cases 1 and 2 also set `voiceState.notice`, which the
call stage renders, to `voice.notice.noiseSuppressionUnsupported` ("O teu
navegador não suporta a Voz limpa ainda; a supressão padrão continua ligada.")
— those two are known-before-capture and worth a sentence; case 3 stays
silent, because it means the chain was already open and playing on the
standard suppressor by the time it happens, and a mid-call notice about a
node nobody asked about a second time would be noise of its own.

## Measuring it

This section is the RNNoise node alone. The gate's bench is in "The voice gate" above.

```bash
cd client && node bench/rnnoise-attenuation.mjs
```

Drives a real Chromium through Playwright, because an `AudioWorklet` does not
exist in jsdom and does not run dependably in an `OfflineAudioContext`. It
feeds white noise at -20 dBFS (and separately a 440 Hz tone over it) through
the same graph with and without the node, and reports dBFS either way. Not in
CI: it needs a browser, it takes ~15 s, and an audio measurement on a shared
runner is a flake waiting to happen.

Measured on an M-series Mac, Chromium 141, 48 kHz:

| signal | before | after | removed |
|---|---|---|---|
| white noise only | -20.0 dBFS | -25.4 dBFS | **5.4 dB** |
| 440 Hz tone + white noise | -17.0 dBFS | -37.1 dBFS | **20.1 dB** |

Read those as a floor, not a promise. Both signals are synthetic and neither
is speech, which is the one thing the model is trained to keep: white noise is
the hardest case for a suppressor that decides frame by frame whether it is
hearing a voice, and a sine wave is something it has every reason to throw
away. What they prove is that the node is in the chain and is doing work. The
number that matters is a person in a room with a mechanical keyboard, and that
one is judged by ear.

## The voice gate

Voz limpa is RNNoise **plus an adaptive gate** since the `voice_gate` flag
(default on). RNNoise decides frame by frame what is voice; what it cannot do is
turn the room down BETWEEN sentences, so a breath, a chair, a key click it
half-believes and the hiss it leaves in a gap all go out at their own level.
The gate turns those down, and nothing else. Code:
`client/src/lib/voice-gate/` (DSP in `voice-gate-worklet.js`, the node factory in
`voice-gate-node.ts`, the kill switch in `voice-gate-flag.ts`).

### What it does

A downward expander, not a mute:

- **Lookahead and sidechain.** The gate node has two inputs: RNNoise's output
  (the audio it gains) and the RAW microphone (the signal it decides from).
  RNNoise delays its output by about 20 ms (measured, 977 samples at 48 kHz), so
  the raw signal is that much ahead of the audio and the gate hears a word
  about 15 ms before the same word reaches the audio path. The head start is
  the lookahead, so the gate **adds 0 ms of its own**. Where there is no
  sidechain (a gate on the raw mic, which the bench does) it delays the audio
  by `lookaheadMs`, 8 ms.
- **Level, confirmation, hysteresis, hold.** Per millisecond block RMS in dB. It
  opens after 5 consecutive blocks above the open threshold (`floor + 10 dB`,
  never below -56 dBFS), closes when the level (smoothed over 8 ms) has stayed
  under the close threshold (`floor + 6 dB`) for 150 ms. A run that is already
  15 dB below its own peak when the confirmation ends is a click dying away,
  not a voice, and does not open it.
- **The floor adapts.** Minimum statistics: the quietest stretch of the last
  3 s of the (30 ms smoothed) level, plus 1.5 dB. It needs no "is this speech"
  decision, so a room louder than its prior cannot lock it out, and speech never
  teaches it that speech is the room. Digital silence (a muted or hardware-gated
  mic) teaches it nothing. Clamped to -80..-42 dBFS.
- **Gentle.** A closed gate settles at **-20 dB**, never silence, released over
  60 ms and opened with a 0.6 ms time constant. It starts OPEN (400 ms) so the
  first words of a call are never held while it learns the room.
- **Fails open, three ways.** The worklet never throws out of `process` (it
  becomes a wire), a `processorerror` rewires RNNoise straight to the gain
  (`connectMicChain`), and a module or node that will not build returns `null`
  from `createVoiceGate`, which is the chain exactly as it was.

### The kill switch

Runtime flag `voice_gate` (env `VOICE_GATE`, global, code default ON), served as
`voiceGate` on the global `GET /api/voice/config`. Off sends every running gate
`{ bypass: true }` on the next config refresh (it stays in the chain as a wire,
mid-call, no rebuild, no rejoin) and builds none. **Unknown is ON**, unlike
`clean_voice_default`: this is an improvement that shipped on with plain RNNoise
as its fallback, so only an explicit `false` takes it away. See
`docs/FEATURE_FLAGS.md`. **Turn it off on reports of a voice that fades inside a
sentence or a word that starts clipped.** Adding the flag was a server change
(`restarts-api`); the gate itself is client-only.

### Why RNNoise and not something newer

Measured and read, November 2026:

| | verdict |
|---|---|
| **RNNoise** (kept) | MIT wrapper over Xiph's BSD-3-Clause model, already shipped, 154 kB wasm, ~20 ms delay. About 0.006x real time in the Node harness. |
| **GTCRN** | MIT, 48 k parameters, **already inside the installed `@sapphi-red/web-noise-suppressor` 0.4.0** (`gtcrn.wasm`, 197 kB, a 48 kHz path), so it is the one free alternative that costs nothing to try. On the bench scene it costs **3 to 4x the CPU of RNNoise** (0.018 to 0.025x real time) and adds **~32 ms** instead of ~20, for gap and key-click reduction that is similar or slightly worse (gap 19.3 / 17.8 / 18.4 dB against RNNoise 18.2 / 9.5 / 24.7, keys 9.3 / 3.2 / 8.8 against 10.3 / 0.8 / 10.4). The paper reports PESQ 2.87 on VCTK-DEMAND and DNSMOS 3.44 on DNS3; those are claims about real speech that a synthetic scene cannot confirm or deny. Not a clear win, so not swapped. It is the first thing to A/B by ear. |
| **DeepFilterNet3** | MIT / Apache-2.0 upstream, and the best-sounding of the open models by reputation, but the browser builds found are a ~9 to 10 MB wasm that needs SIMD, 10 to 30 ms of model delay (the 10 ms variant is a 36 MB model), and the npm package that wraps it for LiveKit (`deepfilternet3-noise-filter`) fetches its wasm from its author's CDN, built from unpublished sources. None of that was verified here, only read from the packages' own pages and PRs, and a runtime fetch from a stranger's CDN is a no for an AGPL app. Not adopted. |
| **Krisp** | Excluded (paid and licensed). |
| **Silero VAD** | Would need onnxruntime-web (megabytes) for a decision the gate already makes from energy and a sidechain. The cleaner next step is RNNoise's OWN voice probability, which its C function returns and the packaged worklet drops: a small custom worklet exposing it would replace the energy test with a real VAD at no extra model. Not done, it needs a build of the wasm glue. |

### Measured

Deterministic scene from `client/src/lib/voice-gate/fixtures.ts` (a seeded
source-filter voice: six words, two starting with a fricative; a fan at -48 dBFS;
bursts of keyboard clicks in the gaps), 48 kHz, 14 s.

```bash
cd client
node bench/voice-gate-bench.mjs      # the DSP in Node: RNNoise, GTCRN, with and without the gate
node bench/voice-gate-browser.mjs    # the same wiring in real Chromium (offline render)
pnpm exec vitest run src/lib/voice-gate   # the assertions
```

Room: fan -48 dBFS, soft keys (-38 dBFS peak):

| chain | gap dB | key dB | onset dB | word dB | added delay |
|---|---|---|---|---|---|
| gate alone (raw mic) | 19.7 | 20.0 | -0.0 | -0.0 | 8.0 ms |
| RNNoise | 18.2 | 10.3 | n/a | -2.1 | 20.4 ms (its own) |
| **RNNoise + gate** | **38.0** | **30.3** | **-0.0** | **-0.0** | **0 ms** |

- *gap dB*: how much quieter the nothing-but-room stretches got against the raw
  mic (the gate adds about its 20 dB range on top of what RNNoise did).
- *key dB*: the same for the loudest click in those gaps.
- *onset dB*: energy kept in the first 40 ms of each word against what the stage
  before the gate delivered. 0 is nothing clipped. RNNoise's own row is not
  shown because its onset loss is its own: it dropped the synthetic fricatives
  (-38 dB), which is also why the hint under the setting still says it can clip
  the start of some words.
- Loud keys (-28 dBFS peak): RNNoise alone barely touches them (0.8 dB), the gate
  takes the peak down 20.8 dB. A loud room (fan -40 dBFS): RNNoise + gate 44.6 dB
  in the gaps with the worst word onset at -0.0.
- The same chain in Chromium 151 (OfflineAudioContext, 48 kHz): RNNoise 18.9 dB
  gaps and 7.3 dB keys, RNNoise + gate **38.7 dB and 27.3 dB, onset -0.0**;
  RNNoise's measured delay 20.4 ms, the gate alone 19.7 / 20.0 exactly as in Node.
- CPU: the gate is about 0.0005 to 0.0008x real time in Node, a tenth of RNNoise.

**What this cannot tell you.** The voice is synthetic. It says the gate keeps a
soft onset, a short word and a fricative opening, quiets a fan and a keyboard,
adds no delay and never goes silent. It does not say how a real voice sounds
through RNNoise and then the gate, whether a trailing breath fades naturally,
whether a quiet speaker's soft words stay, or what a laptop fan three metres
away does to the floor estimate. Those are listening tests, in the PR's QA
list.

### Limits, said plainly

- A click RNNoise itself passes at voice level, and that is as loud as speech
  by the time it reaches the gate, is also passed by the gate. The sidechain
  makes it reject sharp transients that RNNoise smears, but it has no way to
  tell a loud sustained noise from a voice. In a room louder than about -40 dBFS
  of steady noise (SNR under ~18 dB against normal speech) it mostly stays open,
  which is passthrough, not harm.
- A mic that is silent for a while and then loud (unmute) is opened from the
  start: the gate begins open and the silence does not count.
- The gate's decisions assume RNNoise's ~20 ms delay is the sidechain's head
  start. A different suppressor (GTCRN, 32 ms) only makes the head start larger,
  and a shorter one would clip onsets: `connectMicChain` is the one place that
  wires it, and the browser bench is the check.
- Stereo microphones are mixed to mono at the gate (`channelCount: 1`).
- Flipping the flag back ON mid-call does not build a gate in a call that has
  none; it takes effect on the next pipeline (rejoin, device or mode change).

## The default

Since **2026-10-20** Voz limpa is the default for a device that never chose a
mode, behind the runtime flag `clean_voice_default` (env `CLEAN_VOICE_DEFAULT`,
global, code default on, flipped from the dashboard's controles →
interruptores with no deploy). Code: `client/src/lib/clean-voice-default.ts`.

- **The flag.** The client reads `cleanVoiceDefault` off the global
  `GET /api/voice/config` at sign-in and on every config refresh. Unknown (not
  answered yet, an older API, a failed first ask) is off.
- **The guard.** The default lands only where `advancedNoiseSuppressionSupported()`
  holds (AudioWorklet and WebAssembly, the same probe the pipeline runs, so a
  default never produces the "not supported" notice) and
  `navigator.hardwareConcurrency >= 4` when the browser tells. An unknown core
  count passes. Below the bar the default stays `browser`; the person can
  still pick Voz limpa by hand.
- **A stored choice always wins.** See "Migrating the stored setting" below for
  what counts as stored.
- **A default is never written down.** `saveLocalSettings` leaves
  `micProcessing.noiseSuppression` out of the blob until somebody picks a mode
  (the Settings select, or "Ativar" on the nudge). That is what makes the kill
  switch work: turning the flag off moves every defaulted device back to the
  browser's suppressor on its next config refresh, a call already running
  included (`setMicProcessing` swaps the pipeline in place, no rejoin).
- Settings shows the effective mode and, when it is Voz limpa by default,
  says so under the select (`settings.voice.processing.noise.defaultNote`,
  "Ligada por padrão neste aparelho."). The one-time nudge is not offered to a
  microphone already on Voz limpa, by default or by choice, and neither is the
  NOVO dot.
- Voice notes run no worklet, so a note recorded from a Voz limpa microphone
  asks the browser's suppressor instead (`voiceNoteProcessing` in
  `client/src/lib/voice-note-recorder.ts`) rather than recording with none.

`defaultMicProcessing.noiseSuppression` in `client/src/lib/audio-devices.ts`
stays `"browser"`: it is the static fallback, not the switch.

The old condition for flipping it, that the advanced path be heard on a
low-end Android and on a two-hour call first, is what the kill switch is for.
The cost is a few percent of a core per participant, paid on the machine least
able to afford it, and the core guard is only a proxy for that. **On reports of
choppy audio, a hot phone or a laptop fan in calls, turn `clean_voice_default`
off** and nothing else changes.

## Migrating the stored setting

`micProcessing.noiseSuppression` was a boolean until September 2026 and is now
`"off" | "browser" | "advanced"`. Every blob in the wild says `true` or
`false`, and `parseNoiseSuppressionMode` reads `true` (and a missing value,
which the old loader also read as on) as `browser` and `false` as `off`.
Anything unrecognised lands on `browser`.

With Voz limpa as the default, the question is which stored values are a
choice. **Only a device with nothing stored takes the default** (no
`pqp-local-settings` at all, or a blob with no
`micProcessing.noiseSuppression`). A stored `true` or `"browser"` is kept, and
that is deliberate: every save before this change wrote the whole blob,
default included, and the App writes it on every sign-in, so a stored
`"browser"` from somebody who never touched the row cannot be told apart from
somebody who tried Voz limpa and went back. In practice the new default
reaches new devices and new accounts, not devices that already ran the app.
The noise-suppression value is not part of the account's synced preferences,
so a new browser on an old account is a new device here.

The shared preferences schema in
`packages/shared` still declares the old boolean and is deliberately untouched:
nothing reads that field yet, and this is a client-only change that must not
restart the API.
