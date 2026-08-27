# Watch party: module boundaries

Watching a YouTube video together. The wire contract lives in
`packages/shared/src/watch-party.ts` and is the first thing to read; this file
covers only how the client side is split up and why, because the split is not
the obvious one and getting it wrong is the failure this feature is prone to.

**No video or audio passes through our infrastructure.** Every participant
streams from YouTube directly through the IFrame Player API. No media track is
ever published for this feature. If a design starts to need one, that is a
different feature with a different cost model, and it needs a decision rather
than a commit.

## The split

| Module | Owns | Must never contain |
|---|---|---|
| `watchParty/state` | LWW reducer, wire codec, echo suppression, drift ladder, resend, URL parser | DOM, player handles, network calls |
| `watchParty/player` | An imperative shell over the IFrame API | Any decision at all |
| `watchParty/ui` | React components reading state, dispatching intents | Any sync logic |

`state` is pure. It takes `now` as an argument and never reads the clock
itself, the same way `client/src/lib/call-rating.ts` and `lib/acquisition.ts`
take theirs. That is what makes the parts worth testing testable, and
`client/vitest.config.ts` sets `environment: "node"` deliberately, so there is
no DOM to lean on.

## Why the sync logic is not in the player

This is the part that surprises people, so it is worth stating the reasoning
rather than the rule.

The drift ladder needs the remote state and the local position together, and
only `state` has both. Echo suppression needs the last state the room
*adopted*, and again only `state` has it. Putting either in the player wrapper
would mean importing sync logic into the player wrapper, at which point the
reducer stops being the single source of truth and nobody can test the part
that matters.

So `state` returns commands and `player` executes them without judging them:

```ts
type PlayerCommand =
  | { kind: "load"; videoId: string; positionMs: number }
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "seek"; positionMs: number }
  | { kind: "setRate"; rate: number };
```

**Both `PlayerCommand` and `PlayerEvent` are declared in `state.ts`, and
`player.ts` imports them.** The arrow points at the pure module: `state`
depends on nothing, and the alphabet is the reducer's input, not the shell's
output. The deeper reason is that **the player is the replaceable half**:
declare the alphabet in `state` and a second player writes to it; declare it in
the player and the reducer is rewritten for every new player. Two structurally
similar declarations in two files are not a shared contract; see the last
section of this file for what that cost once.

The player reports flat facts back and takes no view on whether an event came
from a person or from a command it just ran. `state` decides that, because
`state` is the only module holding the information the decision needs.

```ts
type PlayerEvent =
  | { kind: "ready" }
  | { kind: "phase"; phase: PlaybackPhase; positionMs: number }
  | { kind: "position"; positionMs: number; jumpedFromMs: number | null }
  | { kind: "rate"; rate: number }
  | { kind: "failed"; failure: PlayerFailure };
```

Two things about `position` are load-bearing and easy to undo.

**It is emitted on every poll, not only when something surprising happens.**
Two different consumers read it: the drift ladder needs a position on every
sample, and scrub handling needs the rare discontinuity. Emit only on the
discontinuity and the ladder receives nothing at all, silently, for ever.

**`jumpedFromMs` is the discontinuity, and the player is the only module that
detects one.** It owns the poll loop, so it owns the threshold and the
suppression that goes with it: it drops its own baseline the instant it issues
a seek, which is what stops it accusing anybody of a seek we performed. `state`
consumes a flagged jump as a user intent and does not look for one itself.
**One detector.** Two is how the failure at the end of this file happened, and
a second dormant one is worse than none, because it reads as coverage.

A `phase` event's `positionMs` is unreliable by construction: BUFFERING and
PLAYING both fire *before* a seek lands, so it reports the position being left
rather than the one being gone to. **Nothing may treat it as evidence that
somebody moved the video.** The echo check compares the video and the phase and
deliberately not the position, because the position comparison it used to do
was against the *room's* expectation, which made every slow join announce its
own buffering delay as a deliberate move and drag the room backwards.

The player takes its handle as an injected interface rather than reaching for
`window.YT`, which is what lets the shell be exercised against a fake in a
suite with no DOM.

## Echo suppression needs two mechanisms

Programmatic player calls fire the same events as user actions. Without a
guard, applying a remote state rebroadcasts it and peers oscillate forever.
One mechanism is not enough, because the two fail differently.

1. **A suppression window**, carried as a deadline and cleared by the injected
   clock. It must not be a boolean cleared by "the event we expect to see":
   seeking to the position the player already holds emits nothing, and telling
   an already paused player to pause emits nothing, so that flag sticks the
   first time the expected event never arrives and then silently swallows
   every genuine user action after it.

   **The deadline is load-bearing and must not be tidied away.** It reads like
   belt-and-braces next to the expected-event path, and it is not: seeking
   while the player is PAUSED was measured emitting *no state-change event at
   all*, so the expected event genuinely never arrives and the deadline is the
   only thing that ends the suppression. Without it, one paused seek swallows
   every user action for the rest of the session. There is a test pinning this,
   and the comment says what breaks without it.
2. **A semantic check**: never broadcast a state that is not a change from the
   last state adopted (same video, same status, position inside the 150ms
   deadband).

Why both. On a programmatic seek to 30s while playing, the IFrame API fires
BUFFERING and then PLAYING, and those fire *before* the seek lands, so the
reported position is still the old one. The semantic check alone compares
playing@10s against adopted playing@30s, sees 20 seconds of difference, and
broadcasts. That is the oscillation. The window covers that transient; the
semantic check covers whatever the window's duration guessed wrong about.

There is a test that fails when the guard is removed: apply a remote pause,
feed in the event sequence a real pause produces, and assert zero broadcasts.
Not one broadcast that happens to be identical. Zero. "It works in practice"
does not close this out.

## The drift ladder

| Drift | Action |
|---|---|
| under 150ms | nothing |
| 150ms to 1s | nudge `playbackRate` to 0.97 (ahead) or 1.03 (behind), hold until under 100ms, then restore to exactly 1.0 |
| over 1s | seek |

Enter the nudge at 150ms and leave it at 100ms. The asymmetry is deliberate
hysteresis; one threshold makes the rate chatter audibly.

**Never seek inside the nudge band**, and the measured reason is stronger than
the aesthetic one. A programmatic seek fires BUFFERING and then PLAYING every
time, and a seek of **50ms was measured costing a 264ms buffering stall**.
There is no such thing as a cheap small seek here: correcting 150ms of drift by
seeking costs more interruption than the drift it removes. Nudging costs no
stall at all, which is why our nudge band is more ambitious than the 1 to 2
second dead bands the rest of the ecosystem settles for.

For the same reason the seek rung **overshoots forward** rather than seeking to
the exact expected position: the stall lands you behind where you aimed. CyTube
adds a full second for this and SyncTube half a second; our measured 264ms is
the floor. Keep the overshoot as a named constant with the measurement in its
comment, so the next person can tell an empirical number from a superstitious
one and knows how to re-derive it.

### The rate the player will actually accept

**Use 0.95 and 1.05. Never 0.97 and 1.03.** This was measured against the real
player, not read off the docs, because the docs are stale on exactly this
point.

The published reference says `setPlaybackRate` honours only the values
`getAvailablePlaybackRates()` returns (0.25 to 2 in quarter steps). That is no
longer true. The player quantises to a **0.05 grid**, floored, clamped to
[0.25, 2]. So a 5% nudge works and genuinely changes playback, pitch-corrected.

**`getAvailablePlaybackRates()` under-reports what the player accepts.** It is
the speed *menu's* list, not the accepted-input allowlist, and treating it as
the latter is what makes the published docs actively misleading here. Reading
it as authoritative is how this feature nearly shipped a correction that only
worked in one direction. The docs are also wrong about the rounding rule: they
say values round "in the direction of 1", but 0.96 resolves to 0.95, which
moves away from 1.

The two values in the original design are the two that fail, and they fail
asymmetrically, which is what makes this worth writing down rather than just
fixing:

- `setPlaybackRate(1.03)` from a rate of 1 stays at 1, and
  `onPlaybackRateChange` **never fires**. A pure no-op.
- `setPlaybackRate(0.97)` from a rate of 1 resolves to 0.95 and the event does
  fire.

A peer running ahead would therefore have slowed down correctly, at a rate it
never asked for, while a peer running behind never sped up at all. Drift would
have corrected in one direction only, and half-working is the failure mode that
survives longest because it reads as flakiness.

Two rules follow, and they outlive the constants:

1. **Snap to the grid in `state`, and feature-detect rather than assume.** The
   grid is undocumented and contradicts the published docs, so treat it as a
   runtime capability, not an invariant: request 1.05 once at startup and read
   back. If it reads 1, fall back to seek-only correction with a wider
   deadband.
2. **Never trust the value you passed.** The event carries the resolved rate,
   never the requested one, and it does not fire at all when nothing changed.
   The player already enforces this by updating its local rate only from
   `onPlaybackRateChange`, which is what makes a refused rate observable
   instead of silent.

**A load resets the rate, so no rate assumption survives one.** `seekTo()`
leaves the rate alone, but `loadVideoById` and `cueVideoById` both reset it to
1. This is worth a rule rather than a footnote because of *when* it bites:
drift correction would work on the first video and fail on the second, which is
the same "looks intermittent" shape as the asymmetry above and just as hard to
attribute. `state` must not carry a rate across a load. Since the player only
updates its rate from `onPlaybackRateChange`, a load with no following event
correctly leaves it reading 1.

Where the decision goes is settled independently of all of the above. **The
player reports the available rates and never silently substitutes one.**
Snapping inside the wrapper is one module quietly overriding a decision another
module made, and it is wrong whichever way the rates turn out.

## One clock, and it is the receiver's

`atMs` is the sender's wall clock and is **diagnostic only**. Never subtract it
from a receiver's clock. Clock offset between two consumer machines is not
bounded by anything and routinely reaches tens of seconds, so
`positionMs + (now - atMs)` desyncs the whole room by whatever the worst clock
in it is wrong by, permanently and invisibly, while the sender sees nothing at
all. The receiver stamps its own arrival time and measures elapsed from that,
which leaves one-way latency as the only error. The full argument, including
why a resend of a `playing` state has to re-sample rather than replay, is in
`packages/shared/src/watch-party.ts`.

## `rev` is a logical clock

Not a timestamp. Any local action sets `rev = maxSeenRev + 1`, and ties break
on `actorId` lexically. `maxSeenRev` has to advance on every frame seen,
including frames whose tie was lost, or two peers ping-pong at the same `rev`
indefinitely.

## Autoplay is a product decision

Browsers block programmatic playback without a real user gesture, per
participant. The UI is built around an explicit "join watch party" click, one
per person, and that click is the gesture. Nothing tries to defeat or detect
the block, and nobody's player starts before their own click.

**Two gestures qualify, not one.** Pressing "start" on the paste form is as
much a click in this document as the join card's button is, and it is made by
the one participant whose intent is not in any doubt: they chose the video.
Wiring only the join card is what put the person who started the party in front
of a card asking them to click into the thing they had just chosen. Both
gestures now go through `nextJoined` in
`client/src/components/watch-party/watch-party-view.ts`, which is the one place
that decides what arms the local gate, and the arming is keyed to *this
machine's* form submit and never to a video appearing in the shared state.
Keying it to the state would open every peer's player with no gesture behind it
at all, which is the block the gate exists to respect.

## A cue is asynchronous, and it eats whatever follows it

Measured on 2026-08-27 against the real player from a visible tab.
`cueVideoById` followed in the same tick by `playVideo` runs unstarted,
buffering, unstarted, CUED and the play is simply gone; the identical
`playVideo` two seconds later plays immediately. The cue takes about **176ms**
to report CUED, and cueing, waiting for that report and only then playing
reaches PLAYING every time.

`load` then `play` is the batch **every party start and every join emits**, so
this was not an edge case. It also failed in the quietest way available: the
room's state said playing, the peer's own status line said playing, and the
person was looking at a still frame with a play button on it, with nothing on
screen to say what had gone wrong.

So `player.ts` holds every command that arrives while a cue is in flight and
flushes them when the player reports `cued`, `playing` or `paused`, never on
`unstarted` or `buffering`, both of which a cue passes through on its way.
**This is not the player making a decision**, which is the rule that file
exists to keep: `state` said play, the player still plays, and the only thing
that changed is that it waits until the call means something. Dropping the
command instead is not neutrality.

A `load` is the one command never held, because last-writer-wins means a second
video supersedes a first rather than queueing behind it.

The fakes in `player.test.ts` and `seam.test.ts` report the cue landing, on a
microtask, for the reason the last section of this file gives: a fake that took
a cue silently and instantly would agree with the broken code and let both
suites stay green over a feature nobody can watch.

## A teardown may only remove what it created

`createYouTubeIframePlayer` mounts into a wrapper of its own under the caller's
host and removes **that wrapper** on teardown. It must never empty the host.

The host is a React ref callback's node, and construction is asynchronous
(`await loadIframeApi()`). React 19's StrictMode detaches and re-attaches that
ref around the first commit, so the container builds a second player against
the same host node while the first one's construction is still in flight, and
both iframes end up inside it. When the abandoned first one finally reaches
`onReady` it is released, and a `host.replaceChildren()` there does not remove
one player's iframe: it removes every child of the shared host, including the
live successor's. YouTube then logs "The YouTube player is not attached to the
DOM", `onReady` never fires for the survivor, and fifteen seconds later the
panel shows "the player gave up" over a video that was fine. Observed
2026-08-27: two iframes added to one host, both removed 427ms later, leaving
zero.

The rule outlives the specific bug and the specific React version. A container
may be shared with a player this one knows nothing about, so teardown reaches
only for nodes it made itself.

## Failure paths ship with the feature

Embedding disabled (101 and 150), video not found or private (100), error 153
(missing HTTP Referer) and the generic player errors (2, 5) are common, not
edge cases. Each needs its own sentence, because each implies a different
action from the person reading it, and each needs a "watch on YouTube" escape.
An unknown code still needs a sentence rather than a blank frame.

A participant whose player has failed is a reader of watch-party state and
never a writer. See the contract file for what happens otherwise; the short
version is that position 0 on a fresh `rev` outranks everyone and resets the
room.

## A test that cannot fail is worse than no test

This one generalises well past watch parties, and it was learned here.

At one point this feature had a `describe("echo suppression")` block that
asserted applying a remote state produces no outgoing message. That property is
guaranteed by the return type: the result has no message field, so there is
nothing an implementation could do to break it. The test could not fail. The
mechanism that actually prevents peers oscillating, a suppression window and an
expected-echo flag living in the player wrapper, had no test at all.

The absence would have been better than the block. An untested module reads as
untested; a suite with a section named after the dangerous behaviour reads as
covered, and the next person moves on. **Pinning a type-level guarantee in a
test named after a runtime behaviour is how a suite comes to lie.**

The check is mechanical, so apply it rather than judging by feel: delete the
mechanism and see whether the test goes red. If it stays green, either the test
is pinning something the compiler already owns, or the mechanism was never
load-bearing. Both are worth knowing and neither is what the test claims.

**A mutation that changes nothing proves nothing.** Before reading a green
suite as a coverage gap, prove the edit actually changed behaviour. Confirming
the file changed is not enough: a mutation aimed at a function body can land in
a type annotation instead (an inline object type in a parameter list will
swallow a naive brace match), and the type stripper then discards it silently,
leaving the mechanism untouched and the suite correctly green. That has already
happened once here and came within a message of being reported as a hole in the
echo guard. When a mutation produces no new failures, suspect the mutation
first and the suite second.

## Two green suites can still not be a feature

`state.ts` and `player.ts` were built, reviewed and tested independently, both
suites passed, and **neither module could talk to the other**. Each declared its
own `PlayerEvent` and `PlayerCommand` and was tested thoroughly against its own
definition, so two of five event names matched and nothing anywhere failed.
Worse, both modules independently implemented scrub detection, so `state`'s
detector received no input at all while `player`'s findings had nowhere to go.

Reviewing each module against its own contract cannot find this, because each
module is correct against its own contract. The check that does find it is
cheap, mechanical, and worth running whenever two modules are built in
parallel:

- **Do the modules that must collaborate import each other at all?** One grep.
  If the answer is no, nothing has ever exercised the seam.
- **Is there a single test that drives both together?** `player` takes its
  handle as an injected interface, so a test wiring a real `state` to a real
  `player` over a fake handle costs nothing and runs in the node suite. Without
  one, the vocabularies are free to drift and the suites will not notice.

That test now exists, in `client/src/lib/watch-party/seam.test.ts`, and it is
the structural fix rather than a nicety. It is not a second copy of either
module's suite. Every test in it fails only for a reason living in the join:
a command one side emits and the other cannot execute, an event one side emits
and the other cannot fold, or a consumer left with no input at all. Three of
its five tests go red under mutations that both module suites survive.

The rule this leaves behind: **a seam that only one side has ever executed is
not a seam, it is two guesses that happen to typecheck separately.** When one
module's output type is another's input type, one of them owns the definition
and the other imports it. Two structurally similar declarations in two files
are not a shared contract.

## Constraints

- **No YouTube Data API and no API key.** This repo is public. No search, no
  title lookup, no thumbnail, no duration from an API. Paste a URL, parse it
  client side: `youtu.be/ID`, `/watch?v=ID`, `/shorts/ID`, `/embed/ID`, and
  the `t` and `start` params in `90`, `1m30s` and `1h2m3s` forms.
- **Do not touch the player chrome.** No overlays on the iframe, no hidden
  controls, no custom scrubber drawn on top, no ad suppression. This violates
  the API terms and is not a matter of style. Controls sit outside the player.
- **UI copy goes through i18next**, in both `en` and `pt-BR`. See
  `docs/I18N.md`, and run `pnpm --filter @pqp/client i18n:check`.
