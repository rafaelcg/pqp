# Music queue

Asked for in the QG and in support: *"bot de música, com fila, play/pause,
skip, volume e suporte a links de plataformas de música"*. Any voice call has
a queue. Anyone in the call adds a YouTube link, a Spotify track link, or a
search; everyone in the call hears the same thing at the same time.

## Not a bot, and why

A bot that streams audio into the room only works where the server is in the
media path, which is a LiveKit room and never a mesh room: every DM call and
every server under ten people. Restreaming YouTube from our own machines is
also what got Groovy and Rythm shut down in 2021, and Spotify's developer
terms forbid third-party synchronised playback outright.

So the queue works the way Discord's Watch Together, Spotify Jam and Apple
SharePlay work: **no audio passes through our infrastructure**. Every
participant plays the track from YouTube through the IFrame Player API on
their own machine, and what travels over the voice socket is one small state
object. It reaches web and Electron on both transports with one protocol and
costs nothing per listener.

## The state

`packages/shared/src/music.ts`. One object per room:

| Field | What |
|---|---|
| `current` | the track playing, or null |
| `queue` | what is up next, at most `MUSIC_QUEUE_LIMIT` (50) |
| `status` | `playing` or `paused` |
| `positionMs`, `atMs` | a position sample; the receiver measures elapsed time from its own arrival clock, never from `atMs` (see `watchPartyStateSchema.atMs` for why). This is the last sample ANYBODY seated sent, so the server does not take it for the room's clock: it keeps its own anchor (`voice_rooms.music_anchor_ms` / `music_anchor_at`, and `anchors` in `server/src/ws/music.ts`), moves it only for a write from whoever is running the music or for a change of `current` or `status` (a new track starts at zero, a pause freezes, a resume restarts), never for an append, a removal, a vote or a switch, and replaces a sample more than `MUSIC_POSITION_TOLERANCE_MS` ahead of that anchor with the anchor's own reading. Clamped, never refused, because the same write carries an ordinary queue append. A sample that is behind is kept as it is: a buffering player lags, it does not run ahead |
| `rev`, `actorId` | the logical clock and its tie-break |
| `openControls` | when true, anyone with SPEAK may write anything a manager may write EXCEPT the three room switches (`openControls`, `repeat`, `autoplay`), which stay with `MANAGE_MUSIC`: a promoted speaker runs the music, they do not decide who else may. Only a manager writes it. A write that omits it keeps what the room already holds |
| `repeat` | `off`, `one` (this track again), or `all` (finished tracks go to the end of the queue). Default `off` |
| `skipVotes` | user ids that have voted to skip the current track. Any change of `current` clears it |
| `history` | the last ten finished tracks, most recent first. A repeat of the same `videoId` moves that row to the front |
| the end-of-track gate | reads the SERVER's clock, and refuses to decide without one. A room whose anchor is missing (the cold-row case, `musicCluster.anchorMissing`) falls back to votes rather than to `held.positionMs`, which is the last sample anybody seated wrote and therefore the very thing the anchor exists to distrust. The same rule applies to the seated roster: absent on the server, no held vote counts |
| a skip vote | counted the same way on both sides: only the votes of people still seated. The client counted every held vote, reached the threshold first, wrote the advance and had it refused, so the vote was never recorded and pressing again did the same thing for ever. A vote that carries with "Continuar com parecidas" on takes the related pick rather than ending the room |
| `actorId` | the writer's own peer id, and the tie-break between two writes at the same `rev` (higher string wins, in the cache and in the row alike). The server refuses a frame whose `actorId` is not the peer id of the socket it arrived on: it grants no permission, but an invented one wins every race it enters, including against a manager acting in the same instant |
| filling a missing `durationMs` | the manager, or whoever added that track, **on every track and not only `current`**. The queue used to go through the same-tracks path, which allows null to a value for anybody: a listen-only seat could give a queued track a length of 1 ms and, once it became current, satisfy the end-of-track gate a millisecond later |
| a position sample from a non-runner | clamped to the room's clock in BOTH directions past `MUSIC_POSITION_TOLERANCE_MS`. Forward was the original bypass; backward was left open on the reasoning that a buffering player lags and cannot reach the gate, which is true of the gate and beside the point for everyone else, since every client seeks to within 2.5s of the room's clock |
| `durationMs` (on every track, `current` and queued) | null, or a real length: greater than zero and at most `MUSIC_MAX_DURATION_MS` (12 h). Refused otherwise, from anybody, before the rights are looked at. It is client-supplied and it is the other operand of the end-of-track gate, so an unbounded one is a way to end a track: zero satisfies the gate from the instant the track starts, and `matchesAdvance` does not ask for `canAdd`, so ANY seated person could then take the room's track away with no votes. The grace is also capped at half the declared length, so a short track cannot be over before it has played |
| `autoplay` | when true and the queue is empty, the room keeps going with a related track. Only a manager writes it. A write that omits it keeps what the room already holds. A track the room picked itself carries `autoplayed: true` |

Last-writer-wins, no host: whoever acted most recently controls the player,
with `rev = seen + 1` and the peer id breaking ties. This is the contract the
watch party's synchronised player already carries (`watch-party.ts`), and
the server half is the same shape (`server/src/ws/music.ts`: hold the state
so a joiner lands at the right position, coalesce position-only writes
instead of dropping them, tear down with the room).

Frames: `set-music` client to server, `music` server to the room, sender
included as the acknowledgement. A joiner is handed the state after
`welcome`. A write that omits `openControls`, `repeat`, `skipVotes`,
`history` or `autoplay` keeps the room's values, so an older client that
only samples position cannot wipe them.

With `VOICE_REGISTRY=postgres` the queue is the watch party's twin, column
for column: `voice_rooms.music` / `voice_rooms.music_rev` are the room's
queue, the map in `server/src/ws/music.ts` is a per-instance cache of it,
and the contract's ordering is the row's WHERE clause, so a write that lost
across machines is handed the winner exactly as a local loser is. Accepted
writes are relayed on the `voice.music` bus topic so the half of the room on
the other machine hears the play, the pause or the skip now rather than on
its next join, and the joiner snapshot reads the row. `voice.cluster.
musicRelayed` and `voice.cluster.musicAdopted` on the operator dashboard are
published-here and applied-from-there; relayed climbing while adopted stays
at zero everywhere is a relay that is not landing. Registry off (the
default) none of that runs, a room lives on one instance, and an API restart
clears the queue.

A third frame, `channel-music`, carries only the current track (id, title,
thumbnail) to everyone who may view the channel, in or out of the call, the
way `channel-live` does for a stream. It is sent when the current track
changes, when the room empties, and on connect for every room with music.
It exists for the sidebar: a row under the channel's occupants saying what
is playing is what makes somebody outside the call join.

## Who may do what

`Permission.MANAGE_MUSIC` (bit 24), in the cargo editor and the per-channel
overwrites beside `MUTE_MEMBERS` and `START_WATCH_PARTY`. The backfill
(`manage_music_bit_2026_09` in `schema.sql`) gives it to every cargo that
already holds `MUTE_MEMBERS` and to the seeded Moderator, never to
@everyone. A conversation call has no cargos, so everyone in it manages.

| | needs |
|---|---|
| add a song, or a list, to the end | `SPEAK` |
| remove a song you added | being in the call |
| start music when nothing is on | `SPEAK` (your own song) |
| skip, pause, resume, seek, skip-back, reorder, shuffle, remove others' songs, put a song on once the current one has ended, "Parar para todos" | `MANAGE_MUSIC`, or SPEAK while `openControls` is on. Seek and skip-back are on this row because both are ordinary writes for whoever is running the music, and skip-back and the end-of-track add both rewrite `history` |
| flip "Todo mundo controla" (`openControls`), set repeat, or flip "Continuar com parecidas" (`autoplay`) | `MANAGE_MUSIC` only, never a promoted speaker |
| autoplay the next related track when the queue ran out | being in the call, while `autoplay` is on, the queue is empty, and the current track has run out. The write must put on your own track with `autoplayed: true`, playing at 0, history as `musicAdvance` would, votes cleared |
| vote to skip | being in the call. A member may only add their own user id. The next write that matches `musicAdvance` is accepted once the held votes FROM PEOPLE STILL SEATED, plus that vote, reach `max(2, ceil(roomSize / 2))`. The threshold's denominator shrinks when somebody leaves, so its numerator does too: a vote is counted only while its owner holds a seat, and the votes themselves are left alone until the track changes |
| play a history row again | `SPEAK` (it is an ordinary own-append under your name) |

`channel-music` also carries `listeners`: how many seated peers have `listeningMusic` true. That flag lives on `voice_peers.listening_music` (default true) and on the roster as `listeningMusic`, the same way `sharingScreen` does. A client that predates `set-music-listening` never turns it off, so they still count. The count is sent again when it changes.

The next track after an end or a skip is `musicAdvance` in `packages/shared/src/music.ts`. Repeat-one keeps the current track at position 0. Repeat-all appends the finished track to the queue and pops the head. Otherwise the head is popped. The finished track is prepended to `history` (cap 10, duplicates by `videoId` dropped). Votes are cleared. Both the client and the rights check use that function, so a member's advance can be compared field for field.

Enforced on the server, not only in the UI. The write is a whole state
object, so `musicWriteAllowed` (`packages/shared/src/music.ts`) diffs it
against what the room holds and refuses anything outside the sender's
rights, handing the held state back on that socket with `forced: true`
(the sender's optimistic copy is a `rev` ahead and would otherwise call the
correction stale). The one subtlety is the end of a track: every player
fires "ended" and tries to advance, and a member's advance looks exactly
like a skip. A member's advance is accepted only once the SERVER's own
clock for the room is within `MUSIC_END_GRACE_MS` of the track's duration.
Both halves of that used to be writable by anybody seated, which made the
gate a formality: the position was the last sample, and the duration could
go from null to any value. The position is the anchor above. The duration
is filled at add time wherever possible (a pasted link has no duration from
oEmbed, so `resolveYouTube` asks InnerTube for one), and where it is still
null only a manager or the person who added the track may fill it in.
No bound on the filled value would do instead: any floor still lets the
filler end the track one grace later.

## Resolving a link

`GET /api/music/resolve?q=`, per-user rate limited, answers `{ tracks,
listName }` (and `track`, the first, for the first client build):

| Pasted | What happens |
|---|---|
| YouTube video (`watch?v=`, `watch/?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, YouTube Music, any of them with a trailing slash) | id off the URL; title and thumbnail off YouTube's oEmbed, no key; the duration from one InnerTube search, because oEmbed has none and the end-of-track gate needs one |
| YouTube playlist (`playlist?list=`, `watch?v=X&list=Y`, YouTube Music) | up to 50 items off InnerTube `browse` (or `playlistItems` with a key). A `watch?v=X&list=Y` starts at X, and a video past the first page is resolved on its own and placed first. A mix (`list=RD...`) is generated per viewer and has no list, so it is treated as its single video |
| Spotify track (`open.spotify.com/track/`, `intl-xx/track/`, `embed/track/`, `spotify:track:`) | title off Spotify's oEmbed, artist off the server-rendered embed page, then one search; keeps the Spotify URL for "abrir no Spotify" |
| Spotify album or playlist (same shapes, `album/`, `playlist/`) | the track list off the embed page, then one search per track, three at a time with one retry, capped at `SPOTIFY_LIST_MAX` (25) |
| `spotify.link/...` | followed, then parsed again |
| Spotify artist, other sites | refused with a message |
| Text that STARTS with a scheme and does not parse (`https://`) | refused the same way, rather than searched. Text that merely contains a colon or a scheme later on ("Rush 2112: Overture") is an ordinary search |
| Anything else | a search |

### Search: InnerTube, the way every music bot does it

Search and playlist reads go to YouTube's internal JSON API, InnerTube
(`youtubei/v1/search`, `youtubei/v1/browse`), in `server/src/services/innertube.ts`.
It is what the YouTube web, TV and mobile apps call and what Lavalink's
youtube-source, yt-dlp, Invidious and Piped call: no key, no quota, one call
for twenty results with title, duration and thumbnail. The official Data API
is not the standard for this because a `search.list` costs 100 of the 10,000
daily units, which is a hundred searches a day; with `YOUTUBE_API_KEY` set
it is used anyway, for the few deployments that want an official path.

Unofficial, so the module follows those projects' two rules. **More than one
client identity**: WEB first, TVHTML5 next; each is rate limited on its own
and answers in its own shape (`videoRenderer` and `lockupViewModel`), and a
client that fails hands over to the next. **Parse by walking, not by path**:
the tree around a result moves with YouTube's experiments, the result
renderers rarely do, so `collectVideos` finds them wherever they are. When
every client fails, the public results and playlist pages are scraped as the
last resort, which is where the feature started. Metadata only: no stream
URL is ever requested, which is the half of InnerTube that PO tokens guard.

### Related videos

`GET /api/music/related?videoId=` asks InnerTube `next` (`youtubei/v1/next`
with `{ videoId }`) for the watch-next list. Same two-client fallback and
the same walk-based `collectVideos`: WEB answers `compactVideoRenderer` and
sometimes `endScreenVideoRenderer`, TVHTML5 answers `lockupViewModel`. The
seed video is dropped. Up to 20 hits are kept (shorts and films are
filtered on the client). Remembered for six hours, keyed by video id, like
search. Concurrent related reads for the same id share one upstream call.
While "Continuar com parecidas" is on, the actor fills about three
upcoming related rows onto the queue *before* the current track ends, seeded
from the last queued id (or the current one). `musicAutoplayCandidate` drops
the finishing id, anything already in `history` or the queue, and anything
shorter than 60 s or longer than 12 minutes when duration is known (a clip
or a film, not a song). Unknown duration is kept. Those rows carry
`autoplayed: true`. ENDED then uses the ordinary `advance()`. A fetch at
ENDED is only the fallback when the buffer is empty.

**Nothing sweeps for divergence, and nothing needs to.** The bus is
fire-and-forget, so an instance that misses a `voice.music` frame holds a
stale queue. What corrects it is the music itself: while a track plays the
actor writes a position sample every ten seconds (`REPORT_MS`), and that
sample is an absolute state at a higher `rev` which crosses the same bus.
A stale instance is therefore at most about ten seconds behind, and when
nothing is playing there is nothing to be stale about. A join reads the
row directly, which covers the rest.

**Skip takes the same fallback.** `musicAdvance` ends the room on an empty
queue whatever `autoplay` says, so the skip button, which went straight to
`advance()`, ended the queue for somebody who had just switched the mode
on and pressed skip before the buffer had filled. `skipToNext` is the
button's path now: with anything queued it is the write it always was, and
into an empty queue with the mode on it asks for a related pick first and
only ends the room when there is genuinely nothing to play, or the lookup
fails.

Around it: a per-user limiter (20 burst, then one every two seconds), an
upstream budget across everybody on the process (300 burst, 10 a second)
charged per call to YouTube or Spotify rather than per request, so a cache
hit costs nothing, a pasted link costs one and a 25-track Spotify list costs
twenty-six; ONE six-hour search cache shared by `/api/music/resolve` and
`/api/music/search`, holding the list of hits so the first serves the
single-track path and all five serve the add box, with one upstream call
per key while it is in flight rather than one per caller; eight-second
upstream timeouts; and no URL query string in an error message (the Data
API key travels in one, which is why `fetchText` cuts the URL at the `?`;
the text somebody searched for is their own and does appear).

## Measured

`tools/music-load/` holds the two harnesses. Run on 2026-09-12 against the
local API and the real upstreams, from one address, over a home connection
in São Paulo.

**Link resolution** (`resolve-load.mjs`, 40 age-checked identities round-robin):

| Scenario | Result |
|---|---|
| 100 unique searches, concurrency 10 | 100/100 OK, p50 364 ms, p95 523 ms, 25 req/s served |
| the same 100 again | 100/100 from cache, p50 1 ms |
| 60 unique searches, concurrency 20 | 60/60 OK, p50 385 ms, p95 505 ms, 44 req/s |
| 10 YouTube playlists (50 items each), concurrency 10 | 10/10 OK, p50 409 ms, p95 1.2 s |
| 5 Spotify playlists (25 tracks each, 130 upstream calls), concurrency 5 | 5/5 OK, p50 3.6 s, max 5.6 s |
| 1.5 searches/s sustained for 3 minutes, all unique | 269/270 OK; the one failure was our own budget; p95 rose from about 500 to 690 ms over the run; no refusal from YouTube |

The first run of the same harness had the budget charged per request and
sized at 120 burst / 2 a second: it refused cache hits and a burst of sixty,
which is how the numbers above came to set the current size.

**Fan-out** (`ws-load.mjs`, 50 seats in one LiveKit room, one writer, a
50-track queue, so a frame is about 16.7 KB before compression):

| Writer rate | Echo latency at the 50 seats | Bytes per seat |
|---|---|---|
| 1 write/s | p50 6 ms, p95 10 ms, 10/10 echoed everywhere | 18 KB/s |
| 5 writes/s | p50 5 ms, p95 9 ms, 50/50 echoed | 82 KB/s |
| 10 writes/s | p50 5 ms, p95 8 ms, 70/100 echoed: the server coalesced 30 position-only writes past its budget, by design | 115 KB/s |

Real rooms sit far below the first row: the only unprompted writer samples
every ten seconds, so a 50-track queue costs each seat about 1.7 KB/s before
compression. The frame is dominated by the queue itself (about 330 bytes a
track); if that ever matters, the step is a delta frame for the queue, not a
smaller cap.

## The client

`client/src/lib/music-store.ts` holds the state outside `VoiceState` so a
position sample does not re-render the call stage; `use-voice.ts` feeds it
and registers a sender on every `welcome`.

The player lives in the composer of the call you are in.
The Music tile on the call dock opens Fila. Nothing draws in the
composer until that tile is pressed or a track is on. A track on is a
~72px bar: 56px art, title (marquee on hover), who added it, then the
infinity (Continuar com parecidas), skip-back, a filled round play, skip
or vote-skip, and repeat (managers; both modes hide under 28rem and move
into `…`). The infinity is Apple Music's glyph for the same idea, and it
took shuffle's slot on purpose: both controls in that pair are now modes
with a state you can see. Shuffle re-orders the QUEUE, so pressing it on
a bar with no queue on screen looked like nothing happening; it lives in
the Fila header now, where the list it re-orders is right below it, and
it is disabled under two tracks.
A seek with clocks sits across the full bar. Whoever runs the music seeks:
a manager, or anybody with SPEAK while Todo mundo controla is on. For
everybody else it is read-only. The bar holds a preview of the thumb's position only
while a pointer drag is in progress (`use-scrub.ts`): the slider is
controlled, so a key press arrives as commit-then-change, and a preview
cleared on commit alone was set again by the change that followed and
never cleared after that, freezing the clock for the rest of the track. A
change with no drag in progress seeks straight through. The right cluster
is the queue toggle, `…`, and a volume control on the bar itself. `…`
opens upward and is grouped by WHO each row reaches rather than by how it
is built: "Só pra você" (Abaixar durante a fala, and Parar de ouvir or
Ouvir), then the room's own (Todo mundo controla, Continuar com
parecidas, and Parar pra todos behind a confirm) for whoever may set
them. The two stops used to sit in different popovers, neither of them
labelled stop. A member sees the same bar as everybody else with the
controls they may not use shown locked, rather than a bar with holes in
it. Art and title
open the queue; adds, skips, and someone else starting a track do not.
Skip-back is client-only: past three seconds it restarts the current
track, otherwise the last Tocadas row becomes current and the one you
left goes to the front of the queue. Parar de ouvir leaves Ouvir on
that same bar. The dock tile stays; pressing it only toggles Fila
while a track is on.

The queue is Fila, `music-fila.tsx`, a chat-width sheet that grows up from
that bar (`max-height` so the field stays typeable). Members stay in the
right rail. The header is `Fila · N`, then +, Ver no palco, and X: no
overflow, because the bar under it is still the player. The sheet is
search, the queue, and Tocadas: no second now-playing card and no
second seek. Search is behind +, or the empty state. Queue rows
drag-reorder; hover and right-click share play-next, remove, and open
on YouTube or Spotify. Tocadas is collapsed at the bottom. Opening
another channel while still in the call puts the thin 32px + edge radio
back in the sidebar, with Fila as a drawer over members (that drawer
keeps the 48px card, seek, and the five-item `…`, because that radio
has no bar), without unmounting them.

The YouTube iframe stays in a hidden dock in `music-mini-player.tsx` for
the whole listen. Exactly one `MusicMiniPlayer` carries it, mounted in
`App` outside every branch, because the sidebar footer has three call
sites and two of them can be on screen at once (the sidebar stays mounted
under Novidades while Novidades renders a footer of its own); two
carriers portal two iframes into the one host and play the track twice.
The footers render the radio and the queue with `embed={false}`. It stays
mounted including after the queue is cleared: ending the room
stops the iframe (`stopVideo`) and does not destroy it. Unmounting is what
stops the sound, so that only happens on Parar de ouvir or leaving the
call.

Rooms you are not in show a card under their occupants
(`channel-music-card.tsx`): title, "N ouvindo" when the count is present,
and Ouvir to join. In the call the card is listen-only. Settings > Voz
has "Entrar na música da call automaticamente" and ducking.

A pasted link still goes through `GET /api/music/resolve`. Typed text goes
through `GET /api/music/search` and the person picks a row.

"Ver no palco" moves that same embed onto the call stage as a 16:9 tile.
The iframe never remounts, so the sound does not stop. Closing the tile is
the only way off. The tile keeps fullscreen. Placement is remembered per
browser in `client/src/lib/music-prefs.ts`.

Ducking is personal. `music-duck.ts` ramps the embed from full volume to
35% over 200 ms when someone is speaking (`speakingPeerIds` or this
machine's transmit gate) and back over 800 ms when they stop. The
preference is on by default; a deafened listener is not ducked, because
nobody is audible to them. Off means a room that already has music shows
Ouvir instead of the player, and Parar de ouvir keeps you out for the rest
of that seat.

Sync rules in the player: a new track loads at the room's expected position; a
status change plays or pauses; every two seconds a non-actor compares the
player's clock with the room's and seeks when more than 2.5 s off; the actor
samples their position every 10 s so a joiner lands close, and nobody else
writes unprompted. Every write samples the live player position, so a queue
edit never carries a stale one. A track ending advances the queue, guarded
on the id so a straggler cannot skip the track the room already moved to.
When `autoplay` is on and repeat is off, the actor keeps about three
related tracks on the queue so ENDED can advance without waiting on
InnerTube. Listeners do not prefetch: that used to mean every seat
asked InnerTube for the same seed. If the queue is still empty at ENDED,
the actor fetches `/api/music/related` at once, or any member does after
1.5 s, and writes one related track with `autoplayed: true`. The play
effect must not call `playVideo()` while YouTube is ENDED, except on
repeat-one: that is what used to restart the finished song. A new add
after this machine saw ENDED starts that pick now and drops pending
autoplayed rows so it becomes the radio seed.

Autoplay can be refused until the page has a gesture; the dock shows
"Toque para tocar" when the player has not started two seconds after being
told to.

## Not done yet

- A "now playing" line in the channel, and on o recado.
- iOS and Android: the frame is shared, the players are not written.
- Persisting the queue across an API restart (the row survives a restart
  only while somebody is still seated; an empty room takes it with it).
