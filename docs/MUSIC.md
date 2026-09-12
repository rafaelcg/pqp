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

Last-writer-wins, no host: whoever acted most recently controls the player,
with `rev = seen + 1` and the peer id breaking ties. This is the contract the
watch party's synchronised player already carries (`watch-party.ts`), and
the server half is the same shape (`server/src/ws/music.ts`: hold the state
so a joiner lands at the right position, coalesce position-only writes
instead of dropping them, tear down with the room).

Frames: `set-music` client to server, `music` server to the room, sender
included as the acknowledgement. A joiner is handed the state after
`welcome`. Not mirrored into the voice registry: a room lives on one
instance, and an API restart clears the queue.

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
| skip, pause, resume, reorder, remove others' songs, "Parar para todos" | `MANAGE_MUSIC` |

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
| YouTube playlist (`playlist?list=`, `watch?v=X&list=Y`, YouTube Music) | up to 50 items off the public playlist page (`lockupViewModel` entries), or `playlistItems` with a key. A `watch?v=X&list=Y` starts at X. A mix (`list=RD...`) is generated per viewer and has no page, so it is treated as its single video |
| Spotify track (`open.spotify.com/track/`, `intl-xx/track/`, `embed/track/`, `spotify:track:`) | title off Spotify's oEmbed, artist off the server-rendered embed page, then one YouTube search; keeps the Spotify URL for "abrir no Spotify" |
| Spotify album or playlist (same shapes, `album/`, `playlist/`) | the track list off the embed page, then a YouTube search per track, two at a time with one retry, capped at `SPOTIFY_LIST_MAX` (10) |
| `spotify.link/...` | followed, then parsed again |
| Spotify artist, other sites | refused with a message |
| Anything else | a YouTube search |

Search uses the YouTube Data API when `YOUTUBE_API_KEY` is set (100 quota
units per search on a 10,000/day free key, which is why the key is not the
default: ten playlists a day would exhaust it) and otherwise reads the first
result off the public results page. Search answers are cached in memory for
six hours, so a list pasted twice costs one round of searches. Metadata only,
either way.

**Known limit.** A Spotify list is slow (about two seconds per track, ten
tracks in twenty seconds) because every track is a YouTube search and a
burst of them from one address makes YouTube drop connections. The fix is
progressive loading (resolve the first few, queue the rest as they land),
not a bigger cap.

## The client

`client/src/lib/music-store.ts` holds the state outside `VoiceState` so a
position sample does not re-render the call stage; `use-voice.ts` feeds it
and registers a sender on every `welcome`. `components/voice/music-bar-button.tsx`
is the control on the call bar beside camera and screen share ("Tocar
música", lit while something plays); `components/voice/music-dock.tsx` is the
line on the call strip and the popover both open: the add box and the queue
with reorder and remove. The player itself is
`components/voice/music-mini-player.tsx`, pinned at the bottom of the
sidebar above the call controls, shaped like a music app's mini player. At
rest it is one card: artwork, title (scrolls on hover), who added it,
play/pause and skip. It opens (the chevron, or the button on the call bar)
into the video toggle, volume with mute, the add box, the queue with
reorder and remove, and two text actions: "Parar de ouvir", which unmounts
this machine's embed and leaves a one-line pill with "Ouvir" as the way
back while the room's queue carries on, and "Parar para todos", the
room-wide stop. It is mounted for the whole call whatever the reader is
looking at, because unmounting the embed is what stops the sound; the video
is folded to zero height by default and the choice is remembered. Rooms you
are not in show a card under their occupants instead
(`channel-music-card.tsx`, off `voiceState.channelMusic`), whose title joins
the call. `components/voice/music-dock.tsx` is only the title on the call
strip.

Sync rules in the player: a new track loads at the room's expected position; a
status change plays or pauses; every two seconds a non-actor compares the
player's clock with the room's and seeks when more than 2.5 s off; the actor
samples their position every 10 s so a joiner lands close, and nobody else
writes unprompted. Every write samples the live player position, so a queue
edit never carries a stale one. A track ending advances the queue, guarded
on the id so a straggler cannot skip the track the room already moved to.

Autoplay can be refused until the page has a gesture; the dock shows
"Toque para tocar" when the player has not started two seconds after being
told to.

## Not done yet

- Ducking the music under speech, like the watch-party stream mixer.
- A "now playing" line in the channel, and on o recado.
- Vote skip, a DJ permission bit, per-server history.
- iOS and Android: the frame is shared, the players are not written.
- Persisting the queue across an API restart (registry row).
