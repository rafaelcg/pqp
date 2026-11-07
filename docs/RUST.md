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

(Phases 0 and 1 share #1561: phase 0 sat unreviewed while phase 1 was already
mechanical, and one reviewer reading a complete protocol port is cheaper than
two reading half of it. Phase 2 onward is its own branch again.)

| # | Step | Why this order | Done when |
|---|---|---|---|
| 0 | `rust/` cargo workspace, `pqp-core` with the voice protocol and resume tokens, differential gate in CI | Cheapest place to prove the contract, and the two pieces where cross-language interop is already mandatory | Landed, #1561 |
| 1 | Extend `pqp-core` to the remaining server frames (audience, watch-party, music, soundboard, live, reactions) | Mechanical now that the harness exists; closes the last cross-language surface | Landed, #1561: `pending` empty, all 30 server arms and all 19 client arms round-trip |
| 1b | Port zod's **value** rules into `pqp-core` — `.uuid()`, length and item bounds, `.url()`, the soundboard `.refine` — as generated data, each proved against a frame zod refused | Structure is not validation: a Rust socket that ends connections has to refuse what Node refuses, or the two disagree about who may be in a room | Landed, #1561: 287 rules over 32 arms, every one proved against a frame zod refused |
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

## What landed in phase 1

The server union is complete. The eight arms that `pending` excused —
`voice-audience`, `watch-party`, `music`, `channel-music`, `live-reactions`,
`soundboard-play`, `voice-stream`, `channel-live` — are now Rust variants, with
`VoiceAudienceChange`, `MusicState`, `ChannelMusicTrack`, `LiveReactionCount`,
`LiveHlsStream` and their enums beside them. `pending` is empty.

Three things that only showed up once the frames were actually ported:

- **`music` and `set-music` do not share a state type.** The read form defaults
  `openControls`, `repeat`, `skipVotes` and `history`, so they always serialize;
  in the write form the same names mean "unchanged" and must stay absent, or a
  position sample wipes the room's skip votes. The fixture now pins both, and
  the sparse write is one of its vectors.
- **`channel-music` carries a different track shape from `music`.** Video id,
  title, thumbnail and a listener count — not a `MusicTrack`. Reusing the
  familiar type here would have been a wrong frame nobody notices.
- **An arm with a nullable nested object needs two examples.** With one, both
  wrong ports look right: expanding `null` into an all-`null` object (the
  `candidate: null` bug from phase 0) and dropping a present object each pass a
  single-example fixture. The generator now derives the field list from the
  schema and refuses to write until each one is seen filled and null. It found
  four arms nobody had thought about — `welcome`, `ice-candidate`,
  `set-watch-party`, `set-music` — and demanded their second example.

```
69 vectors over 49 arms (30 server, 19 client), 9 tests
./rust/scripts/parity.sh → pass; clippy and rustfmt clean
```

## What landed in phase 1b: the values

Serde answers "is this the right shape". Zod also answers "is this a legal
value", and the gap between those two is a room where two machines disagree
about who may stay. `src/validate.rs` is the value layer, and it names no field,
no arm and no number: the rules arrive as `fixtures/constraints.json`, generated
from the shipped schemas by `rust/scripts/gen-constraints.mjs`. A constraint
added to `packages/shared` is therefore enforced by Rust on the next
regeneration, and `parity.sh` fails on the stale fixture if nobody regenerates.
That regeneration nearly shipped as a no-op: it was guarded by a `node -e
'import("zod")'` probe, and pnpm does not hoist zod to the workspace root, so the
probe answered "missing" from there, skipped both generators, and left the gate
green with no drift check behind it. The probe now asks from `packages/shared`,
the package that depends on zod and where the shipped sources resolve it.

Four decisions in it are load-bearing:

- **The generator proves each violation.** For every rule it builds a frame that
  breaks that rule and only that rule, and shows it to zod; if zod does not
  refuse it at the path being broken, the generator throws. All 287 rules have
  such a frame. Reaching that number fixed two bugs in the probe rather than in
  the port: a path ending in `[]` walked to the elements and then never assigned
  the value, and a probe that found the field missing on the first element of an
  array gave up instead of checking the next one. What stayed unproved after that
  was an example that simply did not carry the field — a join that resumes, a
  raised hand, a live stream's tuning, a music `history` — so the vectors now
  carry them. `tests/value_parity.rs` fails if coverage stops being total, and the
  generator still writes any rule it cannot prove to `skipped` with a reason.
- **An unrecognised constraint stops the build.** A `.regex`, `.email` or
  `.multipleOf` added to a schema, or a `.refine` the generator cannot name,
  throws. `Rule` in Rust is a closed enum, so a rule kind the port does not
  implement fails to load as well — and a table that fails to load refuses every
  frame rather than letting them through.
- **`.refine` is identified by behaviour.** Zod wraps a refinement in its own
  closure, so a predicate cannot be recognised by identity. The generator runs
  the schema's refinement and every exported `is*` predicate from `soundboard.ts`
  against a corpus and takes the one that agrees on every value; ambiguous or
  unmatched is a throw, never a guess. What zod answered, value by value, ships
  in the fixture, so the port is pinned to the predicate's behaviour and not to a
  description of it.
- **`.max(64)` on an array counts items.** Probing zod showed `skipVotes`,
  `queue`, `history` and `items` are bounded by item count, not string length, so
  the rule kinds split: `state.skipVotes` is the array, `state.history[].title`
  is a field of each element. `[]` binds to the key in front of it, and a round
  trip test keeps the port's path reader honest about that spelling.

```
287 value rules over 32 arms, 287 proved violations, 0 reported unproved
tests/value_parity.rs 9 tests, validate.rs 7 unit tests
./rust/scripts/parity.sh -> pass; clippy, rustfmt and eslint clean
```

**Not true yet.** Nothing calls `validate` from a runtime path: the Node server is
still the only thing that ends a socket. The layer is a gate phase 2 has to open,
not a behaviour that shipped, and it is worth measuring how long a frame takes to
value-check before it does.

**What phase 2 now owes.** Call `validate::client` / `validate::server` on the
same path that closes the socket, with the resume and peer-id rules — already
pinned by `fixtures/resume-vectors.json` — in front of it, and keep value
coverage total: the gate fails if a rule ships without a proved violation, so a
new field needs an example frame in `gen-proto-vectors.mjs` rather than a rule
written by hand. Then the protocol below: a number, or it is not a win — and
"## Measuring" already says the validation path is not where that number comes
from, so phase 2 has to name which number it is chasing before it starts.

## Measuring, when a phase claims it

### Checking one frame, Rust against zod

The corpus is the one the tests already use — the 72 frames in
`fixtures/proto-vectors.json` — and each stage is billed once per frame: median of
three runs, macOS aarch64, Node 26.13.0, `pqp-core` in release.

```
                 json    shape    rules   checked      ns/frame
zod   client      212      418        -       631
pqp   client      209       96      150       455
zod   server      336      873        -      1209
pqp   server      341      175      206       720
```

```
cargo run --release --example throughput
node --experimental-strip-types --no-warnings \
     --import ./rust/scripts/ts-register.mjs rust/scripts/frame-throughput.mjs
```

Read the asymmetry before the totals: zod checks shape and values in one pass, so
its `shape` column covers both Rust rows. `checked` is the comparable column, and
the port is **28% faster on client frames and 40% faster on server frames**.

How it got there is the part worth keeping. The first time this was measured the
port *lost* — 828 against 631 on client frames — and the write-up blamed the design:
a table-driven validator walks a generic `serde_json::Value`, roughly ten rows per
arm at two or three segments each, so it must pay a couple of dozen map lookups per
frame while zod runs a validator compiled per schema. That explanation was wrong,
and measuring it is what found the real cost: the walk allocated a `Vec` per segment
per candidate and a path `String` per segment, to describe paths nobody read on a
frame that was fine. Map lookups were never the story. `collect` walks into one
scratch buffer reused across the frame and names a path only when a rule actually
fails, which took `rules` from 522 ns to 150 ns and turned a 30% loss into a 28%
win. Two things to remember from that:

- A number that confirms the plan is worth a second look; a number that contradicts
  it is worth the afternoon, because it was the implementation, not the design.
- Before blaming a data-driven approach for a cost, count what it allocates per
  frame on the path where nothing is wrong.

Both walks are kept: `collect` for the passing case, `select` (which carries a
trail) for the failing one, and `check_path` refuses rather than dropping a
violation if the two ever disagree about how many nodes a path names.

### Memory, when a phase claims it

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
