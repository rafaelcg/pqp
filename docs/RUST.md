# Rust core

What a Rust rewrite of pqp means, in what order, and what has to be true before
any of it ships. Started 2026-11-07, after Discord's CTO confirmed Discord is
rebuilding its desktop client in Rust.

## What Discord actually said

From Stanislav Vishnevskiy (Discord co-founder/CTO) on 2026-11-04, as reported
by [TechSpot](https://www.techspot.com/news/114462-discord-rebuilding-desktop-app-rust-fix-memory-problem.html),
[bool.dev](https://bool.dev/news/detail/discord-rust) and
[Windows Latest](https://www.windowslatest.com/2026-11-05/discord-is-killing-its-electron-app-that-can-eat-4gb-of-ram-on-windows-11-and-the-rust-rebuild-uses-just-290mb/):

- Desktop drops Electron **and** the JS UI. The interface is native Rust on
  [GPUI](https://www.bool.dev/news/detail/discord-rust), the GPU-accelerated
  framework from Zed's authors; Discord has local changes and may upstream some.
- Mobile drops React Native but keeps its native interfaces, sharing
  application code with desktop through Rust.
- Embedded experiences (YouTube, Activities) still run in the OS webview.
- A development build ("Discord Phoenix") showed ~290 MB with two accounts
  signed in. Their Windows Electron client has been acknowledged to reach ~4 GB.
- Stated goal is to preserve current appearance and behaviour. User testing is
  hoped for "soon"; no date.

What is **not** established, and should not be quoted back at us:

- No published benchmark. The 290 MB is one developer's Task Manager, two
  accounts, against no controlled measurement of the Electron client.
- The "~5% reduction" figure circulating is from an earlier, different change.
- Discord's older Rust work is a different workload: the 2020 Read States
  service moved Go→Rust to escape garbage-collection latency spikes, and Rust
  already sits in voice, the game SDK, Go Live capture/encode, Elixir NIFs and
  the updater. None of that measures a UI rewrite.

The transferable part is not "use Rust". It is: put state and protocols in a
headless core, keep it testable without an app, ship it incrementally, and
measure.

## Why a big-bang rewrite is not a plan

Measured on `main` today, lines of first-party source:

| Surface | Files | Lines |
|---|---|---|
| `client/src` (React 19 SPA) | 1,941 | 505,541 |
| `server/src` (API, `/ws`, voice signalling) | 675 | 347,740 |
| `ios` (SwiftUI) | 355 | 111,391 |
| `android` (Kotlin + Compose) | 451 | 111,564 |
| `packages/shared` (Zod protocol) | 153 | 43,288 |
| `electron` (JS shell) | — | 12,139 |

About 1.13 million lines, plus 1,329 test files that encode behaviour nobody
wants to re-derive. Roughly 13,700 of those lines are `server/src/ws/voice.ts`
on its own, and that file is mostly accumulated product rules — seats, eviction,
roster access, resume, transport pinning — not infrastructure.

Rewriting all of it in one branch produces a long-lived fork that diverges
faster than it can be ported, ships nothing, and loses every regression the test
suite already encodes. The plan below therefore only allows steps that ship on
their own, with the existing suite still green.

## The contract every phase owes

1. **Byte-compatible on the wire.** While Node and Rust run side by side behind
   the same load balancer, a frame or credential produced by one must be
   accepted by the other. Otherwise a rolling deploy is a hangup, which
   `docs/VOICE_RESUME.md` exists to prevent.
2. **Differential regression, not hand-written expectations.** Fixtures are
   generated from the shipped TypeScript — the real Zod schemas, the real token
   module — and the port is compared against them. An expectation written from
   the port tests the port.
3. **Loud refusal over silent mis-read.** Anything the port cannot honour is
   refused, and refusing is asserted in a test. A half-parsed frame becomes a
   wrong room state.
4. **The existing suite stays green.** 1,329 test files, plus the e2e matrix in
   `ci.yml`. A phase that cannot show both is not done.
5. **Labels honestly.** A change that reaches `server/` or `packages/shared` is
   `restarts-api`. `drops-voice` only when the change itself hangs up a live
   call after resume, per `AGENTS.md`.
6. **A number, or it is not a win.** Each phase states the memory or startup
   measurement it is supposed to improve and how that is measured. "Rewritten in
   Rust" is not a result.

## Phases

Each row is a separate branch and PR. Nothing here blocks the row above it.

| # | Step | Why this order | Done when |
|---|---|---|---|
| 0 | `rust/` cargo workspace, `pqp-core` with the voice protocol and resume tokens, differential gate in CI | Cheapest place to prove the contract, and the two pieces where cross-language interop is already mandatory | This PR |
| 1 | Extend `pqp-core` to the remaining server frames (audience, watch-party, music, soundboard, live, reactions) | Mechanical now that the harness exists; closes the last cross-language surface | `pending` list empty, 30/30 server vectors round-trip |
| 2 | Rust `/ws` gateway **alongside** Node: it terminates sockets for one canary hall and proxies the rest to Node | Smallest live footprint that exercises the real thing; resume and peer-id rules are the risk and are already pinned by vectors | Canary hall reconnects survive a Rust restart at the same rate as a Node one |
| 3 | Postgres read path for the frames the gateway can answer itself | Removes Node from the hot path without touching writes | Byte-identical HTTP responses on a recorded corpus |
| 4 | Desktop: Rust core behind the Electron shell, owning app state and the socket, JS still drawing pixels | This is where the memory claim is testable, and it is reversible | Measured RSS drop on the same scene, both builds |
| 5 | Decide the UI: keep the web UI on a Rust core, or a native GPU UI like Discord's GPUI bet | Only answerable after 4 produces a number | A written go/no-go with measurements, not a preference |

Phase 5 is a genuine fork in the road and the most expensive decision in the
document. Discord replaced its UI because it could absorb that cost; pqp has one
fewer order of magnitude of users to amortise it over, and iOS and Android
already ship native. Do not decide it before phase 4 has a number.

## What landed in phase 0

```
rust/
  Cargo.toml                    workspace
  crates/pqp-core/
    src/lib.rs                  VoiceRoomTransport
    src/proto.rs                voice wire protocol, both directions
    src/resume.rs               HMAC resume tokens
    tests/proto_parity.rs       frames vs zod
    tests/resume_parity.rs      tokens vs the shipped module
  fixtures/                     generated, committed, diffed in CI
  scripts/                      generators, reverse verifier, gate
```

Run it:

```bash
./rust/scripts/parity.sh
```

That regenerates fixtures from the TypeScript, fails if the committed fixtures
have gone stale, runs `cargo test`, sends Rust's own tokens back through the
Node verifier, then clippy and rustfmt. `cargo test` on its own only proves one
direction, and the missing direction is the one that hangs up calls.

Two fidelity rules the port enforces, both learned from failures the harness
caught while it was being written:

- `T.optional()` and `T.nullable().optional()` are **not** the same field. A
  plain Rust `Option<T>` reads `canSpeak: null` as `None`, while zod refuses it:
  `canSpeak` is optional, not nullable. `cameraStreamId: null` and an absent
  `cameraStreamId` really do mean the same thing. `proto.rs`'s table is the
  mapping, and `strict_option` is what makes the first row actually reject null.
- Resume-token claim order and the absent-vs-empty region rule are part of the
  wire format, because the payload is hashed as bytes. Rust mints tokens
  byte-identical to Node, asserted for four claim shapes.

`server/src/ws/voice-resume-token.ts` documents why the token exists: `peerId`
is on every roster, so after a restart "claim this unused id" would let anyone
who read the roster take someone else's seat and force the real owner into a
cold join that drops their audio. Any Rust replacement inherits that threat
model, not just that format.

## Measuring, when a phase claims it

Both builds, same scene: one hall, ten text channels of history loaded, four
peers in a mesh call, five minutes idle. Linux `smaps_rollup` / macOS
`footprint`, median of five cold starts, resident set after the five minutes.
Record the pqp version and the machine. Until a phase can show that table it has
a rewrite, not a memory improvement.

## Risks worth naming early

- **Two protocol definitions.** `packages/shared` stays the source of truth;
  the Rust port is checked against it in CI on every change to
  `packages/shared/src/**`. A Rust type that diverges fails `rust.yml`, not a
  user's call.
- **The port drifts behind the product.** pqp ships continuously. The stale
  fixture check exists so drift is a red CI rather than a behaviour change in
  production.
- **Partial ports that half-work.** Refusal is asserted per pending frame, so a
  pending arm cannot quietly become a permissive one.
- **Cost of phases 2 and 4.** Both add a runtime to operate (deploy, metrics,
  on-call). Phase 2 is scoped to one hall for exactly that reason.
