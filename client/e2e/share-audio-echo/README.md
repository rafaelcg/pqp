# Share-audio echo harness

On-demand. Not `pnpm e2e`. Not CI. Same idea as the bandwidth harness: print
numbers from a real capture, then PASS/FAIL.

This Mac, Docker, and GitHub `windows-latest` (Server 2022, build 20348) cannot
hear Windows 11 exclude. The hearing is a Windows 11 box (the gaming PC).

## What you inject

- **440 Hz** from the capturing pqp tab (`pqpShareAudioProbe.playCallTone()`).
  That is the call.
- **880 Hz** from another document: open `/share-audio-tone.html` (staging:
  `https://staging.pqp-3yr.pages.dev/share-audio-tone.html`). That is Pocket Bard.
- Speakers stay up. Mute fakes a pass.

## What you read

The share-audio track that would be published, not the speakers.

```
os=Win11 22H2  build=22631  client=chrome  surface=monitor
restrictOwnAudio settings=true  caps=[false,true]
floor=-47.2  call440=-45.8  game880=-9.1  hiss1320=n/a
snr440=+1.4  snr880=+38.1
PASS  game present, call at floor
```

Gates (pinned in `client/src/lib/share-audio-probe.ts`):

- Call stripped: `snr440 <= 6 dB`
- Game present: `snr880 >= 20 dB`
- Leak: `snr440 >= 12 dB` on a track we still publish
- Control: computer sound **without** `restrictOwnAudio`. 440 must show
  (`CONTROL_OK`) or later PASS is the probe being deaf.

## Chrome on staging (after this branch is deployed)

1. About → Windows version and **OS build**. Build ≥ 22000 is Windows 11.
   Below that, computer sound is refused; do not expect Pocket Bard to go out.
2. Sign in on https://staging.pqp-3yr.pages.dev (separate Clerk login).
3. Open `/share-audio-tone.html` in another window. Click if 880 is silent.
4. In the capturing tab, DevTools console:

```js
pqpShareAudioProbe.playCallTone()
await pqpShareAudioProbe.controlCapture()
```

Pick **Entire screen**, tick computer sound. Control must print `CONTROL_OK`.

5. Join a voice channel. Share with computer sound ticked. Then:

```js
await pqpShareAudioProbe.measure()
```

That reads the share-audio track the app just published (after any strip).
Paste both the control row and this row in the PR.

Production pqp.gg is the **before** row. Staging is the **after**. Same
machine, same tones, speakers up.

## Electron

Packaged 0.1.6 loads `https://pqp.gg/app`. A staging Pages deploy does not move
the loopback handler. On the gaming PC, from this worktree:

```bash
PQP_APP_URL=https://staging.pqp-3yr.pages.dev pnpm electron:dev
```

Use the in-app picker and tick **Share this computer's audio**. Auto-pick
(one surface) never attaches loopback. Chromium `--use-fake-ui-for-media-stream`
does not click that checkbox.

## Dual process

App in the call, Chrome sharing: Chrome cannot exclude Electron's speakers.
That combo is unfixable in this PR. One client.

## Playwright

`run.mjs` is headed Chrome with fake UI and **without** a fake device. It
still cannot hear exclude on macOS. Run it only on the Windows 11 box:

```bash
cd client/e2e/share-audio-echo
SHARE_AUDIO_ECHO=1 node run.mjs
```
