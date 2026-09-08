# Watch party

A watch party used to be a button on any voice channel. It is now three
things, and this document is in that order:

1. **The event** (below): a party with a name, a host, co-hosts, options and a
   state machine. This is what a person creates, sets up, and takes live.
2. **The channel type** (`channels.type = 'watch_party'`): the room the event
   runs in, with a stage only some people may take.
3. **The stream**: LiveKit egress turning the presenter's screen into an HLS
   playlist that an audience watches without a seat.

They are deliberately separable. A party is live because somebody pressed Ir
ao vivo; a picture exists because somebody is sharing. Conflating those two
was the bug that made a viewer stare at a blank pane and conclude nothing
worked.

## The event

### One row, not two

There is no `watch_parties` table. **A party IS a `channel_sessions` row**,
extended with `host_user_id`, `options`, `went_live_at`, `ended_at`,
`host_disconnected_at` and a `channel_session_cohosts` side table.

That was a decision, not an accident. `channel_sessions` (PR #352) already
carried the title, the channel, the creator and the reminder subscriptions,
and its partial unique index already said "one active per channel", which is
exactly the cardinality a party wants. A scheduled session that goes live does
not become a different object: it changes state. So "the thing I set a
reminder for" and "the thing that is on air" have one id and one history, and
the reminder machinery, the no-show sweep and the sidebar hint all keep
working untouched.

The cost is a table whose name no longer says what it holds. That is the
lesser evil against two tables that have to agree about which one is real.

### The state machine

`packages/shared/src/watch-party-session.ts` is the only place the legal moves
are written down, and both sides import it. The client renders a button
because this module says the action is allowed; the server allows the request
for the same reason.

```
                +-------------+
   create ----> |    draft    |  private to the host and co-hosts
                +------+------+
                  |    |    \
        add a time |    |     \  Ir ao vivo
                  v    |      v
             +---------+--+  +--------+
             | scheduled  |->|  live  |
             +-----+---+--+  +---+----+
                   |    \        |
       cancel      |     \ no-show, or the host never came back
                   v      v      v
              +-----------+   +-------+
              | cancelled |   | ended |
              +-----------+   +-------+
```

Every move and only these: `draft -> scheduled | live | cancelled`,
`scheduled -> draft | live | ended | cancelled`, `live -> ended`. `ended` and
`cancelled` are terminal and nothing leaves them, including a move to
themselves.

Two of those are worth stating out loud:

- **`live -> cancelled` is not a move.** A show that happened is `ended`. You
  cannot un-happen it.
- **`draft -> ended` is not a move either.** A draft nobody ever saw is
  `cancelled`. `ended` is what the reminders and the sidebar treat as "it
  took place", and a draft never took place.

`draft` is the state that makes this a journey. A host who presses Criar
watch party gets an object that exists, has a name, has options and is
invisible to everybody else. Nothing is broadcast until one deliberate act.

### The roles, and who may do what

Four roles, in descending authority. Only the first two are stored.

| Role | Who | Stored |
|---|---|---|
| `host` | whoever created the party, until they hand it over or a co-host claims it | `channel_sessions.host_user_id` |
| `cohost` | a list the host keeps | `channel_session_cohosts` |
| `manager` | anyone with MANAGE_CHANNELS on the channel | derived |
| `viewer` | everybody else | derived |

| Action | host | co-host | manager | viewer |
|---|---|---|---|---|
| see a `draft` | yes | yes | **no** | no |
| see any other state | yes | yes | yes | yes |
| rename, retime, change options | yes | yes | yes | no |
| publish a draft (give it a time) | yes | yes | no | no |
| **Ir ao vivo** | yes | yes | **no** | no |
| **Encerrar** a live party | yes | yes | yes | no |
| cancel a party that never went live | yes | yes | yes | no |
| promote / demote a co-host | yes | **no** | no | no |
| hand the host role over | yes | **no** | no | no |
| claim the host role | no | **yes**, and only in the grace window | no | no |

The three cells worth arguing about, argued:

**A co-host runs the party but not the roster.** They rename it, take it live
and end it, because a co-host exists so the show does not depend on one
person's laptop. They cannot promote, demote or transfer, because the moment
they can, a co-host can demote the host and there is no chain of authority
left. Succession runs through `claimHost`, which is gated on the host actually
being gone.

**A manager stops a party, it does not start one.** MANAGE_CHANNELS ends and
edits a live party, which is moderation and is the point of having it. It does
not press Ir ao vivo on somebody else's draft, and it does not see that draft
at all: a draft is a person thinking, not channel configuration.

**A Moderador is not a manager here.** The seeded Moderador cargo holds
START_WATCH_PARTY and *not* MANAGE_CHANNELS, so a mod may run their own party
and has no authority over anyone else's. If that ever changes, the test that
says so is in `packages/shared/src/watch-party-session.test.ts`.

**A draft answers 404, never 403.** A 403 tells the asker something is there,
which is exactly what an invisible object must not do.

### The host disconnect, and the takeover

`WATCH_PARTY_HOST_GRACE_MS` is **five minutes**.

- The host's **last** socket closes: `host_disconnected_at` is stamped, but
  only on a party that is `live`. The "last socket" check is why this lives in
  `server/src/ws/watch-party-events.ts` and not in the service: a person with
  a laptop and a phone closes one of them constantly, and only the transition
  to zero sockets is a host leaving.
- While the clock runs, the party **stays live**. The audience is watching
  either way, and cutting them off to make a point about ownership helps
  nobody. What the clock changes is that a co-host now sees **Assumir**.
- The host comes back: the stamp is cleared, the button goes away.
- The clock expires with nobody having claimed it: the minute tick
  (`sweepWatchPartyHosts`, beside the reminder job) ends the party.

Five minutes is a product number. Under a minute would end parties over a
browser reload, which reconnects in seconds. Much longer leaves a room "live"
with nobody running it, which is worse than ending it, because the sidebar
keeps promising a show.

**This clock is not the stream.** The egress dies when the presenter's share
stops, which is a separate event with its own monitor and its own recovery
(`hls-egress.ts`), and a host can perfectly well drop while a co-host is
presenting.

**The recording, if there is one, stays with the host who ran the show.** A
takeover does not transfer it. There is no foreign key from `hls_sessions` to
the party on purpose (that file is being changed by other work); the binding
is channel plus the `went_live_at`..`ended_at` window, which is exact because
only one party per channel can be live.

### Nobody watching is ever asked for a microphone

This is the rule, and it is a product decision before it is a technical one.

**Watching is the default and needs no device permission at all.** An audience
seat opens no `getUserMedia`: no prompt, no device, no notice, and no
permission failure to report because none was possible. That is
`VoiceAudioOptions.audienceOnly`, and it is NOT the same thing as the
listen-only fallback beside it, which asks, fails, and explains itself. For
somebody who only wants to watch, every word of that explanation is noise
about a permission they should never have been asked for, and it frames
watching as a broken call. Rafael was shown exactly that banner and it is why
this exists.

**Speaking is a deliberate second act**, `voice.takeTheMicrophone()`, and the
only place in a watch party where a permission prompt is honest: somebody has
decided to speak, so a refusal is worth a sentence. It leaves and rejoins the
room rather than adding a track to a seat that has none, because the join path
already negotiates correctly on mesh and on the SFU and a third negotiation
path is how those two drift apart.

**Whether an audience member may speak is the host's decision, not the
browser's**, which is what `stageMode` below is for.

The QA that proves it counts `getUserMedia` calls in the viewer's page rather
than reading a screenshot: a viewer watching, and then taking the audience
seat, makes **zero**.

### The options

Six controls at most, one of which is a sentence. In the setup surface before
going live, and again in an "Opções" panel while the party runs; the same
component, because a host who learned it at minute zero should not learn a
second one at minute forty. Every change is applied by the server on the spot
(`reconcileLiveWatchPartyOptions`), so it lands for the people already
watching.

| Option | Default | What the server does |
|---|---|---|
| **Quem pode falar** (`stageMode`) | `hosts_only` | closes the floor: denies SPEAK to @everyone, and grants it back to the host and co-hosts |
| **Pedir pra falar** (`raiseHand`) | on, and shown only for `invited` | nothing by itself; it is what makes the queue exist |
| **Chat lento** (`slowModeSeconds`) | 0 | writes `channels.slowmode_seconds`, the channel's own slow mode, and puts the old value back at the end |
| **Reações** (`reactionsEnabled`) | on | carried on the party, read by the client |
| **Quem pode ver** | not a control | the channel's own permissions. A sentence, not a switch |
| **Qualidade** | not here yet | the HLS ladder branch owns it and adds one key when it lands |

`hosts_only` is the default because of the failure mode rather than a
preference: a party of two hundred people with open microphones is not a watch
party, and the 2026-09-05 spike showed how fast a room here gets to two
hundred. `invited` is the same closed floor plus a door, one person at a time.
`everyone` is the old behaviour, kept because six friends watching a film
genuinely want it, and warned about in the copy once the room is busy.

**Closing the floor must never silence the people running the party.** A host
who is not the server owner has no short circuit through `computePermissions`,
so without the member grant the very act of protecting the room takes the
host's own microphone away. `watch-party-options.test.ts` breaks that grant on
purpose and catches it.

**Two things about who may change them, both arguable.** `edit` allows a
manager, so **MANAGE_CHANNELS can open a floor somebody else closed**. That is
deliberate (the stage mode is the lever moderation needs) and it is the kind
of thing to overrule if it reads wrong. A co-host may also change them, for
the same reason a co-host may end the party.

**Announcing a change.** The audience is not told in the channel's chat: this
repo has no system-message kind, and posting from the host's account would be
a message they did not write. The party bar and the options panel show the
current values instead, and they update on the same frame that changed them.
If a written notice is wanted, it needs a system-message type first.

### What going live does to the channel, and what ending puts back

The setup surface asks the host to decide the things that matter before an
audience arrives. Two of them are real channel state, and both are
**restored** when the party ends, never reset:

| Option | What Ir ao vivo does | What Encerrar does |
|---|---|---|
| `slowModeSeconds` | writes `channels.slowmode_seconds`, recording the old value in `restore_slowmode_seconds` (only the FIRST change records it, so a host who moves 30s to 60s mid-show still gets the channel's original value back) | writes the old value back |
| a closed `stageMode` | denies SPEAK to @everyone with an ordinary channel overwrite, records `stage_speak_applied`, and grants a member SPEAK allow to the host, the co-hosts and anyone invited up | removes those bits, and deletes an overwrite row only when the party is the sole reason it existed |
| `reactionsEnabled` | carried on the party, read by the client | nothing to undo |

A channel that already had slow mode on keeps it. A channel where @everyone
was already denied SPEAK is left alone, and ending the party does not hand the
room a microphone it never had.

One reconciler does all of it, rather than an apply and an undo, because the
options are editable while the party runs: a host switching from `everyone` to
`hosts_only` mid-show has to take effect for the people already in the room,
and two half-functions would have needed a third for that case, which is where
they drift. It is idempotent, so a call that changes nothing writes nothing,
which matters because every overwrite write bumps `permissions_version` and
re-resolves every seat.

`restoreChannelAfterParty` reads and clears in one statement, through a CTE,
because `UPDATE ... RETURNING` hands back the *new* values. The obvious
version of that function returned the nulls it had just written and restored
nothing, silently. It was caught by driving the real routes on a local stack,
which is the only thing that catches this class of bug here.

### The routes

| Method | Path | Who |
|---|---|---|
| POST | `/api/channels/:id/watch-parties` | START_WATCH_PARTY on the channel |
| GET | `/api/channels/:id/watch-party` | VIEW; a draft comes back as `null` |
| GET | `/api/servers/:id/watch-parties` | member; VIEW re-checked per channel |
| PATCH | `/api/watch-parties/:id` | `edit` |
| POST | `/api/watch-parties/:id/state` | derived from the target state |
| POST | `/api/watch-parties/:id/cohosts` | `promoteCohost` / `demoteCohost` |
| POST | `/api/watch-parties/:id/host` | `transferHost`, or `claimHost` with `{ claim: true }` |

One `state` route rather than four verbs: the transition table already says
which moves exist and the role table already says who may make them, so four
routes would be four places to forget one of the two checks.

`POST /api/channels/:id/sessions` (the schedule card from PR #352) now asks
for **START_WATCH_PARTY** instead of MANAGE_CHANNELS, which is the
`REPLACE-WHEN-READY` that PR left behind. Its PATCH and cancel also accept the
session's own host, so a mod who scheduled something can fix it.

### The frame

`watch-party-update { channelId, party | null }`, resolved **per recipient**
and sent to every socket that may see the party in its current state. It is
not in `CHAT_SERVER_MESSAGE_TYPES`, for the same reason
`channel-session-reminder` is not: whether a person may see a draft depends on
their role in it, so one encoded copy through the channel relay would hand a
draft to the room. A socket that may not see this state is sent nothing at
all, not a redacted version.

`party: null` means "there is nothing here for you any more": an end, a
cancel, or the party leaving the states you may see. It is how the sidebar
block disappears.

A socket that authenticates mid-show gets every party it may see
(`catchUpWatchParties`), the same catch-up rosters and `channel-live` already
do.

### The journey, screen by screen

1. **Criar watch party**, from the empty stage of a watch party channel.
   Asks for one thing: the name. Optionally a time, which is the fork between
   a private draft and an announced session.
2. **The setup surface** (`draft`). The host's own preview on the left, the
   options on the right: name, slow mode, who can talk, reactions. Nothing is
   broadcast. `getDisplayMedia` runs **here**, and the same `MediaStream` is
   handed to the call at go-live (`ScreenCaptureIntent.stream`), so what they
   approved and what goes out are the same capture rather than two different
   ones.
3. **Ir ao vivo**, one button, and three things in this order: the party's
   state changes, the host takes a seat in the room, the capture goes on the
   stage. State first on purpose: if the share fails, the party is live with
   nothing on screen and the panel says so in words. The other order would
   broadcast a picture from a party nobody has been told about.
4. **The sidebar block**, above the categories: the party's name (not the
   channel's), the host's face, a live pill, and Assistir.
5. **The viewer**: one click on that block selects the channel, the watch
   stage mounts, the HLS plays. No microphone, no seat, no second click.
   Joining the call is a separate button on the stage.
6. **Encerrar**, or the host's grace window expiring.

### Why the viewer entry changed

Rafael reported that a second browser could not get in as a viewer. Reading
the code found three things stacked, all of which had the same symptom:

1. **Nothing live was rendered as nothing at all.** `WatchChannelStage`
   returns `null` when there is no stream, and its "the stream ended" copy
   only fires for someone who had previously seen one. A viewer who arrived
   before the host started sharing, or into an environment where the egress
   could not start, got a blank pane with no words on it. The panel now says
   "A watch party começou" and what to expect, and says something different to
   the host ("compartilha uma janela").
2. **The only prominent button on the row joined the call.** Watching looked
   like it required a call, and the double-click-to-join rule (#360, #363)
   made it look like it required two clicks. The row's button is now
   **Assistir** while a party is live, and it *selects* the channel, which is
   what mounts the watch stage. Joining the call is separate and deliberate.
   The button reverts to Entrar when nothing is live, because then the reason
   to be in the room is to talk.
3. **The dev bypass signs every browser in as the same account** unless
   `pqp:dev-user-suffix` is set. Two windows are one person, and a two-person
   feature looks broken rather than untested. This one is a testing trap, not
   a product bug, and it is already in CLAUDE.md.

The likeliest single cause of what he saw is (1) compounded by his local
environment: with `LIVEKIT_URL` empty and no `LIVE_HLS_*`, no egress can start
at all, so there is never a stream and the old code drew nothing. The change
here does not conjure a picture out of a mesh room, but it does stop the
silence.

### Deliberately not done

- **`stageMode` is enforced through the ordinary SPEAK overwrite**, not
  through a new mechanism. A separate piece of work owns per-channel SPEAK
  policy; this rides on it rather than growing a second one.
- **No quality control yet.** The HLS ladder branch owns what a host may pick;
  when it lands it adds one key to `watchPartyOptionsSchema` and one control to
  `WatchPartyOptionsPanel`. A dropdown that changes nothing would be worse.
- **A change to the options is not written into the chat.** See above.
- **Slow mode is the general chat feature** (`channels.slowmode_seconds`).
  The party only carries the value the host picked so one press applies it.
- **No link from `hls_sessions` to the party row.** Other work is actively
  changing `hls-egress.ts`; the schema comment at the `hls_sessions` block
  still names `channel_session_id` as the eventual join.
- **Native apps are unchanged.** iOS and Android decode `type` as a string and
  see a voice room; they get no create surface, no sidebar block and no setup
  screen. Listed in the per-app to-do at the end of this file.

## The type

## The type

`channels.type = 'watch_party'`. Everything else about the row is a voice
channel: same columns, same overwrites, same voice room on `/ws`, same
transport decision (`server/src/voice/transport-policy.ts` looks at `kind`,
not `type`). `createChannelSchema` accepts it, and gained an optional `topic`
(max 200) so the create dialog can take a short description.

Shared helpers in `packages/shared/src/watch-party-channel.ts`:

| Name | What it answers |
|---|---|
| `isVoiceRoomChannelType(type)` | "does this channel open a voice room" (`voice` or `watch_party`). Use it instead of `type === "voice"`. |
| `isWatchPartyChannelType(type)` | just the new type |
| `canStartWatchPartyStream({ channelType, permissions })` | the ONE gate for the stage (below) |
| `liveStateFromRoster(participants)` | sidebar live state derived from the voice roster |
| `channelLiveStateSchema` / `ChannelLiveState` | the seam the HLS branch fills |

## The bit

`Permission.START_WATCH_PARTY` (bit 23, `8388608`). `PERMISSION_ALL` is now
`16777215`.

Defaults: Admin (ALL), Manager (ALL minus Administrator) and the seeded
Moderator hold it. `@everyone` does not, which is the whole point. Per-channel
overwrites apply like any other bit, so a server can hand the stage of one
channel to a guest with a member overwrite, or bench a mod on one channel with
a deny.

Backfill: `schema.sql` block `start_watch_party_bit_2026_09` (a one-shot on
`data_migrations`) ORs the bit onto every non-everyone role that already holds
MANAGE_CHANNELS, plus every `system_key = 'moderator'` role, and bumps
`permissions_version`. `pqp_ensure_staff_ladder` seeds the new masks for new
servers (Moderator `12927234`, Manager `16777207`).

## The gate

In a `watch_party` channel the stage asks for START_WATCH_PARTY. In a plain
voice channel it still asks for STREAM. Both go through
`canStartWatchPartyStream`, which is called from exactly two server places:

- `server/src/voice/speak.ts` `resolveVoicePublish`, which feeds the SFU
  token grant and the live re-check after a permissions change;
- the join in `server/src/ws/voice.ts`, which sets `peer.canStream`.

`set-sharing-screen` refuses on `peer.canStream` with `screen-share-denied`.
`set-camera` reads the same flag, so an audience member cannot turn a camera
on either (it is an audience). The client hides the share and Watch party
buttons when `welcome.canStream` is false, and shows the row's join button
(`Entrar`) to everyone.

Tests, each proven to fail with the check removed:
`packages/shared/src/watch-party-channel.test.ts` (admin yes, member no,
overwrite flips it), `server/src/ws/voice-watch-party.test.ts` (the same three
through the WS join and `set-sharing-screen`), and a case in
`server/src/voice/speak.test.ts`.

## The seam for the HLS branch

Live state lives in `server/src/voice/hls-egress.ts` as
`LiveHlsStream { hlsUrl, startedAt, presenterPeerId, delaySeconds }`.
`ChannelLiveState` uses the same field names on purpose:

```ts
{ live, presenterPeerId, viewerCount, startedAt, hlsUrl }
```

What landed on the server side (`server/src/ws/voice.ts`,
`server/src/ws/hls-audience.ts`, contract in
`packages/shared/src/live-hls.ts`):

**The stage gate on the egress start.** `pushLiveHls` picks the sharer
through `pickHlsSharer`: `sharingScreen && canStream`. In a watch party
`canStream` is START_WATCH_PARTY (`canStartWatchPartyStream`), so the
transcode reads the same bit `set-sharing-screen` refuses on; there is no
second check keyed on `type`. It also hands `reconcileLiveHls` the channel's
server id (from the audience cache, no extra query) for the
`LIVE_HLS_SERVER_ALLOWLIST` refusal.

**Two frames, one per audience.**

- `voice-stream { channelId, stream | null }`: the room only, as before.
- `channel-live { channelId, stream | null, watching }`: everyone who may
  view the channel, seat or no seat (the roster's `getChannelAudience`),
  when the egress starts, stops or changes URL, and at socket auth for every
  live channel the user can see. This is what the sidebar pill and a viewer
  outside the room build `ChannelLiveState` from; prefer it over the roster
  derivation (`liveStateFromRoster` stays the fallback when no frame has
  arrived). `watching` is viewers without a seat; seats are on the roster.

**Watch mode without a seat.** A client that opened a live channel and did
not press Entrar sends `watch-live { channelId, watching: true }`, and
`false` when it leaves. The server checks `canAccessChannel` (no VIEW: the
frame is ignored, no error), counts the socket and answers that socket alone
with a `channel-live`. The audience hears the new count on the
`ROSTER_AUDIENCE_KEYFRAME_MS` clock (30 s) while the channel is live or
watched, never per subscribe: a wave of arrivals costs the server one frame
per viewer per keyframe, not one frame to the whole server per arrival. The
socket leaves the count on `watch-live false`, on close, and the moment it
takes a seat.

**The token.** Every `hlsUrl` that leaves the server is
`stampViewerStream(stream, userId)`: the playlist proxy path with `?t=`, a
signed token bound to the recipient, the channel and the session
(`server/src/voice/hls-viewer-token.ts`). So both frames are encoded per
socket, never once per room, and a URL copied from one viewer plays for
nobody else. Safari's native player and the iOS app need this; hls.js may
still send the Bearer header instead.

**Belt and braces.** `GET /api/channels/:channelId/live` answers
`{ stream, watching, participants }` after the same VIEW check, for a client
that opens a channel before its socket is up. `stream` is stamped for the
caller.

Tests: `server/src/ws/voice-hls-audience.test.ts` (the gate, the audience,
the count cadence, the token on every path).

Scheduling (built in parallel) attaches to the channel; the sidebar row has a
`TODO(schedule)` where the next session time goes in the idle state.

## Client flag

`VITE_WATCH_PARTY_CHANNELS=true` turns on the create affordance and the
distinct sidebar row (icon, description, pulsing `AO VIVO` pill with the
viewer count, off under `prefers-reduced-motion`). Default off: production
shows nothing new until Rafael flips it. With the flag off an existing
`watch_party` channel renders and joins as a plain voice channel. With the dev
auth bypass on, `?watchParty=1|0` latches the flag for that tab
(`client/src/lib/watch-party-channels.ts`). The snapshot's
`GET /api/live-hls/config` is not on main; when it is, this flag can follow
it the way Baú follows `/api/community-home/config`.

## Native apps

Both decode `type` as a plain string, so the new type never fails a parse.
This PR widened `isVoice` on both (`ios/pqp/Sources/Core/Models.swift`,
`android/.../core/Models.kt`) so a watch party lists as a voice room and joins
as audience; the server refuses their share claim like any other. Still to do
later, per app:

- iOS: a distinct icon and the `AO VIVO` pill (needs `sharingScreen` from the
  roster it already receives); hide the share control in a watch party unless
  `welcome.canStream`; the create sheet does not offer the type.
- Android: same three; also `WireProtocolTest` mirrors the shared enum and was
  updated here.
