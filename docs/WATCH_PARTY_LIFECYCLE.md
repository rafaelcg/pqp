# Watch party lifecycle: the state map

Three state machines run a watch party and **none of them is the other two**.
A party is live because somebody pressed Ir ao vivo. A picture exists because
somebody is sharing. A playlist exists because an egress wrote one. They
overlap most of the time, which is exactly why every incident this feature has
had came from one of them being read as another.

This is the map. `docs/WATCH_PARTY.md` is the feature; this is what is true at
any instant, who changes it, and what a viewer sees while it is.

Written after 2026-09-17, when a single channel produced a zombie session, a
restart for a party that was over, three red log lines for an ordinary
teardown, a `voice.hlsStarted` with no playlist, and a viewer tab stuck on
"reconnecting" for minutes with the truth sitting in the sidebar next to it.
The violated invariants are at the bottom.

---

## 1. The party session (`channel_sessions`)

| State | What it is | Who moves it | The sidebar card |
|---|---|---|---|
| `draft` | Being set up. Invisible to everyone but the host and co-hosts. | The host creating one. | "Montando. Toca pra continuar." (host only) |
| `scheduled` | Announced for a time. | The host. | The countdown card |
| `live` | On air. `went_live_at` stamped. | Ir ao vivo; the takeover (`Assumir`). | The live block, with the audience count |
| `ended` / `cancelled` | Over. | Encerrar, the no-show sweep (`pqp-worker`), the host-gone sweep. | Back to the create/pending card |

Two things read this state outside the panel itself:

- `watchPartyKnownOver(channelId)` (`server/src/ws/watch-party-live.ts`), an
  in-memory mark of what **this process** saw end. It fails open on purpose: a
  channel it knows nothing about transcodes exactly as it always did.
- `GET /api/channels/:id/live` answers `partyLive` beside `ended`, so a viewer
  whose stream has gone can be told which of the two silences it is.

**A party ending ends the broadcast, and does not touch the share.** It is a
voice room; people watch each other's screens in one. Only the broadcast to
people without a seat stops.

---

## 2. The HLS session (the ladder, `rooms` in `hls-egress.ts`)

One session is one `startedAt`, two or three rungs, optionally a camera rung
and a mic archive, and a row per rung in `hls_sessions`.

| State | In the code | What a viewer is told |
|---|---|---|
| **starting** | `startRoom` has published the room into `rooms` with `announced: false` and is waiting for the primary rung's first live playlist (up to 45 s, `PLAYLIST_WAIT_ATTEMPTS`) | **Nothing.** `liveHlsStreamFor` answers null while `announced` is false, so no `voice-stream` carries a URL that does not resolve yet |
| **live** | `announced: true`, the reconcile returned the stream, the push fanned it out | The player attaches; the live badge |
| **restarting** | An egress died, `scheduleRestart` is on the clock (2 s, 4 s, 8 s, capped 15 s; three inside five minutes) | The holding screen's `restarting` copy with its countdown; the client holds rather than hammering a 404ing playlist |
| **stopping** | `stopRoom(channelId, reason)`: rows ended, rungs stopped, archive stopped | `voice-stream` with `stream: null`, `channel-live` with `ended` |
| **ended** | Out of `rooms`; the rows carry `ended_at` | Same as above; retention collects the objects |
| **failed** | Three restarts inside the window: `failedUntil`, no new egress for five minutes or until the share stops | `stream: null`, and the player's own "A transmissão caiu" if it got there first |

**The LL substate.** A party may ask for low latency (`low_latency_requested`).
`resolveHlsModeForChannel` answers `ll` or `conventional` for the channel and
that answer is the fork: `ll` runs on `pqp-remuxd` (`llRooms`, `hls-remux.ts`)
and the ladder above is not started at all. A demotion (the remux box's own
watchdog) clears the request, ends the LL session and reconciles the channel
onto the conventional ladder, which is a **new** `startedAt` and a real
re-attach for every viewer. Both drivers produce a stream, and every read that
asks "what is playing here" has to ask both (`liveHlsStreamFor ?? llStreamFor`)
-- a lesson that cost eighteen minutes of a dead session being re-served on
2026-09-15.

### Who moves the HLS session

| Trigger | Where | Effect |
|---|---|---|
| Presenter starts sharing | `set-sharing-screen` -> `pushLiveHls` | `startRoom` |
| Roster event (join, leave, camera, mute) | `pushLiveHls` | Reconcile; usually a no-op |
| Sharer vanishes | `pickHlsSharer` finds nobody, 5 s grace (`HLS_NO_SHARER_GRACE_MS`); a presenter who left or stopped sharing is waited for `HLS_PRESENTER_RETURN_GRACE_MS` (60 s), and the same person back inside it continues the session | `stopRoom("no-share")` |
| Presenter republishes their screen (new sid) | same-presenter branch | `stopRoom("screen-track-replaced")` then `startRoom` |
| Somebody else takes the share | `presenter-changed` | Stop, then start |
| Party ends | `noteWatchPartyState` -> the live listener -> `pushLiveHls` | `sharer` forced to null, so `stopRoom("no-share")`, with `voice.hlsPartyOver` naming it |
| An egress dies | the health monitor (10 s) | Drop a secondary rung, or end the session and `scheduleRestart` |
| A playlist stalls for 20 s | `rungHealth` | Same as a death, **plus** the rung is stopped: it is still transcoding |
| Mode flip / demotion | `sweepLlDemotions` -> `notifyChanged` | Stop one driver, start the other |
| API restart | `adoptRunningLiveHlsSession` on boot | The session is **adopted**, not restarted: the transcode never stopped, and the audience does not notice the deploy |
| Server allowlist turned off | `resolveLiveHlsForServer` per reconcile | `stopRoom("not-allowlisted")` |
| Presenter gone between the decision and the start | the presenter check, below | `voice.hlsStartCancelled`, no rung started |

---

## 3. What the viewer client shows

The player (`client/src/components/voice/hls-watch-player.tsx`) has its own
small machine, and `resolveHoldingScreenReason` (`client/src/lib/watch-holding-screen.ts`)
is the one place that maps it to words.

| Reason | When | Copy |
|---|---|---|
| `null` | A frame is playing | Nothing |
| `restarting` | `sequence-stuck` (playlist frozen 20 s) or `playlist-gone` (our own proxy answered 404/410) | "A transmissão reiniciou, volta em ~Ns" |
| `reconnecting` | Any other stall, or a fatal error | "A transmissão travou, reconectando" |
| `silent` | A playlist request 401'd inside the last 3 s (pitfall 16) | Nothing at all; it resolves itself |
| `over` | **The server was asked and said there is nothing live, and no party either** | "A sessão acabou" |
| `awaiting` | **Asked, nothing live, party still live** | "Esperando o apresentador voltar" |
| `dead` | The watchdog gave up (rebuild budget, or 8 reconnect checks) | "A transmissão caiu" plus a retry button |
| `buffering` / `unavailable` | A replay (`mode: "vod"`), which never uses the live vocabulary | Plain spinner / "a gravação não está mais disponível" |

`over` and `awaiting` come from `GET /api/channels/:id/live` answering
`stream: null` with `ended: true` -- a null the server **explicitly vouches
for**, never a failed query. They outrank every stall reason, because every
stall reason is an inference from the outside and this one is an answer.

**Coming back needs nothing pressed.** Two doors, deliberately: the `src` prop
(the server pushes `voice-stream` the moment a new session is announced) and
the player's own 20 s poll while it is showing `over`/`awaiting`. Either one
adopting a different `startedAt` clears the state and re-arms the watchdog.
And `WatchChannelStage` drops the dead player on `onSessionOver`, keyed to that
exact session, so the pane goes back to the party panel -- which owns "nothing
is on air" and the button that starts the next show.

---

## The invariants, and the five that broke on 2026-09-17

Channel `d5559e70`, the presenter and the viewer one person in two tabs.

1. **An HLS session is only ever started for somebody who is presenting NOW.**
   Broken: two `pushLiveHls` raced, the second still holding "party live,
   peer f408cf6a sharing" from before the party ended. It waited its turn in
   the reconcile queue and started a two-rung ladder at 19:20:47, 200 ms
   before that presenter's `voice.leave`. **Fixed** by asking the room again
   at each point a start commits -- `LiveHlsPresenterCheck`, registered by
   `ws/voice.ts`, read in `startRoom` before the track probe, after it, and
   after the readiness wait.

2. **A restart is for a live share.** Broken: those egresses died at 19:21:21
   on `track TR_... not found` and the monitor scheduled a restart for a party
   that had ended thirty-four seconds earlier. **Fixed**: `scheduleRestart`
   refuses when the presenter is gone, logs `voice.hlsRestartSkipped`, spends
   no restart budget, and tells the audience the stream is gone instead.

3. **A failed stop is a failure.** Broken: `egress with status EGRESS_COMPLETE
   cannot be stopped` is LiveKit agreeing with us, and it was logged three
   times as `voice.hlsStopFailed` for one ordinary teardown, and parked the id
   in the orphan backoff to be re-asked for an hour. **Fixed**:
   `egressAlreadyStopped` classifies it, `voice.hlsStopNoop` says so, and the
   backoff is cleared rather than grown.

4. **Nobody is told about a session that cannot be played.** Broken:
   `startRoom` publishes the room before its readiness probe, so for the 52.7 s
   that probe ran, every other reader -- `liveHlsStreamFor`, `GET /live`, the
   same-presenter branch of a concurrent reconcile -- could hand a viewer a
   playlist URL that did not exist. **Fixed**: `RoomHls.announced`, false until
   the primary rung's live playlist has been read once. `voice.hlsStarted` now
   carries `announced` beside `playlistReady`, so the line an operator greps
   says whether anybody was told.

5. **A viewer is never told something the server can contradict.** Broken: the
   tab sat on "A transmissão travou, reconectando" while the sidebar card next
   to it said the party was over, and would have gone on to "A transmissão
   caiu" -- a crash report for a show that simply finished. **Fixed**: the
   answer `reconnect()` was already fetching is believed, the watchdog stands
   down, and the two truthful states above appear with a slow poll behind them.

Two older ones this map exists to keep visible:

6. **A cap counts what it says it counts.** `LIVE_HLS_MAX_SESSIONS` is
   sessions, and a session is only a fixed number of processes while nothing
   leaks handlers (pitfall 15).

7. **Both drivers are drivers.** Anything that reads "what is playing on this
   channel" reads the conventional map AND the LL map, or an LL party's
   teardown is invisible (2026-09-15).

---

## 4. Who may end what, and what ends a party by itself

Added 2026-09-18, after an evening in which one production channel produced
seven parties, two abandoned drafts that blocked every subsequent create, a
live party that stayed live on every screen after the server had ended it, and
an Encerrar that answered `403 A host may not end a ended watch party`.

### The table

| Who | draft | scheduled | live |
|---|---|---|---|
| Host | cancel | cancel | end |
| Co-host | cancel | cancel | end |
| MANAGE_CHANNELS, or START_WATCH_PARTY, on the channel | cancel (**override**) | cancel (**override**) | end (**override**) |
| Anyone else who can see the channel | nothing | nothing | nothing |
| Not a member | 404, always | 404, always | 404, always |

**The override is a second door, not a wider first one.** The role table in
`packages/shared/src/watch-party-session.ts` still says `end` and `cancel`
belong to the host and the co-hosts, and the CLIENT draws Encerrar from that
table, so no admin is ever handed a stray button. 2026-09-12 (an uninvolved
admin ending a host's live show with one click) was a button, not a
permission, and the button has not moved. The override is
`canStaffOverrideWatchParty`, asked for by name, on one route.

**It is checked before the visibility gate,** which is the part that fixes the
draft case: a draft is invisible to a manager by design, so `authoriseWatchParty`
answered `not_found` and the server's own owner could not name the party
blocking their channel. Staff can now cancel a draft they still cannot see in
any list, on any sidebar, in any broadcast. Stopping the thing that refused
you is the only thing the override buys.

**A refusal names the states properly now.** `watchPartyRefusalMessage`
produces "a live watch party" and "a watch party that has already ended",
never "a ended watch party".

### Terminal is idempotent

`POST /api/watch-parties/:id/state` with `ended` or `cancelled`, on a party
that is already ended or cancelled, answers **200 with the party**. Two of the
host's own tabs, a sweep that got there a second early, and a party the server
ended behind the host's back all produce that request, and every one of them
is somebody asking for the state the party is already in.

Only the two terminal words. Asking a dead party to go `live` again, or an
ended one to become `scheduled`, is a request for a move and is still refused.

### Nothing silently blocks a create any more

A `draft` that is in the way of `POST /api/channels/:id/watch-parties` is
**superseded**: cancelled for real, through the transition table, broadcast
like every other ending, and the new party takes the channel. Three ways to
qualify, and each is a different kind of "nobody is setting this up":

1. the requester is its own host (the F5 case, and the "closed the tab and
   came back" case: your own abandoned draft never locks you out);
2. its host has no socket anywhere;
3. it has not changed for `WATCH_PARTY_DRAFT_STALE_MINUTES` (default 10).

A `scheduled` or `live` party is never superseded: one was announced to the
room and the other has an audience. Those still answer 409, now with
`blockingParty: { sessionId, state, name }` in the body so the caller has
something to act on.

### Stopping the share does not end the party

A party is `live` because somebody pressed **Ir ao vivo**. A picture exists
because somebody is sharing. Two facts, and the audience sees both: a `live`
party with nothing on it is the stage's `holding` state, "Segura que já já
começa", and the host can put a picture back up and be on air again.

Until 2026-09-18 the last screen share in the room stopping ran
`markChannelSessionEnded` and flipped the party to `ended` on the spot. PR
#720 gave that flip the fan-out it had always been missing, and within hours a
host clicked away to pick another window and ended a live show under everybody
watching. Every reason a host stops sharing is a reason they are about to
start again: switching windows, swapping the film, restarting a capture that
glitched, handing the screen to a co-host who has to find their own window
first.

So the share-stop path now only stamps `channel_sessions.no_share_since`
(`markChannelShareStopped`), and the next share clears it
(`markChannelShareStarted`). The stream still ends: `pushLiveHls` runs on the
next line of the same handler and tears the egress down, which is what it has
always done. Only the party survives.

### The three sweeps

All on the same minute tick as the reminders, in `jobs.ts`.

| Sweep | What it does | Knob | Log | Metric |
|---|---|---|---|---|
| Stale draft | Cancels a `draft` older than the TTL whose host has no socket | `WATCH_PARTY_DRAFT_TTL_MINUTES` (30, `0` off) | `watchParty.sweptDraft` | `watchParty.sweptDrafts` |
| Host gone | Ends a `live` party whose host has been disconnected past the window **and which has no stream** | `WATCH_PARTY_HOST_GONE_MINUTES` (5, `0` off) | `watchParty.sweptHostGone` | `watchParty.sweptHostGone` |
| No share | Ends a `live` party whose `no_share_since` is past the window **and which has no stream** | `WATCH_PARTY_NO_SHARE_MINUTES` (15, `0` off) | `watchParty.sweptNoShare` | `watchParty.sweptNoShare` |

The no-share window is generous on purpose. Fifteen minutes of nothing is an
abandoned room; fifteen seconds of nothing is a host looking for the right
window, and the difference between those two is the whole point. A host who
closes the laptop is caught in five minutes by the host-gone sweep instead;
this one only covers the host who stays at the keyboard with a blank screen.
It runs the same `applyWatchPartyOptions(row, "ended")` restore Encerrar does,
so the channel gets its slow mode and its floor back.

**Neither ending sweep can end a party with a picture on it.** That is the
safety property, and it rests entirely on `channelHasLiveStream`, which
asks `hls_sessions` for a row on this channel with `ended_at IS NULL` started
in the last twelve hours. Three deliberate choices in that one query:

- **The row, not `pickHlsSharer`.** The in-memory authority answers only for
  the process holding the room, and this sweep runs from `jobs.ts`, which in
  the `WORKER_MODE=worker` deployment holds no voice state at all: it would
  see no stream anywhere and end every party it looked at. Pitfall 12.
- **Both drivers write `hls_sessions`**, the conventional ladder
  (`hls-egress.ts`) and the LL remux (`hls-remux.ts`), so one query covers
  both. Invariant 7 above.
- **Twelve hours bounds a leak.** A row nothing ever closed would otherwise
  make its party immortal, which is pitfall 13 with a different table.

It fails safe: an unreadable answer holds the party, counted as
`watchParty.streamCheckFailures`. The cost of being wrong that way is a party
that ends a minute later; the cost of being wrong the other way is a room of
people losing the film. `watchParty.heldByLiveStream` climbing while
`sweptHostGone` and `sweptNoShare` stay flat is the guard working.

For the no-share sweep the same check is doing a second job: the stamp is
written by whichever process held the room, so it can be stale (a share that
started on the other machine, a session adopted across a deploy). A party with
a stream on it is never swept, whatever the column says.

**Why the host-gone default is 5 and not 10.** It is the number that already
shipped, and it is the same number `claimHost` uses: a co-host may take over
only while `WATCH_PARTY_HOST_GRACE_MS` is open, so a sweep window longer than
the grace would create a stretch in which nobody may claim the party and
nothing will end it. That is the ghost party this section exists to kill.
Raise both or neither.

### Every ending is broadcast

The rule: **a party's state never changes without `broadcastWatchParty`**,
which is what clears the sidebar pill, the header bar and the Encerrar
control (a terminal party is fanned out as `null`, see §2 of this file and
`ws/watch-party-events.ts`).

Two paths were missing it until 2026-09-18, and both are the same bug:

- **`markChannelSessionEnded`** (`ws/voice.ts`, the last screen share in the
  room stopping). It flipped a LIVE WATCH PARTY to `ended` and did so in total
  silence: every tab kept its AO VIVO pill indefinitely, the channel kept the
  slow mode and the closed floor the party had set, and Encerrar on the ghost
  answered 403. This is the ghost party. (That path is gone now: giving it the
  fan-out made the underlying rule visible, and the rule was wrong. See
  "Stopping the share does not end the party" above.)
- **`noShowSweep`** (`services/channel-sessions.ts`, a scheduled party an hour
  past its time). Same shape, quieter symptom: the countdown card stayed on
  every sidebar in the server until a reload.

Both return the ids they ended now, and their callers fan them out.
