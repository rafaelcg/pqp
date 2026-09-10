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
player disappearing when that viewer takes a seat, the three states a real
event produces, and the whole takeover: the host promoting a co-host, that
promotion reaching a second real account's running client on the socket, the
host's browser genuinely closing, and the co-host pressing Assumir. It runs with the flag genuinely on (`?watchParty=1`) and
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

**This clock is not the stream, and the difference is the most important
sentence in this document.** See the next section, which answers it in full.

**The end this sweep produces puts the channel back.** For a while it did not:
every other end path goes through the state route, which calls
`applyWatchPartyOptions`, while `sweepWatchPartyHosts` only flipped the row. So
a party ended by a host's wifi dying left the channel with the slow mode the
party had set and left @everyone denied SPEAK, for good, and nothing said so.
It is the same restore, it is idempotent, it is best effort (a failure logs
`voice.watchPartyRestoreFailed` and the sweep carries on to the next party),
and it is pinned by "puts the channel back when the host's grace window ends
the party" in `watch-party-options.test.ts`.

### Does the stream survive the host dropping? No, and a button cannot fix it

Read this before promising anybody that a co-host is a safety net.

**The egress follows whoever is SHARING, not whoever is host.** `pickHlsSharer`
is `peers.find((peer) => peer.sharingScreen && peer.canStream)` and there is
not one reference to a host anywhere in `hls-egress.ts`. So:

| who drops | who was presenting | what the audience sees |
|---|---|---|
| the host | the host | **the picture stops**, in the same tick |
| the host | a co-host | nothing changes. The show carries on |
| the presenting co-host | that co-host | the picture stops |

The first row is the one that matters, because it is the ordinary shape of a
watch party: one person runs it and that same person shares their screen.

**And it is immediate, not five minutes.** The client sends `leave-voice-room`
plus a `POST /api/voice/leave` beacon on `pagehide`, so a closed tab removes
the peer at once, `pushLiveHls` finds no sharer, and `reconcileLiveHls(..., null)`
calls `stopEgress`. The 90 second orphan window only applies when `pagehide`
never fired at all (a crash, an OS kill, a lid closing on a dead network); in
that case the egress does keep running and the audience does keep watching,
until the orphan timer removes the peer. Neither number is the five minute
grace clock, which never touches the egress and is only ever about who is in
charge.

**So what a co-host actually buys.** Not the picture. What survives a host
dropping is the party OBJECT: it stays live, the audience is not cut off, the
room keeps its chat, and somebody other than the person whose laptop died can
end it, change the options, or take it over. Putting a picture back is a
second, deliberate act by the co-host: they share their own screen, which
starts a new egress with a new playlist URL, and every viewer reloads onto it.

**The thing to know before an event**: a co-host who does not hold
START_WATCH_PARTY on the channel can take the party over and **cannot** put a
picture back, because `canStartWatchPartyStream` gates the share on that bit
and the client hides the share control when `welcome.canStream` is false.
Promoting a co-host grants them SPEAK and deliberately does NOT grant them
START_WATCH_PARTY: handing out a broadcast bit as a side effect of a roster
change is a decision that wants making on purpose, not inside this one. The
practical answer is to appoint somebody who already holds it (an admin, or the
seeded Moderador cargo, which carries it). The co-host panel says so in the
copy. **If the real requirement is "any co-host can rescue the picture", that
is a separate change**: either grant the bit alongside SPEAK on the same
channel for the length of the show and revoke it in `restoreChannelAfterParty`,
or hand it out with a per-channel member overwrite before the event.

**The genuinely safe configuration**, and the one to use for an event that
matters: the host and the presenter are **two different people**. Then the host
dropping costs nothing at all, because the row that says "nothing changes" is
the one you are in.

### Appointing a co-host

`POST /api/watch-parties/:id/cohosts` takes `{ userId, cohost }`, host only,
legal in `draft`, `scheduled` and `live`, and refuses the party's own host with
a 409. `true` promotes and `false` demotes; both re-check that the person is a
member of the server and can see the channel, and both broadcast the party.

**It shipped with nothing calling it.** The route, the `channel_session_cohosts`
table and `setWatchPartyCohost` in `client/src/lib/watch-parties-api.ts` all
existed and no client code ever invoked the last one, so the co-host role was
unreachable and the takeover with it: `Assumir` renders for `role === "cohost"`
and there was no way to become one short of a curl. That is the pitfall-9 shape
again, complete on both ends of the wire and absent in the middle, and nothing
catches it: not a type, not the server suite, not a screenshot of a party
running perfectly well.

`components/watch-party/watch-party-cohosts.tsx` is the missing screen. It is
in the Opções drawer while the party runs AND in the setup surface before it
starts, because the moment a host most needs a backup is before their own
connection becomes the single point of failure, and a draft is invisible so its
room is empty by construction.

**The candidates are the server's members, not the room's occupants.** That
reads like the wrong source for a control inside a live party and it is the
deliberate one, for the reason directly above: a picker built from the voice
roster is blank on the setup surface, which is the screen that matters most.
The list already exists in `App.tsx` for the composer's `@` completion, so this
costs no extra request; the server re-checks membership and channel access on
every promotion, so the list is an affordance and never the authority.

**Promoting mid-show grants the microphone, when there is one to grant.** A
closed floor (voice on, and a stage mode other than `everyone`) denies SPEAK to
@everyone and grants it back per member, and `applyGoLiveOptions` does that for
the host and co-hosts at the moment the party goes live. Somebody promoted
after that moment was not in the list when it ran, so before this they arrived
with Encerrar, Assumir, the options panel and no voice: a co-host who could
take a room over and not say a word in it. The grant is now in
`addWatchPartyCohost`, beside the identical one `inviteToWatchPartyStage` has
always done, and a demotion revokes it unless the person is still on the stage
some other way.

**The grant is gated on `floorIsClosed`, not merely on the party being live.**
Live is necessary and it is not sufficient. The grant exists to give back what
closing the floor took away, so on a party that never closed it there is
nothing to give back and the overwrite would be a permission rule written for
no reason: exactly the row shape §"Leftover SPEAK overwrites" is about. A
watch party has no voice by default, which means the ordinary promotion writes
nothing to `channel_overwrites` at all. A co-host still gets into the room,
because that is decided on the party's own row rather than on a bit.

**A draft's co-host gets no overwrite.** A draft's options are a plan, not a
rule, and writing SPEAK bits onto a channel over a show nobody has been told
about leaves permissions behind for a party that may never happen. Going live
picks them up the ordinary way through `stageMemberIds`, so nothing is lost.

**The recording, if there is one, stays with the host who ran the show.** A
takeover does not transfer it. There is no foreign key from `hls_sessions` to
the party on purpose (that file is being changed by other work); the binding
is channel plus the `went_live_at`..`ended_at` window, which is exact because
only one party per channel can be live.

### Nobody watching is ever asked for a microphone

This is the rule, and it is a product decision before it is a technical one.

**And by default there is no microphone anywhere in the room.** `voiceEnabled`
is off unless a host turns it on, so the ordinary watch party is a broadcast:
nobody is asked for a device, nobody is offered a seat, and `join-voice-room`
refuses one to anybody who is not running the party or invited up to speak.
Voice is the exception a host opts into, and the argument for that shape is in
§"A watch party has no voice by default".

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
browser's**, which is what the Voz control below is for: one select whose
first entry is "no voice at all" and whose other three are the stage modes.

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
going live, and again in an "Opções" **dialog** while the party runs; the same
component, because a host who learned it at minute zero should not learn a
second one at minute forty.

**It is a dialog and it used to be a drawer, and that was a real bug rather
than a preference.** The drawer was a `shrink-0` block above the split, so
opening it pushed the split down by its own height. Measured at 1440x900 with a
party live: a 586px drawer took the pane holding the picture from 735px to
149px, a fifth of what it was. Rafael, mid-show: "need to improve this ui.
settings is messy. maybe a popup or pulldown menu?" `Dialog` rather than either
of those because `docs/DESIGN.md` lists Menu and Popover as PLANNED primitives
and says a screen does not hand-roll one; Dialog is the modal this app has, it
is portalled, and the pane behind it does not move a pixel. The trade is that
the picture is dimmed while the dialog is open, which Escape undoes.

**The co-host offer is five rows and a count.** `cohostCandidates` is the
SERVER'S member list, which on the QG is 2078 people, and every one of them was
rendered with an avatar, a name and a Promote button: 104 rows in the DOM on a
106-member sandbox. `max-h-48` bounded what was VISIBLE and not what was BUILT,
which is the wrong half. The filter above it is how a host reaches anybody
else, and the count says how many that is so nothing is silently hidden.

**Frequency is not prominence.** "Voz", which carries who may speak inside it,
and "Chat lento" are levers a host pulls mid-event. "Quem pode ver" and the co-host explainer are read once,
ever, and both used to sit at the same visual weight as the controls. They are
`<details>` disclosures now: one quiet line each, the answer one press away. Every change is applied by the server on the spot
(`reconcileLiveWatchPartyOptions`), so it lands for the people already
watching.

| Option | Default | What the server does |
|---|---|---|
| **Voz** (`voiceEnabled`) | **off** | nothing to the channel at all, and `join-voice-room` refuses a seat to anybody who is not running the party or invited up |
| **Quem pode falar** (`stageMode`) | `hosts_only`, and it applies only once voice is on | closes the floor: denies SPEAK to @everyone, and grants it back to the host and co-hosts |
| **Pedir pra falar** (`raiseHand`) | on, and shown only for `invited` with voice on | nothing by itself; it is what makes the queue exist |
| **Chat lento** (`slowModeSeconds`) | 0 | writes `channels.slowmode_seconds`, the channel's own slow mode, and puts the old value back at the end |
| **Reações** (`reactionsEnabled`) | on | carried on the party, read by the client |
| **Quem pode ver** | not a control | the channel's own permissions. A sentence, not a switch |
| **Qualidade** | not here yet | the HLS ladder branch owns it and adds one key when it lands |

The first two rows are one control on screen, and the next section says why.
`hosts_only` is the default stage mode because of the failure mode rather than
a preference: a party of two hundred people with open microphones is not a
watch party, and the 2026-09-05 spike showed how fast a room here gets to two
hundred. `invited` is the same closed floor plus a door, one person at a time.
`everyone` is the old behaviour, kept because six friends watching a film
genuinely want it, and warned about in the copy once the room is busy. None of
the three is a rule until a host turns voice on: on a voice-off party a stored
`stageMode` is a preference nobody has activated, and it never reaches
`channel_overwrites`.

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

### A watch party has no voice by default

`voiceEnabled` is a new option and it is **false** unless a host says
otherwise. That is a product decision, and it is also the fix for a class of
bug rather than an instance of one.

**The failure mode that decided it.** "Who can talk" was implemented by
writing an @everyone SPEAK deny onto the channel. A party that ends through a
path which does not clean up leaves that rule sitting on the room, and the
room outlives the party by definition. One such leftover was found on
production on 2026-09-09: it would have silenced Saturday's entire audience
even with the floor set to open, and it had to be deleted by hand. The section
below on leftover overwrites is the archaeology of the same class. **A rule
that is never written cannot leak**, so the default path now writes nothing:
this is prevention, not tidier cleanup, and the difference is the whole point.

**One question guards every write.** `watchPartyFloorIsClosed(options)` is
`voiceEnabled && stageModeClosesTheFloor(stageMode)`, it lives in
`packages/shared/src/watch-party-session.ts` so both sides ask the same
function, and in `services/watch-parties.ts` it is the condition on all three
places that write a SPEAK bit: the go-live deny and its member grants, the
co-host promotion grant, and the stage invitation grant. The room's VIEW_CHANNEL
allow is a different write for a different reason and is untouched. With
voice off, going live takes the other branch and runs `openTheFloor`, whose
two helpers read before they write and return early on a channel that has no
overwrite row: two reads per stage member and zero `upsertChannelOverwrite`
calls. A party that never wrote a bit has none to leave behind.

**Voice absence is enforced at the door, on the party's own row.**
`mayTakeWatchPartySeat` is the model and `join-voice-room` in
`server/src/ws/voice.ts` is the chokepoint, marked THE SEAT GATE. The client
stopped offering a viewer any way in (§"A viewer cannot join a watch party"),
but a removed button is a convention and not a model, and the join frame is
the only way into a room. Who is always let in, and why each:

- **anyone holding START_WATCH_PARTY on the channel.** They run parties here
  and have to be able to get into the room to present. This covers the host on
  every path, and it costs nothing: `canStream` in a watch party IS that bit
  (`canStartWatchPartyStream`), already resolved at the join, so the gate skips
  the snapshot entirely for them;
- **the host and the co-hosts by name**, because a co-host is any member the
  host promoted and need not hold the bit;
- **anyone invited up to the stage**, for whom the invitation is precisely the
  permission to talk and is useless without a way in.

Everybody else is refused while a party with voice off is active.

**A channel with no active party is not a closed room.** It joins like the
ordinary voice room it is, which is exactly what `VITE_WATCH_PARTY_CHANNELS`
off already promises a build that draws no party chrome at all. Refusing there
would break a deployment that has the channel type and not the feature.

**Not a CONNECT deny on @everyone**, which is the obvious implementation and
the wrong one: it is the same mechanism as the SPEAK deny whose leftovers
caused this change, a rule written onto a channel that can outlive the party
that wrote it. A decision taken at the door, on the party's row, disappears
when the party does, by construction.

**The gate fails open.** A database hiccup must not lock a host out of their
own show minutes before it starts. The worst an allowed join costs is one
seat; the worst a wrongly refused one costs is the party. A refusal is
`voice.watchPartySeatRefused` in the log.

**The audience does not pay per join.** Presenters (`START_WATCH_PARTY`)
still skip the snapshot entirely. Everybody else reads a per-channel
snapshot (whether voice is on, the host, the co-hosts, the stage invites)
that `loadWatchPartySeat` caches in front of the database, so a 500-person
film night is one query rather than 500. Per-user fields are derived from
those id lists. `broadcastWatchParty` drops the snapshot on every mutation
(Voz on or off, a co-host, a stage invite) so a stale "voice off" cannot
lock a host's friends out after they turned it on, and a stale "voice on"
cannot seat the audience after they turned it off.

**What it does to Android, which is the client this touches hardest.**
`Models.kt` has `isVoice = type == "voice" || type == "watch_party"`, so
Android treats a party room as an ordinary voice channel and offers a join;
it has no watch surface, so what it could ever get there was audio from
whoever was on a microphone. From now on that join is refused in a voiceless
party. The server answers with `voice-join-refused` for a cold join as well
as a resume, so the app leaves "connecting" instead of sitting there. Other
refusals on the same path (a timeout, a block, a CONNECT deny) are still
silent for a cold join; Android's `JoinWatchdog` is the backstop for those.
iOS copy for this frame still talks about rejoining, which is why the
blanket send stays off those other gates.

**Legacy rows read as ON.** A party stored before this option existed has no
`voiceEnabled` key, and it was set up when every watch party was a voice room.
`withLegacyWatchPartyVoice` restores that reading **before** the zod schema
applies its `false` default, so `parseOptions` cannot silently take voice away
from a party that is already running across the deploy. Presence of the key is
the entire test: `createWatchParty` writes the full option set, so every row
written since carries it, including an explicit `false`.

**One control, not two.** The options panel offers a single "Voz" select with
four entries: off, and the three stage modes. It writes `voiceEnabled` and
`stageMode` in one patch. Two products share this feature and the select is
shaped for both: six friends watching a film reach "Todo mundo" in one click,
the same cost as today, and five hundred people watching a presentation pay
zero clicks for the thing they want. Two separate controls would have made the
film night cost two, and would have left a stored `stageMode` sitting on a
voice-off party looking like a rule when it is a preference. Turning voice off
leaves `stageMode` alone, so turning it back on gives the host the floor they
had chosen. `raiseHand` and the stage queue are hidden while voice is off,
because they mean nothing there.

**The affordance asks about voice first, and the order is load bearing.**
`watchPartySpeakAffordance` returns `none` for a viewer whenever voice is off,
ahead of the `canSpeak` test. With no overwrite written, `canSpeak` is usually
the everyday default `true`, so asking it first would put a Falar button on
every viewer's screen in exactly the parties that are meant to have none.

**Two known edges, stated rather than hidden.**

A host who turns voice OFF mid-show does not evict the people already seated.
New joins are refused; existing seats stay until their owners leave. Those
seats are already paid for on the media box, and yanking somebody out of a
room they are speaking in is a louder act than a settings change implies.

**And a voiceless party does not grant its host SPEAK, so a channel that
already denies it silences them.** Before this, the default party closed the
floor and granted the host back, which had the side effect of routing around
any pre-existing @everyone SPEAK deny on the channel: a stale one, or a
deliberate one. A voiceless party writes nothing, so it routes around nothing,
and on such a channel the host has a seat and no microphone while
`watchPartySpeakAffordance` still offers them Falar (it offers the people
running the show the button on purpose, because the server is the authority
and a grant can be a version behind). This is not a new way to get a stale
deny, it is the last thing that was papering over one, and the answer is the
cleanup query in §"Leftover SPEAK overwrites" rather than a grant on the
default path. **Run that query against any channel a big party is about to
use.** A stale deny is invisible until a room is full, which is the whole
reason this section exists.

### What going live does to the channel, and what ending puts back

The setup surface asks the host to decide the things that matter before an
audience arrives. Two of them are real channel state, and both are
**restored** when the party ends, never reset:

| Option | What Ir ao vivo does | What Encerrar does |
|---|---|---|
| `slowModeSeconds` | writes `channels.slowmode_seconds`, recording the old value in `restore_slowmode_seconds` (only the FIRST change records it, so a host who moves 30s to 60s mid-show still gets the channel's original value back) | writes the old value back |
| voice off (`voiceEnabled` false, **the default**) | **nothing to the channel's permissions**. `applyGoLiveOptions` takes the `openTheFloor` branch, which reads before it writes and returns early on a channel with no overwrite row: zero `upsertChannelOverwrite` calls | nothing to undo, because nothing was borrowed |
| a closed `stageMode`, voice on | denies SPEAK to @everyone with an ordinary channel overwrite, records `stage_speak_applied`, and grants a member SPEAK allow to the host, the co-hosts and anyone invited up | removes those bits, and deletes an overwrite row only when the party is the sole reason it existed |
| `reactionsEnabled` | carried on the party, read by the client | nothing to undo |

A channel that already had slow mode on keeps it. A channel where @everyone
was already denied SPEAK is left alone, and ending the party does not hand the
room a microphone it never had.

The first row is the one almost every party takes, and it is what makes the
restore path matter less than it used to: the only rows that need putting back
are the ones a host deliberately asked for by turning voice on.

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
3. **Ir ao vivo**, one button in a bar that says, in the warning tone, that
   nothing is going out yet ("Ainda não tá no ar"), and three things in this
   order: the party's
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

Watching is not a call for viewers. Select the channel and the HLS plays; the
host's LiveKit publish is an invisible pipe while the show is live. Encerrar
leaves that pipe so leave-voice chrome does not linger. Friends who want to
talk use a normal voice channel.

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

**`strongestStageShape` was necessary and it was not sufficient.** It settles
which SHAPE the pane is in when three stages claim it; it says nothing about
who owns the stage's HEIGHT. `CallSplit` reports that up as
`CallSplitState.active`, and `App.tsx` passed it to `WatchChannelStage` and to
`VoiceChannelStage` and not to `WatchPartyPanel`. Both of those draw
`fill ? "h-full min-h-0" : "h-[68svh] min-h-[280px]"`; the party's four
pane-filling surfaces (the empty stage, the setup preview, the scheduled card,
the live waiting placeholder) were `h-[68svh] shrink-0` with no way to be told
otherwise.

With both panes drawn nobody notices: 68% of the window is close enough to the
pane that it reads as deliberate. **Put the chat away and the two numbers
separate.** Measured at 1440x900 on 12 Sep 2026: the pane handed the stage slot
803px of an 819px pane, the setup surface kept insisting on 612, and the host
got their preview, the Ir ao vivo bar stranded in mid-screen, and a 191px band
of empty pane under it with the restore strip at the bottom. Rafael, hosting on
production: "hid the chat and got this bugged UI". The collapse persists, so it
is also the state the app LOADS INTO on the next reload.

Two things fix it and the second is the durable one. The surfaces take `fill`
like their two siblings, so the disagreement is gone. And the stage pane now
clips whenever the pane owns the size (`fills && "overflow-hidden"`, where it
used to be `sized &&`): `sized` requires `collapsed === "none"`, so the ONE
state in which the stage is handed the whole pane was also the one state with
no guard on it, and a child that got its height wrong ran out of the bottom and
painted over the restore strip. The pane is the thing that measured itself, so
the pane holds the line.

Pinned in `client/e2e/watch-party.spec.ts` ("the setup surface fills the pane
when the chat is put away, and after a reload"), which asserts BOTH directions
against the pane and repeats every assertion after an F5. The direction matters:
the existing collapse test in `call-split-layout.spec.ts` asserted
`paneHeight - stageHeight <= 24`, which a surface OVERFLOWING its pane passes
with a negative number.

**The collapse control is furniture now.** "btw the hide chat button is so
small", from the same session. It was `opacity-0` until the pointer reached the
boundary and 32x8 CSS pixels once it got there, which is a control you have to
already know about to find, and on a touch screen there is no hover at all. It
is painted at rest, 48px along the boundary, filled rather than transparent,
with a hit area 8px into each neighbour. The 8px cross axis does not move:
that is `CALL_SPLIT_DIVIDER_PX`, and every clamp in `lib/call-split.ts` is
computed against it.

Side by side also exposed a layout bug worth recording, because it is the
narrow-column version of the one the sidebar block had. The live bar put the
party's identity, the viewer count and three buttons on one row; at 62% of a
laptop pane that clipped **Encerrar** against the divider, which is the one
control a host must always reach. The bar wraps now, the count moved into the
identity line where it is information rather than an action, and the identity
carries a real minimum width so the actions wrap to their own row instead of
the party's name truncating away to nothing.

### Knowing you are not live yet

On 12 Sep 2026 a host on production told a room he was live while the server
reported `sharingScreen: 0` and no transcode running. He had created the party,
picked a window and was looking at his own capture. Everything on that screen
was working exactly as designed, and he was wrong about the one fact that
matters. On the Saturday this exists for, that is the difference between an
audience watching and an audience staring at nothing while the host believes it
is working.

The only thing that had said otherwise was `watchParty.setup.heading`, rendered
as 10px uppercase grey in the corner of the preview. That is the visual
language of a watermark, and a watermark is read as decoration.

Three changes, and the third is the one that generalises:

1. **The badge on the preview is a status light.** A pill with a dot, in the
   warning tone, at a size that is read rather than skimmed. Deliberately the
   same shape as `LivePill`, which it is the opposite of.
2. **The bar under the setup surface is a state, not a footer.** It leads with
   "Ainda não tá no ar" in the warning tone and the button that changes that is
   at the end of the same sentence, so reading the state puts the remedy under
   the pointer. It disappears the moment it stops being true, which is what
   makes it a state rather than a decoration.
3. **That bar cannot be pushed out of view.** It is `shrink-0` under a row that
   is `min-h-0 flex-1`, inside a surface that now takes its height from the
   pane. The settings column and the co-host list scroll inside the row above;
   the bar never moves. Before this, the host's own screenshot showed Ir ao
   vivo only after scrolling, under a co-host list long enough to push it away,
   and the co-host list was the whole membership (see §The options).

The rule behind all three: **a control that decides whether an event happens
does not live at the bottom of a scrolling column, and the state it changes is
worth a sentence rather than a badge.**

### The room has to be visible, or the whole audience is locked out

The worst defect this feature has had, found on production web on 12 Sep 2026
and reproduced in a browser the same day.

`findOrCreateWatchPartyRoom` creates the room with `createChannel` and no
overwrites, so its visibility falls through to whatever @everyone carries at
the SERVER level. A community that does not put VIEW_CHANNEL on @everyone and
hands it back per channel instead is an ordinary Discord-shaped setup, and a
likely one for a server with two thousand members. On such a server the room
is created invisible to everybody except the staff.

What that looks like, measured against a server configured exactly that way:

| | before | after |
|---|---|---|
| the room in a member's `GET /channels` | absent | present |
| `GET /api/servers/:id/watch-parties` for them | `[]` | the party |
| the sidebar block | never appears | appears |
| a deep link to the room | **redirects to #general** | opens the party |

So the entire audience is locked out, silently, while the host sees a
perfectly normal live party from the inside. It is the shape this repo keeps
hitting (pitfalls 9, 12, 13): working and silently not working look identical,
and the difference only shows up on the day of the show, from the outside.

**The intent was always that the room is ordinary.** The options panel says so
to the host in as many words: who can watch is "everyone who can already see
the channel. To make it private, make the channel private." A room nobody can
see is not that sentence being honoured; it is that sentence being false, on a
channel that is never listed and therefore has no settings entry point to fix
it from.

So the room is created with an explicit @everyone **allow** of VIEW_CHANNEL.
Two things about that are deliberate:

- **Only on create.** `findOrCreateWatchPartyRoom` ADOPTS an existing
  `watch_party` channel, and a server that deliberately made theirs private
  meant it. A party starting in it is not a reason for this function to
  overrule a policy decision that is not its own.
- **An allow, not a base permission.** `channel_viewable` applies the
  @everyone overwrite first and per-role and per-member overwrites after it, so
  a role that denies VIEW on this channel still wins. What this removes is the
  accidental case only: a room nobody was ever denied and nobody can see.

It goes through `upsertChannelOverwrite`, which also bumps
`permissions_version` and invalidates the server's audience cache. Without
that bump every already-connected seat keeps its resolved permissions and the
room stays invisible to everybody currently online, which on the night of a
show is indistinguishable from the fix not existing.

Pinned by "makes the room visible to a plain member on a server whose
@everyone cannot see channels by default" and "does not re-open a watch party
room somebody deliberately made private" in
`server/src/services/watch-parties.test.ts`.

**Two things this does NOT cover, stated rather than hidden.**

The QG is not affected: its @everyone does carry VIEW_CHANNEL, checked
read-only against production. So this is a real defect for other servers and
it is NOT the cause of the production report that led to finding it. What
that report was is still open.

And on such a server a non-owner holding START_WATCH_PARTY is refused 403 when
creating a party, because the bit still resolves through a channel they can no
longer see. That is arguable rather than obviously wrong (you cannot act in a
room you cannot enter) and it is a separate question from the audience one.

### Arriving by link is its own code path, and it had no test

Every client assertion in this feature used to reach the party by clicking the
sidebar block. That is ONE path, `handleWatchLiveParty`, which refetches the
channel list when it does not recognise the id, and it papers over the other
one: `applyChannelRoute` looks the id up in `GET /channels`, and when it is not
there it sets "That channel no longer exists or is private" and lands the
person on the first text channel. On a link-driven Saturday that is the whole
event, and it is exactly what the report above described.

`client/e2e/watch-party.spec.ts` now covers both arrivals a real audience
uses, neither of which clicks anything: straight at the room's URL, and a
reload while on it. Both assert the URL did not change, that the party is on
screen rather than the "Pick a channel" empty state, and that the sidebar
block survived. Broken on purpose by making `applyChannelRoute` skip a
`watch_party` channel; both failed.

### A viewer cannot join a watch party

Rafael, shown a version of this that had cut three join controls down to one
quiet one and labelled its consequence: *"NO. A VIEWER CANT JOIN A WATCH PARTY
BRO"*. He is right, and the earlier fix was still the wrong shape.

**Not disabled, not quiet, not explained. Absent.** Demoting a control and
writing an honest label for it ("Entrar só ouvindo") is a way of keeping
something that should not be on the screen: it still says joining is a thing
an audience does, and it still costs every reader the moment it takes to
decide against it. A watch party has an audience and it has the people running
it. The audience watches. That is the whole interaction and it needs no
control.

The seatless path exists exactly so it needs none. Watching is a socket. A
seat is a LiveKit participant and forwarded streams, against a measured
envelope of about 600 interactive users versus an effectively unbounded HLS
audience. Before this, a viewer with a picture playing was offered that seat
**three times on one screen** (the channel header, the party bar and the watch
stage, two of them in the primary fill) by three components that did not know
about each other, each correct on its own.

**Who still gets it, and why each one:**

| | offered a seat | why |
|---|---|---|
| host, co-host | yes | they run the show and have to be able to get back into their own room after a reload or a dropped call |
| START_WATCH_PARTY on the channel | yes | they run parties here, so the room is theirs to get into whether or not this one is theirs |
| invited up to speak | yes | being invited up is precisely the permission to talk, and it is useless without a way in |
| manager | **no** | MANAGE_CHANNELS ends and edits somebody else's party. It does not perform in it |
| everybody else, voice off | **no** | they watch |
| everybody else, **voice on** | yes | the host asked for a room that talks, and a setting that opens voice and offers nobody a way in is a setting that does nothing |

The last row is the one a blanket removal got wrong, and it is why the rule
lives in `mayTakeWatchPartySeat` rather than in the component. "A viewer
cannot join a watch party" was said about a broadcast with three green buttons
on it, and it is right about a broadcast. It is wrong about six friends
watching a film whose host has deliberately turned Voz on: that party's
audience IS the call.

`stage.invited` is public on the wire and always has been (`presentStage`: who
is UP is public, who is ASKING is not), so this is the party's own answer
rather than the client guessing. `WatchPartyPanel` takes a `currentUserId` so
an invited guest can recognise themselves in it.

**And the same function draws the control and refuses the join**, because a
removed button is a convention and not a model, and two copies of one rule is
how a button that does nothing gets shipped. `join-voice-room` asks
`mayTakeWatchPartySeat` and refuses everybody this table refuses,
plus nobody it does not: START_WATCH_PARTY, the host, the co-hosts and the
invited get in, the manager and the audience do not. It is decided on the
party's own row rather than with a permission bit, for the reason in §"A watch
party has no voice by default". A party whose host turned voice ON is an
ordinary voice room again and the gate steps out of the way.

**The listen-only warning went with the control**, and so did
`watchPartyJoinIsListenOnly` in `packages/shared` and its tests. Everybody who
can still see the button can speak once they are in, so a warning about a seat
that cannot would now be false. Work deleted rather than kept.

**And the copy that described the absence.** The stage bar was headed
"Assistindo sem entrar na call". Rafael: *"'Watching without joining the call'
how's that even a thing in watch party lol."* It described the implementation,
which is a voice room with an HLS audience attached, and framed the thing
everybody came for as an abstention from a thing that is no longer even on
offer. Nothing replaced it: a playing film is unusually good evidence that
somebody is watching a film. The row keeps the two facts that are not
derivable from looking, how many people are here and how far behind live they
are, and a quiet "Parar de assistir" that is honest that stopping means
leaving the room.

**What a plain viewer's party bar holds now**, measured: the party's name, the
live pill, the host, the audience count, and zero buttons. That is a title
bar, not an empty container, and it is the only place on screen that names the
party (the channel header says `watch-party`). The count stays because when
the picture has not started there is no stage bar under it, so it is not
always a duplicate.

**The assertion that keeps it that way is a zero.** "One" was satisfiable by
any of the three surfaces surviving; zero cannot be satisfied by accident. "a
plain viewer is offered no way into the call, anywhere" counts every visible
control on the whole document, names each of the three surfaces individually
so a regression says which one came back, and checks the party surfaces that
SHOULD be there so a zero is never "nothing rendered".

### Fullscreen, and why it takes the pane

A watch party is a film, and people watch films fullscreen for two hours. The
player had a fit toggle, a quality menu, a volume slider and
Picture-in-Picture, and no fullscreen control at all. Rafael: *"i dont think i
can make it full screen as a viewer"*.

**The obvious fix is the wrong one.** `video.requestFullscreen()` renders only
that element's subtree, so a fullscreen `<video>` is a film with no chat, no
reactions and no way to reach either. In a watch party what would be left
behind is the room talking about the film.

So `components/voice/watch-fullscreen.ts` takes the **split pane**
(`[data-call-split]`), which already holds the stage, the divider and the
transcript in whatever arrangement this person chose. Fullscreen then means
"the film and my chat take the screen": `68svh` is a fraction of the VIEWPORT
and in element fullscreen the viewport is the screen, so the same rule that
gives the film two thirds of a window gives it two thirds of a screen. The
divider still drags inside it, and somebody who wants nothing but the film
puts the chat away and gets exactly that. One layout, two sizes of viewport,
nothing new to learn.

The refusal path is the one `element-fullscreen.ts` was written for: an
Electron shell can answer neither way and leave the promise pending, so a
`false` still owes the person a filled viewport. The fallback is an in-page
`expand`, a `data-watch-expanded` attribute on the pane and one rule in
`index.css`, with Escape wired up by hand because in that mode the browser is
not the one holding it.

**One honest gap.** The party's chrome (the bar with Encerrar, the options, the
join) is drawn ABOVE the split, so it is not inside the fullscreen element and
is not visible while fullscreen. Escape or the same control brings it back.
That is the correct trade for a viewer and worth revisiting for a host who
wants to end a party without leaving fullscreen.

### A preview on the sidebar block: asked for, costed, not built

Rafael's idea, and worth writing down with numbers rather than a yes or a no:
*"maybe we can add a low quality preview on hover or something"*, on the block
at the top of the sidebar, so somebody can glance at what is playing before
committing to opening it.

It is a genuinely nice idea and the obvious implementation is expensive in
exactly the wrong direction.

**What a live preview would cost.** A hover would have to start an hls.js
session: a playlist plus at least one segment. The playlist is not a static
file here, it is `hls-playlist-proxy.ts`, which re-signs every segment line
into a presigned URL **on every request**, so a hover is API processor time
and a signing round trip, not only bucket egress. A 720p segment is roughly
0.9 MB. The block is rendered for every member of the server who has the app
open while a party is live, which for the QG is thousands of people, and the
cost lands on the one resource the seatless path exists to protect. The
arithmetic is the wrong shape: **cost proportional to curiosity, paid by
people who are not watching**, at the moment an event is starting and the
audience is at its most restless.

**The cheaper approximation, if this is ever wanted.** A poster still, written
by the egress on a slow timer (LiveKit can emit an image output beside the
segments), a few KB, cacheable, and refreshed every fifteen or thirty seconds.
That is cost proportional to the number of LIVE PARTIES rather than to the
number of hovers, which is the only shape that survives a full room. It needs
an image output on the egress, somewhere in `hls_sessions` to hang the key,
and a cache header, so it is real work and it is not blocked on anything.

**Not before an event.** It touches the egress and the bucket, which is the
path the show itself runs on, and the block already carries the party's name,
the host's face and a live pill. The gap it closes is small and the thing it
risks is the broadcast.

### The control bar that reportedly never fades: not reproduced

Rafael, from a live party: *"also this is always there... doesnt disappear"*,
about the call's control cluster over the picture.

`hooks/use-idle-chrome.ts` already implements exactly this: three seconds of
stillness fades the bar, any pointer move, key or focus brings it back, a tap
toggles it on touch, reduced motion switches the fade for an instant toggle,
and a hidden bar swallows the first press rather than taking
`pointer-events: none`, so it can never be pressed by accident and can always
be woken.

**It could not be reproduced locally**, in either role: in a mesh watch party
on 12 Sep 2026 the chrome went to `opacity: 0` after about five seconds of
stillness both for the presenting host and for a viewer who had taken a seat,
and `dm-call-screen-share.spec.ts` covers the same behaviour in CI. Two
explanations survive, and neither is guessable from here:

- **The pointer was resting on the bar.** `barHovered` is in the `pinned` set
  by design, and a pointer parked at the bottom of the screen is an ordinary
  film-watching posture.
- **`hasVideo` was false.** The fade is enabled by `anyVideo && !collapsed`,
  and `hasVideo` counts local camera, remote cameras and
  `screenSharePeerIds`. A room state where that is empty while a picture is on
  screen would pin the bar open over it.

Worth reading the second one against a real LiveKit room before changing
anything, because a fade that is loosened on a guess is a hang-up button that
disappears while somebody needs it.

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
  policy; this rides on it rather than growing a second one. It only ever runs
  for a party whose host turned voice on, which is what keeps that mechanism
  off the ordinary broadcast.
- **Voice absence is NOT enforced with a permission bit.** The parallel move
  would be a CONNECT deny on @everyone, and it is the same mechanism as the
  SPEAK deny whose leftovers caused the change. The seat is decided at the
  door on the party's own row instead, so it goes when the party goes.
- **Turning voice off mid-show does not evict the seated.** New joins are
  refused and existing seats stay. Deliberate, argued above.
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
channel: same columns, same overwrites, same voice room on `/ws`, and the
same transport decision, with ONE exception. `resolveVoiceTransport` decides
on `kind` for every rule but live HLS, where it reads `type`: a Track
Composite egress needs the SFU and only a `watch_party` channel can host one,
so only that type is promoted for it (`liveHlsForcesSfu` in
`server/src/voice/transport-policy.ts`). `createChannelSchema` accepts the
type, and gained an optional `topic` (max 200) so the create dialog can take
a short description.

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

**Two gates on the egress start.** `pushLiveHls` picks the sharer through
`pickHlsSharer`, which asks for `watchParty && sharingScreen && canStream`.

- **The stage gate**, `canStream`. In a watch party that is
  START_WATCH_PARTY (`canStartWatchPartyStream`), so the transcode reads the
  same bit `set-sharing-screen` refuses on.
- **The room gate**, `watchParty`: the seat is in a channel of type
  `watch_party`, resolved from the row at join beside `canStream`. A screen
  share in an ordinary voice channel that happens to be on the SFU (a
  ten-member server, a listed community, an override) starts no transcode.
  Before this gate, any share in any LiveKit room did, which is half of why
  `LIVE_HLS_ENABLED` used to be dangerous to set instance-wide.

It also hands `reconcileLiveHls` the channel's server id (from the audience
cache, no extra query) for the `LIVE_HLS_SERVER_ALLOWLIST` refusal.

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

## What the stream carries, and what it does not

**The two audiences are not watching the same event, and the host cannot tell.**
This is the most surprising thing in the feature and the easiest to be wrong
about, so it is written out rather than left to be inferred from
`hls-egress.ts`.

| | seated in the room | watching the HLS |
|---|---|---|
| the presenter's screen | yes | yes |
| the screen's own audio | yes | **only if the capture had it** |
| every microphone, host included | yes | **no** |
| every camera | yes | **no** |
| delay | sub-second | about ten seconds |

The transcode is a **Track Composite** egress, and
`TrackCompositeEgressRequest` carries one video track sid and one audio track
sid, singular. So `pickScreenTracks` is not filtering a mix, it is making the
entire editorial decision: the screen share, and that same participant's
`SCREEN_SHARE_AUDIO`. Nothing else exists as far as the seatless audience is
concerned.

**A share picked without its own audio is a silent film for everybody outside
the room.** Chrome on macOS cannot capture system audio for a whole screen or a
window at all; only a tab share can, and only with the audio box ticked. The
host hears the film out of their own speakers either way, and the room they are
talking to hears them perfectly over WebRTC, so nothing they can see contains
the fact. On 2026-09-09 Rafael went live with his webcam on and reasonably
assumed it was going out.

**Which is why the server states it.** `LiveHlsStream.hasAudio` is set when the
egress starts, `voice.hlsStarted` carries `audio: "screen" | "none"`, and
`liveHls.silentSessions` on `GET /api/admin/metrics` is the number during a
party rather than a `grep` after one. The host's transmission panel shows it
collapsed as well as expanded, says what to do (share a tab and tick its audio
box), and states what the stream carries and what it does not whether or not
anything is wrong. Adding the audio needs a **new share**: the audio half is
published from the same `getDisplayMedia` capture, so it cannot be added to one
already running, and re-picking changes the screen track sid, which is a
restart the reconcile already handles.

**A silent stream is the host's capture, not a race.** The obvious alternative
explanation is that the egress looks for tracks before the audio half is
published, since `findScreenTracks` returns as soon as it sees the video. It
does not happen: `use-voice.ts` awaits `sfu.publishScreen(stream)`, which
publishes the video and then the audio, and only then sends
`set-sharing-screen`, which is the frame that starts the transcode. The comment
above that call says as much, for a different reason. So `hasAudio: false` means
the capture had no audio, every time.

`hasAudio` is absent, not false, on a session this process **adopted** across a
deploy: the `hls_sessions` row carries the video track sid and not the audio
one. The panel says "not stated" there and warns about nothing, because a false
"your film is silent" during a film that is playing fine teaches a host to
ignore the warning that matters.

**The ten seconds are a broadcast delay and they interact badly with a host who
is also in a live call.** Someone in the room asks a question and the host
answers immediately; the stream audience hears the answer ten seconds after the
host gave it and never heard the question. A host reading chat is reading a
room that is ten seconds ahead of the people they are addressing. That is
ordinary for broadcast and it is worth saying out loud, because a watch party
host is doing both at once. The panel says it in one line.

**Getting the host's microphone into the stream is a feature, not a fix**, and
it is costed in [`docs/plans/WATCH_PARTY_STREAM_AUDIO.md`](./plans/WATCH_PARTY_STREAM_AUDIO.md):
the recommendation is a client-side mix into the screen-share audio track, which
costs the media box nothing, and explicitly NOT a Room Composite egress, which
LiveKit's own docs price at 2 to 6 CPUs against the 0.51 to 0.88 core this one
measures.

## When a session restarts, and the leftovers it used to leave behind

A stalling stream and a healthy one look identical from the API. Read this
before diagnosing one.

**Every teardown is narrated now.** `voice.hlsStopped` carries a `reason`:
`no-share`, `screen-track-replaced`, `presenter-changed`, `not-allowlisted`,
`playlist-not-ready`. It did not, and on 2026-09-09 a live party logged two
`voice.hlsStarted` for one channel nine minutes apart, same presenter, with
nothing at all in between. Three of `stopRoom`'s callers logged nothing and the
fourth logged only in a branch a silent one pre-empted, so there was no way to
tell a host re-picking their share from a transcode dying, which want opposite
responses during an event.

The silent one that mattered: `pushLiveHls` resolved the channel's server id
only when it had a sharer and passed `null` otherwise, and `null` means "not a
server channel" to `reconcileLiveHls`. So an ordinary end of share was torn down
by the allowlist branch instead of the no-share branch. It is a map read, so the
saving was imaginary and the ambiguity was not.

**A rung the monitor declares dead may still be running.** `rungHealth` says
"ended" for two different reasons and only one of them means the handler is
over. LiveKit saying so is final. The playlist not moving for
`PLAYLIST_STUCK_MS` is a rule that exists *because* a killed egress node is
reported ACTIVE forever, and its mirror case, a handler still transcoding while
its output stalled, was dropped from `rooms` and never stopped. It then burned a
core until the box was rebuilt, and `scheduleRestart` started a fresh ladder
beside it on the way out. `stillRunning` now tells the halves apart: a stalled
rung is stopped, a cleanly finished one costs no pointless RPC.

**And there is a net under all of it.** On every monitor tick, for each channel
this process holds a session for, `reapForeignEgresses` asks LiveKit for the
ACTIVE egresses in that room and stops any that are not one of our rungs. Within
a room we are already presenting, an egress that is not ours cannot be anything
but ours from before. It is deliberately NOT "stop everything I do not
recognise", which would kill the sessions `adoptLiveHlsSession` exists to
inherit across a deploy; the 15 s health grace covers the boot window in which a
ladder's rungs are still being adopted one at a time, and a listing it could not
fetch is never a reason to act.

**`liveHls.orphansStopped` belongs at zero.** It is the only evidence a leak
ever happened, because the leak itself is silent: the box simply gets slower and
the parties on it start stalling. This matters more than it looks:
`LIVE_HLS_MAX_SESSIONS` counts **sessions**, so a cap of 3 means twelve handlers
if each session can transiently run four.

### Ending the party ends the broadcast, and it did not

**The most expensive of these, and the one with no symptom at all.**
`pickHlsSharer` asks `watchParty && sharingScreen && canStream` and never asked
whether a party is live. A `watch_party` channel is an ordinary voice room
between shows, so a host who pressed Encerrar and left their screen share
running kept a two-rung transcode alive: about 1.4 cores of the media box,
segments written to storage for as long as it ran, and a `channel-live` frame
telling every member of the server there was something to watch. Seen in
production on 2026-09-09: every `channel_sessions` row for the channel `ended`,
the last of them at 13:24, and a transcode still running at 13:56. Three
forgotten shares fill the box, and `LIVE_HLS_MAX_SESSIONS` would read 3.

That the party and the picture are two facts is deliberate and is argued in
`services/watch-parties.ts`. The argument only ever covered one direction: a
live party with no picture, because conflating them gave a party that said LIVE
over a black rectangle. **A picture with no party is the direction nobody
argued for**, and it is the one that costs money.

`ws/watch-party-live.ts` closes it, and the design is one sentence: it records
only what it has positively seen **end**.

- `broadcastWatchParty` is the single thing every state change passes through
  (seven routes plus the no-show sweep), so it sets the mark.
- `pushLiveHls` treats a marked channel as having no sharer, which stops a
  running transcode and refuses to start another.
- Only `live` clears the mark. A draft created after a show is somebody
  thinking, and must not hand back the permission the end took away.
- **It reconciles on the spot.** `pushLiveHls` otherwise runs on roster events,
  and a host who presses Encerrar and touches nothing else is the ordinary
  case, so the mark change itself kicks a reconcile through a listener
  `ws/voice.ts` registers, exactly as the egress health monitor does.

**Fail open, on purpose.** A channel this process has heard nothing about
transcodes as it always did: a process that restarted mid-party, and a party
ended by the sweep on `pqp-worker` (a different process with a different
memory), both behave as before. Refusing to transcode a real party costs an
event; missing a leak costs a core.

**The share itself is untouched.** It is a voice room, people watch each other's
screens in it, and ending a show is not the same act as stopping a share. Only
the broadcast to people without a seat stops, which is what "Encerrar" means.

`voice.hlsPartyOver` in the log is a host who did exactly that.

### Leftover SPEAK overwrites, and whether they need cleaning

Both ways a party can end (`POST /api/watch-parties/:id/state` and
`sweepWatchPartyHosts`) go through `applyWatchPartyOptions`, and it is the only
thing that ever calls `restoreChannelAfterParty`. Since #427 there is no path
that leaks a new one. Audited on 2026-09-09 by walking the callers; there are
two, and both restore.

**The class is now closed for new parties, and that is a stronger statement
than the paragraph above.** Walking the callers proves the two known paths
restore; it cannot prove a third will not appear, and one leftover found on
production on 2026-09-09 (which would have silenced a whole audience the
following Saturday, and was deleted by hand) is what a proof of that shape
buys you. A watch party has no voice by default, so the ordinary party writes
no SPEAK overwrite at all: not cleaned up correctly, never created. Only a
host who turned voice on and picked a closed floor borrows the channel's
permissions, and only that party has anything to give back. Everything below
still applies to rows written before this, which do not self-heal.

**Rows left by parties that ended BEFORE #427 do not self-heal.** The restore
reads `stage_speak_applied` on the session row, and a session already `ended`
with that flag still set is never revisited. `QG do pqp`'s watch-party channel
still carries one: `@everyone` denied SPEAK (bit 13, `8192`) plus a member
allowed the same. Rafael's second account got "Listening only" from exactly
that.

What it actually costs, which is worth knowing before deciding to clean:

- The **deny** used to be largely self-repairing: the channel is unlisted
  between shows, and the next party reconciled it, because `hosts_only` was
  the effective default and wanted that deny anyway. That reading is now
  wrong in both halves. The default party has no voice, so it wants no deny
  and writes none, and `openTheFloor` lifts only a deny **its own session**
  recorded in `stage_speak_applied`, never one inherited from a party that
  ended before it. So a leftover deny is no longer re-created and no longer
  cleared: it just sits there, silencing the channel between shows, until
  somebody removes it.
- The **member allow** is the quieter residue. It is somebody who was once
  invited to the stage keeping a microphone in that channel for good, with
  nothing on any screen saying why. It bites whenever the floor is closed
  again, which now only happens on a party whose host turned voice on.

So: worth cleaning, not urgent, and it is an operator action rather than a
migration, because it must not touch an overwrite somebody set on purpose.
Scope it to `watch_party` channels with no live session, read it before writing
it, and never run it during an event:

```sh
# READ FIRST. Nothing is modified by this.
psql "$DATABASE_URL" -c "
SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny
  FROM channel_overwrites o
  JOIN channels c ON c.id = o.channel_id
 WHERE c.type = 'watch_party'
   AND (o.allow & 8192 <> 0 OR o.deny & 8192 <> 0)
   AND NOT EXISTS (
     SELECT 1 FROM channel_sessions s
      WHERE s.channel_id = c.id AND s.status = 'live')"
```

Clearing just the SPEAK bit (never the whole row, which may carry bits nobody
here set) and deleting a row that is left holding nothing is the second step,
and it is Rafael's call whether to run it at all.

### A finished session went on answering as if it were live

**This is what viewers were actually hitting**, and it is a different bug from
the leftover transcodes above even though the leftover transcode is what feeds
it. Read from the production bucket on 2026-09-09:

```
14:27:50  live/<ch>/1788963814707-1080p30.m3u8   current session
14:27:47  live/<ch>/1788962552321-1080p30.m3u8   SUPERSEDED, still being written
```

The superseded session's last segment was written at 14:23:35, its live
playlist's newest entry was `14:20:22`, and its LastModified was **one second
old**. A LiveKit egress whose input track has gone keeps rewriting its live
playlist and produces no new segments, so the file is a corpse with a moving
mtime.

**And the proxy served it.** `renderSignedPlaylist` asked only
`cleaned_at IS NULL`, which means "the objects have not been deleted yet";
with retention at 180 minutes that is three hours of a finished session
answering as though it were on air. `sessionRungs` had the same clause, so the
master went on advertising its variants too. The comment on
`buildSignedPlaylist` had always claimed a link from an ended session "404s
cleanly"; nothing implemented it. Both queries ask `ended_at IS NULL` now, and
`hls-playlist-proxy-session.test.ts` proves the predicate against a real
Postgres rather than a mocked `rowCount`, because a mock cannot tell one
predicate from another and would have passed either way.

**Why a 404 is the right answer rather than a redirect.** Every client already
has the recovery: the web player's watchdog treats a fatal error as a reason to
refetch `GET /api/channels/:id/live` and follow whatever session that names,
and iOS's `WatchStreamSwap` swaps on a failure as well as on `startedAt`. So a
404 puts a pinned viewer onto the live session within one watchdog tick, on
both platforms, with no new machinery. It also answers "can a client end up
pinned to an old session": it can, whenever it misses the `channel-live` frame,
and this is what unpins it.

**The backstop not built.** A playlist whose newest entry is older than a few
target durations is not live whatever the rows say, and the proxy could refuse
on the body as well as on the row. It is deliberately left out for now: the
only clock in the file is the egress box's, `#EXT-X-PROGRAM-DATE-TIME` is not
guaranteed present, and the health monitor already tears down a session whose
playlist stops moving for twenty seconds. Worth adding if a session is ever
seen serving stale content with an open row.

### The 401 that stalled every web viewer, and said nothing

**Read this first if a stream is stalling.** It was the largest single cause and
it had no server-side symptom whatsoever.

The playlist proxy takes two credentials: a Bearer header, and a `?t=`
capability this server signs itself, naming the user, the channel and the
session, minted only after a real access check. `handleApi` resolves a Bearer
**before the router**, so any `Authorization` header had to succeed or the
request was 401 before the token in the URL was looked at, and the token-only
door was gated on there being no header at all.

`hls.js` attaches a Clerk JWT through `xhrSetup` **on top of** the `?t=`
already in the URL, caches it in a closure, and refreshes it every 30 s without
`forceRefresh`, while a Clerk JWT lives about 60 s. So roughly once a minute
every playlist request carried an expired token and was rejected. The player
stalled, retried, recovered, and did it again a minute later, for the whole
film, for every web viewer of every watch party since the feature shipped.

Proved on production, one URL, one valid token:

```
?t= alone                          200
?t= + Authorization: expired jwt   401
?t= + Authorization: garbage       401
```

**Why nothing caught it.** Every server test and every `curl` sent only `?t=`,
which is the one request shape that never fails; native iOS and Safari send only
`?t=` too. There was even a test named "serves hls.js (header AND token)" and it
used a **valid** header, so it exercised the shape without the failure inside
it. And the proxy logged nothing on a 401, so every server-side measurement said
the stream was healthy: it took a screenshot of Rafael's network panel.

**Both halves are fixed.** The server tries the capability again after the
Bearer resolution has failed, which is late enough that there is no other caller
to confuse it with. Trying it *first* would be wrong and a test says so: a token
naming one user must not become a different authenticated caller's capability,
which is a rule this route already had. And the client stops attaching a header
when the URL already carries a token, because a second credential is a second
thing that can fail. Either half fixes today; the pair is what stops the next
person adding a header "for safety" and bringing it back.

**A rejection now says why.** `voice.hlsPlaylistRejected` carries `missing`,
`malformed`, `bad-signature`, `expired`, `wrong-channel` or `wrong-session`,
plus whether an `Authorization` header was also present, rate limited to one
line per channel per reason per 30 s with a `suppressed` count. `wrong-session`
is the honest common one, a viewer holding the previous session's token, and it
should cost one clean refetch rather than repeating.

### The stall, and the four things that were causing it

Rafael reported the stream stopping every few seconds to minutes, on web and
iOS. It was not one fault. The `reason` field added to `voice.hlsStopped` is
what made them separable, and production answered within a party:

```
15:24:49  presenter-changed
15:25:23  no-share
15:29:31  screen-track-replaced     nobody touched the share
15:29:58  playlist-not-ready
15:34:17  screen-track-replaced     again
15:40:10  no-share
```

Six teardowns in sixteen minutes on one continuous party. Every one is a new
`startedAt`, a new playlist URL and a rebuffer for the whole audience.

**1. The web player re-attached on a restamped URL.** This one hits every
seatless web viewer of every watch party there has ever been, and it is
independent of everything else here, which is why choosing 720p by hand did not
help. `hlsUrl` carries a per-viewer signed `?t=` token and the server restamps
it on the audience keyframe, every 30 seconds, so the `src` prop changes twice a
minute for a stream that has not moved. `HlsWatchPlayer` re-attached its
`<video>` on any change. iOS was given this exact rule when the audience half
was written (`WatchStreamSwap` swaps on `startedAt`, on a failure and on the
token clock); the web never was, and because the symptom is identical on both it
read as the stream being broken rather than as one platform missing a guard.
`hlsSessionKey` compares the path, which is `.../<channelId>/<startedAt>`, so
only a genuinely new session moves the player.

**2. The publish plan was recalculated from a fluctuating bandwidth estimate.**
`use-voice.ts` resamples the presenter's uplink into `setHlsSource` every two
seconds, and the server restamps the stream frame every thirty, so
`reconcileScreenPlan` runs constantly. Once `hlsSourceTopHeight` began requiring
a **measured** uplink (the right fix for a starved 1080p layer, in the section
below), a link sitting near the 5 Mbit/s threshold made `topHeight` a function
of that estimate, and a change of height republishes the track: new sid, new
egress, new session, everyone rebuffers. `screenPlanPinned` decides the layers
once per broadcast and holds them; a worse uplink still lowers the **ceiling**,
in place, where nobody sees it. The host picking a quality by name forces past
the pin, because that is a person rather than an estimate. A **sustained**
short plan (ten seconds of uplink under the 1080 bar) is also allowed to
drop the height once: sitting on a starved 1080 is what makes the film
drift off its own audio, and a small watch-party room used to publish
1080 regardless because the HLS audience does not count as seats.

There is no hysteresis worth adding instead. The decision is worth making once,
and `replaceTrack` does not help here either: the declared layers are fixed at
publish, so swapping the capture cannot change them.

**3. A sharer that vanished for a moment ended the broadcast.**
`pickHlsSharer` needs `watchParty && sharingScreen && canStream`, and all three
go false without the presenter doing anything: a reconnect that reconstructs
starts the peer with `sharingScreen: false` until the client re-declares, and
`reevaluateVoiceSpeak` clears `sharingScreen` outright for anyone whose
`canStream` resolves false, which runs on **every** permissions bump, including
the ones a watch party's own options reconciler causes by writing channel
overwrites. The first such push used to end the session. It is now held for
`HLS_NO_SHARER_GRACE_MS` (5 s; `0` is the rollback), and because the sharer
going away is the last event the channel produces, the grace wakes itself with a
timer rather than waiting for something else to happen. `voice.hlsSharerVanished`
dumps every peer's three gate bits, so a persistent cause names itself instead of
needing another party to reproduce.

**4. A changed peer id read as a changed presenter.** LiveKit identities are peer
ids, so a reconnect that reconstructs or cold joins looks like somebody else
taking over. If the SFU still holds the very screen track the session was started
on, the media never moved: the new id is adopted onto the running session
(`voice.hlsPresenterReattached`) instead of restarting it. Sids are unique per
publication, so a genuine second presenter still restarts it.

**And `playlist-not-ready` was the box being slow, not the egress being broken.**
The readiness probe waited 20 s, between the 10.8 s and 43.7 s that
`docs/CAPACITY.md` measured for a first playlist on an idle and a saturated box.
On a box carrying leftover transcodes it timed out, tore the session down and
spent one of the three restarts in the window. It waits 45 s now, and
`voice.hlsStarted` reports `playlistWaitMs`, so the next revision of that number
is measured rather than argued.

### What the presenter publishes, and why 1080p was making it worse

Measured on the live party, 2026-09-09. The presenter published
`SCREEN_SHARE` VP8 at 1671x1080 with three simulcast layers (557x360 at
450 kbit/s, 1114x720 at 1400, 1671x1080 at 4000), and about **2.35 Mbit/s was
actually arriving at the egress** over five and a half minutes. So the top
layer was running at roughly 60 % of its target on full-motion content, which
is what "like 20fps, def not fluid" looks like from the outside. The media box
was idle at load 0.87 throughout: this is the presenter's uplink, not the SFU.

**The egress always takes the top layer, and cannot be told otherwise.** Its
SDK source subscribes with `pub.SetSubscribed(true)` and sets no quality or
dimension preference, and `TrackCompositeEgressRequest` has no layer field
either. So the cleanly delivered 720p layer sitting right beside the starving
one is never used, by any rung: **both rungs of the ladder transcode the same
starved 1080p**. There is no server-side lever here at all. The only thing that
decides what the audience sees is what the client publishes.

**So the publish decision now requires a measurement.** `hlsSourceTopHeight`
raises a watch-party share past the large-room 720p cap only when the uplink
has been measured AND clears 4 Mbit/s plus 25 % headroom. It used to treat an
unmeasured uplink as permission, on the convention `decidePromotion` uses for
an unprobed SFU. Those two cases are not alike: a promotion that guesses wrong
costs the box some headroom, and this one costs every viewer the picture. A
cleanly delivered 720p is better television than a starving 1080p and costs the
presenter less than half the uplink.

Two things that change shipped later, on the same facts.

- **A rung taller than the source is refused.** `set-sharing-screen` now
  carries `sourceHeight`, and `pickScreenTracks` reads LiveKit's own
  dimensions when the client is older. `decideLadder` refuses extra rungs
  more than 16 lines taller than that source, so a 720p window does not
  spend a core inventing 1080p. A 1670×1078 window still gets 1080p.
- **The host is told their uplink is short.** The TRANSMISSION panel
  already had the line. `useShareUplinkStrain` now measures on LiveKit
  too: one upload, `describeLimitation` against the published plan
  ceiling. Fibre sitting on 4 Mbps stays quiet; a starving uplink
  speaks.

### The restart that should not happen at all: swapping the share in place

Rafael's framing, and it is a better fix than surviving the restart: in a watch
party the share control should offer to **change** what is being shared rather
than stop and start. Not shipped; written down here because the mechanism is
already available and the caveats are the whole of the design.

**The client does it.** `publishScreen` calls `LocalTrack.replaceTrack` when
a share is already up and the audio half did not appear or disappear. Same
track sid, same SFU-side track, same RTP stream, no new egress. Gaining or
losing the share's audio still unpublishes and republishes, because a
running Track Composite egress is bound to the sids it started with.

Three caveats, and the third is the one that would bite.

- **Whether the egress rides through a mid-stream resolution change is not
  verified.** The SSRC continues and the encoder reconfigures; whether the
  egress's GStreamer pipeline takes that gracefully cannot be tested on a dev
  stack, which has no LiveKit and no egress. This is the thing to try on a real
  party before promising it.
- **Simulcast layers are declared at publish.** `publishScreen` computes
  `screenSimulcastPlan(topHeight)` and constrains the capture to match, and an
  in-place swap keeps the layers the OLD capture declared. The new capture has
  to be constrained to the same top height, which `constrainScreenCapture`
  already does.
- **It cannot add or remove the share's audio, and that is exactly what a host
  re-shares for.** The audio half is a separate publication with its own sid,
  and a running Track Composite egress is bound to the pair it was started with,
  so an audio track published afterwards never reaches it. The 2026-09-09
  restart was Rafael re-sharing *to add the window's audio*: done as a seamless
  swap, the room would have gained the film's sound and the HLS audience would
  have stayed silent, with the picture never flickering to suggest anything had
  happened. So the seamless path is for **changing which window**, and gaining
  or losing the share's audio has to go through a real restart, which
  `probeScreenTracks` would need to notice by comparing the audio sid as well as
  the video one. Say so in the control's copy rather than letting the host find
  out from five hundred people.

None of this replaces the server-side work above. A share also dies for reasons
nobody chose: the window closes, the tab crashes, the machine sleeps.

### The presenter's socket blinking, which is the other way a session restarts

Watched live on 2026-09-09, the presenter of the party in question reconnected
and resumed the same peer id (`voice.resumeAdopted ... orphaned=true`). That is
the machinery working: the seat is held for 90 s and the person never left.

What it does to the transcode depends on which resume they get, and the
difference is not obvious.

- **`adopt`** (the registry has the row, which production runs) carries
  `sharingScreen` onto the new peer, so `pickHlsSharer` never loses the sharer
  and, if the client kept its LiveKit room across the WS reconnect (web and
  Electron do), the screen track sid is unchanged and **nothing restarts at
  all**.
- **`reconstruct` and a cold join** start the peer clean and wait for the client
  to re-declare. Between the roster push and that frame, `pickHlsSharer` finds
  nobody, and until this PR that was a **silent** teardown followed by a
  **silent** start: two `voice.hlsStarted` and no explanation, a new playlist
  URL, and a rebuffer for the whole audience. It is now `no-share` followed by
  a start, which at least names itself.

**The repair is not obvious and is deliberately not in this PR.** Holding the
session open whenever the presenter's peer is still seated would also hold it
open when they genuinely stop sharing and stay in the room, which leaks a core
and shows a frozen frame until the stuck-playlist rule notices twenty seconds
later. Carrying `sharingScreen` across a reconstruct the way `adopt` does is
narrower and probably right, and it still costs one clean restart because a
reconstructed client republishes with a new sid. Do it with the reason field
above in hand: one party's log now says which resume kind is actually
happening, which is the fact this reasoning is missing.

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
`maxSessions` / `rungs` / `oldestSessionMinutes` for the transcodes running on
the instance that answered. `sessions: 0` during a live watch party is the
egress not starting, which on the viewer's screen is a blank pane and in the
log is `voice.hlsStarted` never appearing. `sessions` sitting at `maxSessions`
with a party complaining of a blank pane is the concurrency cap
(`LIVE_HLS_MAX_SESSIONS`), and the log says so: `voice.hlsSessionsCapped`.

**Can the audience hear it?** The same block's `silentSessions`, against
`sessions`. Equal means every live party is going out with no audio at all,
which is a share picked without its own audio rather than a fault, and the host
is told in their own transmission panel. In the log it is
`voice.hlsStarted ... audio="none"`.

**Is the box carrying more transcodes than it should?** The same block's
`orphansStopped`. It belongs at zero. Anything else means a session leaked
handlers onto the media box and the monitor cleaned up after it; the log line is
`voice.hlsOrphanStopped`. See "When a session restarts" above for why this is
the number that bounds `LIVE_HLS_MAX_SESSIONS` actually meaning three.

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
| 9 | `LIVE_HLS_SERVER_ALLOWLIST` | `pqp-api` | unset, which means **every** server. It is now the *fallback* under `servers.live_hls_enabled`, which the operator dashboard writes with no restart. Either one keeps the create control off 908 other servers; the column is the one you can change at 21h on a Saturday. See below |
| 10 | `LIVE_HLS_MAX_SESSIONS` | `pqp-api` | unset, which means the default of 3 concurrent parties per process |

### What `LIVE_HLS_ENABLED=true` does, and no longer does

It used to do two things beyond making watch parties work, and both were
wider than the feature.

**It moved every server voice channel to the SFU.** `resolveVoiceTransport`
returned `livekit` with reason `hls` for any server channel as soon as live
HLS was on for that server, ahead of the size and community rules, so rooms
that are peer-to-peer and cost the media box nothing started being carried by
it. `docs/CAPACITY.md` §6b prices that: moving the peer-to-peer half onto the
box roughly doubles its bytes, and the monthly transfer allowance is what runs
out first, not the cores.

**Every screen share anywhere started a transcode.** `pushLiveHls` picked a
sharer with `sharingScreen && canStream` in any LiveKit room, `watch_party`
or not.

**Both are gone.** The promotion asks for a `watch_party` channel
(`liveHlsForcesSfu`), and so does the egress picker (`pickHlsSharer`'s room
gate). A party can only live in a `watch_party` channel: the create route
that the client actually calls,
`POST /api/servers/:serverId/watch-parties`, routes every party through
`findOrCreateWatchPartyRoom`, which finds or makes exactly that. So the flag
can be set instance-wide and an ordinary voice channel is decided by size,
community and its override exactly as it is with the flag off. The tests that
say so run with the environment variables really set:
`server/src/ws/voice-transport.test.ts` §"live HLS on" reads `profileReads`
to prove the member-count query still runs, which is the counter that catches
a narrow policy with a wide caller.

### The allowlist is now the ROLLOUT SWITCH, and that is the live reason

**Read this before reasoning from the old text.** The allowlist used to be
mandatory because of the blast radius above. That reason is gone: the flag no
longer touches an ordinary voice channel. Do not keep the allowlist because
of capacity, and do not drop it because capacity is handled. The reason it
still exists is a different one.

**`START_WATCH_PARTY` is not a rollout control.** The migration
(`start_watch_party_bit_2026_09`) ORed the bit onto every non-everyone role
already holding MANAGE_CHANNELS plus every seeded Moderator, which on this
instance is **2753 roles across 908 servers**. So `VITE_WATCH_PARTY_CHANNELS`
on globally, with the control gated on the bit alone, is a create button in
front of a few thousand moderators at once, most of them on servers where no
egress can run. That is not a quiet launch, and "they can press it, they just
get a party with no seatless audience" is the problem rather than a mitigation
of it.

**So the control follows the server too.** `canOfferWatchPartyCreate`
(`client/src/lib/watch-party-channels.ts`) needs BOTH the permission bit and
`enabled` from `GET /api/live-hls/config?serverId=`, which is the server-side
answer to `LIVE_HLS_ENABLED` + the bucket + the allowlist. `App.tsx` already
holds that answer for the open server (`useLiveHlsConfig`, fetched once per
server and cached for the page's lifetime, for the screen-share disclosure
sheet), so the gate costs no extra request. An unanswered config counts as
**no**, which is the opposite of `gateScreenShareStart` and deliberately so:
a button that appears a beat late costs a moderator nothing, a missed
disclosure costs a person a lot.

**The end state.** `VITE_WATCH_PARTY_CHANNELS=true` in the web build,
`LIVE_HLS_ENABLED=true` on `pqp-api`, and the servers that may run a party
turned on **in the dashboard** (`servers.live_hls_enabled`). Live in
production, invisible everywhere else.

**What a member on a non-allowlisted server sees: nothing.** Not a disabled
button, not an empty section, not a heading. `LivePartyBlock` returns `null`
when there is no live party and no create control, so the sidebar is byte for
byte the sidebar they had yesterday. Their voice channels are unaffected
(that is the narrowing above), and if somebody on an allowlisted server goes
live, only that server's members see the block. Pinned by
`the create control is absent on a server the operator has not allowlisted`
in `client/e2e/watch-party.spec.ts`, which flips only the config answer and
watches the same account with the same permission gain and lose the control.

### Widening it is a click now, not a secret

`LIVE_HLS_SERVER_ALLOWLIST` is a Fly environment variable, and
`fly secrets set` **restarts the machine**: every WebSocket closes, and the
old line here that said "no deploy, no rebuild" quietly skipped past that.
Worse, nothing anywhere showed which servers were on the list, so the only way
to answer "is Cinemoon allowed" was to read a secret.

So the per-server decision is a column: **`servers.live_hls_enabled`**, read
per request by `resolveLiveHlsForServer` (`server/src/voice/hls-egress.ts`),
the same pattern `COMMUNITY_HOME_ENABLED` and `is_community` already follow.
The operator dashboard's **controles** section searches the 908 servers by
name and writes it; `tools/admin-dashboard/README.md` has the screen.

**Three states, and which wins.**

| `live_hls_enabled` | Answer | Why that order |
|---|---|---|
| `TRUE` | on | a person decided about this server, from the dashboard, after whoever set the secret had left |
| `FALSE` | **off, even if the variable names the server** | this is the kill switch, and a kill switch that needs a deploy is not one |
| `NULL` | whatever `LIVE_HLS_SERVER_ALLOWLIST` says | nobody has decided; the environment is still the answer |

`LIVE_HLS_ENABLED` is above all three and is untouched: with it off, or
without the dedicated bucket, no row turns anything on. And the deploy that
added the column changed nothing, because every row was `NULL`.

**What "takes effect immediately" does and does not cover.** The server-side
capability is immediate: the next `join-voice-room` pins the transport with
the new answer, the next share reconcile starts or stops the egress, and the
next `GET /api/live-hls/config?serverId=` answers the new value. What is
**not** immediate is the create control in a tab that is already open:
`useLiveHlsConfig` caches the config per server for the page's lifetime, so a
host looking at the channel when you flip it has to reload before the button
appears. Flip it before the host opens the channel, or tell them to press F5.
The dashboard says so under the buttons.

Turning a server **off while a party is streaming** stops the egress at the
next reconcile and the audience loses the picture. That is the one control on
that page with a confirmation.

### The one real cost left: concurrent parties

Measured on the same LiveKit and egress versions production runs (2026-09-09,
synthetic full-frame 30 fps motion, close to worst case for screen content):

| rung | cost |
|---|---|
| `720p30` | 0.51 core |
| `1080p30` | 0.88 core |

The default two-rung ladder is about 1.4 of the media box's 4 cores for one
party. `LIVE_HLS_MAX_LADDER_MBPS` prices the rungs, but read `decideLadder`'s
first rule: **the lowest rung always starts**, because a party with no
rendition is a party nobody can see. So the ladder budget degrades the second
and third party (they get their floor rung alone, 0.51 core each) and never
refuses one. Nothing bounded the count.

`LIVE_HLS_MAX_SESSIONS` does, default **3**: about 1.39 + 0.51 + 0.51, call
it 2.4 of 4 cores, leaving the SFU and the TURN relay the rest. The fourth
simultaneous party gets no transcode, logs `voice.hlsSessionsCapped`, and the
share still works over WebRTC for everyone seated in the room; only the
seatless audience misses out. Raise it for a bigger box; zero and anything
unreadable fall back to the default rather than turning the guard off.
`liveHls.sessions` and `liveHls.maxSessions` on `/api/admin/metrics` show how
close it is.

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

The allowlist in step 3 is no longer a capacity guard, but it IS the rollout
switch: with the client flag on globally it is the only thing keeping the
create control off 908 other servers. Set it, and name only the servers the
launch is for. See "The allowlist is now the ROLLOUT SWITCH" above.

Step 3 restarts `pqp-api` and closes every `/ws`. Do it well before the event,
not during it.

### Reading it back, in order

```sh
curl -s https://api.pqp.gg/ready | jq '.checks.liveHls'
# {"ok":true,"ms":…}  not "skipped", which would mean the flag did not take

curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" \
  https://api.pqp.gg/api/admin/metrics | jq '.liveHls'
# enabled true, configured true, allowlisted true, ladder listed,
# sessions 0, maxSessions 3, uncleaned 0,
# sweepsHere false (the sweep lives on pqp-worker)
```

Then, on a server that is NOT in the allowlist, confirm an account holding
START_WATCH_PARTY sees no Criar watch party control at all. That is the quiet
half of the launch and it is the half a metric cannot show you.

Then a real party on the allowlisted server, and during it:
`liveHls.sessions` at least 1, `liveHls.rungs` matching the ladder, and
`voice.hlsStarted` in the log. Ten minutes after it ends, `liveHls.uncleaned`
back at 0 and `voice.hlsSessionCleaned` in the log.

### Turning it back off

`fly secrets unset LIVE_HLS_ENABLED -a pqp-api`. One command, no deploy, and
a watch party goes back to the ordinary transport policy on its next pin.
Every other room was already on it. The
client flag can stay on: with the API answering `enabled: false` the create
surface still appears but nothing can broadcast, so unset
`VITE_WATCH_PARTY_CHANNELS` and redeploy web if the surface itself should go.

## Client flag

`VITE_WATCH_PARTY_CHANNELS=true` turns on the create affordance and the
distinct sidebar row (icon, description, pulsing `AO VIVO` pill with the
viewer count, off under `prefers-reduced-motion`). Default off: production
shows nothing new until Rafael flips it. With the flag off an existing
`watch_party` channel renders and joins as a plain voice channel.

**It is the outer gate, not the rollout.** The build flag is global by
construction (one bundle, every server), so it says whether this build has
watch parties in it at all. WHERE they are offered is
`canOfferWatchPartyCreate`: the permission bit AND the open server's
`GET /api/live-hls/config?serverId=` answer. Turning the build flag on
without an allowlist offers the control on every server whose moderators hold
a bit that was backfilled onto 2753 roles. See "The allowlist is now the
ROLLOUT SWITCH" above. With the dev
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

  **The player was not enough, and build 21 is the proof.** It shipped with
  everything above working and the first report from a real phone was "watch
  party shows as a regular voice channel". It was one, exactly: `isVoice` is
  true for `watch_party` and it was the ONLY question the app asked, so the
  row drew the same speaker glyph under the same Voice heading, the toolbar
  drew the same green phone, and `WatchStageView` rendered `EmptyView()` for
  the two states that are true whenever nothing is being broadcast. Nothing
  was broken. There was simply nothing on screen that said watch party until a
  stream existed, and most of the week no stream exists. Build 22 asks
  `Channel.isWatchParty` in the four places a person can see the difference:

  - **The channel list** (`ChannelListView`) puts parties in their own
    section, above Text, with the clapperboard the web draws, and filters them
    out of Voice and out of every category with one filter, the way
    `channel-list.tsx` does. A live one carries an `AO VIVO` pill fed by
    `channel-live`, which restates itself on the audience keyframe clock, so a
    list opened mid-party gains the pill within thirty seconds. There is no
    REST seed: the catch-up burst is sent at socket auth, long before this
    screen exists.
  - **The empty stage** says so. `unknown` and `idle` draw one card rather
    than two sentences a round trip apart, gated on the type, because this
    view is mounted over every voice channel's transcript.
  - **No seat is offered.** The chat toolbar's join button is not drawn in a
    watch party. A watcher costs one socket in a set; a seat costs a
    participant on the media box, a microphone prompt, and on the default
    party it buys nothing at all, because the default party has no voice and
    the server refuses the join outright. iOS has no presenter or stage
    surface, so there is nothing on that screen a seat unlocks. The trade is
    that an iOS host or co-host cannot take the room from the phone; hosting
    is a web and desktop job today anyway.

  **Build 23 is the player itself**, after the first report from a real phone
  against a live production stream: "the player is very simple, need to
  modernise", "need fullscreen", "no way to change quality", and "it's choppy,
  every 3 to 5 seconds it stops and I need to press play, which doesn't
  necessarily work".

  Read the stalls first, because they were not the player. A share that
  outlived its watch party counted as a finished session and the retention
  sweep deleted the files of a stream still being written to, roughly every
  ten minutes; the web stalled on it too. That is fixed separately and nothing
  on the phone should be tuned against it.

  What the phone did own, measured against production on 2026-09-09:

  - **The live window default is thirty seconds** (`LIVE_HLS_DELAY_SECONDS`).
    A ten second window (five two-second segments) is what production
    published when the iOS stalls were measured: `AVPlayer` joins three
    target durations from the end, so it holds about four seconds of runway.
    A player stopped longer than the window has the playlist slide past the
    playhead, and `play()` is powerless there. `WatchLiveEdge` is the seek
    back in. It lands eight seconds from the live edge on a wide window, and
    four seconds from the back on a short one — build 25 landed eight
    seconds back on a ten second playlist, decoded one frame, and sat.
    Measured from the END rather than the front, because
    `seekableTimeRanges` is not guaranteed to be only the current window.
  - **A stall is not free once it ends.** "It's so choppy it got very
    delayed" is a second bug, not a restatement of the first. `AVPlayer`
    resumes where it stopped, which is right for a recording and wrong for a
    broadcast, so every stall adds its own length to the distance behind live
    and none of it is paid back. Six of them is minutes, and minutes behind on
    a watch party means the chat is discussing a scene the viewer has not
    reached. `catchUpAfter` pays it back: the badge offers Pular pro ao vivo
    at ten seconds behind (the web's own `BEHIND_LIVE_THRESHOLD_SECONDS`, so
    the two clients call the same drift by the same name) and the player
    insists at forty five, where being left behind has stopped being a
    preference. Nothing buffers more. More buffer is more delay, which is the
    complaint.
  - **The delay readout was a constant.** It printed `delaySeconds` off the
    wire, which is the pipeline and the same figure for everybody, so a viewer
    two minutes behind was shown "~10s". It is now the pipeline plus the
    measured distance from the live edge (`WatchDelay`), and it turns amber
    once the badge says behind.
  - **The existing watchdog could not see any of it.** `WatchStallWatch`'s
    clock runs only while `timeControlStatus == .playing`. A starved player is
    `.waitingToPlayAtSpecifiedRate` and an interrupted one is `.paused`, so it
    returned false on every tick of the reported failure and the recovery it
    guards was unreachable. It is untouched and no threshold in it was
    relaxed; the new type sits beside it, and a test pins the blindness so
    nobody "fixes" it by widening the old one into calling a buffering player
    dead.
  - **Nothing was capping the decode.** `preferredMaximumResolution` was never
    set, so on a good link `AVPlayer` climbed to 1080p30 at about 4.6 Mbps and
    decoded it to draw a strip a phone wide. Auto was always adapting, which
    is worth stating because "no quality control" reads as "pinned"; what was
    missing was the ceiling and the honesty. `WatchLadder.resolutionCap` turns
    the surface's own pixels into the ceiling, so the same rule holds 720p
    inline and allows 1080p the moment the viewer taps expand, clamped so it
    never describes a rung the ladder does not publish.
  - **An audio session interruption was permanent.** A call, Siri or another
    app taking the session stops `AVPlayer` and leaves it stopped. Nothing was
    listening, so the film never came back.

  The picture is now `AVPlayerViewController` (`WatchVideoSurface`) rather
  than SwiftUI's `VideoPlayer`, which wraps the same class and exposes none of
  it. That is where fullscreen in landscape comes from, along with AirPlay,
  Picture in Picture and a transport bar that fades while you watch. pqp draws
  the strip underneath: live or how far behind, the headcount, and a quality
  menu built from `AVAsset.variants` (Auto plus whatever the master actually
  advertises, never a hard coded list) labelled with the rung
  `presentationSize` says is being decoded. Collapsing now REMOVES the
  surface rather than squashing it to zero height, which used to leave a
  decoder running to fill a rectangle nobody could see.

  Tests: `ios/pqp/Tests/WatchLivePlayerTests.swift`.

  Still to do on iOS: the party OBJECT (`watch-party-update`, the host,
  cohosts, the stage, raise hand), the presenter side, hiding the share
  control unless `welcome.canStream`, and the create sheet offering the type.
- Android: a distinct icon and the create sheet are still missing. The share
  control follows `welcome.canStream` rather than the transport now, so a host
  can present on a LiveKit room, which is the transport every watch party runs
  on; nothing about that has been run on a device. `WireProtocolTest` mirrors
  the shared enum and was updated here.

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

## Two hand-raises, and how they reconcile

`docs/RAISED_HANDS.md` is a **general** raise-hand: any voice call, no party,
no session row. It is `voice_raised_hands (channel_id, user_id, raised_at)`,
carried on the roster as `handRaisedAt`, cleared when the person leaves, and
visible to everyone in the room.

The unmerged `feat/watch-party-journey` branch has a different one under the
same words: `raiseHand` is a party OPTION, the rows are
`channel_session_raised_hands` keyed on `session_id`, the queue is shown only
to the people running the party, and the whole thing is coupled to
`stageMode: "invited"` and to granting SPEAK to one person at a time. That is a
stage door, not a queue, which is why it was not lifted and a general one was
built instead.

**When that branch lands**, the two should be reconciled rather than left side
by side, and the cheapest shape is probably: keep the party's `raiseHand`
option as the switch that turns the STAGE DOOR on (who gets promoted, and by
whom), and make the queue underneath it the general one, so a person's hand is
one hand wherever they raised it and the host is reading the same order the
room is. The general implementation already has the pieces that costs the most
to write twice: the server-stamped order, the roster field, the cluster path,
and lowering on speaking and on leaving.

