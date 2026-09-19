# Handover: screen-share audio echo

13 Sep 2026. For the Windows gaming PC and the Cursor agent that opens this repo there.

The Mac work is done. The remaining job is to **hear** the fix on Windows 11. Do not merge. Do not claim the echo is gone until the probe rows are on the PR.

Harness copy lives next to the probe: [`client/e2e/share-audio-echo/README.md`](../../client/e2e/share-audio-echo/README.md).

## Where the work is

| Item | Value |
|---|---|
| Repo | [rafaelcg/pqp](https://github.com/rafaelcg/pqp) |
| Branch | `feat/screen-share-echo` |
| PR | https://github.com/rafaelcg/pqp/pull/537 |
| Commit | `2bd80623` — Stop the call leaking into screen-share audio |
| GitHub user | `AndreCamm` (personal). Do not push as `properandre` |
| Staging web | https://staging.pqp-3yr.pages.dev |
| Staging API | https://pqp-api-staging.fly.dev |
| Tone page | https://staging.pqp-3yr.pages.dev/share-audio-tone.html |
| Production (before) | https://pqp.gg |
| Chat title | `Screen-share audio [#537]` |

This change is client-only (web + Electron). Merging it does **not** restart production `pqp-api`.

Staging already has this branch. Workflow `34746955207` succeeded. Hard-refresh or use a private window. The Pages service worker can keep an old bundle.

## What you are proving

QG #ajuda: a screen share with computer sound also sends **pqp call audio**. The room hears itself. Gio wants Pocket Bard (a native app) without the call, and still needs to hear the other players.

The leak is the Windows mixer (WASAPI). Chromium only honours `restrictOwnAudio` on **Windows 11** (NT build ≥ 22000). `getSupportedConstraints().restrictOwnAudio` is true on Windows 10 too. That flag is not proof.

This Mac, Docker, GitHub `windows-latest` (Server 2022, build 20348), and most Windows VMs cannot hear that path. A silent VM looks like a pass. Use this gaming PC.

## What is already shipped

Do not re-implement this unless a staging row says `FAIL_LEAK`.

1. Web: `systemAudio: "include"` only after UA-CH says Windows 11 (`platformVersion` major ≥ 13, or `10.0.BUILD` ≥ 22000). Missing hint means exclude. Always send `restrictOwnAudio: true` if the engine knows the name.
2. `windowAudio`: `"window"` on Win11 Chrome. `"exclude"` otherwise, and always for watch party / `preferBrowserTab`. Omit `windowAudio` inside the Electron shell.
3. After capture, strip share audio before publish if `getSettings().restrictOwnAudio === false` or capabilities cannot include `true`. Do **not** strip when the setting is `undefined` (that would silence a working Win11 share). Notice: `voice.notice.systemAudioStripped`.
4. Electron: parse `os.release()` as `10.0.BUILD`. Loopback only if BUILD ≥ 22000. Never treat `major === 11`. The picker hides audio on Windows 10. Main passes `--pqp-can-exclude-own-audio=0|1` because the sandboxed preload cannot `require("os")`.
5. Probe: `window.pqpShareAudioProbe` (Goertzel on 440 / 880 / 1320).
6. Copy and Caio facts say Windows 11 only. Win10 is a refuse, not Gio’s “hear players + send Bard”.

Key files:

- `client/src/lib/screen-capture-audio.ts`
- `client/src/lib/share-audio-probe.ts`
- `client/src/hooks/use-voice.ts` (`ensureOsCanExcludeCallAudio`, strip, `rememberShareAudioTrack`)
- `electron/lib/display-sources.js`, `electron/main.js`, `electron/preload.js`
- `client/e2e/share-audio-echo/run.mjs`

## What this PC must do

Stay on `feat/screen-share-echo`. Do not open a new branch for the hearing.

You do **not** need a local API for the Chrome hearing. Staging is enough. You need a local checkout only for Electron.

```bash
git fetch origin
git checkout feat/screen-share-echo
git pull
```

If `gh` is used, switch to the personal account first:

```bash
gh auth switch --user AndreCamm
```

### 1. Read the OS build

1. Open Settings → System → About (or `winver`).
2. Write the **OS build** in the PR comment.
3. Build ≥ 22000 is Windows 11. The exclude path can run.
4. Build below 22000 is Windows 10 (or older). Computer sound is refused. Do not expect 880 to go out. Write that and stop the Gio hearing. The refuse path is a different check.

Speakers stay up for every step below. Mute fakes a pass.

### 2. Control row (probe is not deaf)

Production `pqp.gg` does **not** ship `pqpShareAudioProbe`. Run the control on staging.

1. Sign in on https://staging.pqp-3yr.pages.dev (new Clerk login; prod accounts do not exist here).
2. Hard-refresh `/app`.
3. Open https://staging.pqp-3yr.pages.dev/share-audio-tone.html in another window. Click the page if 880 is silent.
4. In the pqp tab, DevTools console:

```js
pqpShareAudioProbe.playCallTone()
await pqpShareAudioProbe.controlCapture()
```

5. In the picker, choose **Entire screen** and tick computer sound.

`CONTROL_OK` means 440 reached the mixer. A later `PASS` is then real.

`CONTROL_DEAF` or `NO_TRACK` means the probe did not hear. Stop. Do not treat a later `PASS` as a fix. Check speakers, the computer-sound tick, and that you shared a **screen** (not a silent tab).

### 3. After row (staging share)

1. Keep 440 and 880 playing.
2. Join a voice channel on staging.
3. Share from the pqp UI with computer sound ticked (same client, one process).
4. Console:

```js
await pqpShareAudioProbe.measure()
```

That reads the share-audio track the app just published, after any strip.

Wanted on Windows 11:

- `snr440` ≤ 6 (call at floor)
- `snr880` ≥ 20 (game present)
- verdict `PASS`

`FAIL_LEAK` (`snr440` ≥ 12 on a track we still publish) means the issue is **not** gone. Stay on this branch and debug. Do not open a new PR.

`FAIL_NO_GAME` means 880 never entered the track. That is unheard, not a pass.

### 4. Before row (production)

Use this to show the old client still leaks. The probe is missing on `pqp.gg`, so use your ears plus a note.

1. Open https://pqp.gg in a window that is **not** the staging app.
2. Join a voice channel.
3. Keep the 880 tone page open (the staging HTML is fine; it is only a speaker).
4. In the production tab console, play 440:

```js
(() => {
  const c = new AudioContext();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = "sine";
  o.frequency.value = 440;
  g.gain.value = 0.2;
  o.connect(g);
  g.connect(c.destination);
  o.start();
})();
```

5. Share from the production UI with computer sound ticked.

You should hear 440 (and often the call) in the share. Write “heard leak on production” in the PR. That is the before.

### 5. Paste on the PR

Comment on https://github.com/rafaelcg/pqp/pull/537. Include:

- OS name and build from About
- Chrome version
- Control row (full `formatShareAudioRow` text)
- Staging `measure()` row
- Production ear result (heard leak / did not)
- Electron row only if you ran step 6

```bash
gh auth switch --user AndreCamm
gh pr comment 537 --body "$(cat <<'EOF'
## Hearing (gaming PC)

- OS:
- Build:
- Chrome:

### Control
(paste)

### Staging measure
(paste)

### Production
heard leak / did not

EOF
)"
```

### 6. Electron (after Chrome rows)

Packaged 0.1.6 still loads `https://pqp.gg/app`. A Pages staging deploy does not move that URL.

From this branch on this PC:

```bat
set PQP_APP_URL=https://staging.pqp-3yr.pages.dev
pnpm electron:dev
```

PowerShell:

```powershell
$env:PQP_APP_URL="https://staging.pqp-3yr.pages.dev"
pnpm electron:dev
```

Use the in-app picker. Tick **Share this computer's audio**. Auto-pick (one surface) never attaches loopback.

Then `pqpShareAudioProbe.measure()` in the Electron DevTools console, same tones.

## Dual process (do not test this as the fix)

App in the call, Chrome sharing that desktop: Chrome cannot exclude Electron’s speakers. That combo stays broken on purpose. One client only.

## Verdicts

| Verdict | Meaning |
|---|---|
| `CONTROL_OK` | Mixer heard 440. Probe is not deaf. |
| `CONTROL_DEAF` | 440 missing on a control capture. Stop. |
| `PASS` | Game in the track, call at floor. |
| `FAIL_LEAK` | Published track still has the call. Issue not gone. |
| `FAIL_NO_GAME` | 880 missing. Unheard, not a pass. |
| `NO_TRACK` | No share-audio track. |

Gates are in `client/src/lib/share-audio-probe.ts`: strip ≤ 6 dB, game ≥ 20 dB, leak ≥ 12 dB.

## Out of scope

- Discord PID picker
- Windows 10 computer sound as a feature
- macOS / Linux / iOS / Android screen audio
- AEC as the fix
- Claiming CI or Playwright heard an echo
- A What’s New post in this PR
- Merging unless Andre asks

## If staging still leaks

1. Stay on `feat/screen-share-echo`.
2. Keep the probe rows in the PR comment.
3. Check you used one client, speakers up, Entire screen, computer sound ticked, build ≥ 22000.
4. Only then change code. Redeploy staging after a push:

```bash
gh auth switch --user AndreCamm
gh workflow run deploy-staging.yml --ref feat/screen-share-echo
```

5. Hard-refresh and run control + measure again.

## What the Mac already checked

These do **not** replace the Windows rows.

- Staging deploy is green. The 880 page is live.
- On macOS the client reports `osCanExcludeCallAudio: false` and asks `systemAudio: "exclude"` / `windowAudio: "exclude"`.
- Headed Chromium `getDisplayMedia` failed with `NotReadableError`. The OS picker was not finished.
- A Fable review of the diff was started and interrupted. It is optional. It is not the hearing.

## Do not

- Merge the PR.
- Use a Windows VM as the gate.
- Mute the speakers.
- Treat `CONTROL_DEAF` or `FAIL_NO_GAME` as success.
- Share from Chrome while Electron is the one in the call and call that the product path.
- Edit `/Users/andre/.cursor/plans/screen-share_audio_37225373.plan.md`.
