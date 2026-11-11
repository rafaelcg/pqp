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
| The row | `ChannelRow` with a `jam` prop: the jam icon (a rounded square in the guitar colour, `JamRowIcon`), "N músicas" under the name, the unread bar and a screen-reader "música nova", on a card with a drifting wash in the instruments' colours (`components/jam/jam-row-art.tsx`, `jam-row.css`). Its face is one function of signals the client already holds (`jamRowMood` in `lib/jam-row-state.ts`: playing, news, empty, quiet; `lib/jam-now-playing.ts` follows the shared engine's transport, so no frame and no request). The wash carries the whole palette and always drifts, about 28 s a loop at rest and faster with attention (hover, then news, the open page, a song playing); news also plays a sheen three times and playing turns the icon into an equaliser. Transform and opacity only, stepped (about 12 compositor frames a second at rest), paused off screen and in a hidden tab, none of it under reduced motion, where the still picture keeps the colour. The classic list draws it in an "Apps" section; the mixed list draws it as an ordinary row |
| The pane | `JamPane`: the wall, the open song beside it (over it on a phone) and the studio over everything. `App` mounts it for `type === "jam"` and never mounts the chat there |
| Realtime | The seven jam frames are in `chatServerMessageSchema` and reach `lib/jam-store.ts` through `lib/jam-frames.ts`; `lib/jam-state.ts` applies each one by id, idempotently (the writer's own socket gets its own frame) |

The flag and storage come from `GET /api/jam/config?serverId=` (`hooks/use-jam-config.ts`).
Off hides every add button and says "paused"; reading is never gated. `uploads:
false` (no bucket) says so on the wall and in the song instead of failing after a
recording.

## The wall

Every song is the SAME card (`JamTile`): its picture on top, clean, and a footer of
its own under it that holds all the words (title, who is on it, what it needs) and
the one round play button. Nothing is ever drawn across the picture, so a cover
photo with big lettering of its own, a dark one, a pale one, a mosaic of faces and
the generated band all sit in the same card. The card is two buttons that are not
nested: a stretched one that opens the song (paused) and the round one that plays
it. The footer is a container: long labels switch to short ones on a narrow card
("Faltam bateria e voz", "Faltam 2", "+2"), so nothing is cut mid-word and the play
button never leaves the card, in pt-BR, English or Spanish.

The grid is `wallColumns(width)` columns (two on a phone, up to six on a big screen,
the content capped at 1720 px and centred). At most ONE card is featured (`planTiles`):
twice as wide, its picture a square twice the size and its footer, taller, carrying
the band's instrument dots too. It is the song with the most people and recordings
in it (what is IN a song, not when it was touched, so a one-take riff is never the
big tile while a six-person band is small), and only when the songs after it can
fill the cells beside it (a count the wall computes from its measured width), so the
grid never has a hole.

A card is drawn from the song SUMMARY alone (the preview fields of `docs/JAM.md`).
The picture is, first that applies: the cover photo the owner chose (a square, the
same frame the crop step shows); a mosaic of the first frames of the song's videos
(one to four, cropped from the top so a face survives; only a card with `hasVideo`
reads its detail, once it comes near the screen); or the band, one lane per
instrument in its colour with the loudest stem's `previewPeaks` running through it
(`BandArt`, lanes capped in height so a riff is one calm band, a dashed lane for each
of the `missingInstruments`). The open song's header draws the same picture
(`JamArtwork`), so the card and the panel tell one story, and opening a card morphs
its picture into the panel's cover (a View Transition where the browser has one).
A swapped cover keeps the old picture on screen until the new one has loaded. Filters
are Tudo, Falta alguém (everything somebody could still add to) and Prontas.

**Click to play.** A click (or Enter) on a card opens the song AND plays it; the
card's round button plays and pauses without changing anything else; a song that is
playing already is only opened. The click and the keypress are the gesture a browser
wants before it lets a page make sound, so they call `unlockJamAudio()`
(`lib/jam-session.ts`) in the very task of the gesture, not later from an effect. A
link or Back still opens a song and waits.

**Keyboard.** Opening a song puts focus in it (its title), and Escape closes it and
gives focus back to the card. Space belongs to the wall (`JamPane`) and plays or
pauses: the open song (playing or paused), else the card the keyboard is on, else
the first card. It leaves a field or a control that owns Space alone, except a card's
own button (which would open and play THAT card). The studio does the same.

**Tão te chamando.** Above the tiles, one card per instrument a `wanted` song is
still missing ("Falta voz em In Bloom"), in that instrument's colour. One click
opens the song behind and the studio over it on that instrument.

**First visit.** An empty Jam shows the how-to picture (three lanes slide in, one
playhead sweeps across all of them, a dashed "tua parte" lane), the one button and
three steps in words. The same picture heads the "Como funciona" sheet.

**Sections.** `JamWallSection` is `{ id, songs }`; the wall renders a list of them.
The public songs from jam.pqp.gg become a second section later. Nothing public is
built here.

**Unread.** Jam frames only reach a socket that joined the channel, so a closed Jam
learns of a new song by asking: when the channels load, on window focus and every
three minutes (`hooks/use-jam-sidebar.ts`). Opening the wall spends the dot
(`lib/jam-seen.ts`, per device).

## An address for a song

`/app/server/<serverId>/channel/<jamChannelId>/song/<songId>` (the forum's
`/post/<postId>` shape; `jamSongRoutePath` and `parseAppRoute` in
`client/src/lib/app-route.ts`). Opening a tile puts it in the address bar,
closing the panel puts the Jam's own address back, and a pasted link opens the
wall with that song open (read by id when it is not on the first page; a song
that does not exist says so). It survives a sign-up redirect like every `/app`
route.

**Wall, song and studio are history steps** (`lib/jam-history.ts`, `jam-pane.tsx`).
Opening a song from a tile pushes an entry (`{ jamStep: "song" }` in the router
state), opening the studio pushes another with the same path (`"studio"`), so the
browser's Back and the phone's go studio, song, wall instead of out of the app.
The flag in the state is what says "the entry below is the previous Jam step", and
it survives a reload, so closing a step in the app goes BACK when the flag is there
and rewrites the address (the forum's way) when it is not (a pasted link). Back from
a studio holding a recording or a take asks the studio's own "Descartar esse take?";
"keep" puts the entry back. A reload on a studio entry lands on the song. A new
song's studio entry becomes the song's when the take is posted.

**Unsent work.** A take that is recorded and not sent, or one going up, makes the
browser ask before a reload or a closed tab (`beforeunload`, in those two phases
only). A song is created before its first take is uploaded, so a closed page leaves
a song with no take; the server keeps it from everybody else (`docs/JAM.md`), the
author sees "Sem faixa ainda" with "Gravar o primeiro take" and "Apagar música", and
leaving the studio of a song it made, with nothing sent, deletes the empty song.

## The song

All in-mix tracks play through the one engine (`lib/jam-session.ts`, shared with
the studio so a take is placed against the backing on one clock). The panel is a
header (a cover, the title, the people), and **the band**, whose sticky
header holds play and pause right over the lanes: one lane per track as a clip on the song's ONE timeline,
a ruler to click to jump, and a playhead line in every lane.

**The stage.** A song with at least one in-mix recording that has a video opens on a
stage (`JamStage`): one 16:9 tile per such recording at real size, full width of the
panel, no taller than about 55vh (so the lanes stay in view on a laptop). One video
is one large tile, two sit side by side, three in a row, four as two by two, then an
even grid. Each tile is muted (the sound is the mix), follows the song clock with the
engine's video follower (`attachVideo`: the file's time is the song's time minus the
take's offset), carries a chip with the person's name and the instrument's colour as
a dot, and dims when its lane is muted or another lane is "Só essa". The stage can go
full screen. With a stage the header is compact (a 56 px cover, the title, and the
play button beside it); a song with no video keeps the full header (a 120 px cover)
and the play button above the lanes. The lane carries no thumbnail.

**One lane layout** (`JamLaneFrame`, the song's lanes and the studio's review). Wide
(the band is 40rem or more across, a container query because the song panel is a
side panel): one line, `[badge + name over person (10rem) | waveform | controls]`.
Narrow: two, the identity with the controls and then the waveform, the controls
wrapping to a line of their own only when they do not fit. Every control is an icon
with a tooltip and a name for a screen reader (the headphones icon is the one that
says mute, volume and "Só essa" are only what you hear); "Ajustar" is one of them,
never laid over the name. The waveform is a quiet surface with bars in the
instrument's colour (`look.bar`, pulled toward the text colour so a yellow stays
visible on a light theme), the played part at full strength and the rest dimmer.
A lane has its
person, instrument, mute, solo and volume (the listener's own mix, never sent);
competing takes (more than one for an instrument) carry votes and an "Ouvir no
lugar" audition; the song's author or a moderator gets "Usar este take" (and
"Tirar da mix" in the lane's menu). A missing instrument is a dashed lane with
"Gravar a voz", which opens the studio on it. The videos, locked to the audio,
are the stage above the band. "Gravar" (named for the missing instrument when there is
one) is drawn only when `viewer.addableInstruments` allows it, and says why not
otherwise. Finishing and deleting the song are in the header's menu.

**One sound at a time.** The engine is shared, so opening the studio stops
whatever the song panel was playing (`use-jam-studio.ts`, at boot) and the
panel's autoplay never starts under the studio. The studio has its own play and
pause for the band before recording and for the take after.

## Mixing: one take per instrument

The server lets several takes of one instrument be in the mix at once. The screens
treat the mix as one take per instrument: **"Usar este take"** on a take that is
out puts it in and then takes the other in-mix takes of its instrument out (two
writes, in that order, so a failure between them leaves both playing and says so,
never a silent instrument). A track's author can **adjust it after posting** from
the "Ajustar" on their own lane, with the same clip editor as the studio (below);
every drag is heard at once and "Guardar" sends only what changed
(`PATCH /api/jam-tracks/:id`).

## Adjusting: the clip editor

`components/jam/jam-clip-editor.tsx`, arithmetic in `lib/jam-clip.ts`. The take is
a clip on the song's timeline with the band's waveform drawn behind it
(`bandEnvelope`: the loudest moment of any in-mix lane per slice, each lane scaled
to itself), and a line where the song starts. Drag an end to cut (the cut parts
stay visible, shaded); drag the middle to move it in time; "Mais cedo" and "Mais
tarde" move it 10 ms; one volume. "O começo de perto" zooms to the three seconds
around the take's start, where lining up is decided. Each end and the middle are
`role="slider"` for the keyboard (arrows; Shift for big steps; Home puts it back).

## The studio

Pick the instrument (pre-selected by `pickInstrument`: what the song is asking for),
press the big button, play, stop, listen with the band, send. Each phase says
what it is asking in one heading ("O que tu vai tocar?", "Gravando voz", "Ficou
bom? Manda pra banda."). Everything else on the screen (input, level, latency,
count-in, camera, adjusting) is for when something is wrong.

**No tempo, no BPM.** The count-in is a switch, "Contar antes de começar" (four
clicks at a fixed speed, then the band), on by default. Its speed was a BPM field
with a tap button; it never changed the song or the placement of a take (the
engine places a take by the clock, not the beat), so a first-time player was
asked a number that did nothing for them. The engine still takes any `countIn`.

- **First use on a pair of devices**: one line in the dock above the record
  button, never a gate: "Quer cravar o tempo?" with "Medir agora" (7 s, by the
  microphone), tap-along, and "Agora não"; the why is its tooltip. The red button records either
  way; pressing it with the check pending is the skip (the browser's estimate is
  used and the skip is remembered for that pair of devices). The engine stores a
  measurement per device pair, so nobody meets the suggestion twice; afterwards
  the latency chip and "Calibrar" in "Teu som" (the header button: input, level,
  count-in, video, delay) remain. The record button's ring follows the microphone
  level before and during a take.
- **Recording**: count-in (one bar), a live clip growing on the same timeline as
  the others with a red edge where it is being written (`lib/jam-live.ts`: a drawn
  bar never changes), the band's lanes showing where they are, the level meter.
- **Review**: the take drops into the mix and plays with the band. "Mandar pra
  banda" is the one big button; posting needs no edit. "Ajustar" is a smaller
  button that opens the clip editor on the take (`lib/jam-take-edit.ts`; a cut
  never reveals the count-in the engine hid).
- **Posting** (`lib/jam-upload.ts`): ticket, `PUT` with progress, claim. The state
  is a value the caller keeps, so a retry continues where the last try stopped and
  reuses the same upload id; a video that will not go can be dropped and the sound
  posted alone. A new song is created at post time, not before, so an abandoned
  studio leaves nothing on the wall.

- **Leaving**: "Voltar" asks before it throws away a live recording, as it does for a take not sent.
- **Replacing a take**: when the poster may switch the mix and already has a take of
  that instrument in it, review asks in one line whether the new one replaces it
  (default yes); after posting the new take goes in and the old one out.
- **The song disappears**: if somebody deletes the song under a recording the studio
  keeps its title and its band, says so, and offers to post the take as a song of its
  own (the recording is kept; only the upload tickets are asked for again) or to
  discard it.
- **The input goes away** (unplugged, permission taken back; the track's `ended`):
  a recording stops at once, keeps what was played when it has a second of sound
  that is not a flat line, and says what happened; otherwise it goes back to the
  start with the same words. Never "Gravando" over a dead input.
- **A silent take** (the part that would be heard never rises above 0.01, about
  -40 dBFS, `lib/jam-take-silence.ts`) asks before it is sent, and can still be sent.
- **A send that fails** keeps the take: try again, back to the take (to adjust it or
  record again), record again, or discard. A song closed to new takes meanwhile says
  so (no retry can work) and offers a song of its own, or the songs list.

**Starting a song** is the same studio with no backing, behind one small sheet:
title, optional artist (empty means an original), who may join (anyone, only the
instruments I am looking for, only me).

## The latency readout

The delay the engine will compensate is always on screen in the studio: a small
chip in the header ("38 ms", with a dot for how sure it is) whose tooltip and
accessible name say the source (measured with the microphone, measured by tapping
along, typed, or estimated by the browser) and the confidence. In the setup
column the card has "Calibrar" and a details disclosure with the source,
confidence, the round trip in use, how many measurements were usable and their
spread, the browser's own estimate, and a field to type the round trip
(`JamEngine.setManualLatency`, kept per pair of devices, cleared with "Voltar ao
medido"). After recording, the review says what the take was corrected by and
from which source. The per-take nudge ("Empurrar o tempo") sits under "Ajustar".

## Taps

Measured by `e2e/jam-web.spec.ts`:

| Flow | Taps |
|---|---|
| Server to the studio, over an existing song | 3: the Jam row, the tile, "Gravar por cima" |
| ...then recording | +1 for the big button (the first use of a pair of devices suggests measuring the delay, and does not block) |
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
