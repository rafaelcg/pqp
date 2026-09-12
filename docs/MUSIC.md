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

## Resolving a link

`GET /api/music/resolve?q=`, per-user rate limited:

- **YouTube link**: the id off the URL, the title and thumbnail off YouTube's
  oEmbed endpoint. No key, no quota.
- **Spotify track link**: the title off Spotify's oEmbed endpoint, the artist
  off the server-rendered embed page, then a YouTube search. The result keeps
  the Spotify URL so the panel can offer "abrir no Spotify". Albums and
  playlists are refused.
- **Anything else**: a YouTube search.

Search uses the YouTube Data API when `YOUTUBE_API_KEY` is set (100 quota
units per search on a 10,000/day free key) and otherwise reads the first
result off the public results page. Metadata only, either way.

## The client

`client/src/lib/music-store.ts` holds the state outside `VoiceState` so a
position sample does not re-render the call stage; `use-voice.ts` feeds it
and registers a sender on every `welcome`. `components/voice/music-bar-button.tsx`
is the control on the call bar beside camera and screen share ("Tocar
música", lit while something plays); `components/voice/music-dock.tsx` is the
line on the call strip and the popover both open: a visible YouTube embed,
play/pause, skip, stop, a local volume slider and the queue with reorder and
remove. The sidebar row is in `layout/channel-list.tsx`, off
`voiceState.channelMusic`.

Sync rules in the dock: a new track loads at the room's expected position; a
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
