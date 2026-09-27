# Plan: screen share with sound on every desktop, the way Discord does it

27 Sep 2026. To be picked up mid-week. Follows [`SCREEN_SHARE_AUDIO_ECHO.md`](./SCREEN_SHARE_AUDIO_ECHO.md), which is the shipped state and must be read first.

## The problem, in one paragraph

A share that should carry sound arrives with none, and the person gets no explanation. Live example, 27 Sep, QG: `cap1tao` shared **Tela 1** from the **desktop app on Windows** in server Macacolandia, and the room saw "está compartilhando (sem som)". The picker showed no sound checkbox. The likeliest reason is Windows 10: the shell only offers loopback on Windows 11, because recording "the computer's sound" on Windows 10 also records the pqp call and the room hears itself (the 23 Aug report behind #537). Same wall on Linux (desktop: never any sound; browser: only a Chrome tab) and macOS (desktop: never any sound). Low call ratings that day named it twice ("ainda não descobrimos se tem como ou não streamar com som").

## What ships today (from the code, 27 Sep)

| Where | Screen / window share sound | Why |
|---|---|---|
| Desktop app, Windows 11 | Yes, if the picker checkbox is ticked (off by default) | `captureResponse` in `electron/lib/display-sources.js` returns `audio: "loopback"`, which Electron >= 43.4 remaps to `loopbackWithoutChrome` (WASAPI process loopback excluding our process tree) when the page asks `restrictOwnAudio: true` |
| Desktop app, Windows 10 | Never. The checkbox is hidden | `windowsBuildAllowsOwnAudioExclude` requires NT build >= 22000; below that the call would leak into the share |
| Desktop app, macOS / Linux | Never | Chromium loopback is Windows-only; asking elsewhere fails the whole capture |
| Chrome, Windows 11 | Screen with "Compartilhar áudio do sistema", or a tab | `systemAudio: "include"` + `restrictOwnAudio` |
| Chrome, Windows 10 | Tab only; system audio is stripped before publish | Same leak; `voice.notice.systemAudioStripped` |
| Chrome, macOS / Linux | Tab only | Browser limit. Nothing we can do on the web |

The desktop app is on Electron `^44.0.0`, version 0.1.9.

## How Discord does it

Discord does not use the browser's `getDisplayMedia` for this. It ships its own native capture engine and records sound **per application**:

- **Windows**: captures only the shared program's audio. That is why the call can never leak (the call is not that program) and why some anti-cheat games block Discord's stream audio.
- **macOS**: historically a separate audio driver; newer versions use ScreenCaptureKit (macOS 13+), which can capture one app's audio.
- **Linux**: stream audio arrived late, through PipeWire.

Confidence: high on the approach, medium on exact version cut-offs (from memory; verify before relying on them).

## The plan: a native audio add-on in the desktop app

One small native Node add-on (N-API, built for Electron 44) per platform, loaded by `electron/main.js`, that produces **PCM of exactly the audio we want** and hands it to the renderer, which turns it into a `MediaStreamTrack` and publishes it as the share's audio (`Track.Source.ScreenShareAudio` on LiveKit, the share's audio sender on mesh). The web client does not change except for consuming that track and the picker/notice copy.

Rules for every platform:

1. **Window share**: capture only the process that owns the shared window (and its child processes).
2. **Screen share**: capture everything **except** pqp's own process tree.
3. **Never** capture pqp's call audio. If the platform cannot guarantee (1) or (2), send no sound and say why (the current behaviour, but explained).
4. Behind a runtime flag (`feature_flags`, PR #839): `desktop_share_audio_native`, default off, per-server override for testing.

### Windows (do first: most of the Brazilian desktop audience, and the live case)

API: `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, ...)` with `AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, ProcessLoopbackParams { TargetProcessId, ProcessLoopbackMode } }`.

- Window share: `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` with the PID of the window. The desktopCapturer source id is `window:<HWND>:0`; `GetWindowThreadProcessId(HWND)` gives the PID. Browsers and some games render audio from a child process: INCLUDE_TARGET_PROCESS_TREE covers children of the target, but a browser's audio service may live under the browser's main process, so resolve to the top-level process of that app, not the window's own PID, and test Chrome, Edge and Firefox specifically.
- Screen share: `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` with **our** main process PID (covers the renderer and the audio service, which are our children).
- Reference implementation to read: Microsoft's "ApplicationLoopback" sample, and OBS `win-wasapi` "Application Audio Capture".
- **The one fact to verify before anything else**: which Windows 10 builds support process loopback. Microsoft's docs list build 20348; OBS says its application audio capture works on Windows 10 **2004 (19041)** and later, which would cover Windows 10 22H2 (19045), the common build. Chromium only enables its exclude mode at 22000, which may be their own caution. If 19041+ works, Windows 10 gets sound with no hooking. If it truly needs 20348, Windows 10 22H2 stays "no sound, explained", and the only route left is Discord-style injection into the target process, which we should **not** do (fragile, anti-cheat, antivirus).
- Build: prebuilt binaries for `win32-x64` and `win32-arm64` in the Electron build workflow (`.github/workflows/electron.yml`), signed with the existing Windows signing.

### macOS

ScreenCaptureKit (macOS 13+): `SCStreamConfiguration.capturesAudio = true`, `excludesCurrentProcessAudio = true`; for a window share, filter to the owning `SCRunningApplication`. Needs the Screen Recording permission we already ask for. Check first whether Electron 44 already exposes this through `setDisplayMediaRequestHandler` with `audio: "loopback"` on macOS (it may, behind ScreenCaptureKit); if so, no add-on is needed on macOS at all, only the shell change in `captureResponse`.

### Linux

PipeWire: capture the shared app's audio node (per-app), or the default sink's monitor minus our own stream. A research agent is on this today (report: `~/.config/pqp/linux-share-audio-2026-09-27.md`); fold its findings in here before starting. PulseAudio-only systems likely stay "tab share in Chrome" with an explanation.

### Renderer side (shared by all three)

- Main streams PCM to the renderer over a `MessagePort` (transferable ArrayBuffers, 10 ms frames, 48 kHz stereo float32).
- An `AudioWorkletNode` feeds a `MediaStreamAudioDestinationNode`; its track is the share audio.
- Publish with the existing share-audio path in `client/src/hooks/use-voice.ts` / `client/src/lib/livekit-session.ts` (source `ScreenShareAudio`), so watch party egress, the mixer and moderation keep working unchanged.
- A/V sync: the audio path is separate from video, so measure the offset (target < 80 ms) with the existing probe (`window.pqpShareAudioProbe`, Goertzel tones) plus a clap test.

### The quick win, ship first (hours, not days)

Independent of all the above:

1. The picker always shows the sound state: "Som: ligado" / "Som: desligado" / "Som: não disponível neste Windows (use o Chrome e compartilhe uma aba)". No hidden checkbox, no scrolling to find it.
2. When a share starts with no audio, the "(sem som)" label explains why for that platform in one line.
3. Consider defaulting the sound checkbox to **on** on Windows 11 for screen shares (it is safe there by design).

## Test matrix (needs real machines; a VM without an audio device reports silence and looks like a pass)

| Machine | Who | Checks |
|---|---|---|
| Windows 10 22H2 | ? (need one) | window share of a game, of Chrome playing YouTube, whole screen; the room never hears itself |
| Windows 11 | André's gaming PC | same, plus regression vs today's loopback |
| macOS 13+ | Rafael's Mac | window + screen |
| Linux (PipeWire, e.g. Ubuntu 24.04) | VM with a virtual sink, or a real box | window + screen |

For every row: probe tones present in the share, call audio absent (the probe's `FAIL_LEAK` check), offset measured, CPU cost of the add-on under 3% of a core.

## Effort

| Piece | Estimate |
|---|---|
| Quick win (picker + notice copy) | half a day |
| Windows proof of concept (add-on, one window share, one screen share, probe) | 1 to 2 days |
| Windows production (build/sign/arm64, PID resolution for browsers, flag, tests) | +1 week |
| macOS | ~1 week, or ~1 day if Electron already does it |
| Linux | ~1 week, depends on the research |

The bottleneck is machines, not code: Windows 10 and Windows 11 with real audio, a Mac, a Linux box.

## Order for mid-week

1. Ship the quick win.
2. Answer the Windows 10 build question with the proof of concept on a Windows 10 22H2 machine.
3. If yes: Windows production behind the flag, turn it on for QG, then Macacolandia (cap1tao's server).
4. macOS, then Linux.

## Open questions

- Who has a Windows 10 22H2 machine? If nobody, a rented Windows VM **with an audio device** (not a GitHub runner, not Server 2022 without audio) needs Rafael's OK because it costs money.
- Do we default the Windows 11 sound checkbox to on?
