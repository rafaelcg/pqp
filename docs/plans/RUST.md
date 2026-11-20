# Rust in pqp: a targeted, gains-based plan

Written 2026-11-20 against `main` at `af3e1edd6`. Supersedes the plan in #1633.
Nothing written in Rust runs in production today. This plan says where Rust goes,
in what order, how each step is proved, and how each step is turned off.

## 1. Goal and non-goals

**Goal.** Put Rust where it buys the kind of gain Discord got from it, and
nowhere else. For pqp that is two places: the desktop app (Electron's fixed
memory cost, which nothing inside Electron removes) and one client core shared
by iOS, Android and a native desktop app (one copy of the wire protocol and the
reconnect rules instead of three). Work starts now, goes in PR-sized steps, and
every step is measured before and after.

**Non-goals.**

- **No Rust on the API server.** The audit found no precondition for it (section
  3). The largest measured server gain, compressing a fan-out frame once instead
  of once per socket, is plain Node and is being built separately behind a runtime
  flag. Any server Rust has to beat that, not today's number.
- No Rust `/ws` gateway, no own permessage-deflate, no Rust media engine (LiveKit,
  `tools/pqp-remux` and ffmpeg are already native), no wasm in the web client, no
  Tauri, no rewrite of the Windows share-audio add-on.

**What would reopen the server.** All of these, measured at a real event after
compress-once has shipped: an API container above 60% of its cores for 5 minutes
or more, or `runtime.eventLoop` p99 above 100 ms on `GET /api/admin/metrics`
traced to GC (a major pause over 50 ms in `--trace-gc`), with the Node fixes for
that path tried, and a bench in this repo showing a Rust version of that exact
path at least 3x cheaper. Then it gets its own section here, with the same test
bar.

## 2. What Discord gained, and why Rust was the fix

| Case | Measured gain, as published | Why Rust, and not something else |
|---|---|---|
| Read States service, Go to Rust ([Howarth, 2020-02-04](https://discord.com/blog/why-discord-is-switching-from-go-to-rust)) | Go's GC ran "every 2 minutes at minimum" and caused latency spikes; the Rust version had "no latency spikes", with latency, CPU and memory all better and average time "measured in microseconds" | An LRU of tens of millions of entries with hundreds of thousands of updates a second, under a tracing GC, on a hot path |
| Member list SortedSet NIF in Elixir ([Nowack, 2019-05-17](https://discord.com/blog/using-rust-to-scale-elixir-for-11-million-concurrent-users)) | Insert into 250,000 items: 27,000 µs (`ordsets`), 640 µs (best pure Elixir), 0.61 to 3.68 µs (Rust) | One large, hot, mutable, ordered structure in a VM built on immutable data |
| Rust data services in front of the message store ([Ingram, 2023-03-06](https://discord.com/blog/how-discord-stores-trillions-of-messages)) | Request coalescing and consistent-hash routing; the published p99s belong to the whole Cassandra to ScyllaDB move, none isolate the Rust layer | Read amplification on a few hot partitions |
| Native media engine inside Electron ([Vass, 2018-09-10](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc)) | "a single C++ media engine built on top of the WebRTC native library" shared by desktop, iOS and Android; no figures | Owning the media path; this is the native-modules-in-Electron shape Discord ran for years |
| Desktop and mobile rebuild on GPUI, 2026-11 (**secondary sources only**: the primary is a post on X that could not be fetched, [x.com/svishnevskiy/status/2118081920194203799](https://x.com/svishnevskiy/status/2118081920194203799); reported by [Inven Global](https://www.invenglobal.com/articles/28182/discord-cto-confirms-the-desktop-and-mobile-apps-are-being-rebuilt-in-rust)) | One screenshot of a prototype at about 290 MB with two accounts; no controlled before and after | Electron's fixed cost plus a JS UI; a Rust core shared by desktop and mobile |

Every measured Discord win had a precondition: GC pauses on a giant mutable
cache, a hot mutable structure in an immutable VM, read amplification. The client
rebuild is aimed at memory and code sharing, and it is the only one without a
published measurement yet.

## 3. Where pqp matches, ranked

Numbers are from the 2026-11-20 audit (M5 Max, Node 26.13.1, rustc 1.99.1) and
#1633's rerun of #1553 (2026-11-16), unless named otherwise.

| # | Area | Baseline we have | Number that would prove a gain | Budget that makes it a win |
|---|---|---|---|---|
| 1 | **Desktop app (Electron)** | 428 MB idle, 1,170 MB with 2,000 messages, 1,523 MB after leaving that channel, 694 MB and 14.9% CPU alone in a call. **Stale**: taken before message list windowing (#1556) and the startup split and calm speaking detector (#1557). No share, watch party or Windows number exists on any stack. GPUI prototype: 79 MB idle, 412 to 422 MB after the same walk, cannot join a call | The go bar in Phase D, on the scenes Phase B measures: a native client at most 40% of Electron's memory idle and 50% in a call, at most 60% of its CPU in a call | Beta parity estimated at 9 months or less from Phase D's real pace; installer at most half the size of Electron's; accessibility, IME, share audio and push-to-talk at parity |
| 2 | **Shared client core (iOS, Android, desktop)** | Jam stem placement fixed three times in three languages in one week (#1594, #1595, #1598). Android, and iOS in mesh rooms, still drop out of voice on an API restart (CLAUDE.md pitfall 11), because each client has its own reconnect and resume code | A rule ported to the core changes once, in one PR, for every consumer; mismatch counter at zero across a release; client-rule fixes made in two or more languages per quarter go down (counted from git history in Phase A) | At most 2 MB per ABI per app, at most 6 minutes of warm CI per app, a cold `cargo build` of the core under 2 minutes, and anyone who never touches Rust builds either app from a clean checkout with one documented command |
| 3 | WebSocket fan-out (server) | 92 KB roster to 1,000 sockets: 406 ms of server CPU and 328 KB RSS per socket today; compressed once, 17.6 ms and 24 KB. At 2,000: 839 ms against 33.5 ms | Per-container CPU at a party join storm, flag off and on | **Node, not Rust.** About 10 lines in `server/src/ws/fanout.ts` plus an ordering wrapper; built separately behind a runtime flag. Listed here because it is the bar for any future server Rust |
| 4 | Everything else on the server | Worst GC pause 3.84 ms and event-loop p99 1.6 ms at 2,000 sockets; the API box at 3% CPU while its pool filled (pitfall 22). Frame validation: zod 4 409 ns (client frames) and 703 ns (server frames) against Rust 466 and 718, and the socket path runs no zod on client frames at all. Reads already coalesce (`READ_CACHE`). Rosters are hundreds of rows. Media is already native | n/a | No precondition. Out of scope |

## 4. Phases

Sizes: **S** is a day or two of agent work and under about 400 changed lines;
**M** is up to a week; **L** is two to three weeks. Every step is one PR unless it
says otherwise. Phases A and B start now, side by side. C needs A1. D needs B and
C1 to finish, but its first step can start now on a branch. E follows C.

### Phase A. Wire-contract fixtures in `@pqp/shared` (no Rust)

The shipped zod schemas stay the only source of truth. Every client, and any Rust,
is checked against vectors generated from them.

- **A1 (M). Generators ported to zod 4, landed in `packages/shared`.** Move
  `gen-proto-vectors.mjs`, `gen-constraints.mjs`, `ts-resolve-hook.mjs` and
  `ts-register.mjs` from #1561 into `packages/shared/scripts/`, rewritten for zod
  4's internals (`_zod.def.type` and `def.checks`; the branch walks zod 3's
  `_def.typeName`, matches nothing on `main`, and writes "0 value rules over 0
  arms" without failing). Output to `packages/shared/fixtures/wire/`. Keep the
  coverage rules that earned their place: arms read off the unions, a filled and a
  null example for every nullable object, every value rule proved by a frame zod
  refuses at the blamed path, `.refine` identified by behaviour. Vitest tests in
  `packages/shared` that fail when: a generator emits zero rules, or fewer than
  the committed floor; any arm has no vector; a zod node type is unrecognised
  (throw, never skip); a committed fixture differs from a fresh in-memory
  regeneration; a fixture carries a key outside a protocol allowlist (no paths, no
  package versions, no `wsResolvedVia`). Carry #1561's lessons into the generator
  comments: optional is not nullable (`canSpeak` against `cameraStreamId`), read
  state is not write state (`MusicState` against `MusicStateWrite`), `.max()` on an
  array counts items, zod's `.url()` accepts `javascript:` and `data:`.
  `restarts-api` (touches `packages/shared`).
- **A2 (M). Android replays the vectors.** `WireVectorsTest.kt` in
  `android/app/src/test/kotlin/gg/pqp/app/protocol/`: decode every valid vector,
  never apply a refused one, and an allowlist of arms the app does not handle yet
  that fails the day an arm becomes handled (the rule `WireProtocolTest.kt`
  already follows with `announcedAheadOfShared`).
- **A3 (M). iOS replays the vectors.** `WireVectorsTests.swift` beside
  `WireDecodingTests.swift`, same rules. A2 and A3 run in parallel after A1.
- **A4 (S). Rule cases with a drift history.** Jam stem placement first, generated
  from `packages/shared/src/jam.ts` in the pattern of `channel-layout-cases.json`,
  replayed by web, iOS and Android. Count the client-rule fixes made in two or more
  languages over the last quarter from git history and write the number into
  section 3 as the baseline.

**Exit.** CI fails on a new frame arm without vectors or a generator that emits
zero rules; `android.yml` and `ios.yml` replay every vector.

### Phase B. Desktop baseline, today (no Rust)

- **B1 (M). Bench in `tools/desktop-bench/`.** Move `electron-bench.mjs`,
  `footprint.mjs`, `electron-profile.mjs` and `electron-retention.mjs` from #1553,
  add a seed script (the README's SQL as a script against the dev bypass), a
  second participant via `pqp:dev-user-suffix`, a local `livekit-server --dev`
  for SFU scenes, and a local live HLS source for the watch party scene (the
  ffmpeg setup in `tools/db-blip-harness/`). Scenes, each a median of at least
  five runs on an idle machine: **S1** idle on a light channel; **S2** 2,000
  messages loaded and scrolled; **S3** back on the light channel after S2; **S4**
  a two-person SFU call, mic on, 5 minutes; **S5** S4 while sharing a 1080p screen;
  **S6** S4 while watching the other person's share; **S7** watching a watch party
  for 5 minutes; **S8** launch to first message painted. Per process: memory
  (macOS `phys_footprint`, Windows private working set) and CPU. Results are JSON
  with machine, OS, build sha and run count.
- **B2 (S). macOS numbers.** Run S1 to S8 on `main`, commit the JSON under
  `tools/desktop-bench/results/`, replace the stale row in section 3.
- **B3 (S). Windows and Linux numbers.** A `workflow_dispatch` workflow,
  `desktop-bench.yml`, runs the same scenes on `windows-latest` and
  `ubuntu-latest` with fake media devices. From Windows we need: total private
  working set and CPU per process for S1, S4, S6 and S7, and S8's median. Runners
  have no GPU, so S5 (encode) is not comparable there and is not quoted; runner
  numbers compare only with runner numbers.
- **B4 (S). Attribution.** From `electron-profile.mjs` and the per-process split,
  write down where S1, S4 and S6 spend memory and CPU (GPU process, renderer JS
  heap, renderer native, main, utility). Fixes that need no Rust go in as ordinary
  PRs; this table is also the input to D6.

B2, B3 and B4 run in parallel after B1. **Exit:** committed numbers for every
scene on macOS and the Windows runner.

### Phase C. `pqp-client-core` in Rust, Android first

One crate, `rust/crates/pqp-client-core`: wire protocol types, frame validation,
and the reconnect and resume state machine. Rule kept from #1633: **no crate
without a consumer.** C1 merges only with C3 open and green behind it, and the
phase is not done until C3 ships. **First consumer: the Android app's
`RealtimeClient.kt`** (606 lines, the smallest of the three realtime clients, and
the one furthest from the web's resume behaviour).

- **C1 (M). The crate.** Start from #1561's `pqp-core` `proto.rs` and
  `validate.rs`, regenerated against A1's fixtures, which the tests read from
  `packages/shared/fixtures/wire/`. Drop `resume.rs`: clients carry the resume
  token opaque and never mint one. Value rules stay data, loaded fail-closed. A
  property test that no input panics. CI `rust.yml` (section 5).
- **C2 (M). Reconnect and resume as a pure machine, TypeScript first.** Extract the
  decisions in `client/src/lib/realtime.ts` (which closes reconnect, backoff and
  jitter, when a `join-voice-room` carries a resume claim, which caps go in
  `auth`) into a pure events-in, actions-out module in `packages/shared`, used by
  the web client with no behaviour change, and generate
  `reconnect-transcripts.json` from it. The Rust machine replays the transcripts.
  No timers and no I/O cross the boundary: the caller passes `now`, gets actions
  with delays. Parallel with C1. `restarts-api`.
- **C3 (M). UniFFI and Android.** UniFFI proc-macro bindings, plain records in and
  out, no callbacks, no async across the boundary. `cargo-ndk` for `arm64-v8a` and
  `x86_64`, a Gradle task before `preBuild`. Wire it into `RealtimeClient.kt` in
  **shadow**: every inbound frame also validated by Rust, the Rust machine run
  beside the Kotlin backoff, answers compared, Kotlin's used. Size measured from
  the release AAB and CI time from `android.yml`, against the budgets in section 3.
- **C4 (S). Counters and flags on the server.** `POST /api/client-core/report`
  (batched run and mismatch counts by kind and arm, modeled on the HLS telemetry
  route), `clientCore` on `GET /api/admin/metrics`, and the flags in Phase E served
  on `GET /api/client-core/config`. Can start beside C1. `restarts-api`.
- **C5 (M). iOS.** XCFramework for `aarch64-apple-ios` and `aarch64-apple-ios-sim`,
  built by a script the Xcode project calls, never committed. Same shadow wiring in
  `RealtimeClient.swift`. Starts once C3 has proved the binding shape.

**Exit.** Both apps on Play internal and TestFlight with the shadow path, runs
above zero on the dashboard, every budget in section 3 met.

### Phase D. Desktop: native prototype against Electron

- **D1 (M). Prototype onto the core.** Move #1553's `spikes/rust-shell/gpui-chat`
  to `rust/apps/desktop-proto`, replace its HTTP and socket code with
  `pqp-client-core` (the core's second consumer), drive S1 to S3 and S8 through
  `tools/desktop-bench/`. Needs C1.
- **D2 (L). Join a real call.** The LiveKit Rust SDK (Zed ships calls on it, against
  the same media server we run): join an SFU room, publish the mic, mute, deafen,
  roster and speaking state from `/ws`. The prototype declares only `livekit` in
  `transports`, so the server refuses it in mesh rooms, as designed. Exit: a
  two-person call with the web client in which both sides measure the other's
  audio level. **Can start now on a branch** with the spike's own socket code;
  it lands on `main` with D1.
- **D3 (L). Screen share.** Watch a share, then publish one on macOS through the
  SDK's native capture. Per-app share audio is not built; its feasibility on
  macOS and Windows is written down as part of the go bar.
- **D4 (M). Watch party viewer.** Play the party's HLS through the platform player
  (AVPlayer on macOS) with the viewer token, enough to measure S7.
- **D5 (M). Measure.** S1 to S8 on macOS, and S1, S4, S6 and S7 on the Windows
  runner with a Windows build of the prototype, against Phase B's Electron numbers
  on the same machine and the same day.
- **D6 (M). Rust native modules inside Electron, evaluated beside it.** This is
  what Discord shipped for years. Using B4's attribution, list every main or
  utility process path that native code would make cheaper; if one costs 5% of a
  core or more in a scene, build it as one napi-rs module and measure it. Also
  measure `pqp-client-core` in the Electron main process in place of the
  renderer's socket. The honest expectation, written now so it can be checked: a
  native module cannot remove Electron's roughly 420 MB fixed cost, and Chromium
  already gives pqp the native media path Discord had to build, so this route
  wins only on a specific hot path B4 finds. It is the fallback if D fails the
  bar. Runs in parallel with D2 to D4.

**Go bar** (D5, same machine, same scene, median of five):

| Scene | Native prototype must be |
|---|---|
| S1 idle | at most 150 MB total and at most 40% of Electron |
| S4 in a call | at most 50% of Electron's memory and 60% of its CPU |
| S6 watching a share | at most 70% of Electron's CPU, no more dropped frames |
| S5 sharing | no more CPU than Electron, and the viewer gets at least the same resolution and frame rate |
| S7 watch party | at most 50% of Electron's memory |
| S8 startup | median at most 0.5 s on macOS |
| Windows runner | the same ratios for S1, S4, S6, S7 |

And all of: GPUI accessibility in a stable release that VoiceOver and Narrator can
use on the message list, composer and call controls; IME working for pt-BR dead
keys and Japanese; a written, credible path to per-app share audio on macOS and
Windows, global push-to-talk, the share picker, the updater and signing; and an
estimate to beta parity, built from D2 to D4's actual pace, of 9 months or less.
**Any miss is a no-go**, recorded here with the numbers; the prototype stays as
reference and the desktop takes D6's route. A go goes to the owner (section 7).

### Phase E. Adoption on iOS and Android

Runtime flags, registered in `server/src/lib/flags.ts`, served on
`GET /api/client-core/config`, read by the apps at socket open:
`client_core_shadow` (global, default off: compute both, use native, report) and
`client_core_primary_android` / `client_core_primary_ios` (global, default off: use
the Rust answer). Per-platform rather than per-server because one socket serves
every server.

- **E1 (S). Shadow on.** Flip `client_core_shadow`. Every mismatch kind becomes a
  vector in Phase A and a fix in whichever copy is wrong.
- **E2 (S per platform). Primary.** Flip a platform's primary flag once shadow has
  run a full release with zero mismatches and at least 1,000,000 frames and 500
  reconnects compared on that platform. The native path stays in the build.
- **E3 (S per platform). Retire the native copy** after two releases on primary
  with zero mismatches and no crash attributed to the core. From then on the core
  is the only path, like any other code.
- **E4 (M). First payoff.** With the machine shared, bring web's resume behaviour
  to the phones' mesh rooms and to Android (pitfall 11) as one change to the core,
  behind its own flag and capability. Scoped as its own plan section when E2 is
  done on both platforms.

**Exit.** Both apps on primary, native copies removed, the next change to the
protocol or the reconnect rules made once.

## 5. The test bar for every phase

1. **Baseline first.** The number a step is meant to move is measured and
   committed before the step's code is written.
2. **Parity on shared fixtures.** Every Rust or native copy replays the vectors and
   transcripts generated from `@pqp/shared` and agrees with the current
   implementation on all of them, accept and refuse alike.
3. **Runtime flag with two counters.** A run counter proving the path executes in
   production (pitfall 12 is the reason) and a mismatch counter that belongs at
   zero, both on `GET /api/admin/metrics`.
4. **Load or soak where it applies.** Socket and reconnect work runs on
   `tools/reconnect-herd-harness/` and `tools/restart-harness/`; anything on the
   call path runs the `seat-churn` rehearsal in `tools/watch-party-load/`; the
   desktop runs `tools/desktop-bench/`; a phone soak is an hour on a device with the
   network toggled.
5. **Rollback is a flag flip**, never an image rollback or an app release. A native
   desktop client, which a flag cannot switch, rolls back by pointing the updater
   back at Electron.
6. **CI.** `rust.yml` runs `cargo test`, `cargo clippy -- -D warnings` and
   `cargo fmt --check` on changes to `rust/**`, `packages/shared/fixtures/**` and
   `packages/shared/scripts/**`. The parity check is machine-independent: fixtures
   compare as regenerated in memory, and a fixture may hold only protocol facts
   (#1561's `parity.sh` fails because `deflate-vectors.json` records where `ws` was
   found on disk).

## 6. The three open PRs

- **#1561 (Rust core).** Salvaged into Phase A1: the four generator and resolver
  scripts, ported to zod 4, and their coverage rules and lessons. Into C1:
  `pqp-core`'s `proto.rs` and `validate.rs` as the start of `pqp-client-core`, and
  `prove-vectors-inert.mjs` if any committed vector ever carries a token. Not
  salvaged: `pqp-deflate` (its output cap is per connection, not per message:
  `produced_total` is never reset, `lib.rs` lines 632 and 766), `resume.rs`,
  `parity.sh`, `docs/RUST.md`.
- **#1553 (desktop spike).** Salvaged into B1: `electron-bench.mjs`,
  `footprint.mjs`, `electron-profile.mjs`, `electron-retention.mjs` and the seed
  SQL. Into D1 and D2: the GPUI prototype and `gpui-bench.mjs`. Not salvaged: the
  Tauri shell and its bench.
- **#1633 (previous plan).** Superseded by this file. Kept from it: the UniFFI
  design and boundary rules, the per-app budgets, the drift rules, "no crate
  without a consumer", and its out-of-scope list for the server.

## 7. The one decision left to the owner

**Whether to run two desktop clients side by side** (Electron and a native client)
for the months a native client needs to reach parity, if the prototype passes the
go bar. Due when D5's numbers are in and pass, before any work toward a native beta
starts. Everything else in this plan proceeds without a decision.
