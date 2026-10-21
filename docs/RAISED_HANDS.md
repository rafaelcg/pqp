# Raise your hand

Asked for in the QG: *"uma coisa que eu senti falta é levantar a mão e aí forma
a fila de quem levantou primeiro"*. In any voice call, ordinary ones included:
put your hand up, and everybody sees the queue in the order the hands went up.

## The whole thing in one field

The wire carries **one number per person and no list**:
`voiceParticipantSchema.handRaisedAt`, epoch milliseconds, null when the hand
is down. Everything else falls out of that.

The order is the server's. The number is stamped by the server, never by the
raiser: with `VOICE_REGISTRY=postgres` it is the `voice_raised_hands` row's
`NOW()`, so two API machines read one clock; without it, the instance's own
`Date.now()`, which is the same clock for everybody in a single-process
deployment. Clients only sort what they are given, with the one rule in
`packages/shared/src/raised-hands.ts`:

> hand up first, oldest raise first, ties broken on `userId`.

The tie-break is not decoration. Two inserts inside the same millisecond are
ordinary, and without a total order two clients would each sort them however
their engine felt like, which is the disagreement the server-stamped timestamp
exists to prevent.

**Why a timestamp and not a `voice-hands` frame.** The roster already fans out
to everyone who can see the channel, already diffs per participant
(`sameParticipant` compares every key, so this field was diffed the day it was
added), and already has a convergence rule and an answer for the socket that
arrives mid-call. A separate frame would need its own copy of all of that to
say something the roster is already saying.

## Keyed on the person, not on the seat

`voice_raised_hands` is `(channel_id, user_id, raised_at)`, cascading with the
room row, and the in-process mirror is `roomRaisedHands` in `ws/voice.ts`. It
is deliberately the same shape as `voice_server_mutes`, and diverges from it at
exactly one end:

| | server mute | raised hand |
|---|---|---|
| survives a socket blip and a resume | yes | yes |
| survives a refresh inside the orphan window | yes | yes |
| survives leaving and rejoining | **yes**, it is a sanction | **no**, it is a request |

Losing your place because a tab reloaded is the complaint the feature exists to
answer, so the hand outlives the seat: a resume reattaches one, a refresh mints
another, and neither is somebody leaving. `removePeer` clears the hand only
when that person holds no seat in the room at all, orphans included.

## What lowers a hand

A hand is a place in a queue, so it stays up until somebody who owns that
place takes it down. Exactly three things do, and nothing automatic is on the
list (no timer, no speaking, no unmute, no being given the floor):

1. **The person.** Always available. Not gated on a moderator's mute, not on
   `Permission.SPEAK`, not on push-to-talk. Raising a hand is asking, and
   somebody who has changed their mind must be able to say so. The hand button
   toggles it, and with sticky hands (below) so does a click on your own
   number on a tile, your row in the queue, or your place on the compact line.
2. **Leaving the room.** Server-side, on the last seat going (`removePeer`,
   `dropRaisedHandForUser`). Orphans count as seats, so a socket blip or a
   refresh inside the 90 s resume window keeps the place.
3. **A moderator**, explicitly, with `Permission.MUTE_MEMBERS` in that channel:
   - one hand: `POST /api/servers/:serverId/members/:userId/voice-lower-hand`,
     through `requireVoiceModeration` (so the outrank check applies);
   - every hand: `POST /api/channels/:channelId/voice-lower-hands`, "Baixar
     todas" in the queue panel and on the compact line. Same bit, and the
     outrank rule per person: a hand the moderator cannot act on is skipped
     and counted (`{ lowered, skipped }`), not a refusal of the whole call.
     Your own hand is lowered like anybody's. Behind `raised_hand_sticky`:
     with it off the route answers 403.
   Neither is audited: the audit log is for sanctions somebody may answer for
   weeks later, and calling on the next person is the ordinary running of a
   room, forty times in a stream.

### What used to lower a hand, and what does now

| Trigger | Before | Now |
|---|---|---|
| The person (button, own number, own queue row) | lowers | lowers |
| Leaving the room (all seats gone) | lowers | lowers |
| A moderator, one hand | lowers | lowers |
| A moderator, "Baixar todas" | did not exist | lowers every hand they may |
| Talking (mic opens, voice activity, push-to-talk) | lowered until #1427, then no | no |
| A moderator unmuting you, or a server mute | no | no |
| Audience mode: a host lets you speak (`setVoiceAudienceSpeaker`, `ws/voice.ts`) | **lowered** | **no**, with `raised_hand_sticky` on |
| A timer | none | none |
| Orphan hold expiring (the seat is gone) | lowers (it is leaving) | lowers |

Talking stopped lowering a hand in #1427 and that part is not behind the flag:
the client simply no longer sends a lower when the mic opens. The one
automatic lower that survived was audience mode's, and it is what the flag
turns off.

### The flag: `raised_hand_sticky`

Runtime flag, global, **on by default** (`RAISED_HAND_STICKY`, flippable from
the dashboard with no deploy; `docs/FEATURE_FLAGS.md`). The server reads it
with `isEnabled` where it matters (the audience grant, the lower-all route)
and serves it as `raisedHandSticky` on `GET /api/voice/config` so the call
shows the new controls. Off restores today's behaviour exactly: letting
somebody speak in audience mode lowers their hand, the number on a tile is a
picture, and "Baixar todas" is not drawn and the route answers 403. An older
client against a new API, or the reverse, degrades to "no new controls".

Raising is the person's own state and rides the voice socket
(`set-raised-hand`, rate-limited by the same limiter as a mute toggle).
Lowering somebody else's is an action taken on a person, so it is an HTTP route
with the rest of them. There is no frame shape anywhere that names a target.

## Where it shows

| Surface | What |
|---|---|
| Call controls | a hand button, `aria-pressed`, on the expanded stage and on the slim bar |
| Expanded stage | `RaisedHandQueue`: the ordered list, your position, an X on your own row (sticky hands), an X per row and **Baixar todas** for a moderator |
| Collapsed call strip | the same queue as one line: first name, `+N`, your position (a button that lowers your hand, sticky hands), an X that lowers all of them for a moderator |
| Call tiles | the hand and its number (`✋ 2`) in the name strip of each tile; with sticky hands it is a button: your own lowers your hand, a moderator's lowers theirs |
| Sidebar occupant row | the hand and its number next to the mute and camera badges |
| Sidebar right-click | **Abaixar a mão**, only while that hand is up and only with the bit |

The collapsed strip is not a corner case. A call where nobody has a camera on
never opens an expanded stage at all (`shouldShowExpandedStage`), and that is
most calls, so the compact line is the shape most people will actually see.
The moderator's lower lives on the sidebar row for the same reason: it has to
be reachable from a call with no picture.

## Three decisions, and why

**Visible to the sidebar, not just to the call.** The roster is one frame for
both audiences, so hiding the hand from people outside the call would mean the
client deliberately dropping something it was told. It is also the more useful
way round: "somebody in there is waiting to talk" is exactly what makes a
person open the call, and a hand is a public gesture in a room whose occupants
are already listed by name. The position is shown with it, on the sidebar and
on the tiles. It used to live only in the stage's queue, and most calls never
open the stage, so the room could not read its own turn order.

**The list is capped, the queue is not.** Refusing the twenty-first hand takes
away the only way that person has to say "me next" and buys nothing: the state
is one flag per person, so the queue is already bounded by the room, and the
room has its own ceiling. What a 130-person community cannot use is a list of
forty names, so the LIST is cut at `RAISED_HAND_LIST_LIMIT` and the tail
becomes a count. Everybody is still told their own position however far back it
is, which is the fact that stops them asking again.

**Nothing is notified.** No toast, no sound, no channel badge, no
`voice-moderation` notice when a moderator lowers yours. A queue people glance
at between sentences is calmer than one that interrupts forty people to
announce a twelfth raise, and the person whose hand came down sees it on the
same roster everybody else is reading, on a button that flips back to
*Levantar a mão*.

## With audience mode

Audience mode makes the hand the audience's way to ask: while it is on, a
person whose mic is locked by it sees the raise button as the primary control
("Pedir pra falar"), and a host sees a one-tap **Liberar o microfone** on
every hand in the queue (on the compact line too, for the first hand).

With sticky hands, letting somebody talk does **not** lower their hand any more:
they keep their number while they have the floor, and the host takes the hand
down with the X on that row (or "Baixar todas") when they are done. That is
the same rule as everywhere else, a hand only comes down when its owner or a
moderator says so. With the flag off it is the old behaviour: the grant lowers
the hand, through the same path a moderator's lower takes.

## One client bug the sticky queue exposed

The client draws your own hand from what it believes (so the click moves the
icon now) and stores that overlay in the occupancy a roster DELTA is merged
onto. A moderator lowering several hands sends several deltas, and the second
one handed the first one's stale overlay back to `applySelfHand` as if the room
had said it: your hand came back up on your screen and nowhere else.
`serverSelfHand` in `use-voice.ts` keeps the raw value the room last stated,
and a delta is merged onto that. Found by driving three real browsers, not by
any test that existed.

## Two machines

Same path as the moderator mute (PR #355), which is the only path voice state
is allowed to take: the row first, then a `voice.raisedHand` hint on the bus
carrying the ROW's instant, then the local half. An instance that misses the
frame still reads the hand on its next roster and on the next join; what the
frame buys is that the queue moves now rather than on the next keyframe.

`voice.raisedHand` is a hint about a row, never the truth. The truth is
`voice_raised_hands`, which is why a join reads it (`getVoiceRaisedHand`) and
why a process that never saw the raise still puts the person in the right
place.

## Tests

| What | Where |
|---|---|
| the ordering rule, ties, one entry per person | `packages/shared/src/raised-hands.test.ts` |
| order, stability, resume, refresh, leaving, an emptied room | `server/src/ws/voice-raised-hands.test.ts` |
| the moderator route: may, may not, idempotent | `server/src/api/voice-moderation.test.ts` |
| two instances: order across the bus, a lower from the other machine, a third process | `server/src/ws/voice-cluster.test.ts`, group "raised hands across instances" |
| talking keeps your own up, the optimistic window, a moderator's lower landing | `client/src/hooks/use-voice.test.ts`, group "raising a hand" |
| unmuting, a moderator's unmute and a renumbering keep the place | `server/src/ws/voice-raised-hands.test.ts` |
| audience grant keeps the hand (flag on) and lowers it (flag off), one instance and two | `server/src/ws/voice-audience.test.ts`, `server/src/ws/voice-audience-cluster.test.ts` |
| lower all: may, may not, skipped by rank, flag off, text channel | `server/src/api/voice-moderation.test.ts`, group "lower ALL hands" |
| lower all over two instances (rows, not the cache) | `server/src/ws/voice-cluster.test.ts`, "a moderator's lower-all on A" |
| clicking the number, the own-row X, Baixar todas, renumbering | `client/src/components/voice/sticky-hands.test.tsx` |
| a moderator's lower is not undone by the next roster delta about somebody else | `client/src/hooks/use-voice.test.ts`, "keeps a hand down that a moderator lowered" |
| the flag's contract with the client | `server/src/lib/flag-client-contract.test.ts` |
| the panel, the compact line, the lower control's gating | `client/src/components/voice/raised-hand-queue.test.tsx` |
| the number beside each hand | `client/src/components/layout/voice-occupant-badges.test.tsx` |

Production runs `VOICE_REGISTRY=postgres`, which is why the cluster group is
the one that matters here (pitfall 12 in `CLAUDE.md`): the single-process
suite exercises the map, and the cluster suite exercises the rows.
