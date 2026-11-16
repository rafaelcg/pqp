# Rust in pqp: what is worth doing, and in what order

Written 2026-11-16 after reviewing the two open Rust pull requests, #1561
(`feat/rust-core`) and #1553 (`spike/rust-desktop-2026-11-05`), rerunning what
both of them claim on the same Mac, and reading the code they would sit next
to. Nothing here ships code. It decides what the next Rust branch is, if any,
and what has to be true before it merges.

## The goal

Not "use Rust". The goal is two things the project actually pays for today:

1. **Three hand-copied clients.** The web client reads `@pqp/shared` directly,
   iOS and Android copy every frame and every client-side rule by hand, and the
   copies drift. The clearest recent case is Jam stem placement, fixed three
   times in three languages in the same week (#1594 iOS, #1595 web and
   contract, #1598 Android), after web takes played up to 2 s out of sync on
   phones.
2. **A heavy desktop app.** Electron idles at about 430 MB and grows past a
   gigabyte on a long channel. Discord's announcement (2026-11-04, a GPUI
   rewrite) made the question loud; the measurements below say where the
   weight actually is.

Rust is one tool for each. The plan uses it only where it beats the cheaper
tool, and says which cheaper tool comes first.

## What the two pull requests taught

### #1561, Rust core: voice protocol and resume tokens

What it is: a cargo workspace with `pqp-core` (all 30 server and 19 client
voice frames as serde types, the HMAC resume token, and a table-driven port of
zod's value rules) and `pqp-deflate` (a permessage-deflate implementation),
plus Node generators that import the shipped zod schemas and the shipped
`voice-resume-token.ts` and emit fixtures the Rust tests replay. 16 commits,
25,057 added lines in 41 files, of which about 15,700 are generated fixtures.

What I ran (2026-11-16, merged with `main` locally, 51 commits behind at the
time):

- The branch merges cleanly. `signaling.ts` has not changed since its base, so
  the protocol and constraint fixtures still regenerate identically.
- `cargo test --all-targets`: 58 passed, 2 ignored, in about 8 s of build on an
  M5 Max. Clippy with `-D warnings` and rustfmt are clean.
- Rust-minted resume tokens are accepted by the shipped `verifyVoiceResumeToken`
  (mesh, livekit with region, livekit without region) and the expired one is
  refused. `ws` reads every frame the Rust deflater produced.
- **`./rust/scripts/parity.sh` fails**, locally and in CI on the last two
  pushes, at the drift step. The only diff is `"wsResolvedVia"` in
  `deflate-vectors.json`, which records how the generator found the `ws`
  package (`node_modules/.pnpm` in one environment, `server/package.json` in
  another). The drift check is pinning a property of the machine, not of the
  protocol.

What the review found:

- **The resume token port is faithful.** Same purpose-bound key derivation,
  same claim order, same absent-versus-empty region rule, same expiry and
  transport checks. The two implementations differ only on payloads Node never
  mints (for example `"v":1.0`, a missing `e`, duplicate keys), and reaching
  those needs the signing key, so it is not a pitfall-16 shaped hole.
- **Nothing consumes it.** There is no `cdylib`, no UniFFI, cbindgen, napi-rs
  or wasm-bindgen. The server, the desktop shell, iOS and Android are all
  unchanged. The crate is tested and reachable from nowhere.
- **Its destination is a Rust `/ws` gateway in front of Node** (its phase 2),
  then a Rust core under Electron (phase 4). The PR's own measurements argue
  against the first: the Node socket path runs no zod on client frames at all,
  so Rust validation is about 240 ns a frame *more* work than today, not less,
  and the API box sat at 3 % CPU while its pool filled (pitfall 22); the
  server incidents in CLAUDE.md's pitfall list (13, 17, 18, 22) were Postgres,
  locks and write ordering, none of them Node running out of processor. #1553
  argues against the second: the desktop's weight is the renderer's React
  tree, which a Rust core in the main process does not touch.
- **It adds a fourth hand copy.** The generator refuses to write fixtures when
  a zod union arm has no Rust variant. That is the right rule for a port, and
  it means every new voice frame needs a `proto.rs` change from whoever adds
  it, for a crate nobody calls.
- **`pqp-deflate` has a bug that would hang up every long call.**
  `Inflater::produced_total` is incremented on every message and only ever set
  at construction (`rust/crates/pqp-deflate/src/lib.rs`, the
  `produced_total > max_output_bytes` check in `inflate`), so the 128 KiB cap
  is per connection lifetime, not per message. A gateway on it refuses every
  frame after about 128 KiB of decompressed traffic. Farol flagged it along
  with four more framing and allocation findings in the same crate. Writing
  RFC 7692 ourselves is security-sensitive work with no product benefit at our
  CPU levels.
- **The genuinely valuable part is language-neutral.** The generators that
  import the real schemas, read coverage off the zod unions instead of a
  maintained list, demand a filled and a null example for every nullable
  object, and prove each value rule with a frame zod refuses: none of that
  needs Rust. It is exactly what the Swift and Kotlin contract tests lack.
  Today `WireProtocolTest.kt` checks frame *names* by reading `packages/shared`
  source; nothing hands a phone a real frame of every arm and asks it to
  decode it.

Two findings belong to Node and stand on their own:

- The client socket path validates nothing beyond `JSON.parse` and a type
  switch (`server/src/ws/index.ts`, `isClientRelayMessage` in
  `server/src/ws/voice.ts`). Whether that should change is a product decision;
  if it does, a shadow count in Node comes first.
- `resumeSecret()` falls back to the published constant `pqp-dev-voice-resume`
  whenever `DEV_AUTH_BYPASS=true` and `CLERK_SECRET_KEY` is empty, without the
  `NODE_ENV` guard the auth bypass itself has. Production always has the Clerk
  key, so this is a hardening item, not an incident.

### #1553, the desktop spike: Electron, GPUI, Tauri

What it is: Playwright drives the unchanged `electron/main.js` against a local
production build; a GPUI window draws the same channels from the same local API
into a virtualized list; a Tauri 2 shell loads the web client in WKWebView.
macOS `phys_footprint` per process, CPU from `ps`.

I reran the Electron and GPUI benches on 2026-11-16, same M5 Max, against the
current `main` client and a fresh database seeded with the README's 5,000
messages, using the spike's bench scripts unchanged (one Electron `full` run,
three cold and three warm startups, two GPUI `full` runs; Tauri was not
rebuilt):

| | Spike, 2026-11-05 | Rerun, 2026-11-16 |
|---|---|---|
| Electron, idle on one channel | 418 to 425 MB | 428 MB |
| Electron, 2,000 messages loaded | 1,203 MB, 100,743 DOM nodes | 1,170 MB, 100,775 DOM nodes |
| Electron, back on the light channel after that | 1,495 MB | 1,523 MB |
| Electron, channel switch (heavy / light) | 55 / 33 ms | 63 / 31 ms |
| Electron, alone in a call (fake devices) | about 700 MB, 21 to 24 % CPU | 694 MB, 14.9 % CPU (GPU process 411 MB) |
| Electron, launch to first message | 0.89 s (one run) | cold median 1.66 s (1.65 to 3.65), warm median 2.76 s (1.68 to 2.81), 3 runs each |
| GPUI, idle | 79 MB | 79 MB (two runs) |
| GPUI, channel switch (heavy / light) | 22 / 21 ms | 14 to 15 / 14 to 15 ms |
| GPUI, 2,000 messages, before any scroll | 87 MB | 85 MB |
| GPUI, 5,000 messages, after scrolling through 2,000 | 89 MB | 212 to 224 MB |
| GPUI, back on the light channel after scrolling 5,000 | 89 MB | 412 to 422 MB |
| GPUI binary | 8.1 MB | 8.1 MB (8,078,624 bytes) |

What that says:

- **Electron's memory numbers reproduce within a few percent.** The GPUI
  headline does not. The spike's raw GPUI file is named
  `gpui-full-run1-sweep-invalid.json`: its scroll sweep never drew the rows,
  and the "89 MB at 5,000 messages" in the report came from that run. With the
  bench on the branch, whose sweep does draw them, GPUI grows to about 215 MB
  at 5,000 and holds about 415 MB after leaving the channel, still with no
  images, embeds or avatars. Still lighter than Electron's 1.5 GB after the
  same walk, but by about 3.7 times (1,523 MB against 412 to 422 MB), not the
  14 times the report's 1,203 MB against 87 MB implies.
- **Startup does not reproduce either.** The spike timed one Electron launch,
  and on a machine with other work running the same build ranged from 1.6 to
  3.7 s. Treat startup as unmeasured until it is run on an idle machine with
  at least five runs.
- **The comparison is honest about itself and still lopsided.** The GPUI window
  renders plain text and code fences: no markdown, reactions, embeds,
  attachments, hover toolbars, composer, IME, accessibility, i18n or voice. Its
  own header calls it a lower bound. The Tauri column was measured with the
  screen locked and should not be quoted.
- **The workload a voice app lives in was never compared.** No screen share was
  measured on any stack, no call with real peers, nothing on Windows or Linux,
  and neither prototype can join a call.
- **The 2,000-message gap is a web client bug, not a runtime.** Every loaded
  message stays mounted (`content-visibility: auto` saves layout and paint, not
  the roughly 175 KB of React and Radix state per row). Windowing the list is
  weeks, not a rewrite.

**The spike's conclusion stands:** do not rewrite the desktop now and do not
move to Tauri (WKWebView needs usage keys before it exposes `mediaDevices`,
the spike found WebKitGTK builds without WebRTC on Linux, and the shell would lose
the Windows loopback add-on, the macOS CoreAudio tap Electron 39 gives for
free, the Linux `pactl` bus, the picker, global push-to-talk and the updater).
Fix the web client inside Electron first, then decide about a native client
with numbers that include a call and a share.

## The strongest arguments, both ways

**For Rust now.** A native client is several times lighter at idle, and that
is the Electron fixed cost (about 420 MB, six processes), which no amount of
web client work removes. GPUI is not a toy framework: Zed ships it, and Zed's
calls and screen sharing run on the LiveKit Rust SDK, the same media server we
run. A shared Rust core is the one design where a client rule is written once
for both phones, which is the exact shape of the Jam placement bug.

**Against.** Nothing that hurts users today is a Rust-shaped problem. The
desktop's gigabyte is an unwindowed list; the server's incidents are Postgres;
the phones' drift is mostly frames and small rules that generated vectors
catch for a fraction of the cost. A native desktop client is a fourth UI over
the same 500,000 lines of product, rebuilt without the web client's tested
WebRTC path, share audio on three operating systems, picker, push-to-talk,
updater and signing, for two people who already ship web, iOS and Android.
And every Rust step so far has produced a well-tested crate nobody calls.

The plan below takes the "against" side for 2026 and leaves a dated door open
for the "for" side, with the conditions that would have to be true.

## Scope worth doing first

In order, and the first two contain no Rust at all. That is deliberate: they
remove most of the cost the goal names, and they are the measuring stick any
Rust step has to beat.

1. **Protocol and rule vectors for every client** (salvaged from #1561). Move
   the generators to `packages/shared/scripts/`, commit their output to
   `packages/shared/fixtures/`, and make the web, iOS and Android test suites
   decode and re-encode every valid vector to zod's canonical form, and refuse
   (or at least never apply) every vector zod refuses, at the path zod blames
   where the client validates at all. Extend the house pattern of
   `channel-layout-cases.json` to client-side rules with a history of drift:
   Jam stem placement and offsets first, the roster delta convergence rule
   second.
2. **Electron diet**, from #1553's own list: window the message list to a few
   hundred rows with the hover toolbar mounted on demand, throttle the speaking
   detector to 15 to 20 Hz and notify on change, split the 1.3 MB App chunk.
   Keep the bench, with budgets, so the decision in milestone 4 has a baseline.
3. **One Rust module shared by iOS and Android**, only if milestone 1 has run
   for a while and logic drift (not shape drift) is still costing fixes in two
   languages. This is the only Rust in the plan before 2027.

## FFI and build design, for milestone 3

- **UniFFI**, proc-macro mode, one crate `pqp-mobile-core` in `rust/`. It
  generates Swift and Kotlin bindings from the Rust signatures, which is the
  whole point: no hand-written C header to drift.
- **The boundary is narrow and value-typed.** Plain records in, plain records
  out, no callbacks, no async across the boundary, no objects that outlive a
  call. The pilot module is a pure function of its inputs (for Jam: a take's
  recorded offsets and the song's timeline in, placements out), so the apps
  keep their own state, networking and UI.
- **iOS:** an XCFramework for `aarch64-apple-ios` and `aarch64-apple-ios-sim`
  (add `x86_64-apple-ios` only if an Intel simulator still matters), built by a
  script the Xcode project calls in a build phase, and checked into neither
  git nor the app: CI builds it.
- **Android:** `cargo-ndk` for `arm64-v8a` and `x86_64` (the emulator), plus
  `armeabi-v7a` only if Play Console says the 32-bit share is worth it. A
  Gradle task runs before `preBuild`.
- **Web keeps TypeScript.** Shipping wasm to replace a few hundred lines of TS
  costs more than it saves. The vectors from milestone 1 keep the TS and the
  Rust copy honest against each other, so the count goes from three copies to
  two, not to one.
- **Budgets the pilot must meet:** each app grows by at most 2 MB per ABI,
  iOS and Android CI each grow by at most 6 minutes warm, a cold `cargo build`
  of the crate stays under 2 minutes on the M5 Max, and a developer who never
  touches Rust can still build either app from a clean checkout with one
  documented command.

Nothing on the server or in Electron links Rust in this plan.

## Test and drift strategy

- **`packages/shared` stays the only source of truth.** Every other copy, Swift,
  Kotlin or Rust, is tested against vectors generated from it.
- **Generated, not hand-written.** Vectors come from the shipped schemas and the
  shipped rule functions, imported directly, never from a copy. Coverage is read
  off the zod unions, so a new arm without a vector fails the generator.
- **Stale fixtures fail CI**, and the drift check compares only what the
  protocol defines. No paths, versions or resolver details in a committed
  fixture, which is the exact way #1561's gate went red.
- **Both directions where a peer has to accept our output.** For anything a
  client sends, the client encodes, and the shipped zod schema in Node parses it,
  in CI.
- **One test file per client per fixture**, named the same in each, so a reviewer
  can see the three agree. A client that does not yet handle an arm lists it in
  an explicit allowlist that fails the day the arm is handled, the same rule
  `announcedAheadOfShared` already follows in `WireProtocolTest.kt`.
- **Trigger paths include the fixtures and the generators**, not only
  `packages/shared/src/**`, so a lockfile or generator change cannot bypass the
  gate (a Farol finding on #1561).

## Milestones

Estimates assume two people in spare time with agents doing most of the typing
and humans reviewing and testing on devices, roughly 8 to 12 focused hours a
week between them.

| # | Milestone | Exit criteria | Estimate |
|---|---|---|---|
| 0 | Close #1561 and #1553 with a pointer here; open Node issues for client frame validation and the resume dev key | Both PRs closed, branches kept, two issues filed | 1 evening |
| 1 | Shared vectors: generators in `packages/shared/scripts/`, voice frames and value rules first, then Jam placement and roster delta cases; decode tests in web, iOS and Android | All three suites round-trip every valid vector and never apply a refused one, in CI; adding a voice frame arm without vectors fails `packages/shared` tests; one drift bug caught by a vector before review | 2 to 3 weeks |
| 2 | Electron diet with a committed bench (`tools/desktop-bench/`, salvaged from #1553) and budgets | 2,000 loaded messages under 500 MB; leaving a heavy channel under 100 ms; in-call CPU measured with two real peers and with a share; startup measured with five or more runs on an idle machine | 4 to 6 weeks |
| 3 | Optional Rust pilot: `pqp-mobile-core` with one pure module behind a runtime flag in both apps | Ships to TestFlight and Play internal; meets every budget above; the vectors pass on the Rust copy; the next change to that module is made once instead of twice | 6 to 8 weeks |
| 4 | Desktop decision, around Q2 2027 | A written go or no-go with numbers from milestone 2 against a native prototype that can join a call and share a screen. Go only if GPUI has shipped accessibility in a stable release, Discord's client has shipped, desktop performance is still a top complaint after milestone 2, and both of us accept that every UI change becomes a signed release on three operating systems | 2 weeks of measuring |

Milestone 3 is the only step that adds a toolchain. If milestone 1 leaves
nothing but shape drift, which vectors already catch, skip it and record that
here.

## Explicitly out of scope

- **A Rust `/ws` gateway or any Rust process on the server path.** Reopen only
  on a measured ceiling: the API process above 60 % CPU at a real event peak,
  after Node-side fixes are exhausted. It would also have to solve
  permessage-deflate (no mainstream Rust WebSocket stack implements RFC 7692,
  per #1561's survey), the 128 KiB payload cap on both legs, `CF-IPCountry`
  and user agent passthrough, and the `TRUST_PROXY` hop count.
- **Our own permessage-deflate.** Never, for the reasons above.
- **Tauri.**
- **A GPUI rewrite before milestone 4's conditions hold.**
- **A Rust voice or media engine.** LiveKit and libwebrtc already are one, and
  the web client's WebRTC path is the most tested code we have.
- **wasm in the web client** for shared logic.
- **Porting the existing Windows share-audio add-on** (1,200 lines of working
  C++). napi-rs is the right choice for the next native helper the shell needs,
  not a reason to rewrite this one.
- **Rewriting `server/src/ws/voice.ts`** or any of the room rules in it.

## Risks

- **A copy nobody calls.** The failure mode of #1561. Rule: no Rust crate
  merges without a consumer that ships in the same milestone.
- **Toolchain tax on the person who does not write Rust.** Every iOS and
  Android build gains a cargo step. The budget in milestone 3 and the
  one-command build are there for this, and the pilot reverts if they slip.
- **Debugging across FFI on a phone.** A panic in Rust is a crash with a
  less useful stack. The pilot module is pure and total (no panics on any
  input, asserted by a property test), and the app keeps its own copy behind
  the flag until the Rust one has a release of clean crash reports.
- **Store review and size.** Extra native libraries are routine for both stores,
  but app size is visible on Play. The 2 MB per ABI budget is measured from the
  release artifact, not estimated.
- **Measuring the wrong thing.** Both PRs measured carefully and still compared
  against a step that does not run (zod on the socket) or against a toy (GPUI
  without voice). Every number in a milestone exit names the scene, the run
  count, the machine and what it is compared against.
- **Discord's announcement as a deadline.** It is not one. Their voice engine
  was already native C++ inside Electron; they replace the UI layer, we would
  replace both.

## Cost

Milestones 0 to 2: about 7 to 10 weeks of calendar time, no new toolchain, and
they are worth doing even if no Rust ever ships. Milestone 3: another 6 to 8
weeks plus a permanent cost of perhaps an hour a week keeping three build
systems happy. Milestone 4: two weeks of measuring before a decision, and if the
answer is go, the spike's own estimate of 6 to 9 months to beta parity for a
native desktop client, which is a different plan.

## What to do with the open pull requests

**#1561: close without merging; keep the branch.** Salvage, in milestone 1:

- `rust/scripts/gen-proto-vectors.mjs`, `gen-constraints.mjs`,
  `ts-resolve-hook.mjs` and `ts-register.mjs`: move to
  `packages/shared/scripts/`, drop the Rust-specific outputs, keep the coverage
  rules (union arms, nullable twins, proved violations).
- `gen-resume-vectors.mjs` and `prove-vectors-inert.mjs`: only if a client ever
  needs to read a resume token; today none does, so leave them on the branch.
- The lessons, which belong in the generator's comments: optional is not
  nullable (`canSpeak` versus `cameraStreamId`); a nullable object needs a
  filled and a null example; read state is not write state (`MusicState`
  versus `MusicStateWrite`); `.max()` on an array counts items; zod's `.url()`
  accepts `javascript:` and `data:`.
- `docs/RUST.md` and `pqp-core` stay on the branch as reference for the day a
  Rust consumer exists. `pqp-deflate` does not get salvaged.
- The GitGuardian incident (39776452) can be closed as a false positive with
  the branch: the eight hits are HMACs over fake claims with a committed fake
  key, all expired in 2023, and `prove-vectors-inert.mjs` shows it.

**#1553: close; it was always a spike.** Salvage `bench/electron-bench.mjs` and
`bench/footprint.mjs` into `tools/desktop-bench/` in milestone 2, with the seed
SQL from its README as a script. Keep the branch for the GPUI and Tauri
prototypes, which are the reference for milestone 4.
