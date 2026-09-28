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

#### Built (branch `win-native-share-audio`, flag off)

| Piece | Where |
|---|---|
| WASAPI process loopback, 48 kHz stereo float32, 10 ms chunks | `electron/native/win-share-audio/src/` (C++, plain N-API) |
| Runs in a utility process, so a native crash costs the share its sound, not the app | `electron/lib/win-share-audio-host.js` |
| Which process a window belongs to, and when INCLUDE would carry the call | `electron/lib/win-share-audio.js` |
| Arm, picker box, start, hand the PCM port to the page | `electron/lib/win-share-audio-session.js`, `electron/main.js` |
| Port to AudioWorklet to `MediaStreamTrack`, added to the share's stream | `client/src/lib/native-share-audio.ts`, `native-share-audio-worklet.js` |
| Runtime flag `desktop_share_audio_native` (per server), `GET /api/share/config` | `server/src/lib/flags.ts`, `server/src/lib/share-config.ts` |
| One-minute diagnostic | `pqp.exe --probe-share-audio` (`electron/lib/win-share-audio-probe.js`) |
| Build, sign, CI smoke | `.github/workflows/win-share-audio.yml`, called by `electron.yml` |

Why C++ and not Rust (napi-rs): WASAPI and COM are C++ APIs, and the two references (Microsoft's sample, OBS) are C++, so a reviewer can read the capture code line against line. It builds with the Visual Studio already on the Windows runner and nothing else, where napi-rs would add a Rust toolchain and the `windows` crate's COM layer for about 400 lines. Plain N-API rather than node-addon-api: five functions, no dependency, and the ABI is stable, so one binary built against Node's headers loads in Electron 44 and every later Electron.

How a share gets its sound. The page (flag on, shell capable, self-test passed) calls `nativeShareAudioArm()` and then `getDisplayMedia({ audio: false })`. The shell's picker shows the sound box because of the arm. If it is ticked, main asks the utility process to capture that surface and answers Chromium with video only, so Chromium's loopback, the mixer, is never opened beside it. The page then claims the PCM port, plays it through an AudioWorklet into a `MediaStreamAudioDestinationNode`, and adds that track to the share's stream before anything reads it: LiveKit publishes it as `ScreenShareAudio`, mesh sends it on the share's audio sender, and the watch party mix, egress and moderation see an ordinary share audio track. With the flag off, or the add-on missing, or the self-test failing, the page never arms and every path is exactly today's (Windows 11 keeps Chromium's `loopback`, Windows 10 stays silent).

What is captured:

- **Screen**: `EXCLUDE_TARGET_PROCESS_TREE` with pqp's main PID. Everything on the machine except pqp.
- **Window**: `INCLUDE_TARGET_PROCESS_TREE` with the window's app. `GetWindowThreadProcessId` on the HWND from `window:<HWND>:0`, then up the parent chain while the executable stays the same (a helper to its app, never a game up to its launcher), and for Store apps past `ApplicationFrameHost.exe` to the process that owns the CoreWindow. Chrome, Edge and Firefox windows belong to the browser's main process and their audio processes are its children, so the window's own PID already covers them.
- **The leak INCLUDE has, and the fallback**: the target's tree includes pqp whenever pqp was started under the target. Sharing a File Explorer window targets explorer.exe, usually our own parent; a terminal started `electron:dev`; a browser can be the parent of a pqp opened from a link. Any window whose app is an ancestor of pqp, or is pqp, falls back to EXCLUDE on our own tree: everything but pqp, still call-free, which is what Windows 11 gets today.

Limits, known and accepted: a game whose sound comes from a process that is neither the window's owner nor below it is silent (never leaky); PID reuse is guarded by creation time on our walk, but Windows's own tree judgement is its own; the worklet skips forward when more than 150 ms is buffered, so a clock that drifts produces a rare small skip rather than growing lag; process loopback sends nothing at all during silence, which the worklet plays as silence.

CI. `win-share-audio.yml` builds x64 and arm64 on `windows-2022` and smoke tests x64 on `windows-2022` (Server 2022, build 20348) and `windows-latest` (Server 2025, build 26100): the binary loads, the process and window lookups answer, a screen resolves to EXCLUDE on our own PID, and activation in both modes returns a pinned result with the capture thread and queue torn down cleanly. Neither runner has an audio device, so CI never hears anything and never claims to; the pinned answers are what each image gives, so a change that breaks activation differently fails there. Measured on the first run: on 20348, activation succeeds in both modes and `Initialize` is refused with `0x88890010` (`AUDCLNT_E_SERVICE_NOT_RUNNING`, the image has Windows Audio off); on 26100 both modes activate, initialize and start. So activation itself is not what 20348 lacks, which says nothing yet about 19045: that is step 1 below.

#### Test steps on a real PC (Windows 10 22H2 and Windows 11)

A VM without an audio device reports silence and looks like a pass. Use a real PC with speakers or headphones, volume up.

Get a build: run the Electron workflow on this branch (Actions, Electron, Run workflow, branch `win-native-share-audio`) and download `pqp-electron-win`. It has the portable exe (`pqp-0.1.9-x64-portable.exe`, `-arm64-` on an ARM PC) and the installer (`pqp-0.1.9-x64.exe`). The portable one is enough for step 1. Step 2 wants the installed one, because the portable launcher does not pass the app's log lines to the terminal; it installs over an existing pqp, per user, at `%LOCALAPPDATA%\Programs\pqp\pqp.exe` by default.

**1. The build question (one minute, no account needed).**

1. Settings, System, About: write down the OS build (for example `19045.5854`).
2. In the folder with the exe, open a Command Prompt and run `pqp-0.1.9-x64-portable.exe --probe-share-audio` (installed: `"%LOCALAPPDATA%\Programs\pqp\pqp.exe" --probe-share-audio`; it runs beside a pqp that is already open). It plays a quiet 440 Hz beep for about four seconds; that is the test signal.
3. A dialog shows the result. It is also on the clipboard and in `%TEMP%\pqp-share-audio-probe.txt`. Paste it on the PR.

Reading it: `include own tree ... -> HEARS_PQP` proves process loopback works on this build and audio flows; `exclude own tree ... -> CLEAN` proves the call stays out. `verdict: SUPPORTED on build N` is the answer this plan has been waiting for. `NOT SUPPORTED ... failed at activate 0x...` means this build cannot, and it keeps today's behaviour. `INCONCLUSIVE` means the beep never reached Windows: check the volume and the output device, run again. `LEAK` must never happen; if it does, stop and report it.

**2. The feature (only after `SUPPORTED`).** Needs the staging web and API from this branch (Actions, Deploy staging, branch `win-native-share-audio`) and the flag on for the test server (dashboard, controles, interruptores, `desktop_share_audio_native`, override for that server; or `DESKTOP_SHARE_AUDIO_NATIVE=true` on staging).

1. Quit pqp from the tray, then point it at staging: `set PQP_APP_URL=https://staging.pqp-3yr.pages.dev` and run `"%LOCALAPPDATA%\Programs\pqp\pqp.exe"` from the same Command Prompt (it prints `[pqp] share audio: ...` lines there). Sign in as A. Put B (any other device, headphones) in the same voice channel.
2. On A, open `https://staging.pqp-3yr.pages.dev/share-audio-tone.html` in Chrome (the 880 Hz "game"). In pqp, Ctrl+Shift+I, Console: `pqpShareAudioProbe.playCallTone()` (440 Hz from pqp, standing in for the call).
3. **Window share, Chrome**: Share, pick the Chrome window, tick the sound box, Share. The terminal shows `capturing include (window-app, chrome.exe)`. Console: `await pqpShareAudioProbe.measure()` must print `PASS` (880 present, 440 at the floor). B hears the 880 tone and never hears 440 or their own voice come back.
4. **Screen share**: stop, Share, Entire screen, tick, Share (`capturing exclude (screen)`). `measure()` must print `PASS`.
5. **By ear, B listening**: a Firefox window playing a video, an Edge window, a game window, Spotify. Each: sound arrives, and B talking never hears themselves.
6. **Fallback**: share a File Explorer window with the box ticked. The terminal says `target-contains-pqp`; the share carries the whole machine minus pqp; B still never hears the call.
7. **A/V offset**: play any audio/video sync test (a flash with a beep) in the shared window; B judges the lag between flash and beep. Target under 80 ms, about two frames at 30 fps.
8. **Cost**: Task Manager, Details, the `pqp.exe` utility process for `pqp share audio`: under 3% of a core while capturing.
9. **Flag off**: turn the override off, reload. Windows 10 is back to no sound box; Windows 11 is back to Chromium's loopback, exactly as before.

Record for each row: OS build, the probe's verdict, `measure()` output, what B heard, the offset, the CPU.

### macOS

ScreenCaptureKit (macOS 13+): `SCStreamConfiguration.capturesAudio = true`, `excludesCurrentProcessAudio = true`; for a window share, filter to the owning `SCRunningApplication`. Needs the Screen Recording permission we already ask for. Check first whether Electron 44 already exposes this through `setDisplayMediaRequestHandler` with `audio: "loopback"` on macOS (it may, behind ScreenCaptureKit); if so, no add-on is needed on macOS at all, only the shell change in `captureResponse`.

### Linux

**Prototype exists: draft PR #866** (branch `linux-desktop-system-audio`, `restarts-api`, flag `linux_desktop_system_audio` default off). The desktop app uses `pactl` to create a null sink, moves every other app's sound into it, loops it on to the speakers so the sharer still hears it, and exposes the sink's monitor as a remapped input the page opens after the picker. The call is never moved, the default output never changes, a watcher tears it all down and cleans up after a crash. No native module.

Proven in Docker with real Electron 44 on PulseAudio 16.1 and PipeWire 1.0.5: the other app is captured and the call is absent (-136 to -145 dB), including new apps mid-share and a device switch. Ruled out: `audio: "loopback"` on Linux records the call too; `restrictOwnAudio` is a no-op on Linux; `getUserMedia` never lists monitor devices. Browser users on Linux stay on "share a Chrome tab".

Needs: AppImage or .deb (Flatpak cannot reach `pactl`), a Pulse or PipeWire session. Left: QA on real GNOME and KDE (Wayland and X11), the watch party setup preview, hiding the `pqp-share-audio` device from the mic picker while sharing, and a ~250 ms echo risk if something makes the share sink the default output. Report: `~/.config/pqp/linux-share-audio-2026-09-27.md`, rig: `~/.config/pqp/linux-share-audio-rig-2026-09-27/`.

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
| Linux | ~1 to 2 days of QA and gaps on top of draft #866, plus a desktop release |

The bottleneck is machines, not code: Windows 10 and Windows 11 with real audio, a Mac, a Linux box.

## Order for mid-week

1. Ship the quick win.
2. Answer the Windows 10 build question with the proof of concept on a Windows 10 22H2 machine.
3. If yes: Windows production behind the flag, turn it on for QG, then Macacolandia (cap1tao's server).
4. Linux (#866) in parallel with Windows, since it is mostly QA now; then macOS.

## Open questions

- Who has a Windows 10 22H2 machine? If nobody, a rented Windows VM **with an audio device** (not a GitHub runner, not Server 2022 without audio) needs Rafael's OK because it costs money.
- Do we default the Windows 11 sound checkbox to on?
