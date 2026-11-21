# desktop-bench

A repeatable baseline for the Electron desktop app: memory and CPU per process,
per scene, as JSON. Step B1 of [`docs/plans/RUST.md`](../../docs/plans/RUST.md);
the committed numbers are step B2 (`results/`). Any native desktop work is
judged against these files, on the same machine, the same day.

It drives the real shell (`electron/main.js`, unchanged) from the repo's own
dev build of Electron, against a production build of the web client and a
scratch local API on the dev auth bypass. Nothing here touches production, a
real account, or anything that costs money.

## What it starts

| Piece | How | Port |
|---|---|---|
| Scratch database | `CREATE DATABASE pqp_bench_<id>` on a local Postgres you give it, dropped at the end | your Postgres |
| API | `server/dist` with `DEV_AUTH_BYPASS=true` (seeds the Sandbox hall) | 3971 |
| Client | a `vite build` of `client/` (into the system temp dir, reused between runs; `BENCH_REBUILD=1` rebuilds) served by a tiny static server | 4183 |
| SFU | `livekit-server --dev` if installed (`brew install livekit`) | 7880 to 7882 |
| Watch party source | ffmpeg writes a live 720p30 HLS stream into a fake S3 and one `hls_sessions` row says it is live; started for S7 only and stopped (row ended) after it | 3973 |
| Second person | headless Chromium signed in as `dev-local-token:bob` (`pqp:dev-user-suffix`) | none |

The API and `livekit-server` are bound to 127.0.0.1 (the bypass token is public).
The database guard in [`lib/local-pg.mjs`](./lib/local-pg.mjs) builds explicit
connection fields from the checked URL and refuses any query string, so a
`?host=` override cannot point it elsewhere. The client build is cached in the
system temp dir and keyed on HEAD plus local changes under `client/` and
`packages/shared`, so a different commit is never measured from an old bundle.

Everything it starts is stopped by pid (its own process group), never by name:
the owner's installed pqp app may be running on the same machine. Electron runs
one instance at a time with its own `--user-data-dir`.

## Running it

```bash
# once: a throwaway Postgres on a port nothing else uses (any local Postgres works)
docker run -d --name pqp-desktop-bench-pg -p 127.0.0.1:55439:5432 \
  -e POSTGRES_PASSWORD=bench postgres:16-alpine

pnpm install
pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build
node electron/node_modules/electron/install.js   # downloads the Electron binary if pnpm skipped it
npx playwright install chromium-headless-shell   # for the second participant (from client/)
brew install livekit                              # optional; without it S4 to S6 are reported as not run

node tools/desktop-bench/electron-bench.mjs --smoke     # every scene once, short: check the rig
node tools/desktop-bench/electron-bench.mjs             # the real thing: 5 runs per scene, about 2 hours
node tools/desktop-bench/electron-bench.mjs --scenes S1,S8 --runs 3
```

Options are listed at the top of [`electron-bench.mjs`](./electron-bench.mjs).
`BENCH_PG_ADMIN_URL` points at another Postgres; it must be on this machine. The
bench refuses any other host, and refuses to seed any database not named
`pqp_bench*` ([`seed.mjs`](./seed.mjs)), so it cannot be aimed at `DATABASE_URL`.

**Conditions for numbers worth keeping:** the machine on AC power, nothing else
heavy running, the screen unlocked and awake (a locked session throttles
timers and the GPU process), and one run of the whole set (it is long and warm:
do not loop it). The Electron window opens on the main display and takes focus
for every launch; leave the machine alone while it runs. The result file records
the power state and `pmset -g therm` before and after.

## Scenes

Each scene is a fresh Electron profile, and the runs are interleaved (run 1 of
every scene, then run 2 of every scene, and so on) so heat and drift are spread
over the scenes instead of landing on the last one. Calls and the watch party
last `--call-seconds` (300).

| Id | What a person is doing | How it is measured |
|---|---|---|
| S1 | idle on `#general` (the light channel, a handful of messages) | memory after 15 s settle, CPU over the next 30 s |
| S2 | 2,000 messages loaded in `#off-topic` (scrolled to the oldest, then swept top to bottom) | memory and CPU over 30 s after the sweep; scroll frame times and long tasks in `extras` |
| S3 | back on `#general` after S2 (same run) | memory and CPU over 30 s, 3 s after the switch |
| S4 | two-person call on the SFU, microphone on (the fake device), the other person's microphone on too | memory at the end, CPU over the time after a 30 s warm-up, memory peak of the 30 s samples |
| S5 | S4 while sharing a 1080p30 screen | as S4; the other person's received resolution and frame rate in `extras` |
| S6 | S4 while watching the other person's 1080p30 share | as S4; shown and dropped frames of the picture in `extras` |
| S7 | watching a live watch party (720p30 HLS through the playlist proxy) | as S4; shown and dropped frames in `extras` |
| S8 | launch to the first message painted, cold (fresh profile) and warm (same profile again) | `extras.cold.contentMs`, `extras.warm.contentMs`; memory after 3 s |

"Memory" is macOS `phys_footprint` per process (what Activity Monitor shows;
RSS double counts pages the helpers share), private working set on Windows,
PSS on Linux. "CPU" is percent of **one core** (100 is a full core), from each
process's cumulative CPU seconds, summed over every process the shell owns. Per
process is reported by kind (`Browser`, `Tab` for the renderer, `GPU`, one key
per utility such as `Utility: Network Service`), and each run keeps the
per-pid rows in `runs[].memory.byProcess` and `runs[].cpu.byProcess`.

## What is real and what is not

Be exact about this when quoting a number.

- **Real:** the Electron shell, the web client bundle, the API, Postgres, the
  WebSocket, LiveKit's SFU (`--dev`), the product's own publish and subscribe
  code, hls.js and the playlist proxy.
- **Share scenes (S5, S6) do not capture the screen.** In Electron `getDisplayMedia`
  goes to the shell's `desktopCapturer` handler, which needs macOS's Screen
  Recording permission (a system dialog nobody can click unattended) and would
  put the owner's screen into the call. The page's `getDisplayMedia` is answered
  by Chromium's fake capture device at 1920x1080, 30 fps. Encode, simulcast,
  publish and the SFU are the product's; the OS capture step (ScreenCaptureKit,
  its GPU readback) is not in S5. Treat S5 as a lower bound for CPU. The sharer in
  S6 is the headless Chromium doing the same thing.
- **Watch party (S7) has no LiveKit egress.** ffmpeg writes the stream and the
  API answers `GET /api/channels/:id/live` from the `hls_sessions` row (the path
  the second machine takes in production). Playlist, segments, viewer token and
  player are the real ones. The picture is `testsrc2` at 2.5 Mbit/s, not a film.
- **The Sandbox hall is not empty:** the API's dev seed holds sockets for a
  dozen dummy members (presence), so the member list and presence updates are
  live in every scene. That is the same for any stack measured against this rig.
- **One shared window size.** Numbers depend on the display (the result file
  records its size and scale factor and the window's bounds). Compare only
  within a machine.
- The second participant is a headless Chromium on the same machine. Its CPU is
  not in the numbers, but it competes with the shell for the machine.

## Output

`results/<date>-<platform>-<arch>-<app sha>.json`, rewritten after every run so
a crash keeps what finished. Top level: `machine`, `os`, `build` (`appSha` is the
commit under test: HEAD, or the merge base with `origin/main` when everything
that differs lives under `tools/desktop-bench` or `docs`; `dirty` is true only
when app code differs), `electron` (versions, display, window), `config`
(`runsPerScene`, durations), `thermalBefore` / `thermalAfter`, `missingScenes`,
and `scenes.<Sn>`: `summary` (median, min, max, p25, p75, `spreadPct` and every
value, for total memory, total CPU, memory and CPU by process kind, and every
numeric `extras` field) and the raw `runs`. `spreadPct` is (max - min) / median.
Memory has been steady on a quiet machine (under about 8% in most scenes, and
under 2% in S1, S7 and S8); CPU spreads wider in percent because the absolute
numbers are small (a 2 point swing on 8% is 25%), so read CPU spread beside the
median. A spread well above that on memory means something else was running.
A failed run stays in `runs` as an `error` and does not count in `okRuns`.

## The other scripts

| Script | What it is |
|---|---|
| `stack-up.mjs` | brings the stack up and leaves it running (prints the `BENCH_*` ids as JSON), for the two scripts below and for poking at a scene by hand; Ctrl-C tears it down |
| `electron-profile.mjs` | CPU and sampled-heap profiles of the hot spots (history held in memory, leaving a channel, a call). Run against an unminified build: `stack-up.mjs --client-dist <dir>` |
| `electron-retention.mjs` | whether a channel's memory comes back after leaving it (forced GC), per step |
| `footprint.mjs` | the per-platform memory and CPU readers the scenes use |
| `seed.mjs` | what the scenes need in the database, through the dev bypass; refuses anything but a local `pqp_bench*` database |

## What this does not do yet

B3 (Windows and Linux numbers from a `workflow_dispatch` workflow) and B4
(attribution of where memory and CPU go) are separate steps of the plan. The
Windows and Linux readers exist in `footprint.mjs` and have not been run.
