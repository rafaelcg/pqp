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

**What is tested, and by whom.** The client journey is pinned end to end in
`client/e2e/watch-party.spec.ts`: creating one from the sidebar, the setup
surface, Ir ao vivo, who does and does not get the create control, the block
appearing for a second real account, the audience surface without a seat, the
player disappearing when that viewer takes a seat, and the three states a real
event produces. It runs with the flag genuinely on (`?watchParty=1`) and
substitutes exactly one thing CI cannot make: the `stream` field, because there
is no LiveKit and no egress on a runner. Everything a person still has to click
by hand, in order, is `docs/WATCH_PARTY_QA.md`.

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

### The streaming notice, and when it appears

"Você é responsável pelo que transmite" is shown once per host per server. It
used to be raised by the share start, which in a watch party meant it landed
**after** Ir ao vivo: the party was already live and the room already told,
and only then did the host read a notice about being responsible for what they
broadcast. That is the one moment the notice exists for and it arrived too late
to inform the decision.

It is now raised when a host opens a `draft` setup surface, before anything can
be sent. Confirming there starts nothing, so the button says "Entendi" rather
than "Entendi, começar a transmitir". Dismissing it without confirming does not
bypass it: the share gate asks again at Ir ao vivo, so the disclosure still
stands between the host and the broadcast. By the time a host who confirmed
presses Ir ao vivo the server already has their ack, so nobody sees it twice.

The plain screen-share path outside a watch party is untouched: there a share
IS the broadcast, so raising it at the share start is already before anything
goes out.

It appears only where a broadcast is possible at all, which means a server the
operator has HLS configured for. On a local stack without `LIVE_HLS_*` the
config answers `enabled: false` and the notice is correctly absent, because
nothing can leave the machine.

**One trap worth knowing**, because it cost an hour. The effect that raises it
depends on the party map, which changes the instant the draft is created (the
optimistic write, then the server's broadcast). The first version had the usual
`let cancelled = false` cleanup, so the effect tore down mid-request, threw away
the answer, and the re-run hit its own once-per-server guard and never asked
again. The notice simply never appeared, silently. A re-render is not a reason
to discard an answer; the only thing worth guarding is having navigated to a
different server, which a ref answers without fighting the render cycle.

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

### A watch party is not a channel in the list

The first version gave watch parties a section of their own under Voice, and
the result was one event with two representations: the block at the top AND a
row further down with its own occupant list, which is exactly the voice-channel
treatment the block existed to escape. The section is gone.

**The channel still exists, and is never listed.** It is the party's voice
room, the home of the chat during the show, and the key `channel_sessions`, the
HLS egress, the overwrites and the permissions all hang on. Removing it would
be a rewrite of every one of those. `channel-list.tsx` filters the type out of
`channels` **once**, at the top of the component, so it disappears from the
top-level groups, the categories, the pinned row and the icons-only rail
together rather than through four filters that could disagree.

**Starting one is an action, not a channel type.** One control in the sidebar,
in the same slot the live block occupies, visible only to holders of
START_WATCH_PARTY. It is there rather than in the server header menu because
that is where the party will appear: create and result share a place, so the
button teaches what it does. `POST /api/servers/:id/watch-parties` finds or
makes the room and opens the draft in one request, so there is never a window
where a half-made channel exists and no party does.

**One room per server, reused.** A fresh channel per party would leak a channel
row, its overwrites and a chat history every time somebody pressed the button.
Reusing one also gives the cardinality Rafael described ("the top container",
singular): one room per server, and the partial unique index already allows one
active party per room, so one live party per server, which is what the block
assumes.

**An existing `watch_party` channel is adopted, not replaced.** The type is
merged and on main, so a server may already have one, or several. The oldest by
position then id wins, deterministically, so two people pressing the button at
the same moment land in the same room instead of racing to make two. Any others
keep existing, unlisted and unused, with their history intact. Nothing is
deleted, and nothing needs a migration.

**The client has to be told about a room it has never seen.** It is created on
demand and never listed, so a viewer who loaded the app before the party existed
has no such channel and selecting it would land on "Escolha um canal". The
create call hands the channel back whole for the host, and a viewer clicking the
block refetches the server's channels once when the id is unknown. That covers
everybody arriving mid-party, which is most of an audience.

**Where the chat lives, and what is left afterwards.** During the party, the
room's own chat: clicking the block selects the room, and the transcript is
beside the picture like any channel. When the party ends the block disappears
and the room goes back to being unlisted, so the conversation is no longer
reachable from the sidebar. The messages are not deleted and remain searchable.

Nothing is posted anywhere on end. That is a decision rather than an oversight,
and it is the weakest part of this: a recap card ("Cinemoon, 47 minutes, 32
people") in a text channel is the obvious follow-up, and it needs a
system-message kind first, which this repo does not have (see the note about
announcing an options change, which ran into the same wall). Posting from the
host's account would be a message they did not write. **This is the thing to
revisit first** if the ended conversation turns out to matter, and it should be
designed with the replay work rather than bolted on before it.

**A member with no permission and no party running sees nothing at all.** No
heading, no empty section, no placeholder. Watch parties are simply not part of
their sidebar until one exists.

### Three decisions, settled

Rafael was asked about these and said "i'll leave to you". They are written
down so the next person inherits the reasoning instead of relitigating them.

**1. The room stays unlisted and reused.** It is never in the sidebar, and one
server has one of them, found or created on demand and adopted if it already
exists. The alternative considered was a fresh channel per party, which reads
more naturally ("this party, this room") and was rejected because it leaks: a
channel row, its overwrites and a chat history per press, so a server that runs
a film night every Friday accumulates a year of dead rooms. Reuse also gives
the cardinality the sidebar block assumes, since the partial unique index
allows one active party per room and therefore one live party per server.

**2. The header keeps the internal room name, with the party's name beneath
it.** The channel header and the composer say `watch-party`; the party bar
directly under them says "Cinemoon: sessão coruja". That looks like a mismatch
and is deliberate. Every channel in this app is a slug (`#general`,
`#off-topic`), so `watch-party` reads as what it is: the room where watch
parties happen, which is also true between shows when no party exists to name
it. The alternative was renaming the channel to the party on every create,
which means slugifying arbitrary names ("Cinemoon: sessão coruja" becomes
`cinemoon-sessao-coruja`), mutating the channel on every show, and leaving the
last party's name on a room that is now empty. If this is ever revisited, the
better fix is a display override for this channel type rather than a rename.

**3. Ending a party leaves nothing behind, for now.** No recap card, no message
in a text channel. The conversation stays in the room, is not deleted and
remains searchable; it is simply no longer reachable from the sidebar once the
block goes.

This is the weakest part of the feature and it is a scope decision rather than
a design one. A recap ("Cinemoon, 47 minutes, 32 people") wants to be a system
message, and this repo has no system-message kind: the only way to post one
today is from a user's account, which would be a message they did not write.
The same wall was hit deciding how to announce an options change mid-party.
Inventing that kind inside this PR would be scope creep on a change that is
already large, and the recap should be designed with the replay work
(`keep_replay` on `hls_sessions`) rather than bolted on before it. **This is
the first thing to revisit** if the ended conversation turns out to matter.

### The journey, screen by screen

1. **Criar watch party**, the one control at the top of the sidebar, for
   people holding START_WATCH_PARTY. Asks for one thing: the name. Optionally a time, which is the fork between
   a private draft and an announced session.
2. **The setup surface** (`draft`). The host's own preview on the left, the
   options on the right: name, who can talk, slow mode, reactions. Nothing is
   broadcast, and the streaming notice is raised here, where it can still
   change the decision. `getDisplayMedia` runs **here**, and the same `MediaStream` is
   handed to the call at go-live (`ScreenCaptureIntent.stream`), so what they
   approved and what goes out are the same capture rather than two different
   ones.
3. **Ir ao vivo**, one button, and three things in this order: the party's
   state changes, the host takes a seat in the room, the capture goes on the
   stage. State first on purpose: if the share fails, the party is live with
   nothing on screen and the panel says so in words. The other order would
   broadcast a picture from a party nobody has been told about.
4. **The sidebar block**, above the categories: the party's name (not the
   channel's), the host's face and a live pill (`components/watch-party/live-pill.tsx`: the
   pulse is on the dot, never the text, and only under `motion-safe`, so
   reduced motion leaves a badge that still reads as live). The block IS the
   button, so
   there is no chip inside it; it had one, in red, and both halves of that were
   wrong. A button inside a button is a second target for the same action, and
   red in this app means destructive (Encerrar, Banir). The bordered card that
   lights up on hover is the affordance.
5. **The viewer**: one click anywhere on that block selects the channel, the
   watch stage mounts, the HLS plays. No microphone, no seat, no second click.
   Joining the call is a separate button on the stage.
6. **Encerrar**, or the host's grace window expiring.

### The layout

The watch stage uses the SAME split machinery as a call: `lib/call-split.ts`
and `components/layout/call-split.tsx`, not a second implementation. So a watch
party gets the stacked and side-by-side arrangements, each with its own
remembered fraction, the same draggable divider with the same pixel minimums,
and the same toggle in the channel header. The shared `side` default (0.62)
stands: no watch-party-specific number was introduced, on Rafael's call.

The one change that made it work was `strongestStageShape`. `stageShape` drives
the divider and the toggle, and it was last-write-wins from a single callback.
A watch party channel mounts three stages at once (the party panel, the watch
stage, the call stage) and each reports as it appears and disappears, so
whichever went away could flatten the pane with a "none" that was only ever
about itself. The pane takes the strongest claim now: a stage that has gone
cannot outvote a picture that is still there.

Side by side also exposed a layout bug worth recording, because it is the
narrow-column version of the one the sidebar block had. The live bar put the
party's identity, the viewer count and three buttons on one row; at 62% of a
laptop pane that clipped **Encerrar** against the divider, which is the one
control a host must always reach. The bar wraps now, the count moved into the
identity line where it is information rather than an action, and the identity
carries a real minimum width so the actions wrap to their own row instead of
the party's name truncating away to nothing.

### Three controls the host and the viewer asked for

**Fit or fill, on the player.** The app already had both behaviours and a
documented reason for the difference: a camera is a face and is better cropped
(`object-cover`), a shared screen is content and is better whole
(`object-contain`). The watch stage is the case where neither default is
obviously right, because the pane's shape almost never matches the source's: a
16:9 film on whatever is left after the chat, the roster and the split is
letterboxed more often than not. So the player carries a toggle, beside the
quality menu and the volume in the one control cluster it already has.

It is a THIRD kind in `lib/video-fit.ts` (`watch`), not a reuse of `screen`.
The question is the same but the context is not: a `screen` tile sits in a grid
where a crop eats a toolbar, and the watch stage owns a pane where somebody may
quite reasonably want the bars gone. Sharing one value would make a choice in
one place silently change the other, which is the mistake the two existing
kinds were split to avoid. It defaults to `contain`, so nothing about a first
render moved, and ordinary call tiles are untouched.

**Hiding a pane** is not this branch's work. It landed separately as PR 403
(`collapsed: "none" | "stage" | "chat"` on `CallSplitPreference`, chevrons on
the divider, a full-edge strip to restore), from the same QG request, and this
branch was building the same thing at the same time. Main's version won on
merge: same type, same values, same `resolveCollapsed`, same
hidden-not-unmounted rule. Nothing was lost and nothing is duplicated.

What this branch does add to the split is **`strongestStageShape`**. `stageShape`
drives the divider and the side-by-side toggle and was last-write-wins from a
single callback, which is fine while one stage can be mounted. A watch party
channel mounts three at once (the party panel, the watch stage, the call
stage), and each reports as it appears and disappears, so whichever went away
could flatten the pane with a "none" that was only ever about itself. The pane
takes the strongest claim instead: a stage that has gone cannot outvote a
picture that is still there. A plain call never hits this, which is why PR 403
did not need it.

**What the host is transmitting.** `components/watch-party/watch-party-transmission.tsx`,
host and co-hosts only, never viewers. Assembled from what already existed
rather than recomputed: `OutboundVideoReadout` for what leaves the machine
(it already knows how to tell a ceiling the ROOM imposed from one the LINK
imposed), `LiveHlsStream.topHeight` for the tallest rung the ladder actually
started (PR 376) and `delaySeconds` for the lag, `useShareUplinkStrain` from
PRs 340 and 370 for whether the uplink is losing, and the party's own audience
count and `wentLiveAt`.

Collapsed by default. The one line is what the ROOM is getting and how many
people that is, because the question a host glances at this to answer is "is
what I am sending arriving". The detail is one press away for when the answer
is no.

One honest gap, stated rather than stubbed: `useShareUplinkStrain` is mesh-only
by design, because on the SFU the stats it reads mean something else and it
would blame a healthy uplink, which is the bug PR 370 fixed. A watch party big
enough to matter is on LiveKit, so the strain line will not appear there.

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

## How you know it is running

The whole of the above can be deployed, configured and doing nothing, and for
a while that is exactly what it was. Three surfaces answer three different
questions, and none of them substitutes for another.

**Can it write a segment at all?** `GET /ready`, `checks.liveHls`. A signed
`HEAD` of a key that cannot exist against the `LIVE_HLS_S3_*` bucket, so a 404
is a pass and a 403 is the answer worth having. **It is not `checks.storage`**:
that is the attachment bucket, a different bucket with a different key pair,
and one being green has never implied anything about the other. Skipped, and
never a 503, while `LIVE_HLS_ENABLED` is not `"true"`.

**Did a transcode actually start?** `GET /api/admin/metrics`, the `liveHls`
block: `enabled`, `configured`, `allowlisted`, `ladder`, and `sessions` /
`rungs` / `oldestSessionMinutes` for the transcodes running on the instance
that answered. `sessions: 0` during a live watch party is the egress not
starting, which on the viewer's screen is a blank pane and in the log is
`voice.hlsStarted` never appearing.

**Are the recordings being deleted?** The same block's `uncleaned`: finished
sessions past their retention window that still hold objects. It belongs at
zero and self-corrects within a sweep tick (60 s) of each party ending.
**Climbing on its own is a dead sweep**, and it is the only symptom one has.

That last number exists because of a live production gap, which is worth
stating plainly since the shape recurs (CLAUDE.md pitfalls 9, 12 and 13).
`sweepHlsSessions` is a cold job, so it runs wherever `jobs.ts` runs.
Production splits that: `pqp-api` has every `LIVE_HLS_S3_*` secret and
`WORKER_MODE=api`, which skips every batch job; `pqp-worker` runs them and has
none of those secrets. So the sweep runs in the one process that cannot reach
the bucket, returns 0, and until now said nothing. Segments accumulate in R2
for good and the only evidence is the bill.

Two halves to closing it, and both are needed:

- **The code half** (done): the sweep logs `voice.hlsSweepMisconfigured` once
  per process when it is the one running and finds sessions it owes but cannot
  reach the bucket, and `uncleaned` on the dashboard makes the leak a number.
- **The operator half**: `pqp-worker` needs `LIVE_HLS_S3_*` **and**
  `LIVEKIT_*`. Not one or the other. The sweep's central rule is "ask the
  media server, do not trust the row". `ended_at` says when this cluster
  stopped believing in a session, and an API that restarted mid-share leaves a
  row ended while the egress keeps writing. Giving the worker the bucket
  without LiveKit would let it delete a live party's segments, which looks
  like corruption rather than a restart. `listActiveEgresses()` answers `null`
  ("could not ask") rather than `[]` ("nothing is running") when there is no
  media server to ask, and every caller treats null as leave-it-alone, so the
  half-configured worker now refuses instead of deleting. It is safe; it is
  just not sweeping, and `uncleaned` will say so.

## Turning it on in production

Everything below has to be true at once. Any one of them missing is the whole
feature off, and only two of them have a symptom you would notice.

### The state on 2026-09-09

| # | What | Where | State |
|---|---|---|---|
| 1 | `LIVE_HLS_ENABLED=true` | `pqp-api` | **missing** |
| 2 | `LIVE_HLS_S3_BUCKET` / `_ENDPOINT` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_FORCE_PATH_STYLE` | `pqp-api` | set, and the bucket was proved to accept a write, a read and a delete from that key pair on 2026-09-09 |
| 3 | `LIVE_HLS_DELAY_SECONDS` | `pqp-api` | set |
| 4 | `LIVE_HLS_PUBLIC_BASE_URL` | `pqp-api` | **not set, and correct**: signed mode is the default, the bucket stays private, and this is only read with `LIVE_HLS_SIGNED_URLS=false`. Never point it at `r2.dev` |
| 5 | `LIVEKIT_URL` / `_API_KEY` / `_API_SECRET` | `pqp-api` | set, `/ready` green |
| 6 | LiveKit **Egress** and Redis running beside the SFU | the media box | running (`livekit/egress:v1.14.1`, `redis:7-alpine`) |
| 7 | `VITE_WATCH_PARTY_CHANNELS=true` at **web build time** | `deploy-web.yml` | **missing**. See "Client flag" below. This is the one no server setting can substitute for |
| 8 | `LIVE_HLS_S3_*` **and** `LIVEKIT_*` on `pqp-worker` | `pqp-worker` | **missing**, so the retention sweep cannot run anywhere. See "How you know it is running" |
| 9 | `LIVE_HLS_SERVER_ALLOWLIST` | `pqp-api` | unset, which means **every** server. See the warning below |

### Why the allowlist is not optional for a first outing

Two things happen the moment `LIVE_HLS_ENABLED=true` with no allowlist, and
neither is "watch parties now work".

**Every server voice channel moves to the SFU.** `resolveVoiceTransport`
returns `livekit` with reason `hls` for any server channel as soon as live HLS
is on for that server, ahead of the size and community rules. Rooms that are
peer-to-peer today, and cost the media box nothing, start being carried by it.
`docs/CAPACITY.md` §6b prices that: moving the peer-to-peer half onto the box
roughly doubles its bytes, and the monthly transfer allowance is what runs out
first, not the cores.

**Every screen share anywhere starts a transcode.** `pushLiveHls` picks a
sharer with `sharingScreen && canStream` in any LiveKit room. It is not
limited to `watch_party` channels, and there is no cap on how many run at
once.

Both are per-server: `isLiveHlsEnabledForServer` gates the transport decision
and the egress alike, so naming the event's server confines both. Measured
cost of one party's transcodes, on the same LiveKit and egress versions
production runs (2026-09-09, synthetic full-frame 30 fps motion, which is
close to worst case for screen content):

| rung | cost |
|---|---|
| `720p30` | 0.51 core |
| `1080p30` | 0.88 core |

So the default two-rung ladder is about 1.4 of the media box's 4 cores for one
party, leaving the rest for the SFU, the TURN relay and everything else on the
same box. For **one** party that is comfortable. There is no ceiling on
concurrent parties, which is what the allowlist is for.

### The commands

Read the server id first; do not guess it.

```sh
# the event's server, by name
psql "$DATABASE_URL" -c "SELECT id, name FROM servers WHERE name ILIKE '%<part of the name>%'"
```

Then, in this order. Each is one command and each is reversible.

```sh
# 1. The web build. Nothing is visible without this, whatever the API says.
gh variable set VITE_WATCH_PARTY_CHANNELS --body true
gh workflow run deploy-web.yml --ref main

# 2. The retention sweep's process. BOTH, never one: the bucket without
#    LIVEKIT_* leaves the sweep unable to tell a finished session from a live
#    one. It refuses rather than deleting, so it is safe, but it does not sweep.
fly secrets set -a pqp-worker LIVEKIT_URL=- LIVEKIT_API_KEY=- LIVEKIT_API_SECRET=- \
  LIVE_HLS_S3_BUCKET=- LIVE_HLS_S3_ENDPOINT=- LIVE_HLS_S3_REGION=- \
  LIVE_HLS_S3_ACCESS_KEY_ID=- LIVE_HLS_S3_SECRET_ACCESS_KEY=- \
  LIVE_HLS_S3_FORCE_PATH_STYLE=-   # each value on stdin, never on the command line

# 3. The feature, confined to one server. Both in one command so there is
#    never a window where it is on for everybody.
fly secrets set -a pqp-api LIVE_HLS_ENABLED=- LIVE_HLS_SERVER_ALLOWLIST=-
```

Step 3 restarts `pqp-api` and closes every `/ws`. Do it well before the event,
not during it.

### Reading it back, in order

```sh
curl -s https://api.pqp.gg/ready | jq '.checks.liveHls'
# {"ok":true,"ms":…}  not "skipped", which would mean the flag did not take

curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" \
  https://api.pqp.gg/api/admin/metrics | jq '.liveHls'
# enabled true, configured true, allowlisted true, ladder listed,
# uncleaned 0, sweepsHere false (the sweep lives on pqp-worker)
```

Then a real party on the allowlisted server, and during it:
`liveHls.sessions` at least 1, `liveHls.rungs` matching the ladder, and
`voice.hlsStarted` in the log. Ten minutes after it ends, `liveHls.uncleaned`
back at 0 and `voice.hlsSessionCleaned` in the log.

### Turning it back off

`fly secrets unset LIVE_HLS_ENABLED -a pqp-api`. One command, no deploy, and
every room goes back to the ordinary transport policy on its next pin. The
client flag can stay on: with the API answering `enabled: false` the create
surface still appears but nothing can broadcast, so unset
`VITE_WATCH_PARTY_CHANNELS` and redeploy web if the surface itself should go.

## Client flag

`VITE_WATCH_PARTY_CHANNELS=true` turns on the create affordance and the
distinct sidebar row (icon, description, pulsing `AO VIVO` pill with the
viewer count, off under `prefers-reduced-motion`). Default off: production
shows nothing new until Rafael flips it. With the flag off an existing
`watch_party` channel renders and joins as a plain voice channel. With the dev
auth bypass on, `?watchParty=1|0` latches the flag for that tab
(`client/src/lib/watch-party-channels.ts`). `GET /api/live-hls/config` is on
main now, so this flag could follow it the way Baú follows
`/api/community-home/config`; it does not yet.

**How production turns it on.** It is a BUILD-TIME flag, so no API secret can
do it and no server flag implies it: the string has to be in the environment of
the `pnpm --filter @pqp/client build` step in `deploy-web.yml`, or the bundle
Cloudflare Pages serves simply has no watch party in it. Until 2026-09-09 the
name was not in that workflow at all, so the answer was permanently "off"
however `LIVE_HLS_ENABLED` was set on `pqp-api` — the server could start an
egress that the shipped client had no surface to show.

```sh
gh variable set VITE_WATCH_PARTY_CHANNELS --body true
gh workflow run deploy-web.yml --ref main       # rebuild and republish Pages
```

Then read it back off the deployed bundle rather than trusting the run:

```sh
curl -s https://pqp.gg/ | grep -o '/assets/index-[A-Za-z0-9]*\.js' | head -1
```

and check the sidebar shows Criar watch party for an account holding
START_WATCH_PARTY. `gh variable delete VITE_WATCH_PARTY_CHANNELS` plus another
web deploy is the way back off; it needs no code change either way. The same
applies to `VITE_WATCH_PARTY_SCHEDULE` (the sidebar's next-session hint) and
`VITE_LIVE_REACTIONS`. Staging sets all three to `true` by default
(`deploy-staging.yml`), which is why a thing can look shipped there and be
invisible in production.

## Native apps

Both decode `type` as a plain string, so the new type never fails a parse.
This PR widened `isVoice` on both (`ios/pqp/Sources/Core/Models.swift`,
`android/.../core/Models.kt`) so a watch party lists as a voice room and joins
as audience; the server refuses their share claim like any other. Still to do
later, per app:

- iOS: the AUDIENCE half now exists (`ios/Voice/WatchStageView.swift`,
  `WatchModel.swift`, `WatchPlayer.swift`, `LiveStream.swift`). It decodes
  `voice-stream` and `channel-live`, subscribes with `watch-live` without
  taking a seat, seeds from `GET /api/channels/:id/live`, and plays the
  stamped playlist with `AVPlayer` above the channel's transcript, with the
  `AO VIVO` pill and the combined headcount.

  Three things about that player are worth knowing before changing it. The
  stamped `hlsUrl` is a different string every keyframe, so re-attaching on a
  changed URL means a re-buffer every 30 seconds for the whole film;
  `WatchStreamSwap` swaps on `startedAt`, on a failure and on the token clock
  only. `HLS_VIEWER_TOKEN_TTL_MS` is an hour and a film is longer, so the
  renewal at 50 minutes is load bearing rather than defensive. And a seat
  suppresses the player outright, because a seated viewer already has the
  presenter's screen as a WebRTC track with its own audio.

  Still to do on iOS: the party OBJECT (`watch-party-update`, the host,
  cohosts, the stage, raise hand), the presenter side, a distinct icon in the
  channel list, hiding the share control unless `welcome.canStream`, and the
  create sheet offering the type.
- Android: a distinct icon and the create sheet are still missing, and the
  share control is still hidden on a LiveKit room, which is every watch party.
  `WireProtocolTest` mirrors the shared enum and was updated here.

**Android watches the stream too**, and landed on the same rules as iOS without
either side reading the other. `voice-stream` and `channel-live` are handled
(`gg.pqp.app.watch`), the audience is seatless in the same way the web is
(`watch-live` and nothing else: no `join-voice-room`, no SFU token, no
microphone), and the playlist plays through Media3 above the transcript. The
channel row grows an `AO VIVO` pill.

The convergence is worth recording because it is the part that is easy to get
wrong twice: `watchSourceChanged` swaps on `startedAt` for exactly the reason
`WatchStreamSwap` does, and a seat is what suppresses the announcement rather
than the player. What Android does not have is the party *itself*:
`watch-party` and `watch-party-update` are still ignored, so the phone draws a
stream rather than a named event with a host and a state machine. See
`docs/ANDROID.md`, section "Watch party, the HLS path", for what is and is not
verified.
