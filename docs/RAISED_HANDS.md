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

1. **The person.** Always available. Not gated on a moderator's mute, not on
   `Permission.SPEAK`, not on push-to-talk. Raising a hand is asking, and
   somebody who has changed their mind must be able to say so.
2. **Speaking.** `isTransmitting` going true, which is a voice-activity gate
   opening on a real syllable or a push-to-talk key going down. **Only the
   client can do this**: `speaking` is deliberately not on the roster, so the
   server never sees it. That is not a hole. The only hand this can lower is
   the person's own, and a client that declined to run it would be leaving its
   own hand up in a queue it can see.
3. **Leaving the room.** Server-side, on the last seat going.
4. **A moderator**, when they call on somebody:
   `POST /api/servers/:serverId/members/:userId/voice-lower-hand`,
   `Permission.MUTE_MEMBERS` in that channel plus the outrank check, through
   `requireVoiceModeration` with the other three voice moderation actions. Not
   audited: the audit log is for sanctions somebody may answer for weeks later,
   and calling on the next person is the ordinary running of a room, forty
   times in a stream.

Raising is the person's own state and rides the voice socket
(`set-raised-hand`, rate-limited by the same limiter as a mute toggle).
Lowering somebody else's is an action taken on a person, so it is an HTTP route
with the rest of them. There is no frame shape anywhere that names a target.

## Where it shows

| Surface | What |
|---|---|
| Call controls | a hand button, `aria-pressed`, on the expanded stage and on the slim bar |
| Expanded stage | `RaisedHandQueue`: the ordered list, your position, an X per row for a moderator |
| Collapsed call strip | the same queue as one line: first name, `+N`, your position |
| Sidebar occupant row | a hand glyph next to the mute and camera badges |
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
are already listed by name. The POSITION is not shown outside the call; that
belongs with the people who can act on it.

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
| speaking lowers your own, the optimistic window, a moderator's lower landing | `client/src/hooks/use-voice.test.ts`, group "raising a hand" |
| the panel, the compact line, the lower control's gating | `client/src/components/voice/raised-hand-queue.test.tsx` |

Production runs `VOICE_REGISTRY=postgres`, which is why the cluster group is
the one that matters here (pitfall 12 in `CLAUDE.md`): the single-process
suite exercises the map, and the cluster suite exercises the rows.
