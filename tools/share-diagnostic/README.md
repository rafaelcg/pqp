# Share diagnostic

Tools for the "a share of an uncapped high-refresh game lags" report
(2026-09-30). All three measure one computer and send nothing anywhere.

| What | Where | For |
|---|---|---|
| Diagnostic page | `client/public/share-diagnostic.html` (pqp.gg/share-diagnostic.html) | Anyone. Press Start, pick the game, play 30 s, press Stop, read the verdict |
| Stand-in game | `client/public/share-diagnostic-game.html` | A window that keeps the graphics card busy, for machines with no game |
| One-command rig | `repro.mjs` (`pnpm share:repro`) | Runs six conditions automatically and prints the numbers and a verdict |
| Priority experiment | `share-priority-test.ps1` | Windows: raise the browser's GPU or CPU priority mid-share to see which one fixes it |

## The page

It captures what you pick with pqp's own settings (60 fps and 1080p
ceilings, `contentHint` motion, H.264 as the media server negotiates it,
three layers at the capture's frame rate, maintain-framerate) and sends it
through a loopback connection inside the page. The table shows, per second:
frames the capturer handed over (`captured`, counted with
MediaStreamTrackProcessor), frames the encoder produced (`sent`), encode time
per frame, what WebRTC says limited it, the size sent, and what a receiver got.
Rows shaded blue are seconds when the page was behind the game.

If a service worker from an older build serves the app instead of the page,
press Ctrl+Shift+R (Cmd+Shift+R on a Mac) once.

## The rig (macOS or Windows)

```bash
pnpm install
pnpm share:repro          # about 3 minutes; SECONDS=30 ONLY=2,4 to narrow it
```

Google Chrome must be installed and allowed to record the screen. On macOS:
System Settings, Privacy and Security, Screen and System Audio Recording,
turn on Google Chrome, then quit and reopen Chrome once. The rig opens its
own windows; leave the machine alone while it runs.

## The priority experiment (Windows)

With a share running and the game uncapped:

```powershell
powershell -ExecutionPolicy Bypass -File share-priority-test.ps1 -Target chrome -Mode status
powershell -ExecutionPolicy Bypass -File share-priority-test.ps1 -Target chrome -Mode gpu
```

`-Target pqp` for the desktop app. If it answers "needs administrator", run the
same line from a PowerShell opened with "Run as administrator". Then `-Mode
reset` and `-Mode cpu` to compare. Everything goes back to normal when the
browser closes.
