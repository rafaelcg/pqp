# Jam, the web client

The screens on top of the audio engine (`docs/JAM_ENGINE.md`) and the server half
(`docs/JAM.md`). A `jam` channel is presented as an app: a row in the sidebar, a
wall of songs, an open song, and a studio.

Code: `client/src/components/jam/` (screens), `client/src/hooks/use-jam-*.ts`
(config, playback, studio, sidebar), `client/src/lib/jam-*.ts` (the rules, with no
React in them). The engine itself is `client/src/lib/jam/` and is not touched.

## Where it lives

| Piece | Where |
|---|---|
| Add a Jam | The Texto "+" menu, a category's "+" menu and, in the mixed list, an "Adicionar Jam" row beside "Criar categoria". Once per server, only for MANAGE_CHANNELS, only while `jam_channels` is on. One click, no name prompt: the channel is called `jam` (`handleCreateJam` in `App.tsx`) |
| The row | `ChannelRow` with a `jam` prop: the jam icon (a rounded square in the guitar colour, `ChannelIcon`), "N músicas" under the name, the unread bar and a screen-reader "música nova". The classic list draws it in an "Apps" section; the mixed list draws it as an ordinary row |
| The pane | `JamPane`: the wall, the open song beside it (over it on a phone) and the studio over everything. `App` mounts it for `type === "jam"` and never mounts the chat there |
| Realtime | The seven jam frames are in `chatServerMessageSchema` and reach `lib/jam-store.ts` through `lib/jam-frames.ts`; `lib/jam-state.ts` applies each one by id, idempotently (the writer's own socket gets its own frame) |

The flag and storage come from `GET /api/jam/config?serverId=` (`hooks/use-jam-config.ts`).
Off hides every add button and says "paused"; reading is never gated. `uploads:
false` (no bucket) says so on the wall and in the song instead of failing after a
recording.

## The wall

Songs are tiles of three sizes (`planTiles` in `lib/jam-wall.ts`): the most active
song is the hero (2 by 2), one in every four after it is wide, the rest small. A
size follows the position and nothing else, so a tile never changes size under a
finger when somebody else's song moves. A song with a video shows the video's
first frame; an audio-only one is a flat tile in its main instrument's colour
drawing its `peaks`. A tile says the title, who is on it and what it needs
(`songNeed`: "falta voz", "faltam baixo e bateria", "qualquer um entra", "pronta").

The list read carries neither peaks nor videos, so the wall reads the first dozen
songs' detail three at a time and the tile fills in (it is complete before that:
stand-in bars, the author, a count). Filters are Tudo, Falta alguém (everything
somebody could still add to) and Prontas.

**Sections.** `JamWallSection` is `{ id, songs }`; the wall renders a list of them.
The public songs from jam.pqp.gg become a second section later. Nothing public is
built here.

**Unread.** Jam frames only reach a socket that joined the channel, so a closed Jam
learns of a new song by asking: when the channels load, on window focus and every
three minutes (`hooks/use-jam-sidebar.ts`). Opening the wall spends the dot
(`lib/jam-seen.ts`, per device).

## The song

All in-mix tracks play through the one engine (`lib/jam-session.ts`, shared with
the studio so a take is placed against the backing on one clock). One lane per
track on the song's timeline (so every lane lines up), with person, instrument,
mute, volume and solo (the listener's own mix, never sent), the videos locked to
the audio, competing takes (more than one for an instrument) with votes and an
"Ouvir no lugar" audition, and for the song's author or a moderator the switch
that puts a take in or out of the mix. "Gravar por cima" is drawn only when
`viewer.addableInstruments` allows it, and says why not otherwise.

## The studio

Pick the instrument (pre-selected by `pickInstrument`: what the song is asking for),
press the big button, play, stop, listen with the band, send. Everything else on
the screen (input, level, latency, count-in, tempo, camera, trim, nudge, volume)
is for when something is wrong.

- **First use on a pair of devices**: a one-screen explanation of the latency
  check with two ways to measure and a skip that says what it costs. The engine
  stores the result per device pair, so it is asked once.
- **Recording**: count-in (1 or 2 bars, tempo with a tap button), a live waveform
  growing on the same timeline as the others (`lib/jam-live.ts`: a drawn bar never
  changes), the level meter beside it.
- **Review**: the take drops into the mix and plays with the band. Posting needs
  no edit. Optional: trim start and end, nudge, volume (`lib/jam-take-edit.ts`; a
  trim never reveals the count-in the engine hid).
- **Posting** (`lib/jam-upload.ts`): ticket, `PUT` with progress, claim. The state
  is a value the caller keeps, so a retry continues where the last try stopped and
  reuses the same upload id; a video that will not go can be dropped and the sound
  posted alone. A new song is created at post time, not before, so an abandoned
  studio leaves nothing on the wall.

**Starting a song** is the same studio with no backing, behind one small sheet:
title, optional artist (empty means an original), who may join (anyone, only the
instruments I am looking for, only me).

## Taps

Measured by `e2e/jam-web.spec.ts`:

| Flow | Taps |
|---|---|
| Server to the studio, over an existing song | 3: the Jam row, the tile, "Gravar por cima" |
| ...then recording | +1 for the big button (+1 on the first use of a pair of devices: measure or skip) |
| Stop to posted | 1: "Mandar pra banda" |

## Copy, motion, theme

All copy is `jam.*` in the three catalogues; pt-BR is `tu`. Motion is
`components/jam/jam.css`: transform and opacity only, ends on the resting style,
all of it off under `prefers-reduced-motion`. The instrument colours are role
tokens (`docs/DESIGN.md`), measured by the bench in every theme.

## Server contract notes

- The engine uploads FLAC (`audio/flac`). The contract listed only webm, ogg, mp4
  and mpeg until PR #1573 added it; this client needs that change on `main`.
- The song summary carries no `peaks`, no video flag and no list of who is on it,
  which is why the wall reads details. A `hasVideo`, a `coverPeaks` and the first
  three contributors on the summary would remove up to a dozen requests per wall.

## Not here

Public songs, comments, the iOS and Android clients (both phones leave a `jam`
channel out of their list), punch-in re-record, a server-side sidebar signal for
a Jam nobody has open.

## Try it in five minutes

1. `docker compose --profile storage up -d minio minio-init` (a native Postgres on
   5432 may shadow Docker's: use your own `DATABASE_URL`).
2. `JAM_CHANNELS=true` in the root `.env`, `pnpm dev`.
3. Open http://localhost:5173/app. Sandbox's Texto "+" now offers **Jam**. Click it.
4. **Gravar uma música**, name it, **Ir pro estúdio**. Allow the microphone. Skip
   the latency check (or measure with the speakers). Press the red button, play
   for a few seconds, stop, **Mandar pra banda**. The song opens and plays.
5. In another window set `localStorage.setItem("pqp:dev-user-suffix", "bob")` and
   reload. Jam row, tile, **Gravar por cima**. Back in the first window the new
   lane appears without a reload.
