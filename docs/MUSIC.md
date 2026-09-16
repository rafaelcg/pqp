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
| `positionMs`, `atMs` | a position sample; the receiver measures elapsed time from its own arrival clock, never from `atMs` (see `watchPartyStateSchema.atMs` for why) |
| `rev`, `actorId` | the logical clock and its tie-break |
| `openControls` | when true, anyone with SPEAK is treated as a manager. Only a manager writes it. A write that omits it keeps what the room already holds |
| `repeat` | `off`, `one` (this track again), or `all` (finished tracks go to the end of the queue). Default `off` |
| `skipVotes` | user ids that have voted to skip the current track. Any change of `current` clears it |
| `history` | the last ten finished tracks, most recent first. A repeat of the same `videoId` moves that row to the front |
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
| skip, pause, resume, reorder, shuffle, remove others' songs, "Parar para todos" | `MANAGE_MUSIC`, or SPEAK while `openControls` is on |
| flip "Todo mundo controla" (`openControls`), set repeat, or flip "Continuar com parecidas" (`autoplay`) | `MANAGE_MUSIC` |
| autoplay the next related track when the queue ran out | being in the call, while `autoplay` is on, the queue is empty, and the current track has run out. The write must put on your own track with `autoplayed: true`, playing at 0, history as `musicAdvance` would, votes cleared |
| vote to skip | being in the call. A member may only add their own user id. The next write that matches `musicAdvance` is accepted once `held.skipVotes` plus that vote reaches `max(2, ceil(roomSize / 2))` |
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
like a skip. The room's last writer samples the track's duration along
with its position, and a member's advance is accepted only once the last
sample is within `MUSIC_END_GRACE_MS` of that duration.

## Resolving a link

`GET /api/music/resolve?q=`, per-user rate limited, answers `{ tracks,
listName }` (and `track`, the first, for the first client build):

| Pasted | What happens |
|---|---|
| YouTube video (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, YouTube Music) | id off the URL; title and thumbnail off YouTube's oEmbed, no key |
| YouTube playlist (`playlist?list=`, `watch?v=X&list=Y`, YouTube Music) | up to 50 items off InnerTube `browse` (or `playlistItems` with a key). A `watch?v=X&list=Y` starts at X, and a video past the first page is resolved on its own and placed first. A mix (`list=RD...`) is generated per viewer and has no list, so it is treated as its single video |
| Spotify track (`open.spotify.com/track/`, `intl-xx/track/`, `embed/track/`, `spotify:track:`) | title off Spotify's oEmbed, artist off the server-rendered embed page, then one search; keeps the Spotify URL for "abrir no Spotify" |
| Spotify album or playlist (same shapes, `album/`, `playlist/`) | the track list off the embed page, then one search per track, three at a time with one retry, capped at `SPOTIFY_LIST_MAX` (25) |
| `spotify.link/...` | followed, then parsed again |
| Spotify artist, other sites | refused with a message |
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
the same walk-based `collectVideos`: WEB answers `compactVideoRenderer`,
TVHTML5 answers `lockupViewModel`. The seed video is dropped. Remembered
for six hours, keyed by video id, like search. The client then runs
`musicAutoplayCandidate`: drop the finishing id, anything already in
`history` or the queue, and anything shorter than 60 s or longer than 12
minutes when duration is known (a clip or a film, not a song). Unknown
duration is kept. The first remaining is minted under the writer and
written with `autoplayed: true`.

Around it: a per-user limiter (20 burst, then one every two seconds), an
upstream budget across everybody on the process (300 burst, 10 a second)
charged per call to YouTube or Spotify rather than per request, so a cache
hit costs nothing, a pasted link costs one and a 25-track Spotify list costs
twenty-six; a six-hour search cache; eight-second upstream timeouts; and no
query string in an error message (the Data API key travels in one).

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
and registers a sender on every `welcome`. `components/voice/music-mini-player.tsx`
is the player at the bottom of the sidebar, above the call status. Nothing
playing is a "Tocar música" row that opens the add box. `components/voice/music-dock.tsx`
is the title line on the call strip; a click unfolds the same player.
The player itself is pinned at the bottom of the sidebar above the call
controls. Two heights of one player, not two modes. At rest it is a bar:
40px artwork, title (always marquee), who added it (avatar and name, or
"Tocando parecidas" when the room picked the track), play/pause and skip.
Progress is the top edge of that bar, a 2px fill on the divider, not a
second row. A member without manage rights sees vote skip
(`1/3`) instead of a dimmed skip. A click on the art, the title, or the
chevron opens the sheet in place: a 56px artwork row (title, who added
it, and "N ouvindo"), an optional 16:9 video capped at about 135px, a
scrubber that stays up even before duration is known (managers seek;
everyone else sees progress), a transport row with repeat and shuffle
on the left for effective managers, play/pause in the centre and skip
(or vote skip) on the right, volume with mute, an activity line ("Rafa
pulou"), a search box that shows the top five results under the input,
the queue with thumbnail, duration, who added it, drag reorder, play
next, remove and "Abrir no YouTube" / "Abrir no Spotify", and a
"Tocadas" list (collapsed to the count when the queue has rows). Room
options live in the sheet's overflow (`...`): "Abaixar quando alguém
fala", show/hide video, "Assistir na tela", "Todo mundo controla" and
"Continuar com parecidas" for effective managers, and "Parar pra todos"
behind a confirm, the room-wide stop. "Parar de ouvir" is an icon on
the compact bar and on the sheet header, next to the overflow: it
unmounts this machine's embed and leaves a one-line pill with "Ouvir"
as the way back while the room's queue carries on. A room that is already
playing shows the bar. Tocar música or adding a song opens the sheet,
because that is where search lives. A pasted link still goes through
`GET /api/music/resolve`.
Typed text goes through `GET /api/music/search` and the person picks a
row. The embed is mounted for the whole call while this machine is
listening, including after the queue is cleared: ending the room stops
the iframe (`stopVideo`) and does not destroy it, because tearing it
down is why a second queue sometimes never played. Unmounting is what
stops the sound, so that only happens on "Parar de ouvir" or leaving
the call. The video is folded to zero height by default and the choice
is remembered. Rooms you are not in show a card under their occupants
instead (`channel-music-card.tsx`, off `voiceState.channelMusic`):
artwork, the title, "N ouvindo" when the count is present and above
zero, and an "Ouvir" that joins the call.

"Assistir na tela" moves that same embed onto the call stage as a 16:9
tile, through the one-mount portal `watch-dock.tsx` already uses: a
detached host is `appendChild`'d between the panel's video slot and
`MusicStageTile`. The iframe never remounts, so the sound does not stop.
When nobody else is publishing, the clip owns the picture pane and the
call controls stay on the call bar: no extra people strip, no overlay
control row. A camera or a share still expands the usual stage
chrome, with the music tile in the grid (featured when nothing else is).
The tile keeps a title overlay and "Voltar pra barra", and uses the
existing fullscreen control. Navigating to a text channel rescues
the host back to the sidebar dock; the placement is remembered per
browser in `client/src/lib/music-prefs.ts`.

Ducking is personal. `music-duck.ts` ramps the embed from full volume to
35% over 200 ms when someone is speaking (`speakingPeerIds` or this
machine's transmit gate) and back over 800 ms when they stop. The
preference is "Abaixar quando alguém fala", on by default; a deafened
listener is not ducked, because nobody is audible to them.

Nothing playing is a "Tocar música" row above the call status. That
opens the add box (the sheet). A room that is already playing shows the
bar, not the sheet. Settings > Voz has "Entrar na música da
call automaticamente"; off means that transition shows the one-line
pill instead, and "Ouvir" is how you join. "Parar de ouvir" keeps you
out for the rest of that seat.

Sync rules in the player: a new track loads at the room's expected position; a
status change plays or pauses; every two seconds a non-actor compares the
player's clock with the room's and seeks when more than 2.5 s off; the actor
samples their position every 10 s so a joiner lands close, and nobody else
writes unprompted. Every write samples the live player position, so a queue
edit never carries a stale one. A track ending advances the queue, guarded
on the id so a straggler cannot skip the track the room already moved to.
When `autoplay` is on, the queue is empty and repeat is off, the actor
fetches `/api/music/related` and writes a related track with
`autoplayed: true`. If the actor has left, any member does the same after
1.5 s.

Autoplay can be refused until the page has a gesture; the dock shows
"Toque para tocar" when the player has not started two seconds after being
told to.

## Not done yet

- A "now playing" line in the channel, and on o recado.
- iOS and Android: the frame is shared, the players are not written.
- Persisting the queue across an API restart (the row survives a restart
  only while somebody is still seated; an empty room takes it with it).
