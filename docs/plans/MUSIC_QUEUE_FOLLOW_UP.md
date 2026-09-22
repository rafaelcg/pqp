# Music queue: bugs, discoverability, and the hint campaign

Status: **built, 22 September 2026**, on branch `pr-757` stacked on PR 757.
Every item is on the branch except 4.4 and 4.5, which section 7 records as
dropped. A Fable 5.1 review of the stack then found a rights bypass this
plan had opened rather than closed (the anchor moved for any structural
write, not for a change of `current` or `status`), a hint card that came
back on every gate flicker, and two cross-instance anchor faults; all four
are fixed on the branch. The item text below is the specification, kept as
written, with a note wherever the code ended up somewhere else.

This is the consolidated work list after the player redesign landed
(commits `fb749ffc` through `149215c5`). It gathers three things that were
discussed separately: bugs found by the test agents on 21 September 2026,
the copy that tells people what the queue accepts, and the campaign that
announces the player. `docs/plans/MUSIC_PLAYER_REDESIGN.md` covered the
layout and is now history; the bar's shape is Spotify's, per `42ad8cb0`.

All four test agents have reported. Every item in sections 0 and 1 was
re-checked against the source, and the ones that could be run without a
browser were run against the shared and client modules. Where the first
reading of a bug was wrong, the item says so in one sentence, so the next
person knows why the obvious fix is not the one written down.

Two facts that bound the whole plan:

- **Phones do not write music state.** Android lists `music` and
  `channel-music` as deliberately ignored frames
  (`android/app/src/test/.../WireProtocolTest.kt`), and the iOS tree has no
  music code at all. Tightening `musicWriteAllowed` cannot break a build
  that is already on a phone. Nothing in this plan changes a frame's shape.
- **Production runs `VOICE_REGISTRY=postgres` on two instances** (pitfall
  11). Every server-side fix in section 0 has to be tested with the
  registry on, or it is pitfall 12 again.

## 0. Rights bypasses, confirmed live

Three ways a person without `MANAGE_MUSIC` can control a room's music. All
three were reproduced over real sockets by the protocol agent, and all
three reproduce against `musicWriteAllowed` alone with a five-line script.
None of them is reachable from outside a voice room: the attacker has to be
seated. That is still exactly the boundary `MANAGE_MUSIC` exists to draw,
and in a public community the room is the internet.

### 0.1 `openControls` makes a member a full manager, not a half one

`musicWriteAllowed` (`packages/shared/src/music.ts`) opens with

    const canManage =
      rights.canManage || (held?.openControls === true && rights.canAdd);
    if (canManage) {
      return true;
    }

`docs/MUSIC.md` says "Todo mundo controla" hands a member skip, pause,
resume, reorder and removing other people's tracks, and that flipping
`openControls` itself, setting `repeat` and flipping `autoplay` stay with
`MANAGE_MUSIC`. The early return gives away all of it. Reproduced: with
`openControls` on, a SPEAK-only member flipped `openControls` off, set
`repeat` to one, set `autoplay` on, and rewrote `history`. All four
accepted.

Fix: replace the early return for the promoted case with one rule, not a
verb table. A speaker under `openControls` may write anything a manager may
write **except** the three room switches: `openControls`, `repeat` and
`autoplay` must equal what the room holds (`controlsUnchanged` already
says this). `rights.canManage` keeps the unconditional `return true`.

Why one rule and not a permission set per verb: the promoted set is wider
than the documented list. It also has to allow seek (any position), the
client-only skip-back (`musicPrevious`: the first `history` row becomes
`current`, the displaced track goes to the front of the queue, `history`
loses its head), an add while the current track has ended (`startNow`:
current into `history` and the front of the queue, autoplayed rows
dropped), and `null` (Parar pra todos). An earlier draft put `history` and
other people's `skipVotes` behind `canManage`; that would have refused
skip-back and the end-of-track add for exactly the people the switch
promotes. Arbitrary `history` and `skipVotes` rewrites stay open to a
promoted speaker on purpose. Both are cosmetic once somebody can skip
outright, and the `sameTrack` identity rule only protects a manager's name
on a track a promoted speaker could remove and re-add anyway.

Client half: `effectiveCanManageMusic` (`music-extras.tsx`) is what draws
repeat, the `…` menu and its two switches. After the server change, a
promoted speaker who presses repeat or a switch gets a `forced` correction.
Draw repeat and the two switches from `voiceState.canManageMusic` only;
keep everything else on the effective flag.

Tests, in `music.test.ts`: held `openControls: true`, a speaker: pause,
skip, reorder, remove somebody else's track, seek, the skip-back shape, the
`startNow` shape and `null` are all `true`; flipping `openControls` off,
setting `repeat`, setting `autoplay` are all `false`. The existing
"promotes a speaker" test only pins pause. `restarts-api`.

### 0.2 Anybody seated writes the room's clock, and the end-of-track gate reads it

The end-of-grace gate is

    held.positionMs >= held.current.durationMs - MUSIC_END_GRACE_MS

and both operands come from the last accepted write, whoever wrote it.

The position-sample branch (same `current`, same `status`, same queue,
same switches, same votes) returns `true` with no rights check at all: not
`canAdd`, not `canManage`. A listen-only seat (no SPEAK) can write it.
Reproduced. It also lets `durationMs` go from null to any value, because
`sameTrack` allows that one transition for the room's writer to fill in.

Two consequences, and the first is bigger than the gate:

1. **Any seated person seeks the room.** Every client follows the room's
   sampled clock and seeks when more than 2.5 s off. A position-only write
   from anybody moves every player in the room. `docs/MUSIC.md` says
   "managers seek; everyone else read-only"; that is true of the UI and
   false of the server.
2. **The gate is satisfiable at will.** Write `positionMs = durationMs -
   500` and advance, or, on a track whose duration is still null, write
   `durationMs: 1` (threshold `-19999`, true at position zero) and advance.
   Both reproduced, no votes, no `MANAGE_MUSIC`.

The branch has no rights check for a reason: every write carries the
writer's live player position (`base()` in `music-store.ts`), including a
plain member's own append, so a position that differs from the held sample
cannot be refused outright without refusing the append it rides on.

Fix, in three parts. The first reading proposed refusing a forward jump;
that is wrong because a refusal takes the append with it, and a legitimate
sample can be ahead of the last one by a few seconds.

**(a) The server keeps its own clock for the room.** Beside the held state,
`server/src/ws/music.ts` keeps an anchor `{ positionMs, at }` in server
time. The anchor is set on every write from `rights.canManage` (a manager's
seek is the truth), and on every structural change of `current` or
`status` from anybody (a new track starts at 0; a pause freezes; a resume
restarts). A position-only sample from a non-manager never moves the
anchor. The room's expected position is `anchor.positionMs + (status ===
"playing" ? now - anchor.at : 0)`, never read from `atMs`, which is the
client's clock and already documented as untrusted.

**(b) A non-manager's sample is clamped, not refused.** In
`applyMusicWrite`, before the rights check: if the sender is not a manager
and `incoming.positionMs > expected + MUSIC_POSITION_TOLERANCE_MS`, replace
`positionMs` with `expected` and go on. The append lands, the seek does
not. The echo differs from the sender's optimistic copy, and the client
adopts it because it is not stale (same `rev`, same `actorId`); an honest
client's player is already where the echo says. Backward samples are
accepted as they are: a buffering or throttled player is behind, never
ahead, and a backward sample cannot reach the gate. Tolerance: 10 s. The
largest honest forward divergence is the client's 2.5 s seek threshold plus
its 2 s check interval plus the manager's own probe-to-server latency, so
under 5 s; 10 s is twice that and half the grace. Too tight clamps honest
appends back a few seconds, which is a visible backward seek for a room
with a buffering manager; too loose lets a member creep the room forward
by the tolerance per write, and the write limiter coalesces position-only
writes without refusing them, so the creep is unbounded per second. Log
the clamp as `voice.musicClamped` with the delta, and add a `reason` to
`voice.musicRefused`, which today logs only channel and user. Watch both
after deploy. Under `openControls` a speaker is a manager here.

**(c) The gate reads the server's clock.** `MusicRights` gains an optional
`expectedPositionMs`; the server fills it, the client omits it and falls
back to `held.positionMs` (the client only uses the function to draw). With
(a) and (b) in place the held sample can no longer be ahead of the
server's clock, but reading the clock directly also stops a stale
ten-second-old sample from refusing an honest end-of-track advance.

**The duration fill is the part clamping cannot close.** A bound on the
filled value does not work: any rule "fill must be at least expected plus
k × grace" still lets the filler cut the track (k − 1) × grace after the
fill, for any k. Two options, decide before building:

- **A (recommended).** The server owns the duration where it can. InnerTube
  search and playlist results already carry `durationMs`; a pasted YouTube
  link resolves through oEmbed, which does not. Add one InnerTube search
  for the video id when oEmbed gives no duration (one budget token, cached
  six hours like any search). Then a null duration only happens when
  InnerTube failed at add time. For that residue, accept the null-to-value
  fill only from `rights.canManage` or from the track's own
  `addedByUserId`, and change `reportPosition` in the client to fill only
  when this machine is one of those, so an unprivileged actor's samples
  are not answered with a `forced` frame every ten seconds. The cost: a
  duration-less track whose adder has left and whose room has no manager
  cannot be advanced by a member at its end; votes still work, and it
  needs InnerTube to have failed at add time.
- **B.** Accept the residue: a member can end a duration-less track after
  one grace. Cheaper, and the hole stays.

Cluster half, and this is not optional: the anchor must live where the
state lives. With the registry on, a manager's seek accepted on `api-a` is
relayed to `api-b` as an absolute state; if `api-b` keeps its own anchor
it does not know the frame was a manager's, keeps the old anchor, and then
clamps every honest sample on its half of the room back by the size of
the seek. Carry `anchorPositionMs` and `anchorAt` in the `voice.music` bus
frame and in the `voice_rooms` row beside `music` (both instances are on
one box and share a clock; Postgres `now()` is fine as the source). A cold
cache with no anchor (a fresh process adopting a row without one) skips
the clamp and the clock-based gate and falls back to the held sample, and
counts that fallback, so the rollout can be watched.

Tests. `music.test.ts`: a non-manager sample ahead of `expectedPositionMs`
by more than the tolerance does not satisfy the gate; the gate is true when
`expectedPositionMs` reaches `durationMs - MUSIC_END_GRACE_MS` even when
`held.positionMs` is stale; the `durationMs: 1` write is refused from a
non-adder non-manager. `server/src/ws/music.test.ts`: a listen-only
sample `3_000_000` ms ahead comes back clamped to the expectation and the
append on the same write survives; a manager's seek moves the anchor; a
member's sample does not. And one registry-on test, in the style of
`voice-roster-delta-registry.test.ts`: a manager's seek accepted on one
instance does not cause a clamp on the other. `restarts-api`.

### 0.3 A departed member's skip vote outlives them

`removePeer` in `server/src/ws/voice.ts` drops a leaver's raised hand
through `dropRaisedHandForUser`. There is no equivalent for `skipVotes`:
grepping the file for `skipVotes` returns nothing. The votes stay while
`roomSize`, the denominator of `max(2, ceil(roomSize / 2))`, shrinks.

Tested live: six seats, threshold three. A votes and leaves. B votes. C
sends the advance and it is accepted, so two live voters out of five
remaining seats cleared a threshold sized for five. Reproduced against the
function: two ids that are in no roster plus the sender's own clear a room
of six.

Fix: count only live voters, at check time, and do not touch the state.
`MusicRights` gains `seatedUserIds`; `musicRoomSize` in `voice.ts` already
reads the cluster room when the registry is on, so return the participants'
user ids from the same read. In `musicWriteAllowed`, `votedOut` counts
`votesHeld.filter(seated)` plus the sender.

Why not prune in `removePeer` as the first reading proposed: a pruned
`skipVotes` is a new state, and a server-minted state needs a `rev`, an
`actorId` for the tie-break, a broadcast, a `persistMusic` write under the
row's ordering, and a bus relay, all racing the clients' in-flight writes
at `rev + 1`. Mutating the held state silently is worse: every client's
next write would carry the old votes, `sameSkipVotes` would fail, and a
plain member's position sample would be refused with a `forced` frame.
The check-side fix has none of that. The visible cost is that the "N
votaram" count still shows a departed vote until the track changes.
Optional client half: `voteSkip` can filter by `voiceState.occupancy`
before deciding to advance, so an optimistic advance is not attempted on
a stale count.

Tests: `music.test.ts`, a held vote from an id not in `seatedUserIds` does
not count; `server/src/ws/music.test.ts`, the live scenario above ends in
`refused`. `restarts-api`.

## 1. Bugs, confirmed

Ordered by what they cost a room. 1.1 drops the call; the rest do not.

### 1.1 A form inside a form: the + button reloads the page and drops the call

`MessageComposer` (`client/src/components/chat/message-composer.tsx`)
renders its `{music}` slot at line 1519, between its own `<form>` at 1394
and `</form>` at 1831. `MusicSearchPicker` renders its own `<form>` (line
357) with a `<button type="submit">` (line 395) whenever `chrome ===
"default"`, which is what the in-call sheet passes (`music-fila.tsx` line
289). The browser agent reproduced a full page navigation from a mouse
click on + three times: the SPA reloads, the seat is lost, the music
session with it. Enter is safe because `onFieldKeyDown` calls
`preventDefault` before any submit event exists. Nested forms are invalid
HTML and React 19 logs the nesting warning every time the panel opens.

Pass 2 of the redesign made the field always mounted, so the nested form is
present the whole time the panel is open rather than only while an adder
was revealed.

Fix: the picker stops being a `<form>`. It is a `<div role="search">`; the
+ button is `type="button"` with `onClick={submit}`; Enter is already
handled on the field. This works in every host (sheet, drawer, rail) and
does not touch the composer's layout. The alternative, rendering the music
slot outside the composer's form, moves a well that the composer's own
tests measure. Test: render `MusicSearchPicker` inside a `<form>` and
assert no nested `form` element and that clicking + calls the submit path
once. Client-only.

### 1.2 Repeat-one hijacks the playing track on the next add

The client marks a track ended locally (`markCurrentEnded`,
`client/src/lib/music-store.ts`) and clears that mark in `set()` only when
the incoming state's `current.id` differs from it. Under `repeat: "one"`,
`musicAdvance` returns the same track object as the new `current`, so the
id is the same and the mark is never cleared. `set()` is the only place
the mark is cleared. `currentTrackHasEnded()` then reports true for the
rest of that track's life.

Reproduced against the store: loop a track under repeat-one, add a second,
and `addTrack` answers `"playing"` with the looping track pushed into
`history` and to the front of the queue. Repeat-all has the same hole
whenever the queue is empty at the moment of advance, because the finished
track is then `rotated[0]`.

Fix: clear the mark when the room restarts the same track, as well as when
the id changes. In `set()`: clear when `current.id` differs, or when the id
is the same and the incoming state has `positionMs === 0` and `status ===
"playing"`. That second case is exactly what `musicAdvance` produces under
repeat-one and the empty-queue repeat-all wrap.

Checked against the cases that looked like they might break it. A manager
seeking to the start is a position-0 playing write on the same id: clearing
the mark there is correct, because `seekTo(0)` on an ENDED player restarts
it. A joiner's first snapshot arrives after `setMusicSession` has already
cleared the mark through `set(null)`. The store's own optimistic `write()`
of the advance clears the mark before the echo; if the server refuses, the
mark is gone while the player is ENDED, so the next add queues instead of
starting, which is the safe direction. A position sample of exactly 0 on
a track that has not ended cannot clear a mark that was never set.

A second guard in the embed, not instead of the first: the player is the
only authority on whether this machine's player is ENDED, so
`onStateChange` should clear the mark on any transition out of ENDED for
the same id (PLAYING, BUFFERING, CUED). The store rule covers the room's
view; the embed rule covers a restart the room did not announce.

Test, in `music-store.test.ts`: repeat-one, `onTrackEnded`, echo the write,
`addTrack` answers `"queued"`, `current` unchanged, `history` unchanged.
Fails today with `"playing"`. Client-only.

### 1.3 The seek bar latches after any keyboard input, and the seek is dropped

`music-now-playing.tsx` keeps a local `scrub` preview (line 169), draws
`position = scrub ?? progress.position` (183), sets `scrub` on every
`onValueChange` and clears it only in `onValueCommit`, which is also the
only path that calls `seekTo`. After an arrow key the displayed clock
freezes, across pause, resume and a track change, and the track never
moves. The same pair is in `music-fila.tsx` (line 63, and the drawer card
at 257 to 278). The volume slider writes from `onValueChange` directly and
is unaffected.

The mechanism is not what it looks like. Radix does fire `onValueCommit`
on keyboard: `onStepKeyDown` calls `updateValues(..., { commit: true })`
(`@radix-ui/react-slider` 1.4.7). But the slider is controlled, and in
controlled mode `useControllableState` runs the updater first, which fires
`onValueCommit` from inside it, and only then calls `onValueChange`. So on
a keypress the order is commit, then change: `seekTo` runs and `scrub` is
cleared, then `onValueChange` sets `scrub` again and nothing ever clears it.
The seek itself is sent; the displayed clock is what latches, and the next
keypress steps from the latched value, which is why the track "never moves"
from the person's point of view. A fix that assumes the commit is missing
would not fix it.

Fix: do not keep a preview across events at all. Keep `scrub` only while a
pointer drag is in progress (set on the root's `onPointerDown`, cleared in
`onValueCommit` and on `onPointerUp`/`onPointerCancel`), and for any
`onValueChange` that arrives with no drag in progress, call `seekTo`
directly, the way the volume slider writes. The write limiter coalesces
position-only writes, so a held arrow key is not a storm. Put the rule in
one place: a `useScrub` hook shared by the bar and the drawer, so the two
copies cannot drift. Test: render the bar, press ArrowRight on the thumb,
assert `seekTo` called once with `position + 250` and that the displayed
clock follows `progress.position` on the next tick. Fails today. Client-
only.

### 1.4 A large add silently evicts the queue and reports nothing dropped

`startNow` gives the incoming tracks the 50-track cap first and the
displaced ones whatever is left. `addTracks` computes `dropped` only from
the incoming tracks that did not fit. Reproduced: a full queue at end of
track, a 30-track add, answer `{ added: 30, dropped: 0 }`, and 28 queued
tracks gone. The single-track `addTrack` path has the same shape with
repeat-one (current plus 50 displaced is 51).

Fix: `startNow` returns how many displaced tracks fell off, and `addTracks`
adds that to `dropped`, reported through the same `music.queuedManyDropped`
string. Autoplayed rows that `startNow` drops on purpose (so the new pick
becomes the radio seed) are not counted; that drop is documented. Reachable
on its own only in the moment a track ends with autoplay on, but 1.2 turns
that moment into a standing condition, so fix 1.2 first and this becomes
rare again. Test: the scenario above answers `dropped: 28`. Client-only.

### 1.5 Two YouTube iframes under Novidades

Confirmed by reading; the first draft had it as unverified. When
`whatsNewOpen` is true, `App.tsx` keeps `ChannelList` or `DmList` mounted
inside a `hidden` wrapper (line 8319) with `footer={sidebarFooter(...)}`,
and mounts `WhatsNewView` with `footer={sidebarFooter()}` (line 8738). Two
`MusicMiniPlayer` instances, the same `voiceState`, the same store, so both
pass `shouldKeepMusicEmbed` and both render `MusicPlayer`, which does
`createPortal(frame, getMusicEmbedHost())` into the one singleton host.
React allows several portals into one container and appends each one's
subtree, so the host gets two frames, two `new YT.Player`, two audio
streams. Each instance also registers `setPositionProbe`, `setSeekApply`
and `setMusicLocalPlayer`, last one wins; when Novidades closes, its
instance's cleanup sets all three to null, so the survivor's player is no
longer the one the store samples or seeks.

The one-off uncaught `NotFoundError: removeChild` the browser agent saw
during heavy Fila open/close, stage toggling and resizing is most likely
the same defect: React removing a portal child from a container whose
children two portals are managing. It is not a separate item; if it
recurs after this fix, it becomes one.

Fix: mount `MusicMiniPlayer` once. Lift it out of `sidebarFooter` into a
single mount in `App`, and let `sidebarFooter` render only the chrome the
footer needs. The comment above `wantsVoiceCleanHint` (App.tsx 6650 to
6665) proves an invariant from "sidebarFooter has exactly three call
sites"; update that comment with the change. Acceptance: in a call with
music on, open Novidades and read
`getMusicEmbedHost().children.length`; one is correct. Client-only.

### 1.6 The typed-search path has no cache and no budget protection

`searchCache` is only read inside `searchYouTube`, which serves
`GET /api/music/resolve`. `searchMusicCandidates`, which serves
`GET /api/music/search`, calls `innertubeSearch` directly. Measured: the
same query three times took 0.394 s, 0.433 s and 0.391 s, against 0.554 s
then 0.0007 s on the resolve path.

Two more costs the first reading missed. When InnerTube answers empty,
`searchMusicCandidates` falls through to `resolveMusic(query)`, which runs
the same `innertubeSearch` again (one or two more tokens of the shared 300)
and then scrapes the results page (one more): an empty answer costs up to
four tokens and a scrape. And a cache alone does little for the as-you-type
field (`b01bdf92`): each pause is a different prefix, so the cache only
helps a repeat. The field's own guard is 350 ms debounce and two characters
minimum; the per-user limiter is 20 burst then one per two seconds.

Fix: one cache, not two. Widen `searchCache` to store the list of hits (up
to five) and let `searchYouTube` read the head; the candidates path and
the resolve path then share entries, so a typed query and the same text
arriving through a Spotify resolve cost one upstream call between them.
Key: the query lowercased with whitespace collapsed. The limit is a
constant (5) and does not belong in the key; if it ever becomes a
parameter, store the widest answer and slice. Cache non-empty answers only,
as today; an empty InnerTube answer is often a flake and must not be
remembered for six hours. Add in-flight coalescing on the key, the pattern
`innertubeRelated` already has, so a room typing the same thing does not
stampede. And change the empty fallback: skip the second InnerTube call
and go to the scrape, or answer empty. With `YOUTUBE_API_KEY` set the
resolve path uses the Data API and stores one hit; that entry serves the
candidates path as a one-item list, which is correct.

Test, in `music-search.test.ts`: two `searchMusicCandidates` calls for the
same text make one `innertubeSearch` call; a `searchYouTube` for that text
makes none. `restarts-api`.

### 1.7 A real YouTube URL with a trailing slash is refused

`parseMusicInput` tests `url.pathname === "/watch"`. `youtube.com/watch/?v=`
is served by YouTube and refused by us. Reproduced. `/shorts/x/` and
`/embed/x/` already parse, because that branch's regex stops at the slash.
Fix: trim a trailing slash before the comparison. Test: `/watch/?v=` in the
parser test fails today; add `/shorts/x/` and `/embed/x/` beside it as
pins. `parseMusicInput` lives in `packages/shared` and the server's
`resolveMusic` calls it, so this is `restarts-api`, not client-only as
first written.

### 1.8 A malformed link is silently searched

`new URL("https://")` throws, so `parseMusicInput` leaves `url` null, skips
the "some other site" refusal, and falls through to a text search.
Reproduced: `"https://"` comes back as `{ kind: "search" }`. A mistyped
paste returns an unrelated song instead of saying the link is not
readable.

Fix: refuse when the text **starts** with a scheme,
`/^[a-z][a-z0-9+.-]*:\/\//i`, and `new URL` throws. Not "contains `://`":
`"bohemian rhapsody http://"` is a search today and stays one. Searches
with colons ("Rush 2112: Overture") never reach this branch; text without
`://` that fails to parse as `https://<text>` (any query with a space) is
the ordinary search path and is untouched.

Server half, which the first reading missed: `searchMusicCandidates` never
calls `parseMusicInput` before InnerTube. The client sends a pasted
`https://` to `/api/music/resolve` because `shouldResolveQuery` matches
`^https?://`, so the parser fix covers the paste; but the same text typed
character by character reaches `/api/music/search` and is searched
upstream regardless. Run `parseMusicInput` at the top of
`searchMusicCandidates` and answer 400 for anything that is not `search`.
Tests: parser, `"https://"` is null; route, the same text answers 400
from `/search`. `restarts-api`.

### 1.9 A deleted playlist answers 502 instead of 404

`resolveYouTubePlaylist` tries InnerTube `browse` first, which answers null
for a list that is gone, then fetches the public playlist page, and YouTube
answers 404 for a deleted list, so `fetchText` throws `upstream` and the
route maps it to 502. The "That playlist is empty, private, or could not
be read" 404 is unreachable for this case. With `YOUTUBE_API_KEY` set the
Data API path 404s the same way.

Fix: `fetchText` takes an option to return null on 404, the two playlist
fetches pass it, and a null page is an empty list. Test: stub `fetch` to
answer 404 for the playlist page with InnerTube stubbed to null; the error
code is `not_found`. Fails today with `upstream`. `restarts-api`.

### 1.10 The play/pause button has no accessible name

`playControl` in `music-now-playing.tsx` (line 297) wraps
`<Tooltip label=...><span className="inline-flex"><Button/></span></Tooltip>`.
`Tooltip` puts `aria-label` on `TooltipPrimitive.Trigger asChild`, which
merges onto its immediate child: the span, which has no role, so the label
is ignored, and the rendered button's `aria-label` is null. The span is
there so the tooltip still opens on a disabled button (our `Button` sets
`disabled:pointer-events-none`). The previous-track button escapes this
because it sets its own `aria-label` on the `Button`.

Fix: the same. Put `aria-label={playing ? t("music.pause") : t("music.play")}`
on the `Button` and keep the span for the tooltip. `Tooltip`'s own rule is
that the name lives on the trigger so the label and the bubble cannot
disagree; the span breaks that rule already, so the duplicate string is
the lesser wrong until the tooltip grows a documented wrapper for a
disabled control. Test: the rendered button has the name. Client-only.

### 1.11 The unsupported-link notice names only Spotify tracks

`music.error.unsupported` reads "Só links do YouTube, links de faixa do
Spotify, ou uma busca" (pt-BR and en). Album and playlist links are
supported, and every 400 from the resolve route lands on this one string,
including the artist-link refusal. Fix: "Só links do YouTube ou do Spotify
(música, álbum ou playlist), ou uma busca", matching `music.placeholder`.
Client-only, locale files.

### 1.12 The not-found message repeats the query back: not a bug

The first reading said `Nothing on YouTube for "<query>"` violates the
documented rule of no query string in an error message. The rule is about
the **URL** query string: `fetchText`'s comment says "Never the query
string: the Data API key travels in it", and it strips `?key=...` from the
upstream URL before reporting a status. Echoing the person's own search
text back to that person is not the same thing, and the client does not
show the server string anyway (it maps 404 to `music.error.notFound`). No
code change. Reword the sentence in `docs/MUSIC.md` to say "no URL query
string in an error message", so the next reader does not make the same
misreading.

## 2. Unverified

Nothing left here. 1.5 was verified by reading and moved up. The
`removeChild` error is folded into 1.5.

## 3. Discoverability copy

The point is that the field takes both a search and a link, and that this
is said where the action is rather than once in a card.

### 3.1 Show the full placeholder

`music.placeholder` already reads "Cole um link do YouTube ou do Spotify
(música, álbum ou playlist), ou busque" and is used only as the
`aria-label`. The visible placeholder is the compact
`music.placeholder.short`, "Adicionar: link ou busca". Widen the visible
one so it names YouTube and a search. Keep a shorter variant for the
drawer, which is 240px wide.

### 3.2 Say it whenever the field is empty

The line that names the sources currently renders only when nothing is
playing. Open the queue mid-song and the field stands alone. Show that one
line whenever the field is empty, in both the sheet and the drawer.

## 4. The hint campaign

The `music` feature hint exists. It is in `FEATURE_HINT_IDS` and
`ATTACHED_FEATURE_HINT_ORDER`, keyed `pqp:feature-hint-music-2026-09`,
rendered in `call-stage.tsx` above the call controls (line 2484), and
gated in `App.tsx` on `featureHintEligible("music")` captured once at
mount plus `voiceState.status === "connected"`. Its comment in
`lib/feature-hints.ts` describes a gate that does not exist ("nothing on")
and a location that is wrong ("the bottom of the sidebar").
`docs/ONBOARDING.md` has no row for it.

The copy is not where the first draft thought. `featureHint.music.body`
already reads "Na barra da call, o botão de Música abre a fila. Cole um
link ou busca pelo nome. Todo mundo na call ouve junto." It was re-aimed
in `923f0d16` and again in the redesign, both times under the same key.
So the people who saw the sidebar-era card have the key stamped and will
never see the re-aimed one. 4.2 is therefore the key bump, not the copy.

### 4.1 Give it the gate it claims

Add `shouldOfferMusicHint` beside the other predicates: connected,
`canSpeak` (without it a person cannot add anything, so the copy would be
a lie), nothing currently playing (if the bar is on screen the card is
describing what the person is looking at), and the Fila panel closed (a
card that points at the tile while the panel it opens is up is noise, and
4.4 owns that moment). `useMusicDock()` already gives `on` and `open`
without following the playhead. `wantsMusicHint` is read once at App
mount; the new conditions are live state and belong in the `wanting` map,
not in the one-shot `useState`.

### 4.2 Bump the key

`pqp:feature-hint-music-2026-09-2`. The copy stays. Everybody sees the
re-aimed card once, including people who dismissed the old one.

### 4.3 A NOVO pip on the Music tile

A lime pip on the dock's Music tile while the hint is unseen and the room
has nothing playing, cleared the moment the panel is opened. Precedent: the
voz limpa nudge's NOVO dot on the Settings row at narrow widths. A pip is
not a card, so it is outside both `CORNER_HINT_ORDER` and the attached
queue and needs no arbitration.

~~It reads the same key as 4.1, so opening the panel spends the impression
for both.~~ **Corrected while writing it:** it keeps its own key,
`pqp:music-pip-2026-09` in `lib/music-pip.ts`. `FeatureHint` records its
impression on first paint and 4.1's gate is a superset of the pip's, so a
shared key would have been stamped in the frame the pip first drew, and a
mark meant to last until somebody opens the panel would have lasted one
render.

### 4.4 A first-open tip on the field

A second attached hint, `musicField`, fired the first time the panel is
opened rather than the first time a call starts, explaining what the field
takes. Better aimed than 4.1, which fires at somebody who has not asked
about music. Rules from `docs/ONBOARDING.md` that apply: it is an attached
hint, so it goes in `ATTACHED_FEATURE_HINT_ORDER` **before** `music` (a
moment beats a standing tip, the same reasoning the file gives for the two
watch party hints); it renders nothing and spends nothing when it does not
win the slot; it yields while a campaign owns the corner; and it gets its
own key and its own row in the table. If 3.2 ships, the field already
says what it takes whenever it is empty, and this hint may be redundant;
decide after 3.2 is on screen.

### 4.5 One re-arm, on a condition, not a clock

A repeating card reads as a bug and teaches people to swat it, and
`lib/hints.ts` is a show-once store by design. Instead, show the field tip
a second time only for somebody who has never added a track, and never
again. Mechanics, since the store has no counter: a second key
(`...-musicField-2`) that is eligible only when the first is seen and a
per-browser fact `pqp:music-added` is absent; `addTrack` / `addTracks`
set the fact on the first `"playing"` or `"queued"` outcome. This is a
change to the music hint's eligibility, not to the hint store, and the
fact is per browser like every campaign key.

### 4.6 Documentation

Add the music row (and the field row if 4.4 ships) to the
`docs/ONBOARDING.md` table, and correct the sentence in
`lib/feature-hints.ts` that still places the player at the bottom of the
sidebar and claims a "nothing on" gate.

## 5. Order of work

Grouped by what ships together and what must ship alone.

1. **1.1 alone, first, today.** A click drops the call. It is a
   twenty-line client change with no dependency on anything else, and the
   campaign in section 4 would send people straight to that button.
2. **0.1 and 0.3 together.** Both are `musicWriteAllowed` changes with a
   `MusicRights` field, both are small, both are tests-first. One
   `restarts-api` PR.
3. **0.2 alone.** It is the only fix here that can refuse or alter an
   honest write, it adds a column and a bus field, and it has a human
   decision in it (A or B for the duration). It ships with its counters
   and is watched. Never in the same PR as anything else.
4. **1.2, 1.3, 1.4 and 1.5 together.** All client-only store and component
   fixes, each with a test that fails first. 1.2 before 1.4 within the PR.
   1.10 and 1.11 ride along; they are one line each.
5. **1.6 to 1.9 together.** All server or shared, all in the resolve and
   search path, one `restarts-api` PR. 1.12's doc sentence rides along.
6. **Section 3.** Small, and it reduces what the hints have to carry.
7. **Section 4, last**, so it announces a player without known bugs, and
   after 3.2 has settled whether 4.4 is still needed.

**What actually shipped.** The order above was followed, but not the
isolation: everything is on one branch stacked on PR 757, including 0.2,
because that is what was asked for. So 0.2's counters
(`voice.musicClamped`, `voice.musicRefused`'s reason, `musicCluster
.anchorMissing`) are watched alongside everything else rather than on
their own deploy, and the tolerance in section 7 is still unmeasured. If
that trade turns out badly, 0.2 is `33e929cf` plus `ce9f524b` plus
`fe8ededf` and reverts as those three.

Labels. `restarts-api`: sections 0 (shared and server), 1.6, 1.7, 1.8,
1.9. The first draft called 1.7 and 1.8 client-only; `parseMusicInput` is
in `packages/shared` and the server runs it. `drops-voice`: none. An API
restart keeps every seat that resumes, and with the registry on the queue
row survives while somebody is seated. Client-only: 1.1 to 1.5, 1.10,
1.11, sections 3 and 4.

Merges follow the house rule: mornings, Brazil time, never Friday night or
Saturday.

## 6. `docs/MUSIC.md` after this plan

The document describes behaviour the code does not have. Update it in the
PR that makes each sentence true, not before:

- "Who may do what": the `openControls` row lists seek, skip-back, and an
  add after the track ended; the switches row says a promoted speaker is
  excluded (0.1).
- "The state", `positionMs` / `atMs`: the server keeps its own anchor and
  clamps a non-manager's forward sample; the gate reads the server's clock
  (0.2).
- The end-of-track paragraph: "the last sample is within grace of the
  duration" becomes "the server's own clock is within grace", and says who
  may fill a missing duration (0.2, whichever option is chosen).
- "vote to skip": `held.skipVotes` becomes "held votes from people still
  seated" (0.3).
- "Around it": "no URL query string in an error message" (1.12); the
  search cache serves both `/resolve` and `/search` (1.6).
- "Resolving a link": `watch/?v=` in the video row (1.7); a scheme that
  does not parse is refused like another site (1.8).
- "The client": the seek preview rule (1.3); one `MusicMiniPlayer` mount
  (1.5).

## 7. Open

Decisions a human has to take before the code is written:

1. ~~0.2, option A or B for the duration fill.~~ **Decided 21 September
   2026: option A.** The duration is server-owned and only a manager or the
   person who added the track may fill it. The rare stall is accepted: a
   duration-less track whose adder has left and whose room has no manager
   present sits until somebody skips it.
2. **0.2, the tolerance.** 10 s is argued above. Nothing measured yet
   says what honest divergence looks like in a Brazilian room with a
   buffering manager; `voice.musicClamped` after deploy is that measurement.
3. ~~1.1, form or slot.~~ **Decided 21 September 2026: the picker drops
   its `<form>`.** The `+` becomes an ordinary button calling the same
   submit path, Enter keeps working as it does. The change stays inside one
   component and the shared composer is not touched.
4. ~~**4.4** stays or goes once 3.2 is visible.~~ **Decided 22 September
   2026: dropped, and 4.5 with it.** 3.2 shipped, so the field names its
   sources in place whenever it is empty, for everybody, with no key and no
   queue slot. A card attached to that same field at that same moment says
   the same thing twice and would take an arbitration slot ahead of the
   music card.
5. From the protocol agent, left out of section 0 because it may be
   deliberate: a 51st queued track is rejected by the zod `.max(50)` on the
   write schema before the handler runs, so the sender gets no response at
   all, not even the `forced` correction every rights refusal sends. That
   matches how the socket treats any invalid frame. The client caps at 50
   itself, so only a modified client sees it. A question, not a bug.
