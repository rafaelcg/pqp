# Convidados: guests replace the stage

**Status:** specification. Nothing here is built.
**Owner decision, 2026-09-13:** the stage goes away for viewers and is replaced
by **guests**. Rafael watched his own party as a viewer that night and called it
"diabolical": taking the stage felt identical to watching, a stray "Entrar na
chamada" was still on screen, and viewer chrome piled up over a black stage.
He also said guests "needs to be a flag in settings", meaning **per party, in
the party's own options**, not a deploy flag.

**Reading order.** `docs/WATCH_PARTY.md` first. Then
`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` items B4, B6 and C10, which
are the same complaint in the owner's earlier words. Then
`docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md` (PR #544), because this plan is
built on the rung that PR already ships, and `docs/plans/WATCH_PARTY_CAMERA_PIP.md`
(PR #535, merged), which is where that rung came from. `docs/RAISED_HANDS.md`
for the queue rules this borrows. `docs/DESIGN.md`, `docs/I18N.md` and
`docs/ONBOARDING.md` for how the surfaces have to be built.

**Aligns with PR #538** (Andre), which splits the watch party surface into a
presenter UI and an audience UI. Every control below is placed in #538's
vocabulary: the audience bar, the presenter header, the presenter dock, the
Ajustes settings list in the setup card, and the options dialog. This plan
never asks for a surface #538 is removing.

---

## 1. Principles

1. **The transmission is the only thing the audience consumes.** Screen, voice,
   faces. A viewer has one player, one chat and nothing else to join.
2. **Nobody but the presenter and the guests is ever in a room.** A seat is not
   a thing a viewer can acquire, ask about, or see a count of.
3. **A guest is heard and seen by everyone, or is not a guest.** If a person's
   microphone does not reach the HLS stream, they are not on the stage, they
   are in a side call, which is the thing being deleted.
4. **One setting decides whether guests exist.** Off means watch only, and off
   is the default. Every other control in the party follows from that one.
5. **Quiet by default.** No join sounds, no seat counts, no roster, no request
   button unless the host asked for one, no notification when a hand goes up.

---

## 2. The setting: `Convidados`

### 2.1 What it replaces

`WatchPartyOptions` today (`packages/shared/src/watch-party-session.ts`) carries
three fields that together describe the stage:

```ts
voiceEnabled: boolean                                   // the "Voz" select's off position
stageMode: "hosts_only" | "invited" | "everyone"        // the rest of that select
raiseHand: boolean                                      // "Deixar pedir pra falar"
```

They collapse into **one**:

```ts
guests: "off" | "invite" | "request"   // default "off"
```

| value | pt-BR label | what it means |
|---|---|---|
| `off` | Ninguém, só assistem | No requests, no invites, no seats. The party is one presenter (plus co-hosts) and an audience. |
| `invite` | Só quem eu chamar | The host and co-hosts call people up by name from the viewers list. Viewers have no button. |
| `request` | Podem pedir pra falar | Viewers may ask. The host accepts or passes. Invites still work. |

`raiseHand` is gone: `request` **is** the raise-hand mode. `everyone` is gone
with no replacement, and that is the point of the change (C10: a moderator
herded ninety people into the call because the door was open).

### 2.2 Migration of existing parties

`channel_sessions.options` is `JSONB`, so **there is no column migration**. Do
it at read time, in the Zod schema's preprocessing, and keep writing the old
fields for one release so a stale tab and the native apps do not see a party
with no `voiceEnabled`.

| old options | new `guests` |
|---|---|
| `voiceEnabled: false` (the default, so almost every row) | `off` |
| `voiceEnabled: true`, `stageMode: "hosts_only"` | `invite` |
| `voiceEnabled: true`, `stageMode: "invited"`, `raiseHand: true` | `request` |
| `voiceEnabled: true`, `stageMode: "invited"`, `raiseHand: false` | `invite` |
| `voiceEnabled: true`, `stageMode: "everyone"` | `request` |
| a legacy row with no `voiceEnabled` key at all | it already passes through `withLegacyWatchPartyVoice`, which reads it as `voiceEnabled: true`, so it lands on `invite` by the row above. Leave that function exactly where it is and run the new map after it. |

Write-back rule for the compatibility release: whenever the server serialises a
party it emits `guests` **and** a derived `voiceEnabled` / `stageMode` /
`raiseHand` triple (`off` to `{false, "hosts_only", true}`, `invite` to
`{true, "invited", false}`, `request` to `{true, "invited", true}`). Delete the
triple one release later, together with `WATCH_PARTY_STAGE_MODES`.

A party that is **live** when the deploy lands keeps working: the read-time map
runs on every fetch and on every `watch-party-update` frame, so a mid-flight
party simply starts describing itself with the new field.

### 2.3 What dies with it

| thing | what happens |
|---|---|
| `watchParty.live.joinCall` ("Entrar no palco") | **Deleted.** No viewer, co-host or host ever sees a button that joins a room by hand. A host is in the room because they are presenting; a co-host is in it because they hold `START_WATCH_PARTY`; a guest is in it because they were accepted. |
| `voice.cinema.join` / `call.panel.join` ("Entrar na chamada") on a `watch_party` channel | **Not rendered.** This is the stray button the owner hit. It is not a watch party control at all, which is why it survived; the fix is a channel-type guard at its own call site, not in the party panel. |
| `watchParty.stage.speak` ("Falar") | **Deleted.** There is no seated-but-silent audience member any more, so there is nothing to offer a microphone to. |
| `watchParty.live.leaveStage` ("Sair do palco") | **Renamed** to `watchParty.guests.leave` ("Sair do ar"). Same position, guests only. |
| `watchParty.options.voice`, `watchParty.options.stage.*`, `watchParty.options.raiseHand` | **Deleted** from both locale files. |
| `voiceState.isAudienceSeat` and `lib/watch-party-seat.ts` | **Deleted.** An audience seat is the concept being removed. `shouldReleaseAudienceWatchSeat` has nothing left to release. |
| `voice.watch.join` ("Entrar na call") | **Deleted.** Same stray as the row above, a different key. Grep for all three before calling this done. |
| `watchPartySpeakAffordance` | **Deleted.** It answers "speak, raiseHand or none" for a seated person, and there is no seated person left to answer it for. The guest's own state is `onAir`, `invited`, `requested` or nothing, and it comes off the party frame. |
| `watchPartyFloorIsClosed` / `stageModeClosesTheFloor` | **Replaced** by `guests !== "off"`, which is the same question with one term instead of two. The SPEAK-overwrite machinery they gate is unchanged. |
| `VoiceAudioOptions.audienceOnly` and `voice.takeTheMicrophone()` | **Deleted.** "Take the microphone" leaves and rejoins the room to add a track; a guest joins the room once, already able to publish, and a viewer never joins it at all. |
| `mayTakeWatchPartySeat` | **Rewritten** as `mayGoOnAir({ canStartWatchParty, guests, isHost, isCohost, isGuest })`, still the one shared predicate the server's `join-voice-room` and the client both consult. Returns true only for the host, a co-host, and an accepted guest. |

### 2.4 Where the setting lives, in #538's surfaces

- **Setup card, step 3 `Ajustes`** (#538's fourth commit renders the options
  form inline): a settings row `Convidados` with the current value and a
  chevron, first in the list, above `Chat lento`. A draft opens no dialog, so
  the three radio options render inline, stacked.
- **Live presenter, `Opções` dialog**: the same `WatchPartyOptionsPanel` row,
  same position.
- **Live presenter dock** (#538's row above the split): a new control
  `Convidados (N/3)` when `guests !== "off"`, opening the guest panel
  (section 3.5). It sits after `Áudio` and before nothing. When `guests` is
  `request` and the queue is non-empty the label carries a lime pip and reads
  `Convidados (N/3) · M pedindo`.
- **Audience bar** (#538's `data-watch-party-bar="audience"`): one control, the
  request button, and only when `guests === "request"`.

### 2.5 When the setting is not offered at all

`Convidados` requires the deployment to be able to carry a separate voice
track, and requires HLS to be on for that server. The client must never guess
(the rule `micArchive` and `voiceTrack` already follow in #544):

- `GET /api/live-hls/config` answers `voiceTrack: boolean`. When false the
  `Convidados` row is **not rendered** and the server coerces the option to
  `off` on read. Shipping guests therefore means setting
  `LIVE_HLS_VOICE_TRACK=true` on `pqp-api`. **Ask it with `?serverId=`**, which
  that route already accepts: #544's last open question is that it checked
  deployment-wide and could therefore disagree with a server whose own
  `live_hls_enabled` row differs. Guests are the reason to close it.
- When `resolveLiveHlsForServer` says HLS is off for this server, the party has
  no seatless audience to be separate from. The row is not rendered and the
  channel behaves as an ordinary call, exactly as it does today.

---

## 3. Flows

Vocabulary used throughout. **Presenter**: the host or the co-host currently
sharing. **Co-host**: `party.cohosts`, holds `START_WATCH_PARTY`, is in the
room. **Guest**: a person in `channel_session_stage_invites` for the live
session, in the room, publishing. **Viewer**: everybody else, seatless.

### 3.1 A viewer asks (`guests === "request"`)

States, in the audience bar:

| state | control | copy (pt-BR / en) |
|---|---|---|
| idle | button, secondary | `Pedir pra falar` / `Ask to speak` |
| pending | button becomes a pill with a spinner-free dot, plus a text link | `Você pediu. Aguarde.` / `You asked. Hang tight.` and `Desistir` / `Never mind` |
| pending, position known | second line, `text-tertiary`, `type-caption` | `Você é o {position}º da fila` / `You are number {position} in line` |
| passed over | the idle button, disabled, with the reason under it | `O host não pode agora. Tenta de novo em {minutes} min.` / `The host can't right now. Try again in {minutes} min.` |
| at the limit | the idle button stays enabled; the queue is never closed (`docs/RAISED_HANDS.md`: the list is capped, the queue is not) | on accept failure only: `Já tem {count} convidados no ar.` |

- **The button is the only audience control that ever appears.** It is absent
  entirely for `off` and `invite`.
- **Withdraw is always available** while pending, and costs no cooldown. It is
  the same rule as lowering your own hand: asking is a request, and somebody who
  changed their mind has to be able to say so.
- **Cooldown after a decline: five minutes**, `GUEST_REQUEST_COOLDOWN_MS` in
  `@pqp/shared`, enforced server-side and mirrored in the disabled button's
  countdown. A withdraw does not set it. Being taken off air after being a
  guest does not set it either; the host took them off for a reason and the
  person may legitimately want back.
- **Nothing is notified.** No toast to the host, no sound, no channel badge.
  Same decision and the same reasoning as `docs/RAISED_HANDS.md`.

**The two hand-raise systems, settled.** `docs/WATCH_PARTY.md`'s closing
section leaves open whether the party's own queue
(`channel_session_raised_hands`) should be folded into the general voice one
(`voice_raised_hands`, the roster's `handRaisedAt`). **It should not.** They
answer different questions for different people: the general one is a seated
participant's public gesture inside a call, rendered on a roster the audience
never receives; this one is a seatless viewer asking for something they do not
have. A viewer has no roster row to carry a timestamp on. The party queue keeps
its own table and borrows only the **ordering rule** from
`packages/shared/src/raised-hands.ts`. Delete that open item from
`docs/WATCH_PARTY.md` when this ships.

### 3.2 The host sees the queue

Inside the guest panel (section 3.5), section `Pedindo pra falar`:

- Ordered by the **server's** `raised_at`, never by the client's clock. Ties
  break on `userId`. Import the rule from `packages/shared/src/raised-hands.ts`
  rather than writing a second comparator.
- The **list** is capped at `GUEST_REQUEST_LIST_LIMIT = 20`; the tail becomes
  `e mais {count} esperando` / `and {count} more waiting`. The **queue** is not
  capped.
- Each row: avatar, display name, how long they have been waiting, and two
  buttons, `Chamar` / `Call up` and `Dispensar` / `Pass`.
- Empty: `Ninguém pediu ainda.` / `Nobody has asked yet.`

### 3.3 The host invites (both `invite` and `request`)

- Control `Chamar alguém` / `Call someone up` at the top of the guest panel,
  opening a filtered people list. The candidate order copies
  `watch-party-cohosts.tsx` exactly: staff first by cargo, then friends, then
  everybody else by name, search preserving that order.
- Candidates are people who can currently see the channel. A person who is not
  watching may still be called up; they get the invitation the next time they
  open the channel, and it expires with the party.
- An invitation is **not** an acceptance. It puts the person in
  `state = "invited"`, and their client draws the sheet in 3.4.

### 3.4 A guest joins

The invited person sees a dialog, not a banner. It is the one moment in this
feature that deserves to interrupt.

```
{name} te chamou pro ar
Seu mic e sua câmera vão pra transmissão. Coloca fone pra não dar eco.
[ Entrar no ar ]   [ Agora não ]
```

en: `{name} called you up` / `Your mic and camera go into the stream. Use
headphones so you don't echo.` / `Go on air` / `Not now`

On `Entrar no ar`, in this order, and each step visible:

1. **The HLS player stops.** Not pauses: the guest's film audio now comes from
   the room over WebRTC, at real time, and the playlist is twenty-five seconds
   behind. Leaving it playing is the same echo `lib/dual-device-watch.ts`
   already warns about, on one device. The stage area swaps to the room's own
   picture of the share.
2. **Permissions.** Microphone first, then camera, both through the existing
   prompts, both refusable. A guest who refuses the camera is still a guest.
   A guest who refuses the microphone is offered `Agora não` and is not one.
3. **Join the room.** `mayGoOnAir` passes because the invite row exists.
4. **Publish.** `Track.Source.Microphone` and `Track.Source.Camera`, sources
   passed explicitly (pitfall 14: the grant is an allowlist and an untagged
   track is refused by the media server while the guest's own app shows them
   live).

Once live, the guest's chrome is exactly four things and nothing else:

| element | behaviour |
|---|---|
| **On-air indicator** | A fixed strip across the top of the stage, `danger-soft` fill with `on-danger-soft` text, reading `VOCÊ ESTÁ NO AR` and, on a second line, `Todo mundo que tá assistindo te ouve.` It is not a badge in a corner and it is not dismissible. It carries a slow pulse on the dot, `motion-safe` only. |
| **Mic** | Toggle, `aria-pressed`, showing a live level meter while unmuted. Muting is local and immediate; it does not leave the stage. |
| **Câmera** | Toggle, `aria-pressed`. Off is a valid steady state and draws the guest's avatar in their tile instead. |
| **Sair do ar** | `danger` button. One tap, no confirm. Leaving is cheap and must feel cheap. |

There is no volume control, no quality picker, no share button, no roster, no
seat count, no reactions bar change. A guest is a viewer who can talk.

### 3.5 The guest panel (presenter and co-hosts)

One dialog, opened from the dock control, three sections top to bottom:

1. **`No ar (N/3)`** with a row per guest: avatar, name, a mic glyph that fills
   while they are transmitting, a camera glyph when their camera is on, and
   `Tirar do ar` / `Take off air`. The presenter's own row is first and has no
   remove button.
2. **`Pedindo pra falar`** (section 3.2), only when `guests === "request"`.
3. **`Chamar alguém`** (section 3.3).

At the limit, `Chamar` and `Chamar alguém` are disabled with the reason
attached to the control, never in a toast: `Máximo de {max} no ar. Tira alguém
primeiro.` / `Max {max} on air. Take someone off first.`

`WATCH_PARTY_MAX_GUESTS = 3`, in `@pqp/shared`, read by the client and enforced
by the server. Three is proposed because four tiles at 320x180 fill the 640x360
stage rung exactly (section 5.4) and because the presenter has to be able to
run a conversation while watching a film.

### 3.6 A guest leaves or is removed

- **Leaves**: unpublish, leave the room, delete the invite row, resume the HLS
  player from live. A short card replaces the on-air strip for eight seconds:
  `Você saiu do ar.` / `You're off air.`
- **Removed by the host**: the server mutes them at the SFU first and revokes
  their publish grant, **then** ejects, **then** deletes the row. Muting first
  is what makes the acceptance criterion in 6.3 true; ejecting first leaves a
  window in which a client that has not yet processed the disconnect is still
  publishing.
- **Disconnects**: the ordinary orphan window applies. A guest whose tab
  reloads inside it comes back as a guest, because the invite row is keyed on
  the person and not on the seat, which is the same choice `voice_raised_hands`
  made and for the same reason.
- **The host disconnects and a co-host takes over** (`Assumir`,
  `WATCH_PARTY_HOST_GRACE_MS`): guests are untouched. The invite rows hang off
  the session, not off the host, and the new presenter inherits them. The one
  thing that does move is the mixer: `stage-mix` and `stage-tiles` are
  published by whoever is **sharing**, so the incoming presenter's browser
  starts publishing them and `pickScreenTracks` follows the presenter identity
  it already follows.
- **The party ends**: every guest is ejected, every invite row goes with the
  session (`ON DELETE CASCADE`), and the SPEAK overwrites the party created are
  removed by the existing `stage_speak_applied` teardown.

### 3.7 Presenter and co-hosts see guests as tiles

In the presenter stage (#538's sixth commit: outgoing monitor, audience
monitor, activity feed), the guests appear as a row of tiles under the outgoing
monitor, in the same order as the composite (section 5.4), so what the presenter
sees and what the audience sees cannot diverge. Each tile carries the name and
a speaking ring. This row **is** the composite's preview: render it from the
same ordered array the canvas draws from.

The activity feed gains two rows: `{name} entrou no ar` and `{name} saiu do ar`.

---

## 4. The audience's view

The whole of it:

- **The player.** Full width, the film, the control bar it already has.
- **The stage picture.** The guest tiles ride the stage rung as a corner box
  over the film, which is `WatchCameraPip` from #535 with the rules in section
  5.5. It can be moved between the four corners and swapped to the stage, and
  it **cannot be unmounted** while it carries audio.
- **Chat.** #538's chat column, unchanged.
- **The request button**, and only when `guests === "request"`.
- **Guest presence in the header**: up to three small avatars, 20px, with a mic
  glyph on the group, and a tooltip listing the names. Label for screen
  readers: `No ar com {names}` / `On air with {names}`. This is derived from
  the party frame, not from the roster: the audience has no roster.

And the whole of what is gone: no seat, no room, no stage to enter, no viewer
count of seated people (the viewer count stays and counts watchers), no join
and leave sounds, no "Entrar na chamada", no call strip in the sidebar while
watching (#538 already removes that one).

**The presence avatars light up in real time, and the voices arrive twenty-five
seconds later.** That is a real inconsistency and the fix is to not animate
them: the avatars say who is on air, never who is speaking right now. No
speaking ring for the audience. The ring belongs on the presenter's surface,
where it is in sync with reality.

---

## 5. Engineering: getting the guests into the mix

The audience must hear presenter and guests. The seatless audience never joins
the LiveKit room, so the only path is an egress.

### 5.1 The three options as briefed, priced

**(a) LiveKit Room Composite egress.** `startRoomCompositeEgress` renders the
room through a layout template in headless Chrome and mixes every microphone,
so faces and voices arrive with no client change at all. It is the complete
answer and it is the expensive one. LiveKit's own docs price a Room Composite
at **2 to 6 CPUs per rendition**, against the **0.51 core** a 720p30 Track
Composite measured at on our own images (`docs/CAPACITY.md` §2). The production
media box is 4 vCPU and also carries the SFU, the TURN relay and Redis, and the
default ladder is one to two renditions. `docs/CAPACITY.md` §1 is explicit about
what happens past the point where that box's CPU pins: egress *falls* rather
than levelling off and a large share of packets reach nobody, which is a cliff,
during a live event, for the seated room as well as the stream. It also needs a
custom layout template (the built-ins frame a film with tiles around it; a film
night wants the film full bleed), which is new hosted surface with its own
failure mode. **Ruled out on this box. Correct once a separate egress box
exists**, which `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` §E already
plans as an on-demand machine.

**(b) Keep the Track Composite film rung, add an audio-only Room Composite
"stage mix" rung the client plays alongside.** Two objections, and the second
is the one that kills it. LiveKit does not price an audio-only Room Composite
separately from a video one, and the audio-only mode still runs the template
pipeline, so the cost above is not obviously avoided and would have to be
measured before anybody could rely on it. And the stage mix would be a *third*
independent playlist, drifting one to three seconds against the film and
against nothing else, which puts the guests' voices out of sync with the guests'
faces if the faces are anywhere else. A third playlist is also a third thing to
authorise, cache, refresh and lose (pitfall 16: a second credential is a second
thing that can fail).

**(c) Per-guest rungs, like #544's voice rung, with the client mixing N
players.** N egresses on the box, N playlists, N tokens, and N independent
drifts, so three guests reach the audience at three different offsets and a
conversation becomes unlistenable. Each also costs a camera slot's budget, so
three guests is roughly a full rendition of box budget spent on talking heads.
The client-side mixing of N `<video>` elements is the least of its problems.
**Rejected.**

### 5.2 The recommendation: (d) the presenter's browser is the mixer

**#544's rung is the carrier, and the presenter's browser is the mixer.**
Neither the film rung nor a new egress carries the guests. **The presenter's
browser already receives every guest**, because it is in the room with them, and
it already owns an `AudioContext` that mixes its own microphone into the share
(`client/src/lib/screen-mix.ts`). Extend that graph, and publish the result as
the second, distinctly named track PR #544 already taught the server to bind.

Concretely, when a live party has `guests !== "off"`:

- The presenter's browser publishes **`stage-mix`**: an audio track carrying
  their own microphone plus every guest's microphone. Source
  `Track.Source.Microphone`, name `stage-mix`. This is the same shape and the
  same reasoning as `mic-archive` (#518) and `voice-track` (#544): a grant is an
  allowlist of *sources*, so a second publication has to go up as a microphone
  and be told apart by **name**. Every other client drops and unsubscribes from
  it on sight, or a guest would hear themselves a round trip late.
- The presenter's browser publishes **`stage-tiles`**: a `canvas.captureStream`
  of a 640x360 grid of the presenter's camera and the guests' cameras. Source
  `Track.Source.Camera`, name `stage-tiles`. Also unsubscribed by every other
  client (they draw the real camera tracks themselves, in the presenter surface).
- The server binds **both** to the slot #544 calls `CAMERA_RUNG_WITH_VOICE`,
  under the unchanged `CAMERA_RUNG_NAME` (`cam360p30`): same object prefix,
  same playlist path, same `?t=` token, no new session, no rebuffer. Call this
  slot the **stage rung** from now on.
- The film rung is untouched. Its audio is the share's own audio and nothing
  else, which is `voiceTrackMode: "separada"` in #544's vocabulary.

Why this and not the others:

1. **Box cost is zero.** No new egress exists. A party with guests costs exactly
   what a party with the presenter's camera on already costs.
2. **Faces and voices are on one egress**, so they are internally lip-synced.
   That is the pair a human scrutinises. The stage drifts against the *film* by
   one to three seconds, which for commentary over a film is tolerable and is
   further corrected in 5.5.
3. **The viewer gets a separate volume for the stage and the film**, which is
   the product win #544 was chasing anyway.
4. **It needs almost no new server code.** `reconcileCameraEgress` already
   starts all three shapes; `pickScreenTracks` already picks a publication by
   name; `adoptLiveHlsSession` already routes `cam360p30` to the camera slot;
   `reapForeignEgresses` already has it in `ours`; `hls_sessions.audio_track_id`
   already exists to adopt the shape back after a deploy.
5. **It fails in the right direction.** If the presenter's browser cannot carry
   it, the film keeps running: the stage rung is refused on the **box** budget
   only and never on the ladder's, exactly as #535 specified for the camera.

What it costs, stated rather than discovered later:

- **The presenter's machine** pays one 640x360 canvas composite (`drawImage` of
  up to four small videos, 15 fps, GPU-accelerated) plus one Opus encode plus
  the decode of N guest microphones it was already decoding to hear them.
  Estimate five per cent of a core. It is an estimate. Measure it on the host's
  actual machine during the test party, because B1 says her machine is the
  fragile part of this system.
- **The presenter's uplink** pays one more Opus track (~40 kbit/s) and one more
  360p video track (~400 kbit/s). The 360p camera cap from #490/#544 already
  holds a presenting host's camera down; the tiles canvas replaces it as the
  published picture, so the total does not go up, it moves.
- **The SFU** carries, at three guests, four participants publishing audio and
  up to four publishing camera in a room whose only other subscriber is the
  egress. Per the packet-cost model in `docs/CAPACITY.md` §1a this is
  negligible against a 200-viewer party, but it is not free, and audio is not
  as cheap as it looks: a forwarded Opus stream is 50 packets a second whatever
  its bitrate.
- **The audience** pays one more 400 kbit/s rendition, out of the same R2
  bucket. About twelve per cent on top of a 3.2 Mbit/s film.
- **A single point of failure moves.** If the presenter's browser drops a
  guest's packets, the audience loses that guest while the presenter still
  hears them. Mitigate by drawing the presenter's own `stage-mix` output level
  in the dock, next to the mic meter #538 already put there, and by warning
  after ten seconds of digital silence on a guest who the roster says is
  transmitting.

### 5.3 The topology is decided at go-live, never mid-party

Moving the presenter's voice from the film's audio bus to the stage rung while
people are watching means the audience hears them cut out of one playlist and
reappear on another several seconds later. So do not move it.

**Rule:** when the party goes live with `guests !== "off"`, the presenter's
browser starts in `separada` immediately, before anyone is watching. The stage
rung exists from the first second, carrying the presenter's voice (and their
camera if it is on). Adding a guest then adds an input to a bus that is already
running and already being transcoded, which is seamless.

When the party goes live with `guests === "off"`, **nothing changes from
today**: `junto`, the voice in the film mix, the camera rung video-only if a
camera is on. One setting decides the whole topology, which is principle 4
holding at the engineering layer too.

The one case that still switches is a host flipping `Convidados` from `off`
to something else **during** a live party. Handle it and warn about it:

- The client keeps its microphone in the film mix until a frame arrives with
  `cameraHasVoiceAudio === true`, then fades it out of the film mix over 250 ms.
  The audience hears the presenter twice for the few seconds the stage rung
  takes to write its first segments, which is better than hearing them not at
  all.
- The confirm reads: `Quem tá assistindo pode ouvir um eco de alguns segundos
  enquanto isso liga.` / `Viewers may hear a few seconds of echo while this
  turns on.`

### 5.4 The tile composite

Pure function, `client/src/lib/stage-tiles.ts`, so it is testable without a
canvas:

- Canvas is **640x360**, drawn at **15 fps** (`requestAnimationFrame` gated by a
  timestamp, not `setInterval`), published with
  `canvas.captureStream(15)`.
- Order is **stable and server-derived**: presenter first, then guests by
  `invited_at` ascending. Never by arrival on the wire, or two viewers on two
  reconnects see two different layouts, and the presenter's own preview (3.7)
  would disagree with the stream.
- Layout by count: 1 fills the frame; 2 side by side at 320x360; 3 and 4 as a
  2x2 grid of 320x180. A missing camera draws the person's avatar centred on
  `surface-2` at the tile's size, never a black rectangle.
- Every tile carries a name label: 11px, `on-accent` on a 60 % black plate,
  bottom left, inset 8px. The audience has no roster, so an unlabelled face is
  an unidentifiable face.
- The canvas is drawn from the `HTMLVideoElement`s LiveKit already attached for
  the presenter's own view. Do not create a second set.
- When the party has **no guests and no presenter camera**, publish **no**
  `stage-tiles` track at all: the stage rung becomes #544's audio-only
  `VOICE_RUNG`, priced at `HLS_VOICE_ONLY_MBPS`, and the PiP draws the voice
  indicator #544 already built.

Server side, `pickScreenTracks` gains one line of the shape it already has for
`mic-archive`: prefer the sharer's publication **named** `stage-tiles` for
`cameraTrackId`, falling back to the first `TrackSource.CAMERA` when there is
none. That single preference is the whole of the server's awareness that guests
exist on the video side.

### 5.5 The viewer's stage box

`WatchCameraPip` from #535, with three changes:

1. **Fullscreen no longer unmounts it.** #492's own open question flagged this
   as the one decision worth a second look, and guests settle it: a fullscreen
   viewer who lost the PiP would lose every voice on the stage. In fullscreen
   the box keeps its corner and its size.
2. **"Hide" is not "unmount" while the rung carries audio.** Collapsing the box
   collapses it to a 28px audio-only chip in the player's header showing the
   guest avatars; the `<video>` element keeps running underneath, because
   hls.js needs a media element to play audio through.
3. **A drift corrector, not a seeker.** Both playlists carry
   `EXT-X-PROGRAM-DATE-TIME`. Every two seconds, compare the stage player's
   program date against the film's; while the gap is between 150 ms and 4 s,
   nudge `playbackRate` to 0.95 or 1.05 until it closes, and only seek when the
   gap exceeds 4 s. Seeking is audible and repeated seeking is worse than
   drift; a five per cent rate change on speech is inaudible. Target: hold the
   gap under 500 ms, which makes lip sync between the tiles and the voices
   irrelevant and puts the conversation close enough to the film.

Volume: the stage box gets its own slider, persisted per browser
(`pqp:watch-stage-volume`), independent of the film's. Default 100 %.

### 5.6 Data model

Everything needed already exists. The changes are three columns and one
constant.

| change | why |
|---|---|
| `channel_sessions.options` gains `guests` inside the existing `JSONB` | no migration; section 2.2 maps the old fields at read time |
| `channel_session_stage_invites` **is** the guests table, unchanged shape (`session_id`, `user_id`, `invited_by`, `invited_at`, PK on the pair) | renaming it costs a migration and buys a word. Rename it in the comment. |
| `channel_session_stage_invites` gains `accepted_at TIMESTAMPTZ` | tells `invited` (called up, has not answered) from `active` (on air). The guest count that `WATCH_PARTY_MAX_GUESTS` bounds is `accepted_at IS NOT NULL`; an unanswered invitation does not hold a slot. |
| `channel_session_raised_hands` gains `declined_at TIMESTAMPTZ` | the row survives a decline instead of being deleted, so the cooldown has something to read. The queue query becomes `WHERE declined_at IS NULL`. |
| `packages/shared`: `WATCH_PARTY_MAX_GUESTS = 3`, `GUEST_REQUEST_LIST_LIMIT = 20`, `GUEST_REQUEST_COOLDOWN_MS = 5 * 60_000` | one number each, read by the client and enforced by the server, the rule `lib/voice-capacity.ts` already follows |

`watchPartyStageSchema` becomes `watchPartyGuestsSchema`:

```ts
{
  onAir: Person[],        // was `invited`; accepted_at IS NOT NULL, in invited_at order
  invited: Person[],      // called up, not yet answered (host-visible only)
  requests: Person[],     // was `hands`; capped at GUEST_REQUEST_LIST_LIMIT
  requestCount: number,   // the real length of the queue
  requested: boolean,     // was `handRaised`: the viewer's own state
  position: number | null // the viewer's own place, null when not requesting
}
```

`party.stage` is emitted **alongside** `party.guests` for one release, derived,
so the native apps and any tab that has not reloaded keep parsing a party.

### 5.7 Permissions and the publish grant

A guest needs to publish a microphone and a camera, and must not be able to
publish a screen share (`pickHlsSharer` scans the whole roster for
`sharingScreen && canStream`, and a guest with `STREAM` is a guest who can
confuse the transcode picker).

`liveKitPublishGrant` in `server/src/voice/backends.ts` takes a third axis:

```ts
export function liveKitPublishGrant(options: {
  canSpeak: boolean;
  canStream: boolean;
  canShowFace: boolean;   // new
}): Pick<VideoGrant, "canPublish" | "canPublishSources">
```

`canShowFace` adds `TrackSource.CAMERA` without the two screen-share sources.
A guest's grant is therefore `{ canPublish: true, canPublishSources:
[MICROPHONE, CAMERA] }`. **A viewer's grant is `{ canPublish: false }`**, which
is the existing `!canSpeak && !canStream` branch, and is what makes 6.3's first
criterion structurally true rather than a client-side promise.

Acceptance and removal do not mint a new token and do not reconnect anybody:
the server already has `setSfuUserCanPublish` and `muteSfuUser`, and uses them
for moderation today. Accept calls `setSfuUserCanPublish(true)`; remove calls
`muteSfuUser` then `setSfuUserCanPublish(false)` then ejects.

The existing SPEAK channel overwrite the stage creates (tracked by
`channel_sessions.stage_speak_applied`) stays exactly as it is, and its teardown
at party end is what already stops a film night leaving the channel changed.

### 5.8 The wire

Following the rule `docs/RAISED_HANDS.md` states and the codebase keeps: **your
own state rides a socket frame; an action taken on another person is an HTTP
route.**

HTTP, all on the existing `POST /api/watch-parties/:id/stage` route, whose
request schema becomes:

```ts
| { action: "invite"; userId: string }    // host/co-host: call somebody up
| { action: "accept"; userId: string }    // host/co-host: accept a request
| { action: "decline"; userId: string }   // host/co-host: pass, sets declined_at
| { action: "remove"; userId: string }    // host/co-host: take off air
| { action: "request" }                   // viewer: ask
| { action: "withdraw" }                  // viewer: never mind
| { action: "join" }                      // the invited person accepting
| { action: "leave" }                     // a guest going off air
```

Keep the route name for one release (it is already deployed and the native apps
call it); add `/guests` as an alias and retire `/stage` with the compatibility
fields. `request` and `withdraw` are rate-limited by the same limiter as a mute
toggle. `accept`, `invite` and `remove` require `START_WATCH_PARTY` in the
channel or being the party's host or co-host, and the server checks
`WATCH_PARTY_MAX_GUESTS` inside the same transaction that writes `accepted_at`,
or two simultaneous accepts both pass a read-then-write check.

WebSocket: **no new frame.** The `watch-party-update` frame already goes out
per socket precisely because the server resolves what each recipient may see,
which is exactly the property the guest queue needs: `requests` and `invited`
are populated only for a recipient holding `START_WATCH_PARTY`, absent for
everybody else. `onAir` goes to everybody. `requested` and `position` are that
recipient's own. One frame, three audiences, nothing to invent.

The one directed thing that does not fit the party frame is the invitation
dialog, and it does fit: a person who is invited gets `invited` containing
themselves on their own copy of the frame. The client draws the dialog when it
finds itself in `invited` and has not yet joined.

### 5.9 Order of work

Six steps. The first three ship a working, if faceless, feature.

1. **Shared and server, the setting.** `guests` on the options schema, the
   read-time migration and the compatibility write-back, `mayGoOnAir`,
   `liveKitPublishGrant`'s third axis, the two new columns, the route's new
   actions, the per-recipient frame fields. `restarts-api`.
2. **Client, the surfaces.** The audience bar's request button and its four
   states, the guest panel, the invitation dialog, the on-air strip and the
   guest's four controls. Delete `isAudienceSeat`, `watch-party-seat.ts`, the
   three retired buttons and the retired keys. Client-only.
3. **Client and server, the audio.** `stage-mix` published by name, dropped and
   unsubscribed by every other client (web, iOS, Android, the same three places
   `mic-archive` touched), bound by `pickScreenTracks`, carried by #544's
   existing rung. `LIVE_HLS_VOICE_TRACK=true` on `pqp-api`. **At this point
   guests are heard by everyone and the feature is shippable.**
4. **Client, the faces.** `stage-tiles.ts`, the canvas publish, the picker's
   name preference, the presenter's tile preview.
5. **Client, the viewer's stage box.** Fullscreen, the audio-only collapse, the
   drift corrector, the stage volume.
6. **Phones.** Section 6.1.

#544 must merge before step 3, and #538 before step 2. Neither is a code
dependency; both are a merge-conflict dependency on `watch-party-panel.tsx`.

---

## 6. Phones, accessibility, acceptance

### 6.1 Phones

- **Mobile web is a first-class guest.** Everything in section 3.4 works in
  mobile Safari and Chrome. The on-air strip respects the safe area. The
  guest's four controls are a fixed bottom bar with 44px targets, not a row in
  the panel.
- **The HLS player must stop before the microphone opens**, and on iOS this is
  the difference between a usable guest and a howling one: the AVPlayer and the
  `getUserMedia` session fight over the audio session, and the film is twenty
  five seconds late into the guest's own microphone. This is the single most
  important phone rule in this document.
- **Headphones**: the invitation sheet says it in copy (3.4). Do not try to
  detect them; there is no reliable API.
- **Camera defaults off on a phone**, regardless of the guest's last choice on
  desktop. A phone camera on a film night is a ceiling.
- **The native iOS and Android apps are step 6 and are not in the first
  release.** They parse the party frame and ignore `guests` today; they must
  keep doing that without crashing, which is what the compatibility `stage`
  field in 5.6 buys. Until they ship, a phone person is a guest through the web
  client. State it in the release notes rather than letting them find out.
- **`VOICE_MESH_RESUME_REQUIRES_CAP` is irrelevant here**: a watch party with
  HLS on is pinned to LiveKit, so no guest is ever in a mesh room.

### 6.2 Accessibility

- The on-air strip is `role="status"` with `aria-live="polite"`, and it says
  what it means in text. It is never colour alone: `VOCÊ ESTÁ NO AR` in words,
  plus an icon, plus the fill.
- Going on air moves focus to the on-air strip. Going off air returns it to the
  request button, or to the player when there is none.
- The mic and camera toggles are `aria-pressed` buttons with visible labels,
  not icon-only. The mic's level meter is decorative and `aria-hidden`; the
  pressed state is the fact.
- The queue rows announce the wait ("esperando há 2 min") as text, not as a
  bare relative timestamp in a title attribute.
- The pulse on the on-air dot and the tile speaking rings are `motion-safe`
  only, per `docs/DESIGN.md`.
- Every new control names a token, never a colour. `danger-soft` /
  `on-danger-soft` for the on-air strip, `accent` for the request button,
  `surface-2` for the tiles' empty state.
- Copy goes into both `client/src/locales/en/translation.json` and
  `client/src/locales/pt-BR/translation.json` in the same commit, flat dotted
  keys under `watchParty.guests.*`, `{name}` interpolation, `_one` / `_other`
  on the queue count, and `pnpm --filter @pqp/client i18n:check` green.

### 6.3 Acceptance criteria for QA

Run against a real party with a real egress. The local stack has no LiveKit and
no egress, so the audio half of this list cannot be checked locally at all.

**Structural**

- [ ] A non-guest viewer can never publish audio. Assert the **token**: a
      seatless viewer's LiveKit grant is `{ canPublish: false }`. Then assert
      the **publish**: a patched client that tries anyway is refused by the
      media server. Both halves, per pitfall 14: a grant is a contract and
      nothing checks that the client keeps it.
- [ ] A guest's grant is exactly `[microphone, camera]`. A guest cannot start a
      screen share, and `pickHlsSharer` never selects one.
- [ ] With `guests: "off"`, the wire is byte-for-byte what it is today: no
      `stage-mix`, no `stage-tiles`, `voiceTrackMode` junto, camera rung video
      only. Confirm by diffing a party's frames against a party on `main`.
- [ ] No surface anywhere on a live `watch_party` channel renders "Entrar na
      chamada", "Entrar no palco" or a seat count. Grep the built bundle for
      the retired keys and get nothing.

**Timing** (measure against the recording, not the wall clock; a viewer's own
buffer adds the HLS delay on top of every number here)

- [ ] A guest's audio reaches the HLS stream within **8 s** of the guest
      pressing `Entrar no ar`: join, publish, the presenter's mix picks it up,
      one 4 s segment is written (`LIVE_HLS_SEGMENT_SECONDS` is 4 since
      2026-09-12). A viewer hears it within **40 s**, which is that plus the
      delay the player deliberately sits at (about five segments back).
- [ ] Removing a guest silences them in the stream within **one segment, 4 s**,
      of the click: `muteSfuUser` lands in well under a second, the presenter's
      mix loses the input immediately, the next segment written is clean. A
      viewer hears the silence within **36 s**. Measure it on the recording,
      because a viewer's own buffer is the rest of that number.
- [ ] Turning `Convidados` on mid-party produces at most **12 s** (three
      segments) of doubled presenter voice and **zero** seconds of absent
      presenter voice.
- [ ] The stage box and the film stay within **500 ms** of each other after the
      drift corrector has had thirty seconds. Read both players'
      `PROGRAM-DATE-TIME`.

**Behaviour**

- [ ] A guest never hears themselves. Test on a phone on speaker, which is the
      worst case.
- [ ] A guest's HLS player is stopped for the whole time they are on air, and
      resumes from live when they go off.
- [ ] Adding and removing a guest never mints a new `startedAt`, never changes
      `hlsUrl`, and never rebuffers a viewer who has been watching throughout.
      Watch one browser for the whole test and never let it stall.
- [ ] Three guests is the ceiling. A fourth accept is refused by the server,
      with the reason on the control. Two simultaneous accepts of the fourth
      slot: exactly one wins.
- [ ] A declined viewer cannot ask again for five minutes and the countdown is
      on the button. A withdrawn viewer can ask again at once.
- [ ] The queue order survives a host's reload and two hosts looking at once.
      The list caps at 20 and the tail is a count.
- [ ] A guest reloading their tab inside the orphan window comes back a guest.
- [ ] Ending the party ejects every guest, removes every SPEAK overwrite, and
      leaves the channel's slow mode as it was before the party.
- [ ] An API deploy mid-party (`restarts-api`) adopts the stage rung back in
      the shape it was, video plus audio, with `cameraHasVideo` and
      `cameraHasVoiceAudio` correct on the first frame a resumed viewer gets.
- [ ] `liveHls.orphansStopped` stays at zero for the whole party.
- [ ] `voice.hlsCameraRefused` does not fire on a box with room for the rung.

---

## 7. Out of scope

- **Room Composite.** Revisit when the on-demand egress box in the post-mortem's
  §E exists, at which point everything (film, every face, every voice) becomes
  one composite with no drift at all and this plan's client-side mixing can be
  deleted. Keep `stage-mix` and `stage-tiles` behind the same seam so that
  deletion is a server change.
- **Native iOS and Android as guests.** Step 6; they watch in the first release.
- **A guest sharing their screen.** Deliberately never: one transcode, one
  picture.
- **More than three guests**, and any "stage" with a queue that rotates people
  automatically.
- **Recording the guests separately.** `LIVE_HLS_MIC_ARCHIVE` keeps recording
  the host's own microphone and is untouched by this. A per-guest archive is a
  streamer feature, not a party feature.
- **Reactions, chat, slow mode, co-host promotion, `Assumir`.** Unchanged.
- **The viewer count** and what it counts. Unchanged.
- **Moderation of a guest beyond removing them.** Existing voice moderation
  (server mute, the audit log) already reaches a guest, because a guest is an
  ordinary participant in an ordinary room.

---

## Appendix: the copy, as keys

Flat dotted keys, `keySeparator` is false, `{name}` interpolation, both locale
files in the same commit. Portuguese is what people will actually read; write it
first and do not translate the English into it.

| key | pt-BR | en |
|---|---|---|
| `watchParty.guests.title` | Convidados | Guests |
| `watchParty.guests.body` | Quem pode falar e aparecer na transmissão junto com você. | Who can speak and appear in the stream with you. |
| `watchParty.guests.off` | Ninguém, só assistem | Nobody, they just watch |
| `watchParty.guests.invite` | Só quem eu chamar | Only who I call up |
| `watchParty.guests.request` | Podem pedir pra falar | They can ask to speak |
| `watchParty.guests.offSummary` | Ninguém entra na sua sala. A transmissão é você. | Nobody joins your room. The stream is you. |
| `watchParty.guests.inviteSummary` | Você chama pelo nome. Ninguém pede. | You call people up by name. Nobody asks. |
| `watchParty.guests.requestSummary` | Quem tá assistindo pede, você aceita. Até {count} no ar. | Viewers ask, you accept. Up to {count} on air. |
| `watchParty.guests.turnOnWarning` | Quem tá assistindo pode ouvir um eco de alguns segundos enquanto isso liga. | Viewers may hear a few seconds of echo while this turns on. |
| `watchParty.guests.ask` | Pedir pra falar | Ask to speak |
| `watchParty.guests.asked` | Você pediu. Aguarde. | You asked. Hang tight. |
| `watchParty.guests.withdraw` | Desistir | Never mind |
| `watchParty.guests.position` | Você é o {position}º da fila | You are number {position} in line |
| `watchParty.guests.declined` | O host não pode agora. Tenta de novo em {minutes} min. | The host can't right now. Try again in {minutes} min. |
| `watchParty.guests.full` | Já tem {count} convidados no ar. | There are already {count} guests on air. |
| `watchParty.guests.invitedTitle` | {name} te chamou pro ar | {name} called you up |
| `watchParty.guests.invitedBody` | Seu mic e sua câmera vão pra transmissão. Coloca fone pra não dar eco. | Your mic and camera go into the stream. Use headphones so you don't echo. |
| `watchParty.guests.invitedAccept` | Entrar no ar | Go on air |
| `watchParty.guests.invitedDecline` | Agora não | Not now |
| `watchParty.guests.onAir` | VOCÊ ESTÁ NO AR | YOU ARE ON AIR |
| `watchParty.guests.onAirBody` | Todo mundo que tá assistindo te ouve. | Everyone watching can hear you. |
| `watchParty.guests.mic` | Mic | Mic |
| `watchParty.guests.camera` | Câmera | Camera |
| `watchParty.guests.leave` | Sair do ar | Go off air |
| `watchParty.guests.left` | Você saiu do ar. | You're off air. |
| `watchParty.guests.panelOnAir` | No ar ({count}/{max}) | On air ({count}/{max}) |
| `watchParty.guests.queue` | Pedindo pra falar | Asking to speak |
| `watchParty.guests.queueEmpty` | Ninguém pediu ainda. | Nobody has asked yet. |
| `watchParty.guests.queueMore_one` | e mais {count} esperando | and {count} more waiting |
| `watchParty.guests.queueMore_other` | e mais {count} esperando | and {count} more waiting |
| `watchParty.guests.waiting` | esperando há {duration} | waiting {duration} |
| `watchParty.guests.accept` | Chamar | Call up |
| `watchParty.guests.decline` | Dispensar | Pass |
| `watchParty.guests.inviteSomeone` | Chamar alguém | Call someone up |
| `watchParty.guests.remove` | Tirar do ar | Take off air |
| `watchParty.guests.atLimit` | Máximo de {max} no ar. Tira alguém primeiro. | Max {max} on air. Take someone off first. |
| `watchParty.guests.onAirWith` | No ar com {names} | On air with {names} |
| `watchParty.guests.joined` | {name} entrou no ar | {name} is on air |
| `watchParty.guests.gone` | {name} saiu do ar | {name} is off air |
| `watchParty.guests.stageVolume` | Volume dos convidados | Guest volume |

Retire in the same commit: `watchParty.options.voice`, `.voiceOff`,
`.voiceOffBody`, `.voiceOffSummary`, `.voiceOnSummary`, `.stageMode`,
`.stage.hosts_only`, `.stage.invited`, `.stage.everyone`, `.stageWarnEveryone`,
`.raiseHand`; `watchParty.live.joinCall`, `.joinCallHint`, `.leaveStage`;
`watchParty.stage.raise`, `.lower`, `.raised`, `.speak`, `.speakHint`,
`.title`, `.hands`, `.noHands`, `.handsMore_one`, `.handsMore_other`,
`.invite`, `.remove`. `voice.cinema.join`, `call.panel.join` and
`voice.watch.join` stay in the catalogue (ordinary calls still use them) and
simply stop being reachable from a `watch_party` channel.

`pnpm --filter @pqp/client i18n:check` must be green, which means no stale
Portuguese, no placeholder mismatch and no leftover key.
