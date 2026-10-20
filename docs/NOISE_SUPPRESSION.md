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
getUserMedia  →  [RNNoise worklet]  →  gain  →  analyser (level meter)
                  only in advanced            →  destination  →  published track
                                                              →  watch-party mix
```

`createMicPipeline` in `client/src/hooks/use-voice.ts`. The suppressor goes in
**before the gain node**, which is before the mute gate, before the meter, and
before the `MediaStreamAudioDestinationNode` whose stream is both what gets
published *and* what `createScreenMix` carries to a watch party's audience. One
insertion covers the room and the stream; nothing beside the publish call
needed to change.

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
